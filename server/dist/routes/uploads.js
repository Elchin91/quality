import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import { db, uploadsDir } from '../db.js';
import { isTranscriptionInFlight } from '../transcriptionState.js';
import { asyncHandler, callbackHandler } from '../asyncHandler.js';
const execFileAsync = promisify(execFile);
class UploadPolicyError extends Error {
}
const ALLOWED_MIME = new Set([
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/mp4',
    'audio/ogg',
    'audio/aac',
    'audio/webm',
    'audio/flac',
    'audio/x-flac',
    'audio/x-m4a',
    'text/plain',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const id = nanoid(12);
        const ext = path.extname(file.originalname) || '';
        cb(null, `${id}${ext}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype))
            return cb(null, true);
        cb(new UploadPolicyError(`Unsupported file type: ${file.mimetype}`));
    },
});
function startsWith(buf, bytes) {
    return bytes.every((byte, index) => buf[index] === byte);
}
function hasMp4Ftyp(buf) {
    return buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp';
}
function isAudioMime(mime) {
    return mime.startsWith('audio/');
}
function ffprobePath() {
    if (process.env.FFPROBE_PATH)
        return process.env.FFPROBE_PATH;
    const ffmpeg = process.env.FFMPEG_PATH;
    if (ffmpeg && path.basename(ffmpeg).startsWith('ffmpeg')) {
        return path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/^ffmpeg/, 'ffprobe'));
    }
    return 'ffprobe';
}
async function isValidAudioFile(filePath) {
    try {
        const { stdout } = await execFileAsync(ffprobePath(), [
            '-v',
            'error',
            '-select_streams',
            'a:0',
            '-show_entries',
            'stream=codec_type',
            '-of',
            'default=nw=1:nk=1',
            filePath,
        ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
        return stdout.split(/\s+/).includes('audio');
    }
    catch {
        return false;
    }
}
function isLikelyUtf8Text(buf) {
    if (!buf.length)
        return true;
    const sample = buf.toString('utf8');
    if (sample.includes('\uFFFD'))
        return false;
    let printable = 0;
    for (const ch of sample) {
        const code = ch.charCodeAt(0);
        if (ch === '\n' || ch === '\r' || ch === '\t' || code >= 32)
            printable += 1;
    }
    return printable / sample.length > 0.95;
}
async function validateUploadedContent(filePath, mime) {
    if (isAudioMime(mime) && (await isValidAudioFile(filePath)))
        return true;
    const fd = await fs.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(4100);
        const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
        const sample = buf.subarray(0, bytesRead);
        switch (mime) {
            case 'audio/mpeg':
            case 'audio/mp3':
                return (startsWith(sample, [0x49, 0x44, 0x33]) ||
                    (sample[0] === 0xff && (sample[1] & 0xe0) === 0xe0));
            case 'audio/wav':
                return (sample.toString('ascii', 0, 4) === 'RIFF' && sample.toString('ascii', 8, 12) === 'WAVE');
            case 'audio/mp4':
            case 'audio/x-m4a':
                return hasMp4Ftyp(sample);
            case 'audio/ogg':
                return startsWith(sample, [0x4f, 0x67, 0x67, 0x53]);
            case 'audio/aac':
                return sample[0] === 0xff && (sample[1] === 0xf1 || sample[1] === 0xf9);
            case 'audio/webm':
                return startsWith(sample, [0x1a, 0x45, 0xdf, 0xa3]);
            case 'audio/flac':
            case 'audio/x-flac':
                return startsWith(sample, [0x66, 0x4c, 0x61, 0x43]);
            case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                return startsWith(sample, [0x50, 0x4b, 0x03, 0x04]);
            case 'text/plain':
            case 'text/csv':
                return isLikelyUtf8Text(sample);
            default:
                return false;
        }
    }
    finally {
        await fd.close();
    }
}
export function detectType(name) {
    const l = name.toLowerCase();
    if (/\.(mp3|wav|m4a|ogg|aac|webm|flac)$/.test(l) || l.includes('call') || l.includes('voice'))
        return 'call';
    return 'chat';
}
export const uploadsRouter = Router();
uploadsRouter.post('/uploads', callbackHandler(upload.single('file')), asyncHandler(async (req, res) => {
    const f = req.file;
    if (!f)
        return res.status(400).json({ error: 'file is required' });
    const validContent = await validateUploadedContent(f.path, f.mimetype).catch(() => false);
    if (!validContent) {
        await fs.unlink(f.path).catch(() => undefined);
        return res.status(400).json({ error: 'file content does not match declared type' });
    }
    const id = path.parse(f.filename).name;
    const type = detectType(f.originalname);
    const now = Date.now();
    db.prepare(`INSERT INTO uploads (id, filename, type, size, mime, path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, f.originalname, type, f.size, f.mimetype, f.path, now);
    res.json({
        id,
        filename: f.originalname,
        type,
        size: f.size,
        mime: f.mimetype,
        created_at: now,
    });
}));
uploadsRouter.delete('/uploads/:id', asyncHandler(async (req, res) => {
    if (req.params.id.startsWith('call-recording:')) {
        return res.status(409).json({ error: 'managed call recording; use Call QA lifecycle' });
    }
    if (isTranscriptionInFlight(req.params.id)) {
        return res.status(409).json({ error: 'transcription in progress' });
    }
    const row = db.prepare('SELECT path FROM uploads WHERE id = ?').get(req.params.id);
    if (!row)
        return res.status(404).json({ error: 'not found' });
    await fs.unlink(row.path).catch((err) => {
        if (err.code !== 'ENOENT')
            console.error(`unlink ${row.path}:`, err.code);
    });
    db.prepare('DELETE FROM uploads WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
}));
export const uploadErrorHandler = (err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE')
            return res.status(413).json({ error: 'file too large' });
        return res.status(400).json({ error: 'invalid upload' });
    }
    if (err instanceof UploadPolicyError) {
        return res.status(400).json({ error: 'unsupported file type' });
    }
    next(err);
};
uploadsRouter.use(uploadErrorHandler);
