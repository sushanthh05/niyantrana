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
import userService from './userService.js';

const REQUIRED_WEARABLE_DAYS = 14;
const ACTIVITY_FACTOR_LIGHT = 1.375;

export class RiskService {
  constructor({
    users = userRepository,
    inference = inferenceClient,
    profiles = userService,
  } = {}) {
    this.users = users;
    this.inference = inference;
    this.profiles = profiles;
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
      // Aggregated from logged meals.
      calorie_intake: dietTotals.energy_kcal ?? 0,
      fat_grams: dietTotals.fat_g ?? 0,
      carbs_grams: dietTotals.carb_g ?? 0,
      protein_grams: dietTotals.protein_g ?? 0,
      sugar_g: dietTotals.sugar_g ?? 0,
      fibre_g: dietTotals.fibre_g ?? 0,
      satfat_g: dietTotals.satfat_g ?? 0,
    };
  }

  async assess(userId, { dietTotals, measured } = {}) {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User');

    if (!user.canBeAssessed()) {
      const missing = ['age', 'height', 'weight', 'gender', 'waist']
        .filter((field) => !user.staticData?.[field]);
      throw new ValidationError('Complete your profile before requesting an assessment', { missing });
    }

    const window = await this.profiles.recentWearableData(userId, REQUIRED_WEARABLE_DAYS);
    if (window.length < REQUIRED_WEARABLE_DAYS) {
      // An honest refusal. v1 generated `5000 + i * 100` steps and carried on,
      // producing a confident risk score from data that did not exist.
      throw new ValidationError(
        `An assessment needs ${REQUIRED_WEARABLE_DAYS} days of wearable data; `
        + `${window.length} recorded so far.`,
        { required: REQUIRED_WEARABLE_DAYS, available: window.length },
      );
    }

    const assessment = await this.inference.assessRisk({
      profile: RiskService.toProfilePayload(user.staticData, dietTotals),
      wearableWindow: window,
      measured,
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

    return assessment;
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
