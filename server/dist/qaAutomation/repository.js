import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseRosterCsv } from './rosterParser.js';
import { MAX_SNAPSHOT_AGE_MS, MAX_UPLOADED_SNAPSHOT_AGE_MS, normalizeRosterName, shiftStartMs, } from './types.js';
function auditSystemLink(db, input) {
    db.prepare(`INSERT INTO qa_roster_system_link_events
       (month,person_key,previous_agent_id,agent_id,action,created_at_ms)
     VALUES (?,?,?,?,?,?)`).run(input.month, input.personKey, input.previousAgentId, input.agentId, input.action, input.nowMs);
}
function removeConflictingSystemLinks(db, input) {
    const links = db
        .prepare(`SELECT month,person_key,agent_id FROM qa_roster_system_links
       WHERE person_key=? OR agent_id=?`)
        .all(input.personKey, input.agentId ?? '');
    for (const link of links) {
        db.prepare('DELETE FROM qa_roster_system_links WHERE month=? AND person_key=?').run(link.month, link.person_key);
        auditSystemLink(db, {
            month: link.month,
            personKey: link.person_key,
            previousAgentId: link.agent_id,
            agentId: null,
            action: 'removed',
            nowMs: input.nowMs,
        });
    }
    return links.length;
}
/** Matches only unique exact names; preserves every admin-confirmed link. */
export function autoLinkRosterPeople(db, month, nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new Error('invalid matching time');
    const work = () => {
        const snapshot = readRosterSnapshot(db, month);
        if (!snapshot)
            throw new Error('roster snapshot unavailable');
        const agents = db.prepare('SELECT id,name FROM agents').all();
        const manual = db.prepare('SELECT person_key,agent_id FROM qa_roster_links').all();
        const blocked = new Set(db.prepare('SELECT person_key FROM qa_roster_manual_blocks').all().map((row) => row.person_key));
        const manualPersons = new Set(manual.map((link) => link.person_key));
        const manualAgents = new Set(manual.map((link) => link.agent_id));
        const peopleByName = new Map();
        for (const person of snapshot.people) {
            const name = normalizeRosterName(person.name);
            peopleByName.set(name, [...(peopleByName.get(name) ?? []), person]);
        }
        const agentsByName = new Map();
        for (const agent of agents) {
            const name = normalizeRosterName(agent.name);
            if (name)
                agentsByName.set(name, [...(agentsByName.get(name) ?? []), agent.id]);
        }
        const desired = new Map();
        let ambiguous = 0;
        for (const [name, people] of peopleByName) {
            const matchingAgents = agentsByName.get(name) ?? [];
            if (people.length !== 1 || matchingAgents.length > 1) {
                ambiguous += people.length;
                continue;
            }
            const person = people[0];
            const agentId = matchingAgents[0];
            if (!agentId ||
                manualPersons.has(person.key) ||
                manualAgents.has(agentId) ||
                blocked.has(person.key))
                continue;
            desired.set(person.key, agentId);
        }
        const existing = db
            .prepare('SELECT person_key,agent_id FROM qa_roster_system_links WHERE month=?')
            .all(month);
        let removed = 0;
        for (const link of existing) {
            if (desired.get(link.person_key) === link.agent_id)
                continue;
            db.prepare('DELETE FROM qa_roster_system_links WHERE month=? AND person_key=?').run(month, link.person_key);
            auditSystemLink(db, {
                month,
                personKey: link.person_key,
                previousAgentId: link.agent_id,
                agentId: null,
                action: 'removed',
                nowMs,
            });
            removed += 1;
        }
        let matched = 0;
        for (const [personKey, agentId] of desired) {
            if (existing.some((link) => link.person_key === personKey && link.agent_id === agentId))
                continue;
            db.prepare(`INSERT INTO qa_roster_system_links (month,person_key,agent_id,matched_at_ms)
         VALUES (?,?,?,?)`).run(month, personKey, agentId, nowMs);
            auditSystemLink(db, {
                month,
                personKey,
                previousAgentId: null,
                agentId,
                action: 'matched',
                nowMs,
            });
            matched += 1;
        }
        return { matched, removed, ambiguous };
    };
    return db.inTransaction ? work() : db.transaction(work).immediate();
}
const storedShiftSchema = z
    .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
})
    .strict();
