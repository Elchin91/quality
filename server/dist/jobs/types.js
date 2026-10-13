import { z } from 'zod';
export const JOB_TYPES = ['chat_sla_scan', 'chat_retention_purge', 'chat_scheduled_cycle'];
const emptyOptions = z.object({}).strict();
const scheduledOptions = z
    .object({
    trigger: z.enum(['scheduled', 'manual']).optional(),
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
};
