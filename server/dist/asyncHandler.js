import { beginRequestHandler } from './requestLifecycle.js';
/** Forward rejected route promises to Express 4 error middleware. */
export function asyncHandler(handler) {
    return (req, res, next) => {
        const complete = beginRequestHandler(res);
        try {
            void handler(req, res, next).catch(next).finally(complete);
        }
        catch (error) {
            try {
                next(error);
            }
            finally {
                complete();
            }
        }
    };
}
/** Own callback middleware until cleanup finishes and next has admitted its successor. */
export function callbackHandler(handler) {
    return (req, res, next) => {
        const complete = beginRequestHandler(res);
        const done = (error) => {
            try {
                next(error);
            }
            finally {
                complete();
            }
        };
        try {
            handler(req, res, done);
        }
        catch (error) {
            done(error);
        }
    };
}
