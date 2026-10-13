import { decodeHTML } from 'entities';
function decodeHtml(value) {
    return decodeHTML(value).replace(/\u00a0/gu, ' ');
}
export function storageToText(storage) {
    const tablesWithHeaders = storage.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/giu, (_table, tableBody) => {
        const rows = [...tableBody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map((match) => ({
            cells: [...match[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/giu)].map((cell) => decodeHtml(cell[1]
                .replace(/<[^>]*>/gu, ' ')
                .replace(/\s+/gu, ' ')
                .trim())),
            isHeader: /<th\b/iu.test(match[1]),
        }));
        const headerIndex = rows.findIndex((row) => row.isHeader);
        const headers = headerIndex >= 0 ? rows[headerIndex].cells : [];
        return rows
            .map((row, index) => {
            const values = row.cells.join(' | ');
            return headers.length && index !== headerIndex
                ? `Table row (columns: ${headers.join(' | ')}): ${values}`
                : values;
        })
            .join('\n');
    });
    const prepared = tablesWithHeaders
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
        .replace(/<ac:structured-macro\b[^>]*ac:name=["'](note|warning|info|tip|panel)["'][^>]*>/giu, '\n$1: ')
        .replace(/<\/(p|div|li|h[1-6]|tr|table|ac:structured-macro|ac:rich-text-body|ac:plain-text-body)>/giu, '\n')
        .replace(/<h([1-6])\b[^>]*>/giu, '\n## ')
        .replace(/<t[hd]\b[^>]*>/giu, ' | ')
        .replace(/<br\s*\/?>/giu, '\n')
        .replace(/<[^>]*>/gu, ' ');
    return decodeHtml(prepared)
        .replace(/[\t\r ]+/gu, ' ')
        .replace(/ *\| */gu, ' | ')
        .replace(/\n\s+/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}
export function attachmentReferences(storage) {
    const names = new Set();
    for (const match of storage.matchAll(/(?:ri:filename|ac:filename)=["']([^"']+)["']/giu)) {
        const name = decodeHtml(match[1]).trim();
        if (name)
            names.add(name);
    }
    return names;
}
export function splitCareText(value, maxChars = 1_800, overlap = 220) {
    const blocks = value
        .split(/\n{1,}/u)
        .map((block) => block.trim())
        .filter(Boolean);
    const chunks = [];
    let section = 'Page content';
    let current = '';
    const flush = () => {
        if (!current.trim())
            return;
        chunks.push({ section, text: current.trim() });
        current = current.trim().slice(-overlap);
    };
    for (const block of blocks) {
        if (/^#{1,6}\s/u.test(block)) {
            flush();
            section = block.replace(/^#+\s*/u, '').slice(0, 180) || section;
            current = `${section}\n`;
            continue;
        }
        if (block.length > maxChars) {
            flush();
            for (let offset = 0; offset < block.length; offset += maxChars - overlap) {
                chunks.push({ section, text: block.slice(offset, offset + maxChars) });
            }
            current = '';
            continue;
        }
        if (current.length + block.length + 1 > maxChars)
            flush();
        current = `${current}\n${block}`.trim();
    }
    flush();
    return chunks;
}
export function normalizeSearchText(value) {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\u0300-\u036f]/gu, '');
}
export function lexicalAliases(value) {
    const compact = value.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    const aliases = new Set(compact.map((word) => word.toLocaleLowerCase()));
    for (let index = 0; index < compact.length - 1; index++) {
        const joined = `${compact[index]}${compact[index + 1]}`.toLocaleLowerCase();
        if (joined.length <= 60)
            aliases.add(joined);
    }
    return [...aliases];
}
