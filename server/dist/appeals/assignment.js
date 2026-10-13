import { randomInt } from 'node:crypto';
export function normalizeAlias(label) {
    const normalized = label?.normalize('NFKC').trim().toLocaleLowerCase('az');
    return normalized || null;
}
export function cryptoRandomIndex(length) {
    return randomInt(length);
}
export function selectEligibleReviewer(db, options) {
    const alias = normalizeAlias(options.originalReviewerLabel);
    const mappedOriginal = alias
        ? db.prepare('SELECT user_id FROM reviewer_aliases WHERE normalized_label = ?').get(alias)?.user_id
        : undefined;
    if (!options.originalEvaluatorUserId && !alias)
        return null;
    if (!options.originalEvaluatorUserId && alias && !mappedOriginal)
        return null;
    const excluded = new Set([options.originalEvaluatorUserId, mappedOriginal].filter(Boolean));
    const candidates = db
        .prepare(`SELECT id FROM users
      WHERE role='reviewer' AND active=1 AND must_change_password=0
      ORDER BY id`)
        .all().filter(({ id }) => !excluded.has(id));
    if (!candidates.length)
        return null;
    const index = (options.randomIndex ?? cryptoRandomIndex)(candidates.length);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length)
        throw new RangeError('random index out of range');
    return candidates[index].id;
}
