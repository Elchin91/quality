import { searchCareIndex, getCareIndexStatus, } from './confluenceIndex.js';
export function confluenceConfigured(env = process.env) {
    return Boolean(env.CONFLUENCE_EMAIL?.trim() && env.CONFLUENCE_API_TOKEN?.trim());
}
export async function searchConfluence(query, signal, _env = process.env) {
    return searchCareIndex(query, signal);
}
export function careIndexStatus() {
    return getCareIndexStatus();
}
