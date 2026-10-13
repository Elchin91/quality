export const APPEAL_STATUSES = [
    'pending_lead',
    'lead_rejected',
    'pending_assignment',
    'pending_review',
    'upheld',
    'adjusted',
];
export class AppealError extends Error {
    code;
    httpStatus;
    constructor(code, httpStatus) {
        super(code);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}
