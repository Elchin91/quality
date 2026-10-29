import { getCareSyncCoordinator } from './confluenceIndexSync.js';
import { createCareSyncRouter } from './routes/care-sync.js';
import { closeAppEventStreams, attachAppEventServer } from './realtime/appEvents.js';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { mountPublicAuthRateLimit, userRateLimit } from './rateLimits.js';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, setGlobalDispatcher } from 'undici';
import { dataDirResolution, db, dbPath, uploadsDir } from './db.js';
import { logger } from './logger.js';
// Long-running calls (Ollama JSON gen on a 9B model with a 4-min transcript;
// audio-service /analyze on a 5-min call) easily exceed Node's default 5-min
// fetch headers timeout. Lift it to 30 min so the upstream — not the HTTP
// client — decides when to give up. Individual callers still set their own
// AbortController where it matters.
setGlobalDispatcher(new Agent({
    connectTimeout: 10_000,
    headersTimeout: 30 * 60 * 1000,
    bodyTimeout: 30 * 60 * 1000,
}));
import { chatRouter } from './routes/chat.js';
import { uploadsRouter } from './routes/uploads.js';
import { transcribeRouter } from './routes/transcribe.js';
import { createAsrLabRouter } from './routes/asr-lab.js';
import { scorecardRouter } from './routes/scorecard.js';
import { agentsRouter } from './routes/agents.js';
import { createTeamRouter } from './team/routes.js';
import { analyticsRouter } from './routes/analytics.js';
import { settingsRouter } from './routes/settings.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { createHistoricalEvaluationRouter } from './importM10/historyRoutes.js';
import { adminUsersRouter } from './routes/admin-users.js';
import { appealsRouter } from './routes/appeals.js';
import { notificationsRouter } from './routes/notifications.js';
import { createChatQaAdminRouter } from './routes/chat-qa-admin.js';
import { createChatQaReviewerRouter } from './routes/chat-qa-reviewer.js';
import { createEvaluationAttachmentRouter } from './routes/evaluation-attachments.js';
import { createReviewerDashboardRouter } from './routes/reviewer-dashboard.js';
import { createContactContextRouter } from './routes/contact-context.js';
import { createCallQaPolicyRouter } from './routes/call-qa-policy.js';
import { createChatContextRouter } from './routes/chat-context.js';
import { createQaUnusableRouter } from './routes/qa-unusable.js';
import { createCallQaAdminRouter } from './routes/call-qa-admin.js';
import { createCallQaReviewerRouter } from './routes/call-qa-reviewer.js';
import { requireAdmin, requireAuth, requirePasswordChangeComplete, requireRole } from './auth.js';
import { csrfOriginGuard, parseAllowedOrigins, securityHeaders } from './security.js';
import { checkReadiness, setCallQaReadinessProvider } from './readiness.js';
import { asyncHandler } from './asyncHandler.js';
import { ChatQaRuntime, createShutdownCoordinator } from './chatQa/runtime.js';
import { generateJsonWithMetadata } from './ollama.js';
import { createCallQaRuntime } from './callQa/runtime.js';
import { transcribeCallQaTask } from './callQa/transcription.js';
import { loadRecordingConfig } from './callQa/recordingConfig.js';
import { CallsOmniAttachmentClient } from './chatQa/attachmentClient.js';
import { createChatAttachmentAccess, createGatedAttachmentFetch, } from './chatQa/attachmentAccess.js';
import { chatQaPrivateEvidenceHeaders } from './chatQa/http.js';
import { createEventsRouter } from './routes/events.js';
import { createQaPoliciesRouter } from './routes/qa-policies.js';
import { createQaAutomationRouter } from './routes/qa-automation.js';
import { runQaAutomationCycle } from './jobs/qaAutomationCycle.js';
import { createCallsDirectorySyncer } from './callsDirectory/runtime.js';
import { searchConfluence } from './confluence.js';
import { createComplaintsRuntime } from './complaints/runtime.js';
import { createComplaintsRouter } from './complaints/router.js';
import { createComplaintMediaRouter } from './complaints/media.js';
export const app = express();
const careSync = getCareSyncCoordinator(db);
const callsDirectory = createCallsDirectorySyncer(db, process.env);
export const chatQaRuntime = new ChatQaRuntime({
    db,
    env: process.env,
    automationCycle: async (signal, syncCatalog) => {
        await runQaAutomationCycle({
            db,
            chatSource: () => chatQaRuntime.getOrConnectSource(),
            chatSourceEnabled: chatQaRuntime.getStatus().enabled,
            callCycle: (callSignal, assignEnabled, syncCalls) => callQaRuntime.automation.run(callSignal, assignEnabled, syncCalls),
            syncCatalog,
            signal,
            syncDirectory: (directorySignal) => callsDirectory.sync({ signal: directorySignal }),
        });
    },
});
let chatAttachmentClient = null;
try {
    chatAttachmentClient = new CallsOmniAttachmentClient(loadRecordingConfig(process.env));
}
catch {
    chatAttachmentClient = null;
}
// One gated upstream fetcher: reviewed-chat, evaluation and neighbour-context attachments share it.
const chatAttachmentFetch = createGatedAttachmentFetch(chatAttachmentClient);
export const openChatAttachment = createChatAttachmentAccess({
    db,
    source: () => chatQaRuntime.getOrConnectSource(),
    client: chatAttachmentClient,
    fetchFile: chatAttachmentFetch,
});
export const callQaRuntime = createCallQaRuntime({
    db,
    uploadsRoot: uploadsDir,
    env: process.env,
    transcribe: transcribeCallQaTask,
    generateRefinement: async ({ prompt, system, signal }) => (await generateJsonWithMetadata(prompt, system, {
        signal,
        numCtx: 8192,
        numPredict: 2048,
        temperature: 0,
    })).parsed,
    generateDraft: ({ prompt, system, signal, generation_options }) => generateJsonWithMetadata(prompt, system, { ...generation_options, signal }),
});
setCallQaReadinessProvider(callQaRuntime.status);
export const complaintsRuntime = createComplaintsRuntime({
    db,
    env: process.env,
    chatSource: () => chatQaRuntime.getOrConnectSource(),
    calls: callQaRuntime.complaints,
});
function listenPort(value) {
    if (value === undefined || value.trim() === '')
        return 8787;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error('PORT must be an integer from 0 to 65535');
    }
    return port;
}
const PORT = listenPort(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';
function parseTrustProxy(value) {
    if (!value)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true')
        return true;
    if (normalized === 'false')
        return false;
    const asNumber = Number(normalized);
    return Number.isInteger(asNumber) && asNumber >= 0 ? asNumber : value;
}
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined)
    app.set('trust proxy', trustProxy);
