class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const badRequest = (code, msg, details) => new ApiError(400, code, msg, details);
const unauthorized = (code = 'UNAUTHORIZED', msg = 'Authentication required') => new ApiError(401, code, msg);
const forbidden = (code = 'FORBIDDEN', msg = 'You do not have permission to do this') => new ApiError(403, code, msg);
const notFound = (code = 'NOT_FOUND', msg = 'Not found') => new ApiError(404, code, msg);
const conflict = (code, msg) => new ApiError(409, code, msg);
const tooMany = (code = 'RATE_LIMITED', msg = 'Too many attempts. Try again later.') => new ApiError(429, code, msg);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany };
