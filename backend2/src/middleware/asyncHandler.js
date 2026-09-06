/**
 * Wraps an async route handler so rejections reach the error middleware.
 *
 * Refactoring applied: Extract Method on a Duplicate Code smell. Every v1 route
 * repeated the same try/catch that logged and returned a generic 500, which is
 * how genuine failures became indistinguishable from each other.
 */
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

export default asyncHandler;
