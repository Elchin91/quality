export function beginCareStage(db) {
    return db.transaction(() => {
        const row = db
            .prepare('SELECT active_generation,staging_generation,sync_started_at FROM care_index_state WHERE id=1')
            .get();
        const generation = row.staging_generation ?? (row.active_generation ?? 0) + 1;
        db.prepare(`UPDATE care_index_state SET staging_generation=?,state='indexing',
       sync_started_at=? WHERE id=1`).run(generation, row.staging_generation
            ? (row.sync_started_at ?? new Date().toISOString())
            : new Date().toISOString());
        return { generation, activeGeneration: row.active_generation };
    })();
}
function insertDocuments(db, generation, docs) {
    const insert = db.prepare(`
    INSERT INTO care_index_documents
      (doc_key,generation,page_id,title,section,kind,source_url,source_updated_at,source_version,content,embedding)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
    for (const doc of docs) {
        insert.run(doc.key, generation, doc.pageId, doc.title, doc.section, doc.kind, doc.url, doc.updatedAt, doc.sourceVersion, doc.content, doc.embedding);
    }
}
export function isCarePageSaved(db, generation, pageId, versionKey) {
    const row = db
        .prepare('SELECT version_key FROM care_index_pages WHERE generation=? AND page_id=?')
        .get(generation, pageId);
    return row?.version_key === versionKey;
}
export function saveCarePage(db, generation, pageId, versionKey, docs) {
    db.transaction(() => {
        db.prepare("DELETE FROM care_index_documents WHERE generation=? AND page_id=? AND kind<>'attachment'").run(generation, pageId);
        insertDocuments(db, generation, docs);
        db.prepare(`INSERT INTO care_index_pages(generation,page_id,version_key) VALUES (?,?,?)
       ON CONFLICT(generation,page_id) DO UPDATE SET version_key=excluded.version_key`).run(generation, pageId, versionKey);
    })();
}
export function getCareAssetCheckpoint(db, generation, assetId) {
    const row = db
        .prepare('SELECT version_key,failed FROM care_index_assets WHERE generation=? AND asset_id=?')
        .get(generation, assetId);
    return row ? { versionKey: row.version_key, failed: Boolean(row.failed) } : undefined;
}
export function saveCareAsset(db, generation, assetId, versionKey, docs, failed) {
    db.transaction(() => {
        db.prepare('DELETE FROM care_index_documents WHERE generation=? AND doc_key GLOB ?').run(generation, `attachment:${assetId}:*`);
        insertDocuments(db, generation, docs);
        db.prepare(`INSERT INTO care_index_assets(generation,asset_id,version_key,failed) VALUES (?,?,?,?)
       ON CONFLICT(generation,asset_id) DO UPDATE SET
       version_key=excluded.version_key,failed=excluded.failed`).run(generation, assetId, versionKey, failed ? 1 : 0);
    })();
}
export function removeStaleCarePages(db, generation, activePageIds) {
    const active = new Set(activePageIds);
    const rows = db
        .prepare('SELECT page_id FROM care_index_pages WHERE generation=?')
        .all(generation);
    db.transaction(() => {
        for (const { page_id: pageId } of rows) {
            if (active.has(pageId))
                continue;
            db.prepare('DELETE FROM care_index_documents WHERE generation=? AND page_id=?').run(generation, pageId);
            db.prepare('DELETE FROM care_index_pages WHERE generation=? AND page_id=?').run(generation, pageId);
        }
    })();
}
export function removeStaleCareAssets(db, generation, activeAssetIds) {
    const active = new Set(activeAssetIds);
    const rows = db
        .prepare('SELECT asset_id FROM care_index_assets WHERE generation=?')
        .all(generation);
    db.transaction(() => {
        for (const { asset_id: assetId } of rows) {
            if (active.has(assetId))
                continue;
            db.prepare('DELETE FROM care_index_documents WHERE generation=? AND doc_key GLOB ?').run(generation, `attachment:${assetId}:*`);
            db.prepare('DELETE FROM care_index_assets WHERE generation=? AND asset_id=?').run(generation, assetId);
        }
    })();
}
export function promoteCareStage(db, generation, counts) {
    db.transaction(() => {
        const row = db
            .prepare('SELECT active_generation,staging_generation FROM care_index_state WHERE id=1')
            .get();
        if (row.staging_generation !== generation)
            throw new Error('CARE staging generation changed.');
        db.prepare(`UPDATE care_index_state SET state=?,active_generation=?,staging_generation=NULL,
       last_successful_sync=?,sync_started_at=NULL,active_pages=?,indexed_pages=?,
       total_assets=?,processed_assets=?,failed_assets=? WHERE id=1`).run(counts.state, generation, new Date().toISOString(), counts.activePages, counts.indexedPages, counts.totalAssets, counts.processedAssets, counts.failedAssets);
        if (row.active_generation !== null && row.active_generation !== generation) {
            db.prepare('DELETE FROM care_index_documents WHERE generation=?').run(row.active_generation);
            db.prepare('DELETE FROM care_index_pages WHERE generation=?').run(row.active_generation);
            db.prepare('DELETE FROM care_index_assets WHERE generation=?').run(row.active_generation);
        }
    })();
}
