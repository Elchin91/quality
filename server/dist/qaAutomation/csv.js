/** RFC 4180 CSV with a UTF-8 BOM and Google Sheets' optional trailing newline. */
export function parseCsv(input) {
    if (input.length > 10_000_000)
        throw new Error('roster CSV exceeds 10 MB');
    const text = input.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let endedField = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
            if (char === '"' && text[index + 1] === '"') {
                field += '"';
                index += 1;
            }
            else if (char === '"') {
                quoted = false;
                endedField = true;
            }
            else {
                field += char;
            }
            continue;
        }
        if (char === '"') {
            if (field || endedField)
                throw new Error('invalid CSV quote');
            quoted = true;
        }
        else if (char === ',') {
            row.push(field);
            field = '';
            endedField = false;
        }
        else if (char === '\r' || char === '\n') {
            if (char === '\r' && text[index + 1] === '\n')
                index += 1;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            endedField = false;
        }
        else {
            if (endedField)
                throw new Error('invalid CSV after quote');
            field += char;
        }
    }
    if (quoted)
        throw new Error('unterminated CSV quote');
    if (row.length || field || !rows.length) {
        row.push(field);
        rows.push(row);
    }
    if (rows.length > 10_000)
        throw new Error('roster CSV has too many rows');
    return rows;
}
