/**
 * Data access for users.
 *
 * Refactoring applied: Extract Class + Hide Delegate.
 *
 * Route handlers previously called `User.findById`, `user.save()` and built
 * `$regex` queries inline -- Feature Envy on the Mongoose model, and a route
 * layer that could not be tested without a live database. Persistence now sits
 * behind this seam, and swapping the store touches one file.
 */
import User from '../models/User.js';
import { exactMatchPattern } from '../domain/text.js';

export class UserRepository {
  findById(id) {
    return User.findById(id);
  }

  findByEmail(email) {
    return User.findOne({ email: String(email).toLowerCase().trim() });
  }

  existsByEmail(email) {
    return User.exists({
      email: { $regex: exactMatchPattern(String(email).toLowerCase().trim()) },
    });
  }

  create(attributes) {
    return User.create(attributes);
  }

  updateStaticData(id, staticData) {
    return User.findByIdAndUpdate(
      id,
      { $set: { staticData, status: 'active' } },
      { new: true, runValidators: true },
    );
  }

  appendWatchData(id, entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    return User.findByIdAndUpdate(
      id,
      { $push: { watchHistory: { $each: list } } },
      { new: true, runValidators: true },
    );
  }

  /** Most recent wearable days, oldest first -- the order the model expects. */
  async recentWatchData(id, days = 14) {
    const user = await User.findById(id).select('watchHistory').lean();
    if (!user?.watchHistory?.length) return [];
    return [...user.watchHistory]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-days);
  }

  appendHealthReport(id, report) {
    return User.findByIdAndUpdate(id, { $push: { healthHistory: report } }, { new: true });
  }

  saveFitbitTokens(id, tokens) {
    return User.findByIdAndUpdate(id, { $set: { fitbit: tokens } }, { new: true });
  }
}

export default new UserRepository();
