import { createCareSyncCoordinator } from './careSyncCoordinator.js';
import { withGpuLease } from './gpuQueue.js';
import { createHash } from 'node:crypto';
import { Ollama } from 'ollama';
import { db as defaultDb } from './db.js';
import { logger } from './logger.js';
import { attachmentReferences, splitCareText, storageToText } from './confluenceContent.js';
import { downloadCareAttachment, fetchCarePages } from './confluenceApi.js';
import { discardCareMediaCache, extractAttachmentText } from './confluenceMedia.js';
import { beginCareStage, getCareAssetCheckpoint, isCarePageSaved, promoteCareStage, removeStaleCareAssets, removeStaleCarePages, saveCareAsset, saveCarePage, } from './confluenceIndexStore.js';
const EMBEDDING_MODEL = process.env.CARE_EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
const MAX_SOURCE_CHARS = 1_800;
function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}
function ollama(signal) {
    return new Ollama({
        host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
        fetch: (url, init) => fetch(url, {
            ...init,
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(90_000)])
                : AbortSignal.timeout(90_000),
        }),
    });
}
function pageCandidates(page) {
    const text = storageToText(page.storage);
    const alias = page.title.replace(/[\s_-]+/gu, '');
    const chunks = splitCareText(`${page.title} ${alias}\n${text}`, MAX_SOURCE_CHARS);
    const docs = chunks.map((chunk, index) => ({
        key: `page:${page.id}:${index}`,
        pageId: page.id,
        title: page.title,
        section: chunk.section,
        kind: 'page',
        url: page.url,
        updatedAt: digest(`${page.version}:${chunk.text}`),
        sourceVersion: String(page.version),
        content: `${page.title} ${alias}\n${chunk.text}`,
        embedding: null,
    }));
    for (const comment of page.comments) {
        const textContent = storageToText(comment.text);
        if (!textContent)
            continue;
        const label = comment.type === 'inline_comment' ? 'Inline comment' : 'Comment';
        for (const [index, chunk] of splitCareText(textContent, MAX_SOURCE_CHARS).entries()) {
            docs.push({
                key: `comment:${comment.id}:${index}`,
                pageId: page.id,
                title: `${page.title} — ${label}`,
                section: 'Comment',
                kind: comment.type,
                url: comment.url || page.url,
                updatedAt: digest(`${comment.date ?? ''}:${chunk.text}`),
                sourceVersion: comment.date ?? 'unknown',
                content: `${label}${comment.date ? ` dated ${comment.date}` : ''}:\n${chunk.text}`,
                embedding: null,
            });
        }
    }
    return docs;
}
function indexedAssets(page) {
    const references = new Set([page.storage, ...page.comments.map((comment) => comment.text)]
        .flatMap((source) => [...attachmentReferences(source)])
        .map((name) => name.normalize('NFKC').toLocaleLowerCase()));
    return page.attachments.filter((attachment) => references.has(attachment.title.normalize('NFKC').toLocaleLowerCase()));
}
function oldEmbedding(db, generation, doc) {
    if (generation === null)
        return null;
    const row = db
        .prepare(`SELECT embedding FROM care_index_documents
     WHERE generation=? AND doc_key=? AND source_updated_at=?`)
        .get(generation, doc.key, doc.updatedAt);
    return row?.embedding ?? null;
}
function cachedAsset(db, generation, id, versionKey, page, title, version) {
    if (generation === null)
        return [];
    const rows = db
        .prepare(`SELECT doc_key,content,embedding FROM care_index_documents
     WHERE generation=? AND doc_key GLOB ? AND source_updated_at=?`)
        .all(generation, `attachment:${id}:*`, versionKey);
    return rows.map((row) => ({
        key: row.doc_key,
        pageId: page.id,
        title: `${page.title} — ${title}`,
        section: `Attachment: ${title}`,
        kind: 'attachment',
        url: page.url,
        updatedAt: versionKey,
        sourceVersion: String(version),
        content: row.content,
        embedding: row.embedding,
    }));
}
async function attachmentDocuments(db, activeGeneration, page, attachment, versionKey, signal) {
    const cached = cachedAsset(db, activeGeneration, attachment.id, versionKey, page, attachment.title, attachment.version);
    if (cached.length)
        return { docs: cached, failed: false };
    if (attachment.fileSize > 150 * 1024 * 1024)
        return { docs: [], failed: true };
    try {
        const bytes = await downloadCareAttachment(attachment, process.env, signal);
        const extracted = await extractAttachmentText(bytes, attachment.mediaType, attachment.title, digest(`${attachment.id}:${versionKey}`), signal);
        if (!extracted.trim())
            return { docs: [], failed: true };
        return {
            failed: false,
            docs: splitCareText(extracted, MAX_SOURCE_CHARS).map((chunk, index) => ({
                key: `attachment:${attachment.id}:${index}`,
                pageId: page.id,
                title: `${page.title} — ${attachment.title}`,
                section: `Attachment: ${attachment.title}`,
                kind: 'attachment',
                url: page.url,
                updatedAt: versionKey,
                sourceVersion: String(attachment.version),
                content: chunk.text,
                embedding: null,
            })),
        };
    }
    catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.message.startsWith('CARE image processing paused'))
            throw error;
        logger.warn({ attachmentId: attachment.id, err: error }, 'CARE attachment extraction failed');
        return { docs: [], failed: true };
    }
}
async function unloadVisionModel(signal) {
    try {
        await ollama(signal).generate({
            model: process.env.OLLAMA_MODEL || 'gemma4:e4b',
            prompt: '',
            stream: false,
            keep_alive: 0,
        });
    }
    catch (error) {
        logger.warn({ err: error }, 'Could not unload CARE vision model before embeddings');
    }
}
async function unloadEmbeddingModel(signal) {
    try {
        await ollama(signal).generate({
            model: EMBEDDING_MODEL,
            prompt: '',
            stream: false,
            keep_alive: 0,
        });
    }
    catch {
        /* Model may already be unloaded. */
    }
}
async function embedMissing(db, generation, signal) {
    try {
        while (true) {
            signal?.throwIfAborted();
            const batch = db
                .prepare(`SELECT id,content FROM care_index_documents
        WHERE generation=? AND embedding IS NULL ORDER BY id LIMIT 8`)
                .all(generation);
            if (!batch.length)
                return true;
            const result = await withGpuLease('ollama', async () => {
                await unloadVisionModel(signal);
                try {
                    return await ollama(signal).embed({
                        model: EMBEDDING_MODEL,
                        input: batch.map((item) => item.content),
                        keep_alive: '2m',
                    });
                }
                finally {
                    // Release resident embedding weights before another GPU consumer starts.
                    await unloadEmbeddingModel();
                }
            }, signal);
            signal?.throwIfAborted();
            db.transaction(() => {
                const update = db.prepare('UPDATE care_index_documents SET embedding=? WHERE id=?');
                for (const [index, doc] of batch.entries()) {
                    const vector = result.embeddings[index];
                    if (!vector)
                        throw new Error('CARE embedding batch returned an incomplete result.');
                    update.run(Buffer.from(new Float32Array(vector).buffer), doc.id);
                }
            })();
        }
    }
    catch {
        signal?.throwIfAborted();
        logger.warn({ code: 'embedding_failed' }, 'CARE semantic embeddings unavailable; keeping full-text search');
        return false;
    }
}
export async function syncCareIndex(db = defaultDb, signal) {
    signal?.throwIfAborted();
    const { generation, activeGeneration } = beginCareStage(db);
    try {
        const pages = await fetchCarePages(process.env, signal);
        if (!pages.length)
            throw new Error('CARE returned no eligible content.');
        const assets = pages.flatMap((page) => indexedAssets(page).map((attachment) => ({ page, attachment })));
        const priority = (attachment) => attachment.mediaType.startsWith('video/') || /\.(mp4|mkv|mov|webm)$/iu.test(attachment.title)
            ? 2
            : attachment.mediaType.startsWith('image/') ||
                attachment.mediaType === 'application/pdf' ||
                attachment.title.toLowerCase().endsWith('.pdf')
                ? 1
                : 0;
        assets.sort((left, right) => priority(left.attachment) - priority(right.attachment) ||
            left.attachment.fileSize - right.attachment.fileSize);
        removeStaleCarePages(db, generation, pages.map((page) => page.id));
        removeStaleCareAssets(db, generation, assets.map(({ attachment }) => attachment.id));
        db.prepare(`UPDATE care_index_state SET active_pages=?,total_assets=?,
       indexed_pages=(SELECT COUNT(*) FROM care_index_pages WHERE generation=?),
       processed_assets=(SELECT COUNT(*) FROM care_index_assets WHERE generation=?),
       failed_assets=(SELECT COUNT(*) FROM care_index_assets WHERE generation=? AND failed=1)
       WHERE id=1`).run(pages.length, assets.length, generation, generation, generation);
        for (const page of pages) {
            signal?.throwIfAborted();
            const versionKey = digest(JSON.stringify([
                2,
                page.version,
                page.title,
                page.storage,
                page.comments.map((item) => [item.id, item.date, item.text]),
            ]));
            if (isCarePageSaved(db, generation, page.id, versionKey))
                continue;
            const docs = pageCandidates(page);
            for (const doc of docs)
                doc.embedding = oldEmbedding(db, activeGeneration, doc);
            saveCarePage(db, generation, page.id, versionKey, docs);
            db.prepare('UPDATE care_index_state SET indexed_pages=(SELECT COUNT(*) FROM care_index_pages WHERE generation=?) WHERE id=1').run(generation);
            logger.info({ pageId: page.id }, 'CARE page saved');
        }
        await withGpuLease('ollama', () => unloadEmbeddingModel(signal), signal);
        for (const [index, { page, attachment }] of assets.entries()) {
            signal?.throwIfAborted();
            const pdf = attachment.mediaType === 'application/pdf' ||
                attachment.title.toLowerCase().endsWith('.pdf');
            const versionKey = digest(`${attachment.version}:${attachment.title}:${attachment.fileSize}:${pdf ? 'pdf-all-pages' : ''}`);
            const checkpoint = getCareAssetCheckpoint(db, generation, attachment.id);
            if (checkpoint?.versionKey === versionKey && !checkpoint.failed)
                continue;
            logger.info({
                assetId: attachment.id,
                mediaType: attachment.mediaType,
                bytes: attachment.fileSize,
                ordinal: index + 1,
                totalAssets: assets.length,
            }, 'CARE asset processing started');
            const result = await attachmentDocuments(db, activeGeneration, page, attachment, versionKey, signal);
            signal?.throwIfAborted();
            saveCareAsset(db, generation, attachment.id, versionKey, result.docs, result.failed);
            if (!result.failed) {
                await discardCareMediaCache(digest(`${attachment.id}:${versionKey}`)).catch((error) => logger.warn({ attachmentId: attachment.id, err: error }, 'CARE media cache cleanup failed'));
            }
            db.prepare(`UPDATE care_index_state SET processed_assets=(SELECT COUNT(*) FROM care_index_assets WHERE generation=?),
         failed_assets=(SELECT COUNT(*) FROM care_index_assets WHERE generation=? AND failed=1) WHERE id=1`).run(generation, generation);
            if ((index + 1) % 10 === 0 || index + 1 === assets.length) {
                logger.info({ processedAssets: index + 1, totalAssets: assets.length }, 'CARE assets saved');
            }
        }
        const embeddingReady = await embedMissing(db, generation, signal);
        const state = db
            .prepare(`SELECT active_pages AS activePages,indexed_pages AS indexedPages,
       total_assets AS totalAssets,processed_assets AS processedAssets,
       failed_assets AS failedAssets FROM care_index_state WHERE id=1`)
            .get();
        signal?.throwIfAborted();
        promoteCareStage(db, generation, {
            ...state,
            state: state.failedAssets || !embeddingReady ? 'degraded' : 'ready',
        });
        logger.info({ pages: state.indexedPages, assets: state.processedAssets }, 'CARE index sync completed');
    }
    catch (error) {
        db.prepare(`UPDATE care_index_state SET state=?,sync_started_at=NULL WHERE id=1`).run(activeGeneration ? 'degraded' : 'unavailable');
        logger.warn({ code: signal?.aborted ? 'interrupted' : 'sync_failed' }, 'CARE index sync interrupted; checkpoints retained');
        throw error;
    }
}
const coordinators = new WeakMap();
export function getCareSyncCoordinator(db = defaultDb) {
    let coordinator = coordinators.get(db);
    if (!coordinator) {
        coordinator = createCareSyncCoordinator(db, (database, signal) => syncCareIndex(database, signal));
        coordinators.set(db, coordinator);
    }
    return coordinator;
}
export function startCareIndexSync(db = defaultDb) {
    const coordinator = getCareSyncCoordinator(db);
    coordinator.start();
    return () => coordinator.stop();
}
