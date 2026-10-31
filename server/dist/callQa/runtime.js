import { getCallQaReviewSource, rejectCallQaAiDraft, saveCallQaTranscriptCorrections, } from './aiDraft.js';
import { createCallQaAutomation } from './automation.js';
import { refineCallQaTask } from './refinement.js';
import path from 'node:path';
import { createSecretKey } from 'node:crypto';
import { loadChatSourceConfig } from '../chatQa/sourceConfig.js';
import { listCallCatalog } from './catalog.js';
import { createMongoCallSourceAdapter } from './mongoSource.js';
import { createMysqlCallSourceAdapter } from './mysqlSource.js';
import { createHttpCallSourceAdapter } from './httpSource.js';
import { appendCallQaOperationalEvent } from './operationalEvents.js';
import { createFfprobeRecordingProbe } from './recordingProbe.js';
import { openAdminCallRecording, openReviewerCallRecording, openReadyRecordingFile, } from './recordingAccess.js';
import { CallsRecordingClient } from './recordingClient.js';
import { loadRecordingConfig } from './recordingConfig.js';
import { CallsChatHttpTransport } from '../chatQa/httpTransport.js';
import { httpContactContextFetcher, } from '../contactContext/context.js';
import { createCallQaReadiness } from './readiness.js';
import { CallRecordingStore } from './recordingStore.js';
import { CallRecordingCache, recordingCacheSettings } from './recordingCache.js';
import { getReviewerCallQaTask, listReviewerCallQaTasks } from './queries.js';
import { createComplaintCallDiscovery } from '../complaints/callSource.js';
import { assignCallQaTask, CallQaServiceError, cancelCallQaTask, completeCallQaTask, generateCallQaAiDraft, startCallQaTask, } from './service.js';
import { callSourceConfigFromChatSource } from './sourceConfig.js';
import { syncCallCatalog } from './sync.js';
function loadState(options) {
    let recordingConfig = null;
    try {
        recordingConfig = loadRecordingConfig(options.env);
    }
    catch {
        recordingConfig = null;
    }
    let normalizationProtection = options.normalizationProtection ?? null;
    let configuredSource = null;
    if (!normalizationProtection) {
        try {
            // CALL_SOURCE_BACKEND=http reads calls from the Calls search API, like HTTP chats;
            // otherwise the call catalog keeps its own database source.
            const callsOverHttp = options.env.CALL_SOURCE_BACKEND?.trim() === 'http';
            const chat = loadChatSourceConfig(callsOverHttp
                ? { ...options.env, CHAT_SOURCE_BACKEND: 'http' }
                : options.env.CHAT_SOURCE_BACKEND?.trim() === 'http'
                    ? { ...options.env, CHAT_SOURCE_BACKEND: options.env.CALL_SOURCE_BACKEND || 'mysql' }
                    : options.env);
            if (chat) {
                normalizationProtection = {
                    externalAgentIdHmacKey: createSecretKey(chat.samplingHmacSecret),
                };
                if (chat.backend === 'http') {
                    if (!chat.http)
                        throw new Error('invalid call source configuration');
                    configuredSource = createHttpCallSourceAdapter(chat.http, chat.httpCatalog);
                }
                else {
                    const sourceConfig = callSourceConfigFromChatSource(chat);
                    configuredSource =
                        chat.backend === 'mysql'
                            ? createMysqlCallSourceAdapter(sourceConfig)
                            : createMongoCallSourceAdapter(sourceConfig);
                }
            }
        }
        catch {
            normalizationProtection = null;
            configuredSource = null;
        }
    }
    const configuredProbe = options.env.FFPROBE_PATH?.trim();
    const configuredFfmpeg = options.env.FFMPEG_PATH?.trim();
    const probeExecutable = configuredProbe ||
        (configuredFfmpeg && path.basename(configuredFfmpeg).startsWith('ffmpeg')
            ? path.join(path.dirname(configuredFfmpeg), path.basename(configuredFfmpeg).replace(/^ffmpeg/u, 'ffprobe'))
            : 'ffprobe');
    return {
        recordingConfig,
        normalizationProtection,
        source: options.source ?? configuredSource,
        probeExecutable,
    };
}
function serviceUnavailable(code) {
    if (code === 'transcript_unavailable')
        throw new CallQaServiceError(code, 404);
    throw new Error('call qa source unavailable');
}
function requireAdmin(db, actorUserId) {
    const row = db
        .prepare(`SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1 AND must_change_password=0`)
        .get(actorUserId);
    if (!row)
        throw new CallQaServiceError('not_found', 404);
}
function adminSourceDetail(db, actorUserId, sourceRecordId) {
    requireAdmin(db, actorUserId);
    const row = listCallCatalog(db, { page: 1, pageSize: 1, sourceRecordId }).items[0];
    if (!row)
        throw new CallQaServiceError('not_found', 404);
    return row;
}
function locator(value) {
    if (value.startsWith('call-url:'))
        return { kind: 'call_url', value };
    if (value.startsWith('omnichannel:'))
        return { kind: 'omnichannel_id', value };
    throw new CallQaServiceError('recording_not_ready', 409);
}
function bakuWindow(from, to) {
    const start = new Date(`${from}T00:00:00+04:00`);
    const end = new Date(new Date(`${to}T00:00:00+04:00`).getTime() + 86_400_000);
    return { start, end };
}
function taskSource(db, taskId, reviewerUserId) {
    const row = db
        .prepare(`SELECT source_record_id FROM call_qa_tasks WHERE id=? AND reviewer_user_id=?`)
        .get(taskId, reviewerUserId);
    return row?.source_record_id ?? null;
}
/** Composes pure/domain services once from server-only configuration and injected I/O boundaries. */
export function createCallQaRuntime(options) {
    const state = loadState(options);
    const source = state.source;
    const recordingClient = state.recordingConfig
        ? new CallsRecordingClient(state.recordingConfig)
        : null;
    const complaintCalls = createComplaintCallDiscovery({
        db: options.db,
        env: options.env,
        normalizationProtection: options.normalizationProtection,
    });
    let recordingStore = null;
    if (state.recordingConfig) {
        try {
            recordingStore = new CallRecordingStore({
                db: options.db,
                uploadsRoot: options.uploadsRoot,
                maxBytes: state.recordingConfig.maxBytes,
                operationTimeoutMs: state.recordingConfig.timeoutMs,
                probe: createFfprobeRecordingProbe({
                    executable: state.probeExecutable,
                    timeoutMs: 15_000,
                }),
            });
        }
        catch {
            recordingStore = null;
        }
    }
    const maxReadyBytes = state.recordingConfig?.maxBytes ?? 104_857_600;
    const cache = recordingClient && recordingStore
        ? new CallRecordingCache({
            db: options.db,
            uploadsRoot: options.uploadsRoot,
            maxFileBytes: maxReadyBytes,
            ...recordingCacheSettings(options.env),
            getRecording: (locator, signal) => recordingClient.getRecording(locator, signal),
            store: recordingStore,
            probe: createFfprobeRecordingProbe({
                executable: state.probeExecutable,
                timeoutMs: 15_000,
            }),
        })
        : null;
    cache?.start();
    const configured = Boolean(source && state.normalizationProtection && recordingClient && recordingStore);
    const failedProbe = async () => {
        throw new Error('call qa dependency unavailable');
    };
    const probes = options.readinessProbes;
    const readiness = createCallQaReadiness({
        configured,
        probeSource: probes?.source ?? source?.probe?.bind(source) ?? failedProbe,
        probeCallsAuth: probes?.callsAuth ?? recordingClient?.probeAuth.bind(recordingClient) ?? failedProbe,
        probeRecordingEndpoint: probes?.recordingEndpoint ??
            recordingClient?.probeRecordingEndpoint.bind(recordingClient) ??
            failedProbe,
        timeoutMs: Math.min(state.recordingConfig?.timeoutMs ?? 5_000, 10_000),
    });
    const status = readiness.status;
    let contactContext;
    try {
        contactContext = state.recordingConfig
            ? httpContactContextFetcher(new CallsChatHttpTransport(state.recordingConfig))
            : undefined;
    }
    catch {
        contactContext = undefined;
    }
    const automation = createCallQaAutomation({
        db: options.db,
        source,
        normalizationProtection: state.normalizationProtection,
        recordingClient,
        recordingStore,
        prepareRecording: cache ? (id, signal) => cache.prepare(id, signal) : undefined,
        contactContext,
    });
    const admin = {
        health: async ({ actorUserId }) => {
            requireAdmin(options.db, actorUserId);
            return status();
        },
        sync: async ({ actorUserId, from, to, pageSize, signal, correlationId }) => {
            requireAdmin(options.db, actorUserId);
            try {
                if (!source || !state.normalizationProtection)
                    return serviceUnavailable('source_unavailable');
                const result = await syncCallCatalog({
                    db: options.db,
                    source,
                    normalizationProtection: state.normalizationProtection,
                    window: bakuWindow(from, to),
                    bakuDateFrom: from,
                    bakuDateTo: to,
                    pageSize,
                    signal,
                    clock: () => new Date(),
                });
                appendCallQaOperationalEvent({
                    db: options.db,
                    actorUserId,
                    actorRole: 'admin',
                    eventType: 'sync_succeeded',
                    batchSubject: 'catalog_sync',
                    correlationId,
                });
                return result;
            }
            catch (error) {
                appendCallQaOperationalEvent({
                    db: options.db,
                    actorUserId,
                    actorRole: 'admin',
                    eventType: 'sync_failed',
                    batchSubject: 'catalog_sync',
                    correlationId,
                    code: 'source_unavailable',
                });
                throw error;
            }
        },
        listSources: async ({ actorUserId, ...query }) => {
            requireAdmin(options.db, actorUserId);
            return listCallCatalog(options.db, query);
        },
        getSource: async ({ actorUserId, sourceRecordId }) => adminSourceDetail(options.db, actorUserId, sourceRecordId),
        prepareRecording: async ({ actorUserId, sourceRecordId, signal, idempotencyKey }) => {
            requireAdmin(options.db, actorUserId);
            const row = options.db
                .prepare('SELECT recording_locator FROM call_source_records WHERE id=?')
                .get(sourceRecordId);
            if (!row)
                throw new CallQaServiceError('not_found', 404);
            try {
                if (!recordingClient || !recordingStore)
                    return serviceUnavailable('source_unavailable');
                const result = cache
                    ? await cache.prepare(sourceRecordId, signal)
                    : await recordingStore.store({
                        sourceRecordId,
                        response: (await recordingClient.getRecording(locator(row.recording_locator), signal))
                            .response,
                        signal,
                    });
                appendCallQaOperationalEvent({
                    db: options.db,
                    actorUserId,
                    actorRole: 'admin',
                    eventType: 'preparation_succeeded',
                    sourceRecordId,
                    idempotencyKey,
                });
                return result;
            }
            catch (error) {
                appendCallQaOperationalEvent({
                    db: options.db,
                    actorUserId,
                    actorRole: 'admin',
                    eventType: 'preparation_failed',
                    sourceRecordId,
                    idempotencyKey,
                    code: 'recording_failed',
                });
                throw error;
            }
        },
        openRecording: async ({ sourceRecordId, ...input }) => openAdminCallRecording({
            db: options.db,
            uploadsRoot: options.uploadsRoot,
            sourceRecordId,
            maxReadyBytes,
            ...input,
            ...(cache && input.method !== 'HEAD' ? { openReadyFile: cache.open } : {}),
        }),
        assign: async (input) => assignCallQaTask({ db: options.db, ...input }),
        cancel: async (input) => cancelCallQaTask({ db: options.db, ...input }),
    };
    const reviewer = {
        listTasks: async (input) => listReviewerCallQaTasks(options.db, input),
        getTask: async (input) => getReviewerCallQaTask(options.db, input),
        start: async (input) => {
            startCallQaTask({ db: options.db, ...input });
            return getReviewerCallQaTask(options.db, {
                taskId: input.taskId,
                reviewerUserId: input.reviewerUserId,
            });
        },
        openRecording: async ({ taskId, ...input }) => openReviewerCallRecording({
            db: options.db,
            uploadsRoot: options.uploadsRoot,
            taskId,
            maxReadyBytes,
            ...input,
            ...(cache && input.method !== 'HEAD' ? { openReadyFile: cache.open } : {}),
        }),
        rejectDraft: async ({ taskId, reviewerUserId, aiReview, reason }) => rejectCallQaAiDraft(options.db, taskId, reviewerUserId, aiReview, reason),
        reviewSource: async ({ taskId, reviewerUserId }) => getCallQaReviewSource(options.db, taskId, reviewerUserId),
        refine: async (input) => {
            if (!options.generateRefinement)
                throw new CallQaServiceError('ai_generation_failed', 503);
            return refineCallQaTask({ db: options.db, ...input, generate: options.generateRefinement });
        },
        saveTranscriptCorrections: async ({ taskId, reviewerUserId, sourceRevision, corrections }) => saveCallQaTranscriptCorrections({
            db: options.db,
            taskId,
            reviewerUserId,
            sourceRevision,
            corrections,
        }),
        transcribe: async ({ taskId, reviewerUserId, signal, correlationId, qualityProfile }) => {
            const sourceRecordId = taskSource(options.db, taskId, reviewerUserId);
            try {
                if (!options.transcribe)
                    return serviceUnavailable('transcript_unavailable');
                const result = await options.transcribe({
                    db: options.db,
                    uploadsRoot: options.uploadsRoot,
                    taskId,
                    reviewerUserId,
                    signal,
                    qualityProfile,
                    ...(cache ? { openReadyFile: cache.open } : {}),
                });
                if (sourceRecordId)
                    appendCallQaOperationalEvent({
                        db: options.db,
                        actorUserId: reviewerUserId,
                        actorRole: 'reviewer',
                        eventType: 'transcription_succeeded',
                        taskId,
                        sourceRecordId,
                        correlationId,
                    });
                return result;
            }
            catch (error) {
                if (sourceRecordId)
                    appendCallQaOperationalEvent({
                        db: options.db,
                        actorUserId: reviewerUserId,
                        actorRole: 'reviewer',
                        eventType: 'transcription_failed',
                        taskId,
                        sourceRecordId,
                        correlationId,
                        code: 'transcript_unavailable',
                    });
                throw error;
            }
        },
        draft: async ({ taskId, reviewerUserId, signal, correlationId }) => {
            const sourceRecordId = taskSource(options.db, taskId, reviewerUserId);
            try {
                if (!options.generateDraft)
                    throw new CallQaServiceError('ai_generation_failed', 503);
                const result = await generateCallQaAiDraft({
                    db: options.db,
                    taskId,
                    reviewerUserId,
                    signal,
                    generateDraft: (input) => options.generateDraft({ ...input, signal }),
                });
                if (sourceRecordId)
                    appendCallQaOperationalEvent({
                        db: options.db,
                        actorUserId: reviewerUserId,
                        actorRole: 'reviewer',
                        eventType: 'draft_succeeded',
                        taskId,
                        sourceRecordId,
                        correlationId,
                    });
                return result;
            }
            catch (error) {
                if (sourceRecordId)
                    appendCallQaOperationalEvent({
                        db: options.db,
                        actorUserId: reviewerUserId,
                        actorRole: 'reviewer',
                        eventType: 'draft_failed',
                        taskId,
                        sourceRecordId,
                        correlationId,
                        code: 'ai_failed',
                    });
                throw error;
            }
        },
        complete: async (input) => completeCallQaTask({ db: options.db, ...input }),
    };
    return {
        admin,
        reviewer,
        status,
        automation,
        openReadyRecording: cache?.open ?? openReadyRecordingFile,
        complaints: {
            discover: complaintCalls.discover,
            prepare: async (sourceId, signal) => {
                const row = options.db
                    .prepare('SELECT recording_locator FROM call_source_records WHERE id=?')
                    .get(sourceId);
                if (!row)
                    throw new CallQaServiceError('not_found', 404);
                if (cache) {
                    await cache.prepare(sourceId, signal);
                    return;
                }
                if (!recordingStore || !recordingClient)
                    throw new Error('recording_not_ready');
                await recordingStore.store({
                    sourceRecordId: sourceId,
                    response: (await recordingClient.getRecording(locator(row.recording_locator), signal))
                        .response,
                    signal,
                });
            },
        },
        close: async () => {
            complaintCalls.close();
            await cache?.close();
        },
    };
}
