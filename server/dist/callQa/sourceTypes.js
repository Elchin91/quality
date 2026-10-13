const OBSERVED_OMNICHANNEL_ID = /^\d{10}\.\d{3,6}$/u;
/** Accepts the bounded dotted identifier shape observed in the live call source. */
export function isObservedOmnichannelId(value) {
    return typeof value === 'string' && OBSERVED_OMNICHANNEL_ID.test(value);
}
export const CALL_SOURCE_EXCLUSION_CODES = [
    'missing_talk_interval',
    'invalid_source_ref',
    'invalid_recording_locator',
    'invalid_agent_identity',
    'invalid_talk_interval',
    'invalid_source_duration',
    'invalid_source_updated_at',
    'invalid_source_metadata',
];
