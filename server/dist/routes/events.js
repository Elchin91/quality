import { Router } from 'express';
import { createEventStreamHandler } from '../realtime/appEvents.js';
export function createEventsRouter(db) {
    const router = Router();
    router.get('/events', createEventStreamHandler({ db }));
    return router;
}
