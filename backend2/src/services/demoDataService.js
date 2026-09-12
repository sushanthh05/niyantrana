/**
 * Populates an account with a realistic history.
 *
 * Necessary because the wearable API landscape closed (see
 * `wearableImportService.js`): a reviewer opening the live URL owns no device
 * and has no export to upload, so without this the app is an empty shell and
 * the trajectory feature has nothing to draw.
 *
 * Two rules make this safe to ship in a health product:
 *
 * 1. Every generated day is stored with `source: 'demo'`, so seeded data is
 *    distinguishable from a real device export at the record level -- not just
 *    by a banner in the UI that could be missed or removed.
 * 2. The generator produces *plausible* data, never *flattering* data. The
 *    profile genuinely scores as at-risk, because a demo that only ever shows
 *    green tells a reviewer nothing about the model. It was also chosen by
 *    measurement rather than by feel -- see DEMO_PROFILE.
 */
import { ValidationError } from '../domain/errors.js';
import loggingService from './loggingService.js';
import userRepository from '../repositories/userRepository.js';
import Food from '../models/Food.js';

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

export const TRENDS = ['improving', 'declining', 'stable'];

/**
 * A moderate-risk profile, chosen by measurement rather than by feel.
 *
 * The first version used BMI 31 / waist 106. That scores convincingly high --
 * and produces an almost FLAT trajectory, because the classifiers saturate in
 * that region: waist and BMI dominate, so ninety days of improving activity
 * moved the scores by under 0.4 points a week. A reviewer would see four red
 * dials and four straight lines, which demonstrates nothing.
 *
 * Measured slopes over the generator's own 90-day improving curve:
 *
 *   BMI 31 / waist 106   fatty -0.12  hyper +0.23  dysgl -0.39  diab -0.39
 *   BMI 28 / waist  97   fatty -2.16  hyper -0.00  dysgl  0.00  diab -0.20
 *   BMI 25 / waist  90   fatty -0.12  hyper  0.00  dysgl -0.01  diab -0.00
 *
 * BMI 28 sits in the responsive band: high enough to flag real risk, low enough
 * that behaviour change visibly moves it. That is the honest demonstration.
 */
export const DEMO_PROFILE = {
  age: 45,
  height: 175,
  weight: 86,
  gender: 'M',
  waist: 97,
  has_hereditary_risk: true,
  alcohol_drinks_week: 8,
  smoking_status: 1,
};

/**
 * Deterministic pseudo-random generator.
 *
 * A fixed seed means a demo account looks the same every time it is rebuilt,
 * which matters when a screenshot in the README has to match what a reviewer
 * sees when they click the link.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DemoDataService {
  constructor({ users = userRepository, logs = loggingService } = {}) {
    this.users = users;
    this.logs = logs;
  }

  /**
   * Generate wearable days, oldest first.
   *
   * Correlations are deliberate rather than independent noise: as activity and
   * sleep improve, resting heart rate falls and HRV rises, which is how real
   * fitness data behaves. Independent random columns would let the trajectory
   * feature show a trend in one metric while another contradicted it.
   */
  static generateWearableDays({ days = DEFAULT_DAYS, trend = 'improving', seed = 42 } = {}) {
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      throw new ValidationError(`days must be an integer between 1 and ${MAX_DAYS}`);
    }
    if (!TRENDS.includes(trend)) {
      throw new ValidationError(`trend must be one of: ${TRENDS.join(', ')}`);
    }

    const random = mulberry32(seed);
    const entries = [];

    for (let i = 0; i < days; i += 1) {
      const date = new Date(Date.now() - (days - 1 - i) * 86400000);
      date.setUTCHours(12, 0, 0, 0);

      // 0 -> 1 across the window, then shaped by the requested direction.
      const elapsed = days === 1 ? 1 : i / (days - 1);
      const progress = trend === 'improving' ? elapsed
        : trend === 'declining' ? 1 - elapsed
          : 0.5;

      // Weekends are less active for most desk workers; without this the data
      // looks synthetic at a glance.
      const isWeekend = [0, 6].includes(date.getUTCDay());
      const weekend = isWeekend ? 0.75 : 1.0;
      const jitter = () => (random() - 0.5) * 2;   // -1 .. 1

      const steps = Math.round((3200 + 7800 * progress) * weekend + jitter() * 900);
      const activeMinutes = Math.round((9 + 58 * progress) * weekend + jitter() * 7);
      const sleepHours = 5.5 + 2.0 * progress + jitter() * 0.5;
      const sleepScore = Math.round(60 + 28 * progress + jitter() * 6);
      const restingHeartRate = Math.round(77 - 12 * progress + jitter() * 3);
      const hrv = Math.round(30 + 26 * progress + jitter() * 4);

      entries.push({
        date,
        daily_steps: Math.max(0, steps),
        active_minutes: Math.max(0, activeMinutes),
        sleep_hours: Math.round(Math.min(11, Math.max(3, sleepHours)) * 100) / 100,
        sleep_quality_score: Math.min(100, Math.max(0, sleepScore)),
        resting_heart_rate: Math.min(120, Math.max(40, restingHeartRate)),
        heart_rate_variability: Math.max(5, hrv),
        calories_burned: Math.round(1900 + 700 * progress + jitter() * 120),
        source: 'demo',
      });
    }
    return entries;
  }

  /**
   * Seed an account: profile, wearable history and recent meals.
   *
   * Idempotent by replacement -- calling it twice does not double the history,
   * because a reviewer clicking a "load demo data" button twice should not end
   * up with 180 days.
   */
  async seed(userId, { days = DEFAULT_DAYS, trend = 'improving',
    seed = 42, mealDays = 3 } = {}) {
    const entries = DemoDataService.generateWearableDays({ days, trend, seed });

    await this.users.updateStaticData(userId, {
      ...DEMO_PROFILE,
      // BMR is recomputed by the user service; passing it here would go stale.
      bmr: undefined,
    });
    await this.users.replaceWatchData(userId, entries);

    const meals = await this.#seedMeals(userId, mealDays);

    return {
      profile: DEMO_PROFILE,
      wearableDays: entries.length,
      trend,
      mealsLogged: meals,
      source: 'demo',
      notice: 'This history was generated for demonstration. '
        + 'Every wearable day is stored with source "demo".',
    };
  }

  /**
   * Log a few realistic Indian meals per day from the Anuvaad database.
   *
   * Uses real food rows so the macros are genuine values from the reference
   * data rather than numbers invented here.
   */
  async #seedMeals(userId, mealDays) {
    if (mealDays < 1) return 0;

    const wanted = ['idli', 'biryani', 'dal', 'chapati', 'paneer', 'chai'];
    const found = [];
    for (const term of wanted) {
      const [match] = await Food.find({ food_name: { $regex: term, $options: 'i' } })
        .limit(1).lean();
      if (match) found.push(match);
    }
    if (!found.length) return 0;   // food collection not seeded

    const mealTypes = ['breakfast', 'lunch', 'dinner'];
    let logged = 0;
    for (let day = 0; day < mealDays; day += 1) {
      for (let slot = 0; slot < mealTypes.length; slot += 1) {
        const food = found[(day * mealTypes.length + slot) % found.length];
        await this.logs.logMeal(userId, {
          foodCode: food.food_code,
          foodName: food.food_name,
          servings: slot === 1 ? 2 : 1,
          mealType: mealTypes[slot],
          loggedAt: new Date(Date.now() - day * 86400000),
        });
        logged += 1;
      }
    }
    return logged;
  }
}

export default new DemoDataService();
