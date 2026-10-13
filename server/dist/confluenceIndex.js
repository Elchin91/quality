import { Ollama } from 'ollama';
import { withGpuLease } from './gpuQueue.js';
import { db as defaultDb } from './db.js';
import { logger } from './logger.js';
import { normalizeSearchText } from './confluenceContent.js';
export { syncCareIndex, startCareIndexSync } from './confluenceIndexSync.js';
const EMBEDDING_MODEL = process.env.CARE_EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
const DEFAULT_DB = defaultDb;
function ollama(signal) {
    return new Ollama({
        host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
        fetch: (url, init) => fetch(url, {
            ...init,
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
                : AbortSignal.timeout(30_000),
        }),
    });
}
export function getCareIndexStatus(db = DEFAULT_DB) {
    const syncOperation = db
        .prepare(`SELECT operation_id AS id,status,started_at AS startedAt,
    finished_at AS finishedAt,error_code AS errorCode FROM care_sync_operation WHERE id=1`)
        .get();
    const row = db
        .prepare(`
    SELECT state,active_generation,last_successful_sync AS lastSuccessfulSync,
           active_pages AS activePages,indexed_pages AS indexedPages,
           total_assets AS totalAssets,processed_assets AS processedAssets,
           failed_assets AS failedAssets
    FROM care_index_state WHERE id=1
  `)
        .get();
    if (!row?.active_generation && row?.state !== 'indexing') {
        return {
            syncOperation: syncOperation ?? null,
            state: 'unavailable',
            lastSuccessfulSync: row?.lastSuccessfulSync ?? null,
            activePages: 0,
            indexedPages: 0,
            totalAssets: 0,
            processedAssets: 0,
            failedAssets: 0,
        };
    }
    return {
        syncOperation: syncOperation ?? null,
        state: row.state,
        lastSuccessfulSync: row.lastSuccessfulSync,
        activePages: row.activePages,
        indexedPages: row.indexedPages,
        totalAssets: row.totalAssets,
        processedAssets: row.processedAssets,
        failedAssets: row.failedAssets,
    };
}
function queryTokens(query) {
    const stopWords = new Set([
        'привет',
        'здравствуйте',
        'пожалуйста',
        'hi',
        'hello',
        'нужна',
        'нужно',
        'информация',
        'информацию',
        'про',
        'about',
        'information',
        'need',
        'please',
        'haqqinda',
        'haqqında',
        'barədə',
        'məlumat',
        'məlumatı',
        'lazımdır',
        'что',
        'такое',
        'как',
        'где',
        'когда',
        'какой',
        'какая',
        'какие',
        'почему',
        'ответ',
        'можно',
        'это',
        'what',
        'who',
        'where',
        'when',
        'why',
        'which',
        'how',
        'does',
        'are',
        'is',
        'do',
        'can',
        'the',
        'and',
        'for',
        'with',
        'from',
        'into',
        'does',
        'tell',
        'me',
        'about',
        'please',
        'necə',
        'nədir',
        'hansı',
        'kim',
        'üçün',
        'ilə',
        'haqqında',
    ]);
    const cleaned = normalizeSearchText(query);
    return [
        ...new Set((cleaned.match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((word) => !stopWords.has(word))),
    ].slice(0, 20);
}
function cosine(left, right) {
    if (!left.length || left.length !== right.length)
        return 0;
    let dot = 0;
    let leftSize = 0;
    let rightSize = 0;
    for (let index = 0; index < left.length; index++) {
        const a = left[index];
        const b = right[index];
        dot += a * b;
        leftSize += a * a;
        rightSize += b * b;
    }
    return leftSize && rightSize ? dot / Math.sqrt(leftSize * rightSize) : 0;
}
export async function searchCareIndex(query, signal) {
    if (signal?.aborted)
        return [];
    const state = DEFAULT_DB.prepare('SELECT state,active_generation,staging_generation,indexed_pages FROM care_index_state WHERE id=1').get();
    const generation = state?.active_generation ?? (state?.indexed_pages ? state.staging_generation : null);
    if (!generation)
        throw new Error('CARE is still being indexed. Please retry when the index is ready.');
    const tokens = queryTokens(query);
    const lexical = [];
    if (tokens.length) {
        const match = tokens.map((token) => `"${token.replace(/"/gu, '""')}"`).join(' OR ');
        lexical.push(...DEFAULT_DB.prepare(`
      SELECT d.id, bm25(care_index_fts,3.0,2.0,1.0) AS score
      FROM care_index_fts JOIN care_index_documents d ON d.id=care_index_fts.rowid
      WHERE care_index_fts MATCH ? AND d.generation=?
      ORDER BY score LIMIT 30
    `).all(match, generation));
    }
    let semantic = [];
    if (state.state !== 'indexing')
        try {
            const response = await withGpuLease('ollama', () => ollama(signal).embed({
                model: EMBEDDING_MODEL,
                input: tokens.length ? tokens.join(' ') : query,
                keep_alive: '0',
            }), signal);
            const vector = response.embeddings[0];
            if (vector) {
                const rows = DEFAULT_DB.prepare('SELECT id,embedding FROM care_index_documents WHERE generation=? AND embedding IS NOT NULL').all(generation);
                semantic = rows
                    .map((row) => ({
                    id: row.id,
                    score: cosine(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4), new Float32Array(vector)),
                }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 30);
            }
        }
        catch (error) {
            logger.warn({ err: error }, 'CARE semantic query unavailable; using full-text results');
        }
    if (signal?.aborted)
        return [];
    const scores = new Map();
    lexical.forEach((item, index) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + index + 1)));
    semantic.forEach((item, index) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + index + 1)));
    const compactQuery = tokens.join('').replace(/[^\p{L}\p{N}]/gu, '');
    if (compactQuery.length >= 4 && lexical.length) {
        const ids = lexical.map((item) => item.id);
        const rows = DEFAULT_DB.prepare(`SELECT id,title FROM care_index_documents WHERE generation=? AND id IN (${ids.map(() => '?').join(',')})`).all(generation, ...ids);
        for (const row of rows) {
            const title = normalizeSearchText(row.title).replace(/[^\p{L}\p{N}]/gu, '');
            if (title.includes(compactQuery))
                scores.set(row.id, (scores.get(row.id) ?? 0) + 0.02);
        }
    }
    if (compactQuery.length >= 4) {
        const exactTitleDocs = DEFAULT_DB.prepare(`SELECT id,page_id,doc_key,title,LENGTH(content) AS chars
       FROM care_index_documents WHERE generation=? AND kind='page'`).all(generation).filter((row) => normalizeSearchText(row.title).replace(/[^\p{L}\p{N}]/gu, '') === compactQuery &&
            row.chars >= 120);
        exactTitleDocs.sort((a, b) => Number(a.doc_key.split(':').at(-1)) - Number(b.doc_key.split(':').at(-1)));
        for (const [index, row] of exactTitleDocs.slice(0, 2).entries()) {
            scores.set(row.id, (scores.get(row.id) ?? 0) + 0.06 - index * 0.005);
        }
    }
    const semanticScores = new Map(semantic.map((item) => [item.id, item.score]));
    const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    if (!lexical.length && (!semantic.length || (semanticScores.get(semantic[0].id) ?? 0) < 0.22))
        return [];
    const selected = [];
    const perPage = new Map();
    const candidateIds = ordered.map(([id]) => id);
    if (candidateIds.length) {
        const placeholders = candidateIds.map(() => '?').join(',');
        const rows = DEFAULT_DB.prepare(`SELECT id,page_id FROM care_index_documents WHERE generation=? AND id IN (${placeholders})`).all(generation, ...candidateIds);
        const pagesById = new Map(rows.map((row) => [row.id, row.page_id]));
        for (const [id] of ordered) {
            const pageId = pagesById.get(id);
            if (!pageId)
                continue;
            const count = perPage.get(pageId) ?? 0;
            if (count >= 2)
                continue;
            selected.push(id);
            perPage.set(pageId, count + 1);
            if (selected.length === 6)
                break;
        }
    }
    if (!selected.length)
        return [];
    const rows = DEFAULT_DB.prepare(`SELECT doc_key,title,section,kind,source_url,content FROM care_index_documents WHERE generation=? AND id IN (${selected.map(() => '?').join(',')})`).all(generation, ...selected);
    const byKey = new Map(rows.map((row) => [row.doc_key, row]));
    return selected.flatMap((id) => {
        const key = DEFAULT_DB.prepare('SELECT doc_key FROM care_index_documents WHERE generation=? AND id=?').get(generation, id);
        const row = key ? byKey.get(key.doc_key) : undefined;
        if (!row)
            return [];
        return [
            {
                id: row.doc_key,
                title: row.title,
                url: row.source_url,
                excerpt: row.content.slice(0, 1_000),
                section: row.section,
                kind: row.kind,
            },
        ];
    });
}
