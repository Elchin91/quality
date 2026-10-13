import { Router } from 'express';
import { z } from 'zod';
import { isIP } from 'node:net';
import { db, setSetting } from '../db.js';
import { listLocalModels, model, ollamaHost } from '../ollama.js';
import { asyncHandler } from '../asyncHandler.js';
export const settingsRouter = Router();
const PUBLIC_SETTING_KEYS = new Set(['ollama_host', 'ollama_model', 'ui_language', 'ui_theme']);
function isPrivateOllamaHost(value) {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || !hostname.includes('.')) {
        return true;
    }
    const ipVersion = isIP(hostname);
    if (ipVersion === 4) {
        const [a, b] = hostname.split('.').map(Number);
        return (a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168));
    }
    if (ipVersion === 6) {
        return (hostname === '::1' ||
            hostname.startsWith('fc') ||
            hostname.startsWith('fd') ||
            hostname.startsWith('fe8'));
    }
    return false;
}
function ollamaHostAllowed(value) {
    return (process.env.NODE_ENV !== 'production' ||
        process.env.ALLOW_EXTERNAL_OLLAMA === 'true' ||
        isPrivateOllamaHost(value));
}
settingsRouter.get('/settings', (_req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const obj = {};
    for (const r of rows) {
        if (PUBLIC_SETTING_KEYS.has(r.key))
            obj[r.key] = r.value;
    }
    obj.ollama_host = ollamaHost();
    obj.ollama_model = model();
    res.json(obj);
});
const updateShape = z
    .object({
    ollama_host: z
        .string()
        .url()
        .refine(ollamaHostAllowed, 'external Ollama host is disabled')
        .optional(),
    ollama_model: z.string().min(1).optional(),
    ui_language: z.enum(['en', 'ru', 'az']).optional(),
    ui_theme: z.enum(['light', 'dark', 'system']).optional(),
})
    .strict();
settingsRouter.put('/settings', (req, res) => {
    const parsed = updateShape.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.message });
    if (process.env.OLLAMA_HOST?.trim() &&
        parsed.data.ollama_host &&
        parsed.data.ollama_host !== ollamaHost())
        return res.status(409).json({ error: 'ollama_host is managed by OLLAMA_HOST' });
    if (process.env.OLLAMA_MODEL?.trim() &&
        parsed.data.ollama_model &&
        parsed.data.ollama_model !== model())
        return res.status(409).json({ error: 'ollama_model is managed by OLLAMA_MODEL' });
    for (const [k, v] of Object.entries(parsed.data)) {
        if (typeof v === 'string')
            setSetting(k, v);
    }
    res.json({ ok: true });
});
settingsRouter.get('/settings/models', asyncHandler(async (_req, res) => {
    try {
        const models = await listLocalModels();
        res.json({ models, current: model(), host: ollamaHost() });
    }
    catch {
        res.json({
            models: [],
            current: model(),
            host: ollamaHost(),
        });
    }
}));