app.use(securityHeaders());
app.use(pinoHttp({
    logger,
    redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.body.password',
        'req.body.current_password',
        'req.body.new_password',
    ],
}));
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ORIGINS);
app.use(cors({
    origin: (origin, cb) => !origin || ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error(`CORS: origin ${origin} not allowed`)),
    credentials: true,
}));
const generalLimiter = userRateLimit(1800, 15 * 60_000);
const aiLimiter = userRateLimit(20, 15 * 60_000);
const uploadLimiter = userRateLimit(30, 60 * 60_000);
const callQaRateLimitHandler = (_req, res) => {
    res.status(429).json({ error: 'rate_limited', code: 'rate_limited' });
};
const callQaPrepareLimiter = rateLimit({
    windowMs: 60 * 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: callQaRateLimitHandler,
    keyGenerator: (req) => `user:${req.user.id}`,
});
const callQaTranscriptionLimiter = rateLimit({
    windowMs: 60 * 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: callQaRateLimitHandler,
    keyGenerator: (req) => `user:${req.user.id}`,
});
const callQaAiLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: callQaRateLimitHandler,
    keyGenerator: (req) => `user:${req.user.id}`,
});
// Chat review auto-loads every image/video/audio (plus adjacent conversations), so the
// per-user budget is generous; upstream stays protected by the 3-concurrent fetch gate.
const chatAttachmentLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    handler: callQaRateLimitHandler,
    keyGenerator: (req) => `user:${req.user.id}`,
});
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/qa/tasks/:id', chatQaPrivateEvidenceHeaders);
app.use('/api', csrfOriginGuard(ALLOWED_ORIGINS));
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/ready', asyncHandler(async (_req, res) => {
    const readiness = await checkReadiness();
    res.status(readiness.ok ? 200 : 503).json({ ...readiness, ts: Date.now() });
}));
// Public auth endpoints (login/register have their own stricter limiter).
mountPublicAuthRateLimit(app);
app.use('/api', authRouter);
// Everything below requires a valid session.
app.use('/api', requireAuth);
app.use('/api', generalLimiter);
app.use('/api', requirePasswordChangeComplete);
app.use('/api/scorecard/evaluate', aiLimiter);
app.use('/api/chat', aiLimiter);
app.use('/api/transcribe', aiLimiter);
app.use('/api/uploads', uploadLimiter);
app.use('/api', createEventsRouter(db));
app.use('/api', createQaPoliciesRouter(db));
app.use('/api', createQaAutomationRouter(db, { directory: callsDirectory }));
app.use('/api', createReviewerDashboardRouter({ db }));
app.use('/api', createContactContextRouter({ db }));
app.use('/api', createCallQaPolicyRouter({ db }));
app.use('/api', createQaUnusableRouter({ db }));
app.use('/api', createComplaintMediaRouter(db, uploadsDir));
app.use('/api', createComplaintsRouter(complaintsRuntime.routerOptions));
app.use('/api', createChatContextRouter({
    db,
    source: () => chatQaRuntime.getOrConnectSource(),
    fetchAttachment: chatAttachmentFetch,
    attachmentLimiter: chatAttachmentLimiter,
}));
// Agent-scoped portal.
app.use('/api', meRouter);
app.use('/api', createHistoricalEvaluationRouter(db));
app.use('/api', appealsRouter);
app.use('/api', createEvaluationAttachmentRouter({
    openAttachment: openChatAttachment,
    limiter: chatAttachmentLimiter,
    database: db,
}));
app.use('/api', notificationsRouter);
app.use('/api', createChatQaAdminRouter({ db, runtime: chatQaRuntime }));
app.use('/api', createChatQaReviewerRouter({
    db,
    aiDraftLimiter: aiLimiter,
    attachmentLimiter: chatAttachmentLimiter,
    openAttachment: openChatAttachment,
    generateDraft: ({ prompt, system, signal, generation_options }) => generateJsonWithMetadata(prompt, system, { ...generation_options, signal }),
    searchFaq: searchConfluence,
}));
app.use('/api', createCallQaAdminRouter({
    dependencies: callQaRuntime.admin,
    prepareLimiter: callQaPrepareLimiter,
}));
app.use('/api', createCallQaReviewerRouter({
    dependencies: callQaRuntime.reviewer,
    transcriptionLimiter: callQaTranscriptionLimiter,
    aiLimiter: callQaAiLimiter,
}));
// Admin user management.
app.use('/api', adminUsersRouter);
app.use('/api', createTeamRouter(db));
// Admin-only surfaces. The scorecard router internally scopes mutations/comments
// to admins; analytics/settings/agents/uploads/transcribe remain admin-only.
app.use('/api', createCareSyncRouter(careSync));
app.use('/api', requireRole('admin', 'reviewer'), chatRouter);
app.use('/api', requireAdmin, uploadsRouter);
app.use('/api', requireAdmin, transcribeRouter);
app.use('/api', createAsrLabRouter(process.env.ASR_LAB_DIR?.trim() ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.runtime', 'asr-pilot-localdoc-20261005')));
app.use('/api', requireAdmin, scorecardRouter);
app.use('/api', requireAdmin, agentsRouter);
app.use('/api', requireAdmin, analyticsRouter);
app.use('/api', requireAdmin, settingsRouter);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(moduleDir, '..', '..', 'dist');
// Vite fingerprints /assets/*, so they can be cached for a year; the HTML shell always revalidates.
app.use(express.static(distDir, {
    setHeaders(res, file) {
        res.setHeader('Cache-Control', file.startsWith(path.join(distDir, 'assets') + path.sep)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache');
    },
}));
app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
        if (err)
            res.status(404).send('Frontend not built. Run `npm run build` or use `npm run dev`.');
    });
});
// Catch unhandled errors thrown by route handlers so Express doesn't silently
// swallow them or crash the process on a single bad request.
app.use((err, _req, res, _next) => {
    logger.error({ err }, 'Unhandled route error');
    const isDev = process.env.NODE_ENV !== 'production';
    const msg = isDev && err instanceof Error ? err.message : 'internal server error';
    if (!res.headersSent)
        res.status(500).json({ error: msg });
});
const tlsCertificatePath = process.env.TLS_CERT?.trim();
const tlsPrivateKeyPath = process.env.TLS_KEY?.trim();
if (Boolean(tlsCertificatePath) !== Boolean(tlsPrivateKeyPath)) {
    throw new Error('TLS_CERT and TLS_KEY must be provided together');
}
export const server = tlsCertificatePath && tlsPrivateKeyPath
    ? createHttpsServer({
        cert: readFileSync(tlsCertificatePath),
        key: readFileSync(tlsPrivateKeyPath),
        minVersion: 'TLSv1.2',
    }, app).listen(PORT, HOST)
    : createHttpServer(app).listen(PORT, HOST);
