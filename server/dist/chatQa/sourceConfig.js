const REQUIRED_KEYS = [
    'CHAT_SOURCE_MONGO_URI',
    'CHAT_SOURCE_MONGO_DATABASE',
    'CHAT_SOURCE_MYSQL_HOST',
    'CHAT_SOURCE_MYSQL_PORT',
    'CHAT_SOURCE_MYSQL_USER',
    'CHAT_SOURCE_MYSQL_PASSWORD',
    'CHAT_SOURCE_MYSQL_DATABASE',
    'CHAT_SOURCE_MYSQL_TLS',
    'CHAT_SAMPLING_HMAC_SECRET',
];
function required(env, key) {
    const value = env[key]?.trim();
    if (!value)
        throw new Error(`missing required configuration: ${key}`);
    return value;
}
function parseBoolean(value, key, defaultValue) {
    if (value === undefined || value.trim() === '')
        return defaultValue;
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    throw new Error(`invalid configuration: ${key}`);
}
function parsePort(value) {
    if (!/^\d+$/.test(value))
        throw new Error('invalid configuration: CHAT_SOURCE_MYSQL_PORT');
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error('invalid configuration: CHAT_SOURCE_MYSQL_PORT');
    }
    return port;
}
function parseQueryTimeout(value) {
    if (value === undefined || value.trim() === '')
        return 60_000;
    if (!/^\d+$/.test(value)) {
        throw new Error('invalid configuration: CHAT_SOURCE_QUERY_TIMEOUT_MS');
    }
    const timeout = Number(value);
    if (!Number.isSafeInteger(timeout) || timeout < 10_000 || timeout > 300_000) {
        throw new Error('invalid configuration: CHAT_SOURCE_QUERY_TIMEOUT_MS');
    }
    return timeout;
}
function parseMongoUri(value, requireTls, laptopVpn) {
    try {
        const uri = new URL(value);
        if (uri.protocol !== 'mongodb:' && uri.protocol !== 'mongodb+srv:')
            throw new Error('invalid');
        const options = new Map([...uri.searchParams.entries()].map(([key, option]) => [
            key.toLowerCase(),
            option.toLowerCase(),
        ]));
        const tls = options.get('tls') ?? options.get('ssl');
        const insecure = [
            'tlsinsecure',
            'tlsallowinvalidcertificates',
            'tlsallowinvalidhostnames',
        ].some((key) => options.get(key) === 'true');
        if (insecure)
            throw new Error('invalid');
        if (laptopVpn &&
            (uri.protocol !== 'mongodb:' ||
                uri.hostname !== '192.168.46.4' ||
                (uri.port !== '' && uri.port !== '27017')))
            throw new Error('invalid');
        if (requireTls && (tls === 'false' || (uri.protocol === 'mongodb:' && tls !== 'true'))) {
            throw new Error('invalid');
        }
        return value;
    }
    catch {
        throw new Error('invalid configuration: CHAT_SOURCE_MONGO_URI');
    }
}
function parseBase64(value) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
        throw new Error('invalid configuration: CHAT_SAMPLING_HMAC_SECRET');
    }
    const secret = Buffer.from(value, 'base64');
    if (secret.length < 16)
        throw new Error('invalid configuration: CHAT_SAMPLING_HMAC_SECRET');
    return secret;
}
export function loadChatSourceConfig(env) {
    const enabled = parseBoolean(env.CHAT_SOURCE_ENABLED, 'CHAT_SOURCE_ENABLED', false);
    if (!enabled)
        return null;
    for (const key of REQUIRED_KEYS)
        required(env, key);
    const production = env.NODE_ENV === 'production';
    const vpnRequested = parseBoolean(env.CHAT_SOURCE_VPN_PROFILE, 'CHAT_SOURCE_VPN_PROFILE', false);
    const laptopVpn = vpnRequested && env.AGENTSCORE_LAPTOP_PROFILE === '1';
    if (vpnRequested && !laptopVpn)
        throw new Error('invalid configuration: CHAT_SOURCE_VPN_PROFILE');
    const mongoUri = parseMongoUri(required(env, 'CHAT_SOURCE_MONGO_URI'), production && !laptopVpn, laptopVpn);
    const mysqlTls = parseBoolean(required(env, 'CHAT_SOURCE_MYSQL_TLS'), 'CHAT_SOURCE_MYSQL_TLS', true);
    if (production && !laptopVpn && !mysqlTls)
        throw new Error('invalid configuration: CHAT_SOURCE_MYSQL_TLS');
    const mysqlHost = required(env, 'CHAT_SOURCE_MYSQL_HOST');
    if (laptopVpn && mysqlHost !== '192.168.46.4')
        throw new Error('invalid configuration: CHAT_SOURCE_MYSQL_HOST');
    return {
        enabled: true,
        mongoUri,
        mongoDatabase: required(env, 'CHAT_SOURCE_MONGO_DATABASE'),
        mysqlHost,
        mysqlPort: parsePort(required(env, 'CHAT_SOURCE_MYSQL_PORT')),
        mysqlUser: required(env, 'CHAT_SOURCE_MYSQL_USER'),
        mysqlPassword: required(env, 'CHAT_SOURCE_MYSQL_PASSWORD'),
        mysqlDatabase: required(env, 'CHAT_SOURCE_MYSQL_DATABASE'),
        mysqlTls,
        laptopVpn,
        queryTimeoutMs: parseQueryTimeout(env.CHAT_SOURCE_QUERY_TIMEOUT_MS),
        samplingHmacSecret: parseBase64(required(env, 'CHAT_SAMPLING_HMAC_SECRET')),
    };
}
export function redactChatSourceConfig(config) {
    return {
        enabled: config.enabled,
        mongoDatabase: config.mongoDatabase,
        mysqlHost: config.mysqlHost,
    };
}
