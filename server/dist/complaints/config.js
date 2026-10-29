const ORIGIN = 'https://jira.pashapay.az';
export function loadComplaintsConfig(env) {
    const enabled = env.COMPLAINTS_ENABLED === 'true';
    if (env.COMPLAINTS_ENABLED && !['true', 'false'].includes(env.COMPLAINTS_ENABLED))
        throw new Error('COMPLAINTS_ENABLED');
    let base;
    try {
        base = new URL(env.JIRA_BASE_URL || ORIGIN);
    }
    catch {
        throw new Error('JIRA_BASE_URL');
    }
    if (base.origin !== ORIGIN ||
        base.pathname !== '/' ||
        base.username ||
        base.password ||
        base.search ||
        base.hash)
        throw new Error('JIRA_BASE_URL');
    const token = env.JIRA_TOKEN?.trim() ?? '';
    if (/[\r\n]/.test(token) || token.length > 4096)
        throw new Error('JIRA_TOKEN');
    const field = (key, fallback) => {
        const value = env[key] || fallback;
        if (!/^customfield_\d+$/.test(value))
            throw new Error(key);
        return value;
    };
    return {
        enabled,
        baseUrl: ORIGIN,
        token,
        intervalMs: 3_600_000,
        phoneField: field('JIRA_COMPLAINTS_PHONE_FIELD', 'customfield_13715'),
        employeeField: field('JIRA_COMPLAINTS_EMPLOYEE_FIELD', 'customfield_11201'),
        reasonField: field('JIRA_COMPLAINTS_REASON_FIELD', 'customfield_13827'),
    };
}
export function redactComplaintsConfig(config) {
    const { token, ...safe } = config;
    return { ...safe, configured: Boolean(token) };
}
