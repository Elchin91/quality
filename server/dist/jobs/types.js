import { z } from 'zod';
export const JOB_TYPES = [
    'chat_sla_scan',
    'chat_retention_purge',
    'chat_scheduled_cycle',
    'complaint_sync',
    'complaint_discovery',
];
const emptyOptions = z.object({}).strict();
const scheduledOptions = z
    .object({
    trigger: z.enum(['scheduled', 'manual']).optional(),
    sync_catalog: z.boolean().optional(),
    sync_operation_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,200}$/u)
        .optional(),
})
    .strict()
    .refine((value) => !value.sync_operation_id || value.trigger === 'manual');
export const JOB_PAYLOAD_SCHEMAS = {
    chat_sla_scan: emptyOptions,
    chat_retention_purge: emptyOptions,
    chat_scheduled_cycle: scheduledOptions,
    complaint_sync: emptyOptions,
    complaint_discovery: z
        .object({
        complaint_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
        actor_user_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        default_window: z.boolean().optional(),
        phone: z
            .string()
            .regex(/^\d{10,15}$/u)
            .optional(),
    })
        .strict(),
};
