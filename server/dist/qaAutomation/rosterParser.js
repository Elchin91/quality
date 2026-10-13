import { parseCsv } from './csv.js';
import { normalizeRosterName, } from './types.js';
function dayFromCell(value) {
    const cell = value.trim();
    let year;
    let month;
    let day;
    const local = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+[\p{L} .]+)?$/u.exec(cell);
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:\s+[\p{L} .]+)?$/u.exec(cell);
    if (local)
        [, day, month, year] = local.map(Number);
    else if (iso)
        [, year, month, day] = iso.map(Number);
    else
        return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year ||
        date.getUTCMonth() + 1 !== month ||
        date.getUTCDate() !== day) {
        throw new Error('invalid roster date header');
    }
    return date.toISOString().slice(0, 10);
}
function dateColumns(rows, month) {
    const expectedDays = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    for (const row of rows.slice(0, 5)) {
        // The workbook repeats the same month in later hour/accounting grids.
        // Only E:AI is the operator shift calendar.
        const cells = Array.from({ length: expectedDays }, (_, offset) => {
            const index = 4 + offset;
            return { index, date: dayFromCell(row[index] ?? '') };
        });
        if (cells.every((cell, index) => cell.date === `${month}-${String(index + 1).padStart(2, '0')}`)) {
            return cells;
        }
    }
    throw new Error('current month roster date headers unavailable or ambiguous');
}
function sourceIdentity(id, name) {
    const stableId = id.trim().normalize('NFKC').toUpperCase();
    if (stableId && !/^IDM[-\s]?[A-Z0-9]+$/.test(stableId)) {
        throw new Error('unrecognized roster employee identifier');
    }
    const normalizedName = normalizeRosterName(name);
    if (!normalizedName || normalizedName.length > 200)
        throw new Error('invalid roster person name');
    return {
        key: stableId ? `idm:${stableId.replace(/\s+/g, '')}` : `name:${normalizedName}`,
        sourceId: stableId || null,
    };
}
function parseShift(value, date) {
    const cell = value.trim().normalize('NFKC');
    if (!cell || /^(off|vacation|army|бюллетень|отпуск|выходной|x|-|—)$/iu.test(cell))
        return null;
    const match = /^(\d{1,2}):([0-5]\d)\s*[-–—]\s*(\d{1,2}):([0-5]\d)$/u.exec(cell);
    if (!match)
        throw new Error('unrecognized roster shift value');
    const startHour = Number(match[1]);
    const endHour = Number(match[3]);
    if (startHour > 23 || endHour > 23)
        throw new Error('invalid roster shift time');
    const startsAt = `${String(startHour).padStart(2, '0')}:${match[2]}`;
    const endsAt = `${String(endHour).padStart(2, '0')}:${match[4]}`;
    if (startsAt === endsAt)
        throw new Error('zero-length roster shift');
    return { date, startsAt, endsAt };
}
function rowKind(row) {
    const label = row[1]?.trim().normalize('NFKC').toLocaleLowerCase('ru') ?? '';
    if (/^(чаты|chats?)$/iu.test(label))
        return 'chat';
    if (/^(звонки|calls?)$/iu.test(label))
        return 'call';
    if (/^(часы|hours?)$/iu.test(label))
        return 'hours';
    if (!label)
        return 'blank';
    if (/^(social media|monitoring|мониторинг|социальные сети)$/iu.test(label))
        return 'other';
    return 'person';
}
/** Parses the approved monthly calendar grid; unexpected headings or values block refresh. */
export function parseRosterCsv(csv, month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        throw new Error('invalid roster month');
    const rows = parseCsv(csv);
    const dates = dateColumns(rows, month);
    const people = [];
    const keys = new Set();
    let section = null;
    let seenChat = false;
    let seenCall = false;
    let afterCallHours = false;
    let seenMixed = false;
    for (const row of rows.slice(1)) {
        const kind = rowKind(row);
        if (kind === 'chat') {
            if (seenChat || seenCall)
                throw new Error('ambiguous chat roster section');
            section = 'chat';
            seenChat = true;
            continue;
        }
        if (kind === 'call') {
            if (!seenChat || seenCall)
                throw new Error('ambiguous call roster section');
            section = 'call';
            seenCall = true;
            continue;
        }
        if (kind === 'hours') {
            if (section === 'call')
                afterCallHours = true;
            section = null;
            continue;
        }
        if (kind === 'blank') {
            if (section === 'mixed' && seenMixed)
                break;
            continue;
        }
        if (kind === 'other')
            break;
        if (!section && afterCallHours)
            section = 'mixed';
        if (!section)
            continue;
        const name = row[1].trim().normalize('NFKC').replace(/\s+/g, ' ');
        const identity = sourceIdentity(row[0] ?? '', name);
        if (keys.has(identity.key))
            throw new Error('duplicate roster identity');
        keys.add(identity.key);
        const shifts = [];
        const invalidShiftDates = [];
        for (const { index, date } of dates) {
            try {
                const shift = parseShift(row[index] ?? '', date);
                if (shift)
                    shifts.push(shift);
            }
            catch {
                invalidShiftDates.push(date);
            }
        }
        people.push({ ...identity, name, channel: section, shifts, invalidShiftDates });
        if (section === 'mixed')
            seenMixed = true;
    }
    if (!seenChat ||
        !seenCall ||
        !seenMixed ||
        !people.some((person) => person.channel === 'chat') ||
        !people.some((person) => person.channel === 'call')) {
        throw new Error('roster sections incomplete');
    }
    return people;
}
