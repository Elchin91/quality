function unavailable(config) {
    return {
        state: config === 'ready' ? 'degraded' : 'unavailable',
        checks: {
            config,
            source: 'unavailable',
            calls_auth: 'unavailable',
            recording_endpoint: 'unavailable',
        },
    };
}
async function boundedProbe(probe, parent, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent?.aborted)
        abort();
    else
        parent?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    const aborted = new Promise((resolve) => {
        if (controller.signal.aborted)
            resolve(false);
        else
            controller.signal.addEventListener('abort', () => resolve(false), { once: true });
    });
    const settled = Promise.resolve()
        .then(() => probe(controller.signal))
        .then(() => true, () => false);
    try {
        return (await Promise.race([settled, aborted])) ? 'ready' : 'unavailable';
    }
    finally {
        clearTimeout(timer);
        parent?.removeEventListener('abort', abort);
    }
}
/** Runs only bounded, body-free probes and returns an allowlisted value-only status. */
export function createCallQaReadiness(dependencies) {
    if (typeof dependencies.configured !== 'boolean' ||
        typeof dependencies.probeSource !== 'function' ||
        typeof dependencies.probeCallsAuth !== 'function' ||
        typeof dependencies.probeRecordingEndpoint !== 'function' ||
        !Number.isSafeInteger(dependencies.timeoutMs) ||
        dependencies.timeoutMs < 10 ||
        dependencies.timeoutMs > 30_000) {
        throw new Error('invalid call qa readiness dependencies');
    }
    return Object.freeze({
        async status(signal) {
            if (!dependencies.configured)
                return unavailable('unavailable');
            const [source, callsAuth, recordingEndpoint] = await Promise.all([
                boundedProbe(dependencies.probeSource, signal, dependencies.timeoutMs),
                boundedProbe(dependencies.probeCallsAuth, signal, dependencies.timeoutMs),
                boundedProbe(dependencies.probeRecordingEndpoint, signal, dependencies.timeoutMs),
            ]);
            return {
                state: source === 'ready' && callsAuth === 'ready' && recordingEndpoint === 'ready'
                    ? 'ready'
                    : 'degraded',
                checks: {
                    config: 'ready',
                    source,
                    calls_auth: callsAuth,
                    recording_endpoint: recordingEndpoint,
                },
            };
        },
    });
}
