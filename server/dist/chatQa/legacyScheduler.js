import { nextBakuNine, runChatQaCycle } from './scheduler.js';
const nowFrom = (clock) => clock();
export function scheduleChatQaJobs(input) {
    const clock = input.clock ?? (() => new Date());
    const setTimeoutFn = input.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay));
    const clearTimeoutFn = input.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    let timer = null;
    let active = null;
    let cycleError = null;
    let closed = false;
    let sourceClosed = false;
    const schedule = () => {
        if (closed)
            return;
        const delay = nextBakuNine(nowFrom(clock)).getTime() - nowFrom(clock).getTime();
        timer = setTimeoutFn(() => {
            timer = null;
            cycleError = null;
            active = (input.runCycle
                ? input.runCycle()
                : runChatQaCycle({ db: input.db, source: input.source, clock }))
                .catch((error) => {
                cycleError = error;
            })
                .finally(() => {
                active = null;
                schedule();
            });
        }, delay);
    };
    schedule();
    return {
        async close() {
            if (!closed) {
                closed = true;
                if (timer !== null)
                    clearTimeoutFn(timer);
                timer = null;
            }
            if (active)
                await active;
            let closeError = null;
            if (!sourceClosed) {
                sourceClosed = true;
                try {
                    await input.source.close();
                }
                catch (error) {
                    closeError = error;
                }
            }
            if (cycleError)
                throw cycleError;
            if (closeError)
                throw closeError;
        },
    };
}