const storedPersonSchema = z
    .object({
    key: z.string().min(1).max(250),
    sourceId: z.string().max(80).nullable(),
    name: z.string().min(1).max(200),
    channel: z.enum(['chat', 'call', 'mixed']),
    shifts: z.array(storedShiftSchema).max(31),
    invalidShiftDates: z
        .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
        .max(31)
        .default([]),
})
    .strict();
export function saveRosterCsv(db, input) {
    const sourceKind = input.sourceKind ?? 'google';
    if (!/^\d{1,20}$/.test(input.sourceGid))
        throw new Error('invalid roster sheet ID');
    if (!Number.isSafeInteger(input.fetchedAtMs) || input.fetchedAtMs < 0) {
        throw new Error('invalid roster fetch time');
    }
    const people = parseRosterCsv(input.csv, input.month);
    const snapshot = {
        month: input.month,
        sourceGid: input.sourceGid,
        fetchedAtMs: input.fetchedAtMs,
        people,
        sourceKind,
    };
    const hash = createHash('sha256').update(input.csv).digest('hex');
    const work = () => {
        const update = db
            .prepare(`INSERT INTO qa_roster_snapshots
       (month,source_gid,fetched_at_ms,source_sha256,people_json,source_kind)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(month) DO UPDATE SET
       source_gid=excluded.source_gid,
       fetched_at_ms=excluded.fetched_at_ms,
       source_sha256=excluded.source_sha256,
       people_json=excluded.people_json,
       source_kind=excluded.source_kind
     WHERE excluded.fetched_at_ms >= qa_roster_snapshots.fetched_at_ms`)
            .run(input.month, input.sourceGid, input.fetchedAtMs, hash, JSON.stringify(people), sourceKind);
        const effective = update.changes ? snapshot : readRosterSnapshot(db, input.month);
        autoLinkRosterPeople(db, input.month, input.fetchedAtMs);
        return effective;
    };
    return db.inTransaction ? work() : db.transaction(work).immediate();
}
export function readRosterSnapshot(db, month) {
    const row = db
        .prepare(`SELECT month,source_gid,fetched_at_ms,people_json,source_kind
         FROM qa_roster_snapshots WHERE month=?`)
        .get(month);
    if (!row)
        return null;
    const parsed = storedPersonSchema.array().min(1).max(500).safeParse(JSON.parse(row.people_json));
    if (!parsed.success)
        throw new Error('invalid persisted roster');
    const people = parsed.data;
    const keys = new Set();
    for (const person of people) {
        if (keys.has(person.key))
            throw new Error('duplicate persisted roster identity');
        keys.add(person.key);
        for (const shift of person.shifts) {
            if (!shift.date.startsWith(row.month) || shift.startsAt === shift.endsAt) {
                throw new Error('invalid persisted roster shift');
            }
            shiftStartMs(shift);
        }
        if (person.invalidShiftDates.some((date) => !date.startsWith(row.month))) {
            throw new Error('invalid persisted roster issue date');
        }
    }
    return {
        month: row.month,
        sourceGid: row.source_gid,
        fetchedAtMs: row.fetched_at_ms,
        people,
        sourceKind: row.source_kind,
    };
}
export function rosterIsFresh(snapshot, nowMs) {
    return (Number.isSafeInteger(nowMs) &&
        nowMs >= snapshot.fetchedAtMs &&
        nowMs - snapshot.fetchedAtMs <=
            (snapshot.sourceKind === 'upload' ? MAX_UPLOADED_SNAPSHOT_AGE_MS : MAX_SNAPSHOT_AGE_MS));
}
export function getAutomationEnabled(db) {
    const row = db.prepare('SELECT enabled FROM qa_automation_settings WHERE id=1').get();
    return row?.enabled === 1;
}
export function setAutomationEnabled(db, input) {
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
        throw new Error('invalid audit time');
    const admin = db
        .prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1")
        .get(input.adminUserId);
    if (!admin)
        throw new Error('invalid automation settings actor');
    db.prepare(`UPDATE qa_automation_settings SET enabled=?,updated_at_ms=?,updated_by_user_id=? WHERE id=1`).run(input.enabled ? 1 : 0, input.nowMs, input.adminUserId);
}
export function confirmRosterLink(db, input) {
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
        throw new Error('invalid audit time');
    const snapshot = readRosterSnapshot(db, input.month);
    if (!snapshot || !snapshot.people.some((person) => person.key === input.personKey)) {
        throw new Error('roster identity absent from selected month');
    }
    const admin = db
        .prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1")
        .get(input.adminUserId);
    const agent = db.prepare('SELECT 1 FROM agents WHERE id=?').get(input.agentId);
    if (!admin || !agent)
        throw new Error('invalid roster confirmation');
    db.transaction(() => {
        const previous = db
            .prepare('SELECT agent_id FROM qa_roster_links WHERE person_key=?')
            .get(input.personKey);
        removeConflictingSystemLinks(db, {
            personKey: input.personKey,
            agentId: input.agentId,
            nowMs: input.nowMs,
        });
        db.prepare('DELETE FROM qa_roster_manual_blocks WHERE person_key=?').run(input.personKey);
        db.prepare(`INSERT INTO qa_roster_links (person_key,agent_id,confirmed_by_user_id,confirmed_at_ms)
       VALUES (?,?,?,?)
       ON CONFLICT(person_key) DO UPDATE SET
         agent_id=excluded.agent_id,
         confirmed_by_user_id=excluded.confirmed_by_user_id,
         confirmed_at_ms=excluded.confirmed_at_ms`).run(input.personKey, input.agentId, input.adminUserId, input.nowMs);
        db.prepare(`INSERT INTO qa_roster_link_events
       (person_key,previous_agent_id,agent_id,action,actor_user_id,created_at_ms)
       VALUES (?,?,?,'confirm',?,?)`).run(input.personKey, previous?.agent_id ?? null, input.agentId, input.adminUserId, input.nowMs);
    }).immediate();
}
export function removeRosterLink(db, input) {
    if (!input.personKey || input.personKey.length > 250)
        throw new Error('invalid roster person key');
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
        throw new Error('invalid audit time');
    const admin = db
        .prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1")
        .get(input.adminUserId);
    if (!admin)
        throw new Error('invalid roster confirmation actor');
    return db
        .transaction(() => {
        const prior = db
            .prepare('SELECT agent_id FROM qa_roster_links WHERE person_key=?')
            .get(input.personKey);
        const systemRemoved = removeConflictingSystemLinks(db, {
            personKey: input.personKey,
            nowMs: input.nowMs,
        });
        if (!prior && !systemRemoved)
            return false;
        if (prior) {
            db.prepare('DELETE FROM qa_roster_links WHERE person_key=?').run(input.personKey);
            db.prepare(`INSERT INTO qa_roster_link_events
       (person_key,previous_agent_id,agent_id,action,actor_user_id,created_at_ms)
       VALUES (?,?,NULL,'remove',?,?)`).run(input.personKey, prior.agent_id, input.adminUserId, input.nowMs);
        }
        db.prepare(`INSERT INTO qa_roster_manual_blocks (person_key,blocked_by_user_id,blocked_at_ms)
         VALUES (?,?,?) ON CONFLICT(person_key) DO UPDATE SET
           blocked_by_user_id=excluded.blocked_by_user_id,
           blocked_at_ms=excluded.blocked_at_ms`).run(input.personKey, input.adminUserId, input.nowMs);
        return true;
    })
        .immediate();
}
