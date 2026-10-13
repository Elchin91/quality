import { spawn } from 'node:child_process';
const MAX_OUTPUT_BYTES = 64 * 1024;
const INHERITED_RECORDING_PATH = '/dev/fd/3';
function validatedConfig(config) {
    if (typeof config.executable !== 'string' ||
        config.executable.length < 1 ||
        config.executable.length > 1_024 ||
        // eslint-disable-next-line no-control-regex -- Executable paths must reject ASCII controls.
        /[\u0000-\u001F\u007F]/u.test(config.executable) ||
        !Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 1_000 ||
        config.timeoutMs > 60_000) {
        throw new Error('invalid recording probe configuration');
    }
    return { ...config };
}
/** Runs ffprobe against an inherited open descriptor with bounded output, timeout, and abort. */
export function createFfprobeRecordingProbe(input) {
    const config = validatedConfig(input);
    return ({ fileDescriptor, signal }) => new Promise((resolve, reject) => {
        if (!Number.isSafeInteger(fileDescriptor) || fileDescriptor < 0 || signal.aborted) {
            reject(new Error('recording probe unavailable'));
            return;
        }
        const child = spawn(config.executable, [
            '-v',
            'error',
            '-select_streams',
            'a:0',
            '-show_entries',
            'stream=codec_type:format=duration,format_name',
            '-of',
            'json',
            // Preserve the private descriptor boundary while allowing ffprobe to seek.
            // `pipe:3` starts at the writer's EOF offset and cannot discover Ogg duration.
            INHERITED_RECORDING_PATH,
        ], { stdio: ['ignore', 'pipe', 'ignore', fileDescriptor] });
        let output = '';
        let settled = false;
        let exceeded = false;
        const kill = () => child.kill('SIGKILL');
        const timer = setTimeout(kill, config.timeoutMs);
        const finish = (work) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', kill);
            work();
        };
        signal.addEventListener('abort', kill, { once: true });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > MAX_OUTPUT_BYTES) {
                exceeded = true;
                kill();
                return;
            }
            output += chunk;
        });
        child.once('error', () => finish(() => reject(new Error('recording probe unavailable'))));
        child.once('close', (code) => {
            finish(() => {
                if (signal.aborted || exceeded || code !== 0) {
                    reject(new Error('recording probe unavailable'));
                    return;
                }
                try {
                    const parsed = JSON.parse(output);
                    const durationSeconds = Number(parsed.format?.duration);
                    const formats = String(parsed.format?.format_name ?? '').split(',');
                    if (!parsed.streams?.some((stream) => stream.codec_type === 'audio') ||
                        !Number.isFinite(durationSeconds) ||
                        durationSeconds <= 0 ||
                        !formats.includes('ogg')) {
                        reject(new Error('recording probe unavailable'));
                        return;
                    }
                    resolve({ durationSeconds, mimeType: 'audio/ogg' });
                }
                catch {
                    reject(new Error('recording probe unavailable'));
                }
            });
        });
    });
}
