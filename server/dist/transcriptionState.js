const inFlightTranscriptions = new Map();
export function getInFlightTranscription(uploadId) {
    return inFlightTranscriptions.get(uploadId);
}
export function setInFlightTranscription(uploadId, work) {
    inFlightTranscriptions.set(uploadId, work);
}
export function clearInFlightTranscription(uploadId, work) {
    if (inFlightTranscriptions.get(uploadId) === work)
        inFlightTranscriptions.delete(uploadId);
}
export function isTranscriptionInFlight(uploadId) {
    return inFlightTranscriptions.has(uploadId);
}
export function hasInFlightTranscriptions() {
    return inFlightTranscriptions.size > 0;
}
