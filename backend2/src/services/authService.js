/**
 * Registration and credential verification.
 *
 * Refactoring applied: Extract Class. authRoutes.js previously mixed HTTP
 * parsing, duplicate checking, bcrypt hashing and persistence in one handler.
 */
import bcrypt from 'bcryptjs';

import { ConflictError, ValidationError } from '../domain/errors.js';
import userRepository from '../repositories/userRepository.js';

const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthService {
  constructor(users = userRepository) {
    this.users = users;
  }

  async register({ email, password }) {
    if (!email || !password) throw new ValidationError('Email and password are required');
    if (!EMAIL_PATTERN.test(email)) throw new ValidationError('Enter a valid email address');
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    if (await this.users.existsByEmail(email)) {
      throw new ConflictError('An account with that email already exists');
    }

    const user = await this.users.create({
      email: email.toLowerCase().trim(),
      password: await bcrypt.hash(password, SALT_ROUNDS),
    });
    return { id: user.id, email: user.email };
  }

  /** Used by the Passport local strategy. Returns the user, or null. */
  async verifyCredentials(email, password) {
    const user = await this.users.findByEmail(email).select('+password');
    if (!user) return null;
    return (await bcrypt.compare(password, user.password)) ? user : null;
  }
}

export default new AuthService();
