import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u);
const critical = z
    .object({
    amounts: z.array(z.string().trim().min(1).max(200)).max(100),
    names: z.array(z.string().trim().min(1).max(200)).max(100),
    negations: z.array(z.string().trim().min(1).max(200)).max(100),
})
    .strict();
const reference = z
    .object({
    text: z.string().trim().max(20_000),
    category: z
        .string()
        .trim()
        .min(1)
        .max(80)
        // eslint-disable-next-line no-control-regex -- reject control characters at the input boundary
        .regex(/^[^\u0000-\u001F\u007F]+$/u),
    reviewed: z.boolean(),
    critical,
    critical_forbidden: critical.optional(),
})
    .strict()
    .refine((value) => !value.reviewed ||
    (value.category !== 'unreviewed' && (!!value.text || value.category === 'unintelligible')));
const emptyCritical = () => ({ amounts: [], names: [], negations: [] });
const manifest = z
    .object({
    version: z.literal(1),
    language: z.literal('az'),
    entries: z
        .array(z
        .object({
        id,
        call_id: id,
        split: z.string().min(1).max(40),
        start: z.number().finite().nonnegative(),
        duration: z.number().finite().positive().max(30),
    })
        .passthrough())
        .max(1_000),
})
    .passthrough();
function validId(value) {
    const result = id.safeParse(value);
    return result.success ? result.data : null;
}
async function loadManifest(root) {
    try {
        return manifest.parse(JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')));
    }
    catch {
        return null;
    }
}
async function readReference(root, clipId) {
    try {
        const raw = JSON.parse(await fs.readFile(path.join(root, 'reference', `${clipId}.json`), 'utf8'));
        const parsed = reference.safeParse(raw);
        return parsed.success
            ? { ...parsed.data, critical_forbidden: parsed.data.critical_forbidden ?? emptyCritical() }
            : null;
    }
    catch {
        return null;
    }
}
async function baselinePredictions(root) {
    try {
        const file = JSON.parse(await fs.readFile(path.join(root, 'predictions', 'localdoc-loudnorm-baseline.json'), 'utf8'));
        return Object.fromEntries(Object.entries(file.predictions ?? {}).filter(([key, value]) => validId(key) && typeof value === 'string' && value.length <= 20_000));
    }
    catch {
        return {};
    }
}
/** Local reference lab: never reveal source file paths from the manifest. */
export function createAsrLabRouter(root) {
    const router = Router();
    router.use('/asr-lab', requireAdmin);
    router.get('/asr-lab/clips', asyncHandler(async (_req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        const data = await loadManifest(root);
        if (!data)
            return res.status(503).json({ error: 'asr_lab_unavailable' });
        const predictions = await baselinePredictions(root);
        const entries = await Promise.all(data.entries.map(async (entry) => ({
            id: entry.id,
            call_id: entry.call_id,
            split: entry.split,
            start: entry.start,
            duration: entry.duration,
            raw_text: predictions[entry.id] ?? null,
            suggested_text: null,
            uncertain_intervals: [],
            reference: await readReference(root, entry.id),
        })));
        res.json({ version: 1, language: 'az', entries });
    }));
    router.get('/asr-lab/clips/:id/audio', asyncHandler(async (req, res) => {
        const clipId = validId(req.params.id);
        if (!clipId)
            return res.status(400).json({ error: 'invalid_input' });
        const data = await loadManifest(root);
        if (!data?.entries.some((entry) => entry.id === clipId))
            return res.status(404).json({ error: 'not_found' });
        const clipsRoot = await fs.realpath(path.join(root, 'clips')).catch(() => null);
        const file = await fs.realpath(path.join(root, 'clips', `${clipId}.wav`)).catch(() => null);
        if (!clipsRoot || !file || path.dirname(file) !== clipsRoot)
            return res.status(404).json({ error: 'not_found' });
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.type('audio/wav');
        res.sendFile(file, (error) => {
            if (error && !res.headersSent)
                res.status(404).json({ error: 'not_found' });
        });
    }));
    router.put('/asr-lab/clips/:id/reference', asyncHandler(async (req, res) => {
        const clipId = validId(req.params.id);
        const parsed = reference.safeParse(req.body);
        if (!clipId || !parsed.success)
            return res.status(400).json({ error: 'invalid_input' });
        const data = await loadManifest(root);
        if (!data?.entries.some((entry) => entry.id === clipId))
            return res.status(404).json({ error: 'not_found' });
        const referenceRoot = await fs.realpath(path.join(root, 'reference')).catch(() => null);
        if (!referenceRoot ||
            path.dirname(referenceRoot) !== (await fs.realpath(root).catch(() => null)))
            return res.status(503).json({ error: 'asr_lab_unavailable' });
        const previous = await readReference(root, clipId);
        const value = {
            ...parsed.data,
            critical_forbidden: parsed.data.critical_forbidden ?? previous?.critical_forbidden ?? emptyCritical(),
        };
        const target = path.join(referenceRoot, `${clipId}.json`);
        const temporary = path.join(referenceRoot, `.${clipId}.${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
                mode: 0o600,
                flag: 'wx',
            });
            await fs.rename(temporary, target);
        }
        finally {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
        }
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ reference: value });
    }));
    return router;
}
