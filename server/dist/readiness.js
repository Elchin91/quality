import { probeAudioService } from './audioService.js';
import { listLocalModels, model } from './ollama.js';
const unavailableCallQa = () => ({
    state: 'unavailable',
    checks: {
        config: 'unavailable',
        source: 'unavailable',
        calls_auth: 'unavailable',
        recording_endpoint: 'unavailable',
    },
});
let callQaStatusProvider = () => unavailableCallQa();
export function setCallQaReadinessProvider(provider) {
    callQaStatusProvider = provider;
}
const defaultDependencies = {
    probeAudioService,
    listLocalModels,
    selectedModel: model,
    callQaStatus: (signal) => callQaStatusProvider(signal),
};
const READINESS_TIMEOUT_MS = 5_000;
function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('readiness dependency timed out')), timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
async function boundedCallQaStatus(provider, timeoutMs) {
    if (!provider)
        return unavailableCallQa();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const aborted = new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
    const operation = Promise.resolve()
        .then(() => provider(controller.signal))
        .catch(() => null);
    try {
        const raw = await Promise.race([operation, aborted]);
        if (!raw)
            return unavailableCallQa();
        if (typeof raw !== 'object')
            return unavailableCallQa();
        const candidate = raw;
        const state = candidate.state;
        const checks = candidate.checks;
        const allowed = (value) => value === 'ready' || value === 'unavailable';
        if (typeof state !== 'string' ||
            !['ready', 'degraded', 'unavailable'].includes(state) ||
            !checks ||
            !allowed(checks.config) ||
            !allowed(checks.source) ||
            !allowed(checks.calls_auth) ||
            !allowed(checks.recording_endpoint)) {
            return unavailableCallQa();
        }
        return {
            state: state,
            checks: {
                config: checks.config,
                source: checks.source,
                calls_auth: checks.calls_auth,
                recording_endpoint: checks.recording_endpoint,
            },
        };
    }
    catch {
        return unavailableCallQa();
    }
    finally {
        clearTimeout(timer);
    }
}
export async function checkReadiness(dependencies = defaultDependencies, timeoutMs = READINESS_TIMEOUT_MS) {
    const selectedModel = dependencies.selectedModel();
    const [audioResult, modelsResult, callQaResult] = await Promise.allSettled([
        withTimeout(dependencies.probeAudioService(), timeoutMs),
        withTimeout(dependencies.listLocalModels(), timeoutMs),
        boundedCallQaStatus(dependencies.callQaStatus, timeoutMs),
    ]);
    const audio = audioResult.status === 'fulfilled' ? audioResult.value : null;
    const models = modelsResult.status === 'fulfilled' ? modelsResult.value : [];
    const audioReady = audio?.ok === true && audio.asr?.state === 'ready' && audio.asr.tooling_ready === true;
    const ollamaReady = models.includes(selectedModel);
    const callQa = callQaResult.status === 'fulfilled' ? callQaResult.value : unavailableCallQa();
    return {
        ok: audioReady && ollamaReady,
        dependencies: {
            audio: audioReady
                ? {
                    ok: true,
                    model: audio.model,
                    degraded: audio.degraded,
                    ...(audio.diarization ? { diarization: audio.diarization } : {}),
                }
                : { ok: false },
            ollama: { ok: ollamaReady, model: selectedModel },
            call_qa: { ok: callQa.state === 'ready', ...callQa },
        },
    };
}
