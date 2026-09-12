/**
 * Meal, vitals and activity logging.
 *
 * Two responsibilities beyond storage:
 *
 * 1. **Resolving macros at log time.** A client sends a food code and a serving
 *    count; the server looks the food up in the Anuvaad database and stores the
 *    resulting macros. The client never gets to assert its own nutrition
 *    numbers, which is what made the old client-supplied `dietTotals` path
 *    untrustworthy -- a browser could claim any intake it liked and the model
 *    would believe it.
 *
 * 2. **Turning logs into model inputs.** Daily macro totals and the latest
 *    measured biomarkers are computed here, not passed in.
 */
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { MEAL_TYPES } from '../models/MealLog.js';
import { CONTEXT_FIELDS, MEASURED_FIELDS } from '../models/VitalReading.js';
import foodRepository from '../repositories/foodRepository.js';
import logRepository from '../repositories/logRepository.js';
import userRepository from '../repositories/userRepository.js';
import Food from '../models/Food.js';

const MAX_SERVINGS = 50;

export class LoggingService {
  constructor({ logs = logRepository, foods = foodRepository, users = userRepository } = {}) {
    this.logs = logs;
    this.foods = foods;
    this.users = users;
  }

  // --- Meals ---------------------------------------------------------------
  /**
   * Log a meal.
   *
   * Preferred form supplies `foodCode` (or `foodName`) and `servings`; macros
   * are then resolved server-side. Explicit macros are accepted only for foods
   * absent from the database, and are range-checked.
   */
  async logMeal(userId, payload = {}) {
    const servings = Number(payload.servings ?? 1);
    if (!Number.isFinite(servings) || servings <= 0 || servings > MAX_SERVINGS) {
      throw new ValidationError(`servings must be between 0 and ${MAX_SERVINGS}`);
    }
    if (payload.mealType && !MEAL_TYPES.includes(payload.mealType)) {
      throw new ValidationError(`mealType must be one of: ${MEAL_TYPES.join(', ')}`);
    }

    const food = await this.#resolveFood(payload);
    const attributes = {
      foodName: food.food_name,
      foodCode: food.food_code,
      mealType: payload.mealType || 'snack',
      servings,
      loggedAt: payload.loggedAt ? new Date(payload.loggedAt) : new Date(),
      energy_kcal: (food.energy_kcal ?? 0) * servings,
      fat_g: (food.fat_g ?? 0) * servings,
      carb_g: (food.carb_g ?? 0) * servings,
      protein_g: (food.protein_g ?? 0) * servings,
      sugar_g: (food.freesugar_g ?? food.sugar_g ?? 0) * servings,
      fibre_g: (food.fibre_g ?? 0) * servings,
      satfat_g: (food.satfat_g ?? 0) * servings,
    };

    if (!Number.isFinite(attributes.energy_kcal) || attributes.energy_kcal <= 0) {
      throw new ValidationError('Could not determine calories for this meal');
    }
    return this.logs.createMeal(userId, attributes);
  }

  /** Find the food in the database, or accept caller-supplied macros. */
  async #resolveFood(payload) {
    if (payload.foodCode) {
      const found = await Food.findOne({ food_code: payload.foodCode }).lean();
      if (found) return found;
    }
    if (payload.foodName) {
      const [found] = await this.foods.search(payload.foodName, 1);
      if (found) return found;
    }

