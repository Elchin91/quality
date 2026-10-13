export const CALL_SOURCE_MAX_WINDOW_DAYS = 31;
export const CALL_SOURCE_MAX_PAGE_SIZE = 100;
export const CALL_SOURCE_MAX_ROWS = 5_000;
/** Reuses only the established read-only source connections and excludes sampling secrets. */
export function callSourceConfigFromChatSource(source) {
    const mongoUri = source.mongoUri.trim();
    const mongoDatabase = source.mongoDatabase.trim();
    const mysqlHost = source.mysqlHost.trim();
    const mysqlUser = source.mysqlUser.trim();
    const mysqlPassword = source.mysqlPassword;
    const mysqlDatabase = source.mysqlDatabase.trim();
    if (source.enabled !== true ||
        !mongoUri ||
        !mongoDatabase ||
        !mysqlHost ||
        !Number.isInteger(source.mysqlPort) ||
        source.mysqlPort < 1 ||
        source.mysqlPort > 65_535 ||
        !mysqlUser ||
        !mysqlPassword ||
        !mysqlDatabase ||
        typeof source.mysqlTls !== 'boolean') {
        throw new Error('invalid call source configuration');
    }
    return Object.freeze({
        enabled: true,
        mongoUri,
        mongoDatabase,
        mysqlHost,
        mysqlPort: source.mysqlPort,
        mysqlUser,
        mysqlPassword,
        mysqlDatabase,
        mysqlTls: source.mysqlTls,
        laptopVpn: source.laptopVpn,
        maxWindowDays: CALL_SOURCE_MAX_WINDOW_DAYS,
        maxPageSize: CALL_SOURCE_MAX_PAGE_SIZE,
        maxRows: CALL_SOURCE_MAX_ROWS,
    });
}
export function redactCallSourceConfig(config) {
    return {
        enabled: config.enabled,
        mongoDatabase: config.mongoDatabase,
        mysqlHost: config.mysqlHost,
        mysqlPort: config.mysqlPort,
        mysqlDatabase: config.mysqlDatabase,
        mysqlTls: config.mysqlTls,
        maxWindowDays: config.maxWindowDays,
        maxPageSize: config.maxPageSize,
        maxRows: config.maxRows,
    };
}