attachAppEventServer(server);
const closeResources = createShutdownCoordinator({
    runtime: {
        close: async () => {
            await careSync.stop();
            await complaintsRuntime.close();
            await callQaRuntime.close();
            await chatQaRuntime.close();
        },
    },
    closeServer: async () => {
        const closed = new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
        await Promise.all([closed, closeAppEventStreams()]);
    },
    closeDatabase: () => db.close(),
});
function handleStartupError(error) {
    const message = error.code === 'EADDRINUSE'
        ? `AgentScore API cannot start because ${HOST}:${PORT} is already in use`
        : 'AgentScore API failed to start';
    logger.error({ err: error, host: HOST, port: PORT }, message);
    try {
        db.close();
    }
    catch (closeError) {
        logger.error({ err: closeError }, 'Database close after startup failure failed');
    }
    process.exitCode = 1;
}
server.once('error', handleStartupError);
server.once('listening', () => {
    server.off('error', handleStartupError);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : PORT;
    logger.info({
        host: HOST,
        port,
        dbPath,
        dataDirSource: dataDirResolution.source,
    }, 'AgentScore backend listening');
    careSync.start();
    complaintsRuntime.start();
    void chatQaRuntime.start().catch((error) => {
        logger.error({ err: error }, 'Chat QA runtime failed to start');
    });
});
function shutdown(signal) {
    logger.info({ signal }, 'Shutting down AgentScore backend');
    void closeResources()
        .catch((error) => {
        logger.error({ err: error }, 'AgentScore shutdown failed');
        process.exitCode = 1;
    })
        .finally(() => {
        process.exit();
    });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
