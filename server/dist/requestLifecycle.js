const requests = new WeakMap();
/** A settled async boundary, rather than a disconnect, proves handler completion. */
export function beginRequestHandler(response) {
    const state = requests.get(response);
    if (!state)
        return () => { };
    state.pending++;
    let settled = false;
    return () => {
        if (settled)
            return;
        settled = true;
        state.pending--;
        state.check();
    };
}
export function observeRequestCompletion(response, complete) {
    let ended = false, completed = false;
    const state = {
        pending: 0,
        check: () => {
            // Static/read-only responses have no application owner. Their transport
            // may close without finish; registered writers must still settle first.
            if (completed || state.pending || !(ended || response.destroyed))
                return;
            completed = true;
            requests.delete(response);
            response.off('finish', finish);
            response.off('close', state.check);
            complete();
        },
    };
    const finish = () => {
        ended = true;
        state.check();
    };
    requests.set(response, state);
    // Ending the response is sufficient for synchronous routes, but registered
    // async handlers keep ownership until their entire promise has settled.
    const end = response.end;
    response.end = ((...args) => {
        try {
            return end.apply(response, args);
        }
        finally {
            finish();
        }
    });
    response.once('finish', finish);
    response.once('close', state.check);
}
