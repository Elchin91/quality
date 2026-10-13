import { spawnSync } from 'node:child_process';
export const LAPTOP_VPN_SOURCE_HOST = '192.168.46.4';
const VPN_INTERFACE = 'vpn0';
export function assertLaptopVpnSourceEndpoints(mongoUri, mysqlHost) {
    let mongo;
    try {
        mongo = new URL(mongoUri);
    }
    catch {
        throw new Error('invalid laptop VPN source endpoint');
    }
    if (mysqlHost !== LAPTOP_VPN_SOURCE_HOST ||
        mongo.protocol !== 'mongodb:' ||
        mongo.hostname !== LAPTOP_VPN_SOURCE_HOST ||
        (mongo.port !== '' && mongo.port !== '27017')) {
        throw new Error('invalid laptop VPN source endpoint');
    }
}
function route() {
    const result = spawnSync('ip', ['-4', 'route', 'get', LAPTOP_VPN_SOURCE_HOST], {
        encoding: 'utf8',
        timeout: 1_000,
        maxBuffer: 4_096,
    });
    return result.status === 0 ? result.stdout : '';
}
export function isApprovedLaptopVpnRoute(output) {
    const firstLine = output.split('\n', 1)[0]?.trim() ?? '';
    return /^192\.168\.46\.4\s+dev\s+vpn0\s+src\s+(?:\d{1,3}\.){3}\d{1,3}(?:\s|$)/u.test(firstLine);
}
/** Fail closed before opening a source connection or issuing another source query. */
export function assertLaptopVpnRoute(readRoute = route) {
    if (!isApprovedLaptopVpnRoute(readRoute())) {
        throw new Error(`corporate source route must use ${VPN_INTERFACE}`);
    }
}
/** Close live source sockets promptly if VPN routing disappears while idle or mid-query. */
export function monitorLaptopVpnRoute(onLost, readRoute = route) {
    const timer = setInterval(() => {
        try {
            assertLaptopVpnRoute(readRoute);
        }
        catch {
            clearInterval(timer);
            onLost();
        }
    }, 1_000);
    timer.unref();
    return () => clearInterval(timer);
}
