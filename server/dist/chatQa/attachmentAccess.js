import { randomUUID } from 'node:crypto';
import { ChatAttachmentError, } from './attachmentClient.js';
import { safeTranscript } from './http.js';
import { CHAT_EVIDENCE_HASH_VERSION, attachmentLocatorForTranscriptIndex, legacyConversationContentHash, normalizeConversation, } from './normalize.js';
import { persistedConversationEvidence } from './sourceEvidenceStore.js';
import { effectiveTranscriptJson } from './retention.js';
import { evaluationAttachmentTask } from './evaluationAttachmentAuthorization.js';
function actor(input) {
    return input.userId ?? input.reviewerUserId;
}
export class ChatAttachmentAccessError extends Error {
    code;
    httpStatus;
    constructor(code, httpStatus) {
        super(code);
        this.code = code;
        this.httpStatus = httpStatus;
        this.name = 'ChatAttachmentAccessError';
    }
}
class AttachmentFetchGate {
    #maximum;
    #active = 0;
    #waiting = [];
    constructor(maximum) {
        this.#maximum = Math.max(1, Math.min(maximum, 8));
    }
    acquire(signal) {
        if (signal.aborted)
            return Promise.reject(new Error('attachment_fetch_aborted'));
        if (this.#active < this.#maximum) {
            this.#active += 1;
            return Promise.resolve(this.releaseOnce());
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                signal,
                resolve,
                reject,
                abort: () => {
                    const index = this.#waiting.indexOf(waiter);
                    if (index >= 0)
                        this.#waiting.splice(index, 1);
                    reject(new Error('attachment_fetch_aborted'));
                },
            };
            signal.addEventListener('abort', waiter.abort, { once: true });
            this.#waiting.push(waiter);
        });
    }
    releaseOnce() {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.#active -= 1;
            while (this.#waiting.length > 0) {
                const waiter = this.#waiting.shift();
                waiter.signal.removeEventListener('abort', waiter.abort);
                if (waiter.signal.aborted)
                    continue;
                this.#active += 1;
                waiter.resolve(this.releaseOnce());
                break;
            }
        };
    }
}
function fail(code, httpStatus) {
    throw new ChatAttachmentAccessError(code, httpStatus);
}
function authorizedContext(db, input, now) {
    const evaluationAccess = input.evaluationId !== undefined;
    const taskId = evaluationAccess
        ? evaluationAttachmentTask(db, input.evaluationId, actor(input))
        : input.taskId;
    if (!taskId)
        return null;
    const row = db
        .prepare(`SELECT tasks.interaction_id AS interactionId,interactions.conversation_id AS conversationId,
        interactions.content_hash AS contentHash,
        interactions.content_hash_version AS contentHashVersion,
        interactions.transcript_json AS transcriptJson
       FROM chat_qa_tasks tasks
       JOIN source_interactions interactions ON interactions.id=tasks.interaction_id
       WHERE tasks.id=? AND (?=1 OR tasks.reviewer_user_id=?) AND tasks.status<>'cancelled'
         AND EXISTS (SELECT 1 FROM users WHERE id=? AND active=1 AND must_change_password=0)`)
        .get(taskId, evaluationAccess ? 1 : 0, actor(input), actor(input));
    if (!row ||
        typeof row.interactionId !== 'string' ||
        typeof row.conversationId !== 'string' ||
        typeof row.contentHash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(row.contentHash) ||
        (row.contentHashVersion !== 1 && row.contentHashVersion !== CHAT_EVIDENCE_HASH_VERSION) ||
        typeof row.transcriptJson !== 'string' ||
        effectiveTranscriptJson(db, taskId, now) === null)
        return null;
    return {
        taskId,
        interactionId: row.interactionId,
        conversationId: row.conversationId,
        contentHash: row.contentHash,
        contentHashVersion: row.contentHashVersion,
        transcriptJson: row.transcriptJson,
    };
}
function sameContext(left, right) {
    return Boolean(right &&
        left.taskId === right.taskId &&
        left.interactionId === right.interactionId &&
        left.conversationId === right.conversationId &&
        left.contentHash === right.contentHash &&
        left.contentHashVersion === right.contentHashVersion);
}
function upgradeLegacyBinding(dependencies, input, expected, nextHash) {
    const now = dependencies.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now))
        return null;
    return dependencies.db.transaction(() => {
        const current = authorizedContext(dependencies.db, input, now);
        if (current?.interactionId === expected.interactionId &&
            current.conversationId === expected.conversationId &&
            current.contentHash === nextHash &&
            current.contentHashVersion === CHAT_EVIDENCE_HASH_VERSION)
            return current;
        if (!sameContext(expected, current))
            return null;
        const changed = dependencies.db
            .prepare(`UPDATE source_interactions SET content_hash=?,content_hash_version=?
         WHERE id=? AND content_hash=? AND content_hash_version=1`)
            .run(nextHash, CHAT_EVIDENCE_HASH_VERSION, expected.interactionId, expected.contentHash).changes;
        if (changed === 1) {
            dependencies.db
                .prepare(`INSERT INTO chat_qa_events
           (id,task_id,actor_user_id,event_type,reason,metadata_json,created_at)
           VALUES (?,?,?,?,?,?,?)`)
                .run(dependencies.createId?.() ?? randomUUID(), expected.taskId, actor(input), 'attachment_evidence_rebound', 'Legacy attachment evidence bound to the current server-only locator', JSON.stringify({ from_hash_version: 1, to_hash_version: CHAT_EVIDENCE_HASH_VERSION }), now);
        }
        const upgraded = authorizedContext(dependencies.db, input, now);
        return upgraded?.contentHash === nextHash &&
            upgraded.contentHashVersion === CHAT_EVIDENCE_HASH_VERSION
            ? upgraded
            : null;
    })();
}
export function createChatAttachmentAccess(dependencies) {
    const fetchGate = new AttachmentFetchGate(dependencies.maxConcurrentFetches ?? 3);
    return async (input) => {
        const accessNow = dependencies.now?.() ?? Date.now();
        let initial = authorizedContext(dependencies.db, input, accessNow);
        if (!initial)
            return fail('not_found', 404);
        const retained = safeTranscript(initial.transcriptJson);
        const retainedEntry = retained?.[input.transcriptIndex];
        if (!retainedEntry || retainedEntry.kind !== 'attachment')
            return fail('not_found', 404);
        const source = await dependencies.source();
        if (!source || !dependencies.client)
            return fail('source_unavailable', 503);
        const evidence = persistedConversationEvidence(dependencies.db, initial.interactionId, initial.conversationId);
        if (!evidence)
            return fail('source_unavailable', 503);
        let loaded;
        try {
            loaded = await source.loadConversation(evidence);
        }
        catch {
            return fail('source_unavailable', 503);
        }
        const normalized = normalizeConversation(loaded);
        if (initial.contentHashVersion === 1) {
            if (legacyConversationContentHash(loaded) !== initial.contentHash)
                return fail('source_unavailable', 503);
            const upgraded = upgradeLegacyBinding(dependencies, input, initial, normalized.contentHash);
            if (!upgraded)
                return fail('source_unavailable', 503);
            initial = upgraded;
        }
        else if (normalized.contentHash !== initial.contentHash) {
            return fail('source_unavailable', 503);
        }
        const locator = attachmentLocatorForTranscriptIndex(loaded, input.transcriptIndex);
        if (!locator)
            return fail('attachment_unavailable', 404);
        let media;
        let release = null;
        try {
            release = await fetchGate.acquire(input.signal);
            media = await dependencies.client.getFile(locator, input.signal);
        }
        catch (error) {
            release?.();
            if (error instanceof ChatAttachmentError && error.code === 'attachment_unavailable')
                return fail('attachment_unavailable', 404);
            return fail('source_unavailable', 503);
        }
        let current;
        try {
            current = authorizedContext(dependencies.db, input, dependencies.now?.() ?? Date.now());
        }
        catch {
            release();
            return fail('source_unavailable', 503);
        }
        if (!sameContext(initial, current)) {
            release();
            return fail('not_found', 404);
        }
        return { ...media, release };
    };
}
