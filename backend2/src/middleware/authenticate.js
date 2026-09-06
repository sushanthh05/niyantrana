/**
 * Session guard.
 *
 * Refactoring applied: Extract Method. An identical `isAuthenticated` was
 * defined separately in apiRoutes.js and userRoutes.js (Duplicate Code), so the
 * two could drift apart.
 */
import { UnauthorizedError } from '../domain/errors.js';

export function authenticate(req, _res, next) {
  if (req.isAuthenticated?.()) return next();
  return next(new UnauthorizedError());
}

export default authenticate;
