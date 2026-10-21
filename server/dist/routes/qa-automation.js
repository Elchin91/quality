import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { asyncHandler } from '../asyncHandler.js';
import { requireRole } from '../auth.js';
import { DurableJobRepository } from '../jobs/repository.js';
import { refreshCurrentRoster, rosterErrorCode } from '../qaAutomation/googleSheets.js';
import { listRosterQuota, quotaFor } from '../qaAutomation/quota.js';
import { confirmRosterLink, getAutomationEnabled, readRosterSnapshot, removeRosterLink, saveRosterCsv, setAutomationEnabled, } from '../qaAutomation/repository.js';
import { bakuMonth, UPLOADED_ROSTER_GID } from '../qaAutomation/types.js';
import { previousBakuDay } from '../qaAutomation/reviewWindow.js';
import { listReviewerReadiness } from '../reviewerAssignment/repository.js';
import { SOURCE_DIAGNOSTICS } from '../chatQa/sourceDiagnostics.js';
import { lastDirectorySync } from '../callsDirectory/sync.js';
import { callDirectionSql } from '../callsDirectory/groups.js';
const linkBody = z.object({ agent_id: z.string().min(1).max(128) }).strict();
const settingBody = z.object({ enabled: z.boolean() }).strict();
const personKey = z.string().min(1).max(250);
const uploadBody = z
    .object({
    csv: z.string().min(1).max(5_000_000),
    month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .optional(),
})
    .strict();
