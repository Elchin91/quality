export class CallQaServiceError extends Error {
    code;
    httpStatus;
    constructor(code, httpStatus) {
        super(code);
        this.code = code;
        this.httpStatus = httpStatus;
        this.name = 'CallQaServiceError';
    }
    toJSON() {
        return { name: this.name, code: this.code, message: this.message };
    }
}
