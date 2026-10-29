/** Canonical digits, with Azerbaijani national formats expanded explicitly. */
export function normalizeComplaintPhone(value) {
    if (typeof value !== 'string' || value.length > 64 || !/^\+?[\d\s().-]+$/u.test(value.trim()))
        return null;
    let phone = value.replace(/\D/gu, '');
    if (phone.startsWith('00'))
        phone = phone.slice(2);
    if (/^0\d{9}$/u.test(phone))
        phone = `994${phone.slice(1)}`;
    else if (/^\d{9}$/u.test(phone))
        phone = `994${phone}`;
    return /^\d{10,15}$/u.test(phone) ? phone : null;
}
export function phoneContact(value, channels) {
    // A numeric Telegram/channel identifier is not evidence of a customer's phone.
    if (!channels.length ||
        !channels.every((channel) => /^(whatsapp|phone|sipphone|call)$/iu.test(channel)))
        return null;
    return normalizeComplaintPhone(value);
}
