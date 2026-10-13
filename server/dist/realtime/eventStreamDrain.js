import { observeRequestCompletion } from '../requestLifecycle.js';
/** Track admitted handlers separately from socket lifetime: a disconnect is not writer completion. */
export class EventStreamDrain {
    closing = false;
    server;
    streams = new Map();
    owned = new Set();
    requests = new Map();
    attach(server) {
        if (this.server)
            throw new Error('event drain already attached');
        this.server = server;
        server.prependListener('request', (_request, response) => {
            let resolve;
            const done = new Promise((complete) => {
                resolve = complete;
            });
            this.requests.set(response, { socket: response.socket, done });
            observeRequestCompletion(response, () => {
                this.requests.delete(response);
                resolve();
                if (this.closing)
                    setImmediate(() => this.server?.closeIdleConnections());
            });
        });
    }
    track(response, close) {
        this.owned.add(response);
        if (this.closing) {
            close();
            return () => {
                this.owned.delete(response);
            };
        }
        this.streams.set(response, close);
        return () => {
            this.streams.delete(response);
            this.owned.delete(response);
        };
    }
    writers(socket) {
        return [...this.requests]
            .filter(([response, request]) => !this.owned.has(response) && (socket === undefined || request.socket === socket))
            .map(([, request]) => request.done);
    }
    async waitForWriters() {
        while (this.writers().length)
            await Promise.all(this.writers());
    }
    async close() {
        this.closing = true;
        const responses = [...this.streams].map(([response, close]) => new Promise((resolve) => {
            let done = false;
            const socket = response.socket;
            const finish = () => {
                if (done)
                    return;
                done = true;
                clearInterval(timer);
                response.off('finish', finish);
                response.off('close', finish);
                setImmediate(() => this.server?.closeIdleConnections());
                resolve();
            };
            const started = Date.now();
            const timer = setInterval(() => {
                // Never sever a pipelined socket while any ordinary handler still owns it.
                // Without pre-request tracking, allow only Node's safe idle closure.
                if (Date.now() - started >= 1000 && this.server && this.writers(socket).length === 0) {
                    response.destroy();
                    socket?.destroy();
                    finish();
                }
            }, 50);
            timer.unref();
            response.once('finish', finish);
            response.once('close', finish);
            close();
            if (response.writableFinished || response.destroyed)
                finish();
        }));
        await Promise.all([...responses, this.waitForWriters()]);
        await new Promise((resolve) => setImmediate(() => {
            this.server?.closeIdleConnections();
            resolve();
        }));
    }
}
