import { randomUUID } from 'node:crypto';
export function createCareSyncCoordinator(db, sync) {
    let inFlight = null;
    let controller = null;
    let timer = null;
    let stopped = false;
    db.prepare("UPDATE care_sync_operation SET status='interrupted',error_code='interrupted',finished_at=? WHERE status='running'").run(new Date().toISOString());
    const status = () => db
        .prepare(`SELECT operation_id AS id,status,
    started_at AS startedAt,finished_at AS finishedAt,error_code AS errorCode
    FROM care_sync_operation WHERE id=1`)
        .get() ?? null;
    const request = () => {
        if (stopped)
            throw new Error('care_sync_stopped');
        if (inFlight)
            return status();
        const id = randomUUID();
        const startedAt = new Date().toISOString();
        controller = new AbortController();
        const signal = controller.signal;
        db.prepare(`INSERT INTO care_sync_operation(id,operation_id,status,started_at,finished_at,error_code)
      VALUES(1,?,'running',?,NULL,NULL) ON CONFLICT(id) DO UPDATE SET
      operation_id=excluded.operation_id,status='running',started_at=excluded.started_at,finished_at=NULL,error_code=NULL`).run(id, startedAt);
        inFlight = Promise.resolve()
            .then(() => {
            signal.throwIfAborted();
            return sync(db, signal);
        })
            .then(() => {
            signal.throwIfAborted();
            db.prepare("UPDATE care_sync_operation SET status='succeeded',finished_at=? WHERE operation_id=?").run(new Date().toISOString(), id);
        })
            .catch((error) => {
            const message = error instanceof Error ? error.message : '';
            const code = signal.aborted
                ? 'interrupted'
                : /401|403|not configured|rejected the configured credentials|CARE permissions/i.test(message)
                    ? 'authorization_failed'
                    : /timeout|timed out/i.test(message)
                        ? 'timeout'
                        : /fetch failed|ECONN|network/i.test(message)
                            ? 'source_unavailable'
                            : 'sync_failed';
            db.prepare('UPDATE care_sync_operation SET status=?,finished_at=?,error_code=? WHERE operation_id=?').run(signal.aborted ? 'interrupted' : 'failed', new Date().toISOString(), code, id);
        })
            .finally(() => {
            inFlight = null;
            controller = null;
        });
        return status();
    };
    return {
        status,
        request,
        start() {
            if (timer || stopped)
                return;
            request();
            timer = setInterval(request, 60 * 60 * 1000);
            timer.unref();
        },
        async wait() {
            await inFlight;
        },
        async stop() {
            stopped = true;
            if (timer)
                clearInterval(timer);
            timer = null;
            controller?.abort();
            await inFlight;
        },
    };
}
