import pino from 'pino';
export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
        paths: [
            'req.body.password',
            'req.body.new_password',
            'req.body.current_password',
            'req.headers.cookie',
            'req.headers.authorization',
            '*.password',
            '*.password_hash',
        ],
        censor: '[REDACTED]',
    },
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
});
