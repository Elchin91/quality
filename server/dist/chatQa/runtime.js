import { scheduleDurableChatQaJobs } from '../jobs/maintenance.js';
import { createChatSourceClient } from './sourceClient.js';
import { loadChatSourceConfig } from './sourceConfig.js';
import { safeSourceDiagnostic, sourceDiagnosticFromError, SourceDiagnosticError, } from './sourceDiagnostics.js';
// Health probes serve interactive requests as well as scheduler recovery. Driver
// timeouts do not cover a stalled pool close or every network operation.
async function sourceDeadline(work, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            work,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new SourceDiagnosticError('source_query_timeout')), timeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
async function releaseSource(source) {
    try {
        await sourceDeadline(source.close(), 2_000);
    }
    catch {
        // Observe late rejections, but never hold recovery on driver cleanup.
    }
}
export class ChatQaRuntime {
    dependencies;
    status = { enabled: false, state: 'disabled' };
    source = null;
    sourceConfig = null;
    sourcePromise = null;
    scheduler = null;
    startPromise = null;
    closePromise = null;
    closing = false;
    refreshPromise = null;
    refreshStatus() {
        this.refreshPromise ??= this.checkStatus().finally(() => {
            this.refreshPromise = null;
        });
        return this.refreshPromise;
    }
    async checkStatus() {
        if (this.closing)
            return this.status;
        if (this.status.state !== 'ready' || !this.source) {
            await this.resolveSource();
            return this.status;
        }
        const candidate = this.source;
        try {
            const health = await sourceDeadline(candidate.preflight(), 20_000);
            if (this.closing || this.source !== candidate)
                return this.status;
            if (!health.ok)
                throw new SourceDiagnosticError(safeSourceDiagnostic(health.errorCode));
            this.status = {
                enabled: true,
                state: 'ready',
                health: {
                    request_join_rate: health.requestJoinRate,
                    conversation_join_rate: health.conversationJoinRate,
                },
            };
        }
        catch (error) {
            if (!this.closing && this.source === candidate) {
                this.source = null;
                this.status = {
                    enabled: true,
                    state: 'unavailable',
                    error_code: sourceDiagnosticFromError(error, 'source_preflight_failed'),
                };
            }
            await releaseSource(candidate);
        }
        return this.status;
    }
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    getStatus() {
        return this.status;
    }
    getSource() {
        return this.status.state === 'ready' ? this.source : null;
    }
    getOrConnectSource() {
        return this.resolveSource();
    }
    start() {
        if (!this.startPromise)
            this.startPromise = this.startOnce();
        return this.startPromise;
    }
    async startOnce() {
        let config;
        try {
            config = (this.dependencies.loadConfig ?? loadChatSourceConfig)(this.dependencies.env);
        }
        catch {
            this.status = { enabled: true, state: 'unavailable', error_code: 'invalid_configuration' };
            config = null;
        }
        this.sourceConfig = config;
        if (!config && this.status.state !== 'unavailable') {
            this.status = { enabled: false, state: 'disabled' };
        }
        try {
            this.scheduler = (this.dependencies.schedule ?? scheduleDurableChatQaJobs)({
                db: this.dependencies.db,
                source: () => this.resolveSource(),
                sourceEnabled: Boolean(config),
                automationCycle: this.dependencies.automationCycle,
            });
        }
        catch {
            this.status = { enabled: true, state: 'unavailable', error_code: 'source_unavailable' };
            return;
        }
        if (config)
            await this.resolveSource();
    }
    resolveSource() {
        if (this.status.state === 'ready' && this.source)
            return Promise.resolve(this.source);
        if (this.closing || !this.sourceConfig)
            return Promise.resolve(null);
        if (this.sourcePromise)
            return this.sourcePromise;
        this.sourcePromise = this.connectSource(this.sourceConfig).finally(() => {
            this.sourcePromise = null;
        });
        return this.sourcePromise;
    }
    async connectSource(config) {
        this.status = { enabled: true, state: 'starting' };
        let candidate = null;
        let failure = 'source_unavailable';
        try {
            candidate = (this.dependencies.createSource ?? createChatSourceClient)(config);
            const health = await sourceDeadline(candidate.preflight(), 20_000);
            if (!health.ok)
                failure = safeSourceDiagnostic(health.errorCode);
            if (!health.ok || this.closing)
                throw new Error('source unavailable');
            this.source = candidate;
            this.status = {
                enabled: true,
                state: 'ready',
                health: {
                    request_join_rate: health.requestJoinRate,
                    conversation_join_rate: health.conversationJoinRate,
                },
            };
            return candidate;
        }
        catch (error) {
            if (error instanceof SourceDiagnosticError)
                failure = error.code;
            if (this.source === candidate)
                this.source = null;
            if (!this.closing) {
                this.status = { enabled: true, state: 'unavailable', error_code: failure };
            }
            if (candidate)
                await releaseSource(candidate);
            return null;
        }
    }
    close() {
        if (!this.closePromise)
            this.closePromise = this.closeOnce();
        return this.closePromise;
    }
    async closeOnce() {
        await this.start();
        this.closing = true;
        let firstError = null;
        try {
            if (this.scheduler)
                await this.scheduler.close();
        }
        catch (error) {
            firstError = error;
        }
        try {
            if (this.source)
                await sourceDeadline(this.source.close(), 2_000);
        }
        catch (error) {
            firstError ??= error;
        }
        this.scheduler = null;
        this.source = null;
        this.sourceConfig = null;
        if (firstError)
            throw firstError;
    }
}
export function createShutdownCoordinator(input) {
    let shutdown = null;
    return () => {
        shutdown ??= (async () => {
            let firstError = null;
            try {
                await input.runtime.close();
            }
            catch (error) {
                firstError = error;
            }
            try {
                await input.closeServer();
            }
            catch (error) {
                firstError ??= error;
            }
            try {
                input.closeDatabase();
            }
            catch (error) {
                firstError ??= error;
            }
            if (firstError)
                throw firstError;
        })();
        return shutdown;
    };
}