    // Not in the database: the caller must supply the numbers, and say so.
    if (!payload.foodName) throw new ValidationError('foodName or foodCode is required');
    if (payload.energy_kcal == null) {
      throw new NotFoundError(`Food "${payload.foodName}"`);
    }
    const energy = Number(payload.energy_kcal);
    if (!Number.isFinite(energy) || energy < 0 || energy > 10000) {
      throw new ValidationError('energy_kcal must be between 0 and 10000');
    }
    return {
      food_name: payload.foodName,
      food_code: undefined,
      energy_kcal: energy,
      fat_g: Number(payload.fat_g) || 0,
      carb_g: Number(payload.carb_g) || 0,
      protein_g: Number(payload.protein_g) || 0,
      freesugar_g: Number(payload.sugar_g) || 0,
      fibre_g: Number(payload.fibre_g) || 0,
      satfat_g: Number(payload.satfat_g) || 0,
    };
  }

  listMeals(userId, options) {
    return this.logs.listMeals(userId, options);
  }

  async deleteMeal(userId, id) {
    const deleted = await this.logs.deleteMeal(userId, id);
    if (!deleted) throw new NotFoundError('Meal log');
    return { deleted: true };
  }

  /** Macro totals for a day, or null when nothing was logged. */
  dailyMacroTotals(userId, date) {
    return this.logs.dailyMacroTotals(userId, date);
  }

  macroTrend(userId, days) {
    return this.logs.macroTotalsByDay(userId, days);
  }

  // --- Vitals --------------------------------------------------------------
  async logVitals(userId, payload = {}) {
    const known = { ...MEASURED_FIELDS, ...CONTEXT_FIELDS };
    const attributes = {
      measuredAt: payload.measuredAt ? new Date(payload.measuredAt) : new Date(),
      source: payload.source || 'manual',
      note: payload.note,
    };

    for (const [field, [min, max]] of Object.entries(known)) {
      if (payload[field] == null) continue;
      const value = Number(payload[field]);
      if (!Number.isFinite(value)) throw new ValidationError(`${field} must be a number`);
      if (value < min || value > max) {
        throw new ValidationError(`${field}=${value} is outside the plausible range ${min}-${max}`);
      }
      attributes[field] = value;
    }

    if (!Object.keys(known).some((field) => attributes[field] != null)) {
      throw new ValidationError(
        `Supply at least one reading: ${Object.keys(known).join(', ')}`);
    }

    const reading = await this.logs.createVitalReading(userId, attributes);

    // A recorded weight or waist changes the profile the model sees, so keep
    // staticData in step rather than letting the two drift apart.
    if (attributes.weight_kg != null || attributes.waist_cm != null) {
      await this.#syncProfileMeasurements(userId, attributes);
    }
    return reading;
  }

  async #syncProfileMeasurements(userId, attributes) {
    const user = await this.users.findById(userId);
    if (!user?.staticData) return;
    const staticData = { ...user.staticData.toObject() };
    if (attributes.weight_kg != null) staticData.weight = attributes.weight_kg;
    if (attributes.waist_cm != null) staticData.waist = attributes.waist_cm;
    await this.users.updateStaticData(userId, staticData);
  }

  listVitals(userId, options) {
    return this.logs.listVitalReadings(userId, options);
  }

  /** Latest measured biomarkers, for the assessment to prefer over estimates. */
  latestMeasuredBiomarkers(userId, maxAgeDays) {
    return this.logs.latestMeasuredBiomarkers(userId, maxAgeDays);
  }

  // --- Activity ------------------------------------------------------------
  /**
   * Manually logged exercise, stored as a wearable day.
   *
   * Deliberately reuses `watchHistory` rather than adding a parallel
   * collection: the model consumes activity through the wearable feature
   * bridge, and a second store would need reconciling with the first.
   */
  async logActivity(userId, payload = {}) {
    const minutes = Number(payload.active_minutes ?? payload.durationMinutes ?? 0);
    const steps = Number(payload.daily_steps ?? payload.steps ?? 0);
    if (minutes <= 0 && steps <= 0) {
      throw new ValidationError('Supply active_minutes or daily_steps');
    }

    const entry = {
      date: payload.date ? new Date(payload.date) : new Date(),
      daily_steps: steps || undefined,
      active_minutes: minutes || undefined,
      calories_burned: Number(payload.calories_burned) || undefined,
      sleep_hours: Number(payload.sleep_hours) || undefined,
      sleep_quality_score: Number(payload.sleep_quality_score) || undefined,
      resting_heart_rate: Number(payload.resting_heart_rate) || undefined,
      heart_rate_variability: Number(payload.heart_rate_variability) || undefined,
      source: 'manual',
    };

    const user = await this.users.appendWatchData(userId, [entry]);
    if (!user) throw new NotFoundError('User');
    return { recorded: 1, total: user.watchHistory.length };
  }
}

export default new LoggingService();
