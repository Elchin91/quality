import { z } from 'zod';
export const QA_POLICY_TYPES = ['sampling', 'escalation', 'reassignment'];
export const samplingPolicySchema = z
    .object({
    enabled: z.boolean(),
    min_client_messages: z.number().int().min(1).max(1_000),
    min_agent_messages: z.number().int().min(1).max(1_000),
    monthly_target: z.number().int().min(1).max(100),
    monthly_cap: z.number().int().min(1).max(100),
    reviewer_open_cap: z.number().int().min(1).max(100),
    sla_days: z.number().int().min(1).max(30),
    retention_days: z.number().int().min(1).max(3_650),
    overlap_days: z.number().int().min(1).max(31),
    timezone: z.literal('Asia/Baku'),
})
    .strict()
    .refine((value) => value.monthly_target <= value.monthly_cap);
export const escalationPolicySchema = z
    .object({
    enabled: z.boolean(),
    overdue_after_hours: z.number().int().min(1).max(720),
    priority: z.enum(['normal', 'high']),
})
    .strict();
export const reassignmentPolicySchema = z
    .object({
    enabled: z.boolean(),
    stale_after_hours: z.number().int().min(1).max(720),
    max_open_tasks: z.number().int().min(1).max(100),
})
    .strict();
export const QA_POLICY_SCHEMAS = {
    sampling: samplingPolicySchema,
    escalation: escalationPolicySchema,
    reassignment: reassignmentPolicySchema,
};
