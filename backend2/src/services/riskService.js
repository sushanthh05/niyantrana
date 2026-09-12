/**
 * Orchestrates a risk assessment.
 *
 * Pattern applied: Facade over the user repository and the inference client.
 *
 * This class is the direct replacement for apiRoutes.js, which was a 138-line
 * Long Method that fetched the user, fabricated wearable data when none
 * existed, called the ML service, substituted random biomarkers on any failure,
 * re-implemented the Fatty Liver Index in JavaScript, and attached a hardcoded
 * "Oats / Salad / Soup" action plan.
 *
 * Every one of those fallbacks is gone. If an assessment cannot be produced,
 * that fact is reported. In a health application, a plausible invented number
 * is worse than an error.
 */
import inferenceClient from '../clients/inferenceClient.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { bodyMassIndex } from '../domain/metabolic.js';
import userRepository from '../repositories/userRepository.js';
import loggingService from './loggingService.js';
import userService from './userService.js';

const REQUIRED_WEARABLE_DAYS = 14;

// How much history to send for trajectory analysis. 90 days gives roughly a
// dozen 7-day-stepped windows, which is enough to fit a trend without making
// the payload or the inference cost grow without bound.
const TRAJECTORY_HISTORY_DAYS = 90;
const ACTIVITY_FACTOR_LIGHT = 1.375;

export class RiskService {
  constructor({
    users = userRepository,
    inference = inferenceClient,
    profiles = userService,
    logs = loggingService,
  } = {}) {
    this.users = users;
    this.inference = inference;
    this.profiles = profiles;
    this.logs = logs;
  }

  /**
   * Translates stored documents into the inference wire format.
   *
   * Refactoring: Extract Method. v1 built this object inline and omitted every
   * dietary field, while leaving a comment admitting the model needed them --
   * so the model branch that consumes them received nothing usable.
   */
  static toProfilePayload(staticData, dietTotals = {}) {
    return {
      age: staticData.age,
      gender: staticData.gender,
      height: staticData.height,
      weight: staticData.weight,
      bmi: bodyMassIndex(staticData.weight, staticData.height),
      waist: staticData.waist,
      has_hereditary_risk: Boolean(staticData.has_hereditary_risk),
      alcohol_drinks_week: staticData.alcohol_drinks_week ?? 0,
      smoking_status: staticData.smoking_status ?? 0,
      // Aggregated server-side from logged meals. null, never 0, when nothing
      // has been logged: "ate nothing" and "logged nothing" are different
      // states, and zero calories is a fabrication the model would believe.
      // The gradient-boosting estimators handle the resulting NaN natively.
      calorie_intake: dietTotals?.energy_kcal ?? null,
      fat_grams: dietTotals?.fat_g ?? null,
      carbs_grams: dietTotals?.carb_g ?? null,
      protein_grams: dietTotals?.protein_g ?? null,
      sugar_g: dietTotals?.sugar_g ?? null,
      fibre_g: dietTotals?.fibre_g ?? null,
      satfat_g: dietTotals?.satfat_g ?? null,
    };
  }

  /**
   * Daily macros from the user own meal logs.
   *
   * Today first; if nothing is logged yet today, the most recent day that has
   * meals, so an assessment run at 9am does not report a fasting diet. Returns
   * null when the user has never logged a meal.
   */
  async #dietTotalsFor(userId) {
    const today = await this.logs.dailyMacroTotals(userId);
    if (today) return today;

    const recent = await this.logs.macroTrend(userId, 7);
    return recent.length ? recent[0] : null;
  }

  /**
   * Produce an assessment.
   *
   * Diet totals and measured biomarkers are read from the user own logs, NOT
   * taken from the caller. Previously the client supplied `dietTotals`, so a
   * browser could assert any nutrition figures it liked and the model would
   * treat them as observed intake.
   */
  async assess(userId, { measured } = {}) {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User');

    if (!user.canBeAssessed()) {
      const missing = ['age', 'height', 'weight', 'gender', 'waist']
        .filter((field) => !user.staticData?.[field]);
      throw new ValidationError('Complete your profile before requesting an assessment', { missing });
    }

    // One read covers both needs: the tail is the 14-day window the model
    // scores, the whole run is the history the trajectory walks.
    const history = await this.profiles.recentWearableData(userId, TRAJECTORY_HISTORY_DAYS);
    const window = history.slice(-REQUIRED_WEARABLE_DAYS);
    if (window.length < REQUIRED_WEARABLE_DAYS) {
      // An honest refusal. v1 generated `5000 + i * 100` steps and carried on,
      // producing a confident risk score from data that did not exist.
      throw new ValidationError(
        `An assessment needs ${REQUIRED_WEARABLE_DAYS} days of wearable data; `
        + `${window.length} recorded so far.`,
        { required: REQUIRED_WEARABLE_DAYS, available: window.length },
      );
    }

    const [dietTotals, recorded] = await Promise.all([
      this.#dietTotalsFor(userId),
      this.logs.latestMeasuredBiomarkers(userId),
    ]);

    const assessment = await this.inference.assessRisk({
      profile: RiskService.toProfilePayload(user.staticData, dietTotals),
      wearableWindow: window,
      history,
      // Explicitly supplied lab values win; otherwise the most recent recorded
      // reading per biomarker is used.
      measured: measured ?? recorded?.measured ?? null,
    });

    // Persist for trend analysis. healthHistory existed in the v1 schema but
    // nothing ever wrote to it (Dead Code).
    await this.users.appendHealthReport(userId, {
      biomarkers: assessment.biomarkers,
      risks: assessment.risks?.map(({ condition, score, band, rationale }) => ({
        condition, score, band, rationale,
      })),
      provenance: assessment.provenance,
    });

    return {
      ...assessment,
      inputs: {
        wearableDays: window.length,
        historyDays: history.length,
        dietLoggedOn: dietTotals?.date ?? dietTotals?._id ?? null,
        mealsCounted: dietTotals?.meals ?? 0,
        measuredBiomarkers: Object.keys(recorded?.measured ?? {}),
      },
    };
  }

  async recommendMeal(userId, meal) {
    if (!meal?.name) throw new ValidationError('A meal name is required');

    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User');

    const latest = user.healthHistory?.[user.healthHistory.length - 1];
    return this.inference.recommendMeal({
      userContext: {
        predicted_tg: latest?.biomarkers?.triglycerides ?? null,
        calorie_target: user.staticData?.bmr
          ? Math.round(user.staticData.bmr * ACTIVITY_FACTOR_LIGHT)
          : null,
      },
      meal,
    });
  }
}

export default new RiskService();
