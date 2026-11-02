import { nextBakuNine } from '../chatQa/scheduler.js';
import { dailyDeliveries } from './dailyRepository.js';
import { rosterReadiness } from './rosterReadiness.js';
export function automationDailyStatus(db, month, now) {
    const deliveries = dailyDeliveries(db);
    const latest = deliveries.at(-1)?.review_date;
    const day = latest ? deliveries.filter((row) => row.review_date === latest) : [];
    const complete = day.length === 2 && day.every((row) => row.source_completed_at !== null);
    const times = day
        .map((row) => row.source_completed_at)
        .filter((time) => time !== null);
    return {
        daily_deliveries: deliveries,
        next_run_at: nextBakuNine(new Date(now)).getTime(),
        roster_status: rosterReadiness(db, new Date(now + 4 * 3_600_000).toISOString().slice(0, 7), now),
        full_sync_verified: complete,
        has_daily_history: day.length > 0,
        activated: Boolean(db.prepare('SELECT 1 FROM qa_daily_schedule WHERE id=1').get()),
        full_sync: day.length && !(!complete && day.every((row) => row.status === 'delivered'))
            ? {
                status: complete
                    ? 'succeeded'
                    : day.some((row) => row.status === 'retry')
                        ? 'failed'
                        : 'running',
                error_code: complete ? null : (day.find((row) => row.error_code)?.error_code ?? null),
                started_at: db
                    .prepare('SELECT MIN(created_at) FROM qa_daily_deliveries WHERE review_date=?')
                    .pluck()
                    .get(latest),
                completed_at: complete ? Math.max(...times) : null,
            }
            : null,
    };
}
