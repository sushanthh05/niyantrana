/**
 * The single place errors become HTTP responses.
 *
 * Refactoring applied: Chain of Responsibility + Replace Error Code with Exception.
 *
 * Critically, this never downgrades a failure into a success. If the inference
 * service is unreachable the client receives 503 with provenance
 * "unavailable" -- not a 200 carrying a fabricated risk score, which is what
 * v1 did in three separate places.
 */
import { AppError } from '../domain/errors.js';
import config from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(`Route ${req.method} ${req.originalUrl} not found`, 404));
}

export function errorHandler(err, _req, res, _next) {
  const isKnown = err instanceof AppError;
  const statusCode = isKnown ? err.statusCode : 500;

  // A 503 from a dependency we already model is expected operational noise --
  // log it as a one-line warning. Only unknown errors and 5xx faults get a stack.
  if (!isKnown) {
    console.error('[error]', err.message, config.isProduction ? '' : err.stack);
  } else if (statusCode === 503) {
    console.warn('[unavailable]', err.message);
  } else if (statusCode >= 500) {
    console.error('[error]', err.message);
  }

  const body = {
    error: err.name || 'InternalServerError',
    message: isKnown ? err.message : 'An unexpected server error occurred',
  };
  if (err.details) body.details = err.details;
  if (err.provenance) body.provenance = err.provenance;
  if (!config.isProduction && !isKnown) body.stack = err.stack;

  res.status(statusCode).json(body);
}
