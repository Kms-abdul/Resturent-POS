'use strict';

/**
 * One error shape for the whole API means the frontend has exactly one thing to
 * handle, and one place to add a new case. Anything thrown that is not an
 * AppError is treated as a bug: logged with a stack, reported to the client as
 * a generic 500 with a request id, and never leaked verbatim.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }
}

const badRequest = (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details);
const unauthorized = (msg = 'Sign in to continue') => new AppError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg = 'You do not have permission to do that') =>
  new AppError(403, 'FORBIDDEN', msg);
const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
const conflict = (msg, details) => new AppError(409, 'CONFLICT', msg, details);
const tooMany = (msg = 'Too many attempts. Wait a moment and try again.') =>
  new AppError(429, 'TOO_MANY_REQUESTS', msg);
const unavailable = (msg, details) => new AppError(503, 'UNAVAILABLE', msg, details);

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
  unavailable,
};
