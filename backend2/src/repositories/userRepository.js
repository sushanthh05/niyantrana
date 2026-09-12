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

  /**
   * Replace the whole wearable history.
   *
   * Used by demo seeding and by a full re-import, both of which must be
   * idempotent: clicking "load demo data" twice should not leave 180 days.
   */
  replaceWatchData(id, entries) {
    return User.findByIdAndUpdate(
      id,
      { $set: { watchHistory: Array.isArray(entries) ? entries : [entries] } },
      { new: true, runValidators: true },
    );
  }

  /**
   * Merge days by date: an existing day is updated, a new one appended.
   *
   * Re-importing an overlapping export should refresh those days rather than
   * create duplicates, which would corrupt the 14-day window the model reads.
   */
  async upsertWatchData(id, entries) {
    const incoming = Array.isArray(entries) ? entries : [entries];
    const user = await User.findById(id).select('watchHistory');
    if (!user) return null;

    const dayOf = (value) => new Date(value).toISOString().slice(0, 10);
    const merged = new Map(
      (user.watchHistory || []).map((day) => [dayOf(day.date), day.toObject?.() ?? day]),
    );
    let added = 0;
    let updated = 0;
    for (const entry of incoming) {
      const key = dayOf(entry.date);
      if (merged.has(key)) updated += 1; else added += 1;
      merged.set(key, { ...merged.get(key), ...entry });
    }

    const history = [...merged.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
    await User.findByIdAndUpdate(id, { $set: { watchHistory: history } },
      { runValidators: true });
    return { added, updated, total: history.length };
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