/** The review month, the current month, or the next one (uploaded ahead of time). */
function uploadableMonths(now) {
    const current = bakuMonth(now);
    const [year, month] = current.split('-').map(Number);
    const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
    return [...new Set([previousBakuDay(now).date.slice(0, 7), current, next])];
}
function lastChannelSync(db) {
    const chat = db
        .prepare(`SELECT status,started_at,completed_at,error_code FROM chat_sync_runs
     WHERE mode='apply' ORDER BY started_at DESC,rowid DESC LIMIT 1`)
        .get();
    const hasCallEvents = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='call_qa_events'")
        .get();
    const call = hasCallEvents
        ? db
            .prepare(`SELECT event_type,created_at_utc FROM call_qa_events
     WHERE event_type IN ('sync_succeeded','sync_failed') ORDER BY created_at_utc DESC,rowid DESC LIMIT 1`)
            .get()
        : undefined;
    return {
        chat: chat
            ? {
                ...chat,
                error_code: chat.error_code === null
                    ? null
                    : Object.hasOwn(SOURCE_DIAGNOSTICS, chat.error_code) ||
                        chat.error_code === 'partial_source_data'
                        ? chat.error_code
                        : 'source_catalog_failed',
            }
            : null,
        call: call
            ? {
                status: call.event_type === 'sync_succeeded' ? 'succeeded' : 'failed',
                started_at: Date.parse(call.created_at_utc),
                // Operational events store the cycle start, not its completion time.
                completed_at: null,
                error_code: call.event_type === 'sync_succeeded' ? null : 'source_unavailable',
            }
            : null,
    };
}
export function createQaAutomationRouter(db, options = {}) {
    const router = Router();
    router.use(['/admin/chat-qa/automation', '/admin/call-qa/automation'], requireRole('admin'));
    for (const base of ['/admin/chat-qa/automation', '/admin/call-qa/automation']) {
        router.get([`${base}/status`, `${base}/preview`], (_req, res) => {
            const now = Date.now();
            const bounds = previousBakuDay(now);
            const month = bounds.date.slice(0, 7);
            const snapshot = readRosterSnapshot(db, month);
            const setting = db
                .prepare('SELECT enabled,updated_at_ms FROM qa_automation_settings WHERE id=1')
                .get();
            const quota = listRosterQuota(db, now);
            const reviewerOpenCap = db.prepare('SELECT reviewer_open_cap FROM chat_sampling_policy WHERE id=1').get().reviewer_open_cap;
            const reviewerReadiness = listReviewerReadiness(db, reviewerOpenCap);
            const hasReviewer = reviewerReadiness.some((item) => item.ready);
            const channel = base.includes('chat-qa') ? 'chat' : 'call';
            const operators = quota.map((item) => {
                const chat = item.agentId
                    ? db
                        .prepare(`SELECT COUNT(*) count FROM source_interactions source
                   WHERE source.agent_id=? AND source.eligibility_state='eligible'
                     AND source.completed_at_utc>=? AND source.completed_at_utc<?
                     AND NOT EXISTS(SELECT 1 FROM chat_qa_tasks task
                       WHERE task.interaction_id=source.id AND task.status<>'cancelled')`)
                        .get(item.agentId, bounds.start, bounds.end).count
                    : 0;
                const call = item.agentId
                    ? db
                        .prepare(`SELECT COUNT(*) count FROM call_source_records source
                   WHERE source.agent_id=? AND source.eligibility_status='eligible'
                     AND source.baku_date=? AND ${callDirectionSql(db, 'source')}
                     AND NOT EXISTS(SELECT 1 FROM call_qa_tasks task
                       WHERE task.source_record_id=source.id AND task.status<>'cancelled')`)
                        .get(item.agentId, bounds.date).count
                    : 0;
                const channelQuota = item.agentId ? quotaFor(db, item.agentId, now, channel) : item;
                const shortfallReason = item.reason !== 'ready'
                    ? item.reason
                    : channelQuota.reason !== 'ready'
                        ? channelQuota.reason
                        : !hasReviewer
                            ? 'no_reviewer'
                            : channel === 'chat' && chat === 0
                                ? 'no_chat_material'
                                : channel === 'call' && call === 0
                                    ? 'no_call_material'
                                    : item.channel === 'mixed' && chat + call === 0
                                        ? 'no_material'
                                        : null;
                return {
                    ...item,
                    available_chat: chat,
                    available_call: call,
                    shortfall_reason: shortfallReason,
                    channel_remaining: channelQuota.remaining,
                    channel_fallback: channelQuota.channelFallback ?? false,
                };
            });
            const lastJob = db
                .prepare(`SELECT status,error_code,started_at,completed_at FROM durable_jobs
           WHERE type='chat_scheduled_cycle' ORDER BY created_at DESC,id DESC LIMIT 1`)
                .get();
            res.json({
                enabled: getAutomationEnabled(db),
                updated_at_ms: setting.updated_at_ms,
                month,
                target: operators.length * 20,
                completed: operators.reduce((sum, item) => sum + item.completed, 0),
                open: operators.reduce((sum, item) => sum + item.open, 0),
                due: operators.reduce((sum, item) => sum + item.due, 0),
                shortfall: operators.reduce((sum, item) => sum + item.remaining, 0),
                roster: snapshot
                    ? {
                        source_gid: snapshot.sourceGid,
                        fetched_at_ms: snapshot.fetchedAtMs,
                        source_kind: snapshot.sourceKind ?? 'google',
                    }
                    : null,
                operators,
                agent_choices: db.prepare('SELECT id,name FROM agents ORDER BY name,id').all(),
                last_job: lastJob ?? null,
                directory: lastDirectorySync(db),
                last_channel_sync: lastChannelSync(db),
                reviewers: {
                    total: reviewerReadiness.length,
                    ready: reviewerReadiness.filter((item) => item.ready).length,
                    blocked: Object.fromEntries(['inactive', 'password', 'unavailable'].map((reason) => [
                        reason,
                        reviewerReadiness.filter((item) => item.reason === reason).length,
                    ])),
                },
            });
        });
        router.post(`${base}/refresh-roster`, asyncHandler(async (_req, res) => {
            try {
                const snapshot = await refreshCurrentRoster(db);
                res.json({ month: snapshot.month, fetched_at_ms: snapshot.fetchedAtMs });
            }
            catch (error) {
                res.status(503).json({ error: rosterErrorCode(error) });
            }
        }));
        // For servers without internet access: a month tab downloaded from Google Sheets as CSV.
        router.post(`${base}/upload-roster`, (req, res) => {
            const parsed = uploadBody.safeParse(req.body ?? {});
            if (!parsed.success)
                return res.status(400).json({ error: 'invalid_input' });
            const now = Date.now();
            const month = parsed.data.month ?? previousBakuDay(now).date.slice(0, 7);
            if (!uploadableMonths(now).includes(month))
                return res.status(400).json({ error: 'roster_month_unavailable' });
            try {
                const snapshot = saveRosterCsv(db, {
                    month,
                    sourceGid: UPLOADED_ROSTER_GID,
                    fetchedAtMs: now,
                    csv: parsed.data.csv.replace(/^\uFEFF/u, ''),
                    sourceKind: 'upload',
                });
                res.json({
                    month: snapshot.month,
                    fetched_at_ms: snapshot.fetchedAtMs,
                    people: snapshot.people.length,
                    source_kind: 'upload',
                });
            }
            catch {
                res.status(422).json({ error: 'roster_schema_invalid' });
            }
        });
        router.post(`${base}/directory/sync`, asyncHandler(async (req, res) => {
            if (!options.directory)
                return res.status(503).json({ error: 'directory_unconfigured' });
            const outcome = await options.directory.sync({ actorUserId: req.user.id, force: true });
            if (outcome.status !== 'synced')
                return res.status(503).json({ error: `directory_${outcome.status}` });
            res.json({
                telesales: outcome.summary.telesales,
                provisioned: outcome.summary.provisioned,
                issues: outcome.summary.issues,
            });
        }));
        router.post(`${base}/run`, (req, res) => {
            const parsed = z
                .object({})
                .strict()
                .safeParse(req.body ?? {});
            if (!parsed.success)
                return res.status(400).json({ error: 'invalid_input' });
            const now = Date.now();
            const job = new DurableJobRepository(db).enqueue({
                type: 'chat_scheduled_cycle',
                payload: { trigger: 'manual' },
                idempotencyKey: `qa-manual-${nanoid(16)}`,
                now,
            });
            res.status(202).json({ job_id: job.id, status: job.status });
        });
        router.put(`${base}/enabled`, (req, res) => {
            const parsed = settingBody.safeParse(req.body);
            if (!parsed.success)
                return res.status(400).json({ error: 'invalid_input' });
            const now = Date.now();
            db.transaction(() => {
                const wasEnabled = getAutomationEnabled(db);
                setAutomationEnabled(db, {
                    enabled: parsed.data.enabled,
                    adminUserId: req.user.id,
                    nowMs: now,
                });
                if (!wasEnabled && parsed.data.enabled)
                    new DurableJobRepository(db).enqueue({
                        type: 'chat_scheduled_cycle',
                        payload: { trigger: 'manual', sync_catalog: false },
                        idempotencyKey: `qa-enabled-${nanoid(16)}`,
                        now,
                    });
            })();
            return res.json({ enabled: parsed.data.enabled, updated_at_ms: now });
        });
        router.put(`${base}/links/:personKey`, (req, res) => {
            const key = personKey.safeParse(req.params.personKey);
            const body = linkBody.safeParse(req.body);
            if (!key.success || !body.success)
                return res.status(400).json({ error: 'invalid_input' });
            try {
                confirmRosterLink(db, {
                    month: previousBakuDay(Date.now()).date.slice(0, 7),
                    personKey: key.data,
                    agentId: body.data.agent_id,
                    adminUserId: req.user.id,
                    nowMs: Date.now(),
                });
                return res.json({ person_key: key.data, agent_id: body.data.agent_id });
            }
            catch {
                return res.status(409).json({ error: 'mapping_conflict' });
            }
        });
        router.delete(`${base}/links/:personKey`, (req, res) => {
            const key = personKey.safeParse(req.params.personKey);
            if (!key.success)
                return res.status(400).json({ error: 'invalid_input' });
            return res.json({
                removed: removeRosterLink(db, {
                    personKey: key.data,
                    adminUserId: req.user.id,
                    nowMs: Date.now(),
                }),
            });
        });
    }
    return router;
}
