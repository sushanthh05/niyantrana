/**
 * Profile and wearable-data operations.
 *
 * Refactoring applied: Move Method. The Mifflin-St Jeor calculation lived
 * inline in two route handlers (Duplicate Code); it now comes from
 * domain/metabolic.js, which mirrors the Python implementation.
 */
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { basalMetabolicRate, bodyMassIndex } from '../domain/metabolic.js';
import userRepository from '../repositories/userRepository.js';

const REQUIRED_PROFILE_FIELDS = ['age', 'height', 'weight', 'gender', 'waist'];

export class UserService {
  constructor(users = userRepository) {
    this.users = users;
  }

  async getStatus(userId) {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User');
    return {
      status: user.status,
      staticData: user.staticData,
      canBeAssessed: user.canBeAssessed(),
      wearableDays: user.watchHistory?.length ?? 0,
    };
  }

  async saveProfile(userId, payload) {
    const missing = REQUIRED_PROFILE_FIELDS.filter((f) => payload?.[f] === undefined);
    if (missing.length) throw new ValidationError('Incomplete profile', { missing });

    const staticData = {
      age: Number(payload.age),
      height: Number(payload.height),
      weight: Number(payload.weight),
      gender: String(payload.gender).toUpperCase().startsWith('M') ? 'M' : 'F',
      waist: Number(payload.waist),
      has_hereditary_risk: Boolean(payload.has_hereditary_risk),
      alcohol_drinks_week: Number(payload.alcohol_drinks_week) || 0,
      smoking_status: Number(payload.smoking_status) || 0,
    };
    staticData.bmr = basalMetabolicRate({
      weightKg: staticData.weight, heightCm: staticData.height,
      age: staticData.age, sex: staticData.gender,
    });

    const user = await this.users.updateStaticData(userId, staticData);
    if (!user) throw new NotFoundError('User');
    return user.staticData;
  }

  async updateWeight(userId, weight) {
    if (!weight || Number(weight) <= 0) throw new ValidationError('A positive weight is required');
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User');

    const staticData = { ...user.staticData.toObject(), weight: Number(weight) };
    staticData.bmr = basalMetabolicRate({
      weightKg: staticData.weight, heightCm: staticData.height,
      age: staticData.age, sex: staticData.gender,
    });

    const updated = await this.users.updateStaticData(userId, staticData);
    return {
      staticData: updated.staticData,
      bmi: bodyMassIndex(staticData.weight, staticData.height),
    };
  }

  async recordWearableData(userId, entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    if (!list.length) throw new ValidationError('No wearable data supplied');
    const user = await this.users.appendWatchData(userId, list);
    if (!user) throw new NotFoundError('User');
    return { recorded: list.length, total: user.watchHistory.length };
  }

  /**
   * Recent wearable days. Returns whatever exists; callers decide what to do
   * with an insufficient window. v1 fabricated 14 days of fake data here.
   */
  recentWearableData(userId, days = 14) {
    return this.users.recentWatchData(userId, days);
  }
}

export default new UserService();
