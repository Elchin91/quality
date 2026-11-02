import { boundedOperation } from '../jobs/boundedOperation.js';
import { refreshCurrentRoster, rosterErrorCode, RosterLoadError } from './googleSheets.js';
import { readRosterSnapshot, rosterIsFresh } from './repository.js';
export function nextRosterMonth(month) {
    const [year, number] = month.split('-').map(Number);
    return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
}
export function rosterReadiness(db, month, now) {
    const summary = (value) => {
        const roster = readRosterSnapshot(db, value);
        return {
            month: value,
            ready: Boolean(roster && rosterIsFresh(roster, now)),
            source_kind: roster?.sourceKind ?? (roster ? 'google' : null),
            fetched_at_ms: roster?.fetchedAtMs ?? null,
        };
    };
    const last = db.prepare('SELECT * FROM qa_roster_refresh_status WHERE id=1').get();
    const sameMonth = last?.next_attempt_at != null &&
        new Date(last.next_attempt_at + 4 * 3_600_000).toISOString().slice(0, 7) === month;
    return {
        current: summary(month),
        next: {
            ...summary(nextRosterMonth(month)),
            error_code: sameMonth ? last.next_error_code : null,
            attempted_at_ms: sameMonth ? last.next_attempt_at : null,
        },
        last_attempt_at: last?.last_attempt_at ?? null,
        last_error_code: last?.last_error_code ?? null,
    };
}
export async function ensureDeliveryRoster(input) {
    const { db, reviewDate, now, signal } = input;
    const month = reviewDate.slice(0, 7);
    const previous = readRosterSnapshot(db, month);
    const last = db
        .prepare('SELECT last_attempt_at FROM qa_roster_refresh_status WHERE id=1')
        .pluck()
        .get();
    const fresh = Boolean(previous && rosterIsFresh(previous, now));
    let currentError;
    const interval = previous?.sourceKind === 'upload' ? 6 * 3_600_000 : 3_600_000;
    if (!fresh || last === undefined || now - last >= interval) {
        try {
            await boundedOperation(signal, 30_000, (child) => (input.refresh ?? refreshCurrentRoster)(db, { now, month, reviewDate, signal: child }));
            db.prepare(`INSERT INTO qa_roster_refresh_status(id,last_attempt_at,last_error_code) VALUES (1,?,NULL)
        ON CONFLICT(id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_error_code=NULL`).run(now);
        }
        catch (error) {
            signal.throwIfAborted();
            db.prepare(`INSERT INTO qa_roster_refresh_status(id,last_attempt_at,last_error_code) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET
        last_attempt_at=excluded.last_attempt_at,last_error_code=excluded.last_error_code`).run(now, rosterErrorCode(error));
            if (!fresh)
                currentError =
                    error instanceof RosterLoadError ? error : new RosterLoadError('roster_network_failed');
        }
    }
    // Prefetch does not hold up today's work; an unpublished next-month sheet is expected.
    const today = new Date(now + 4 * 3_600_000).toISOString().slice(0, 10);
    if (Number(today.slice(8)) >= 25) {
        const next = nextRosterMonth(today.slice(0, 7)), snapshot = readRosterSnapshot(db, next);
        if (!snapshot || !rosterIsFresh(snapshot, now)) {
            let code = null;
            try {
                await boundedOperation(signal, 30_000, (child) => (input.refresh ?? refreshCurrentRoster)(db, { now, month: next, signal: child }));
            }
            catch (error) {
                signal.throwIfAborted();
                code = rosterErrorCode(error);
            }
            db.prepare(`INSERT INTO qa_roster_refresh_status(id,next_attempt_at,next_error_code) VALUES(1,?,?)
        ON CONFLICT(id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,next_error_code=excluded.next_error_code`).run(now, code);
        }
    }
    if (currentError)
        throw currentError;
}
