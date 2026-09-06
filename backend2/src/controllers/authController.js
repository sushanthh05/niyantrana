/**
 * HTTP adapters for authentication.
 *
 * Controllers are deliberately thin: parse, delegate, format. No business rule
 * lives here. Compare v1 authRoutes.js, which validated, queried, hashed and
 * persisted inside the handler.
 */
import passport from 'passport';

import { UnauthorizedError } from '../domain/errors.js';
import authService from '../services/authService.js';

export async function register(req, res) {
  const user = await authService.register(req.body);
  res.status(201).json({ success: true, user });
}

export function login(req, res, next) {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return next(new UnauthorizedError(info?.message || 'Invalid email or password'));
    return req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      return res.json({ success: true, user: { id: user.id, email: user.email } });
    });
  })(req, res, next);
}

export function logout(req, res, next) {
  req.logout((err) => {
    if (err) return next(err);
    // v1 called req.logout() but never destroyed the session or cleared the
    // cookie, so the session record survived logout.
    return req.session.destroy((destroyErr) => {
      if (destroyErr) return next(destroyErr);
      res.clearCookie('connect.sid');
      return res.json({ success: true, message: 'Logged out' });
    });
  });
}

export function me(req, res) {
  res.json({ user: { id: req.user.id, email: req.user.email, status: req.user.status } });
}
