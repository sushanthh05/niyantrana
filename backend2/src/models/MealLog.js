/**
 * A logged meal, with the macros resolved at log time.
 *
 * Macros are stored on the log rather than looked up from `Food` on every read.
 * That is deliberate denormalisation: the food database is versioned (Anuvaad
 * INDB 2024.11) and a future release could change a value, which would silently
 * rewrite a user's history. A meal log records what was true when it was eaten.
 *
 * Replaces the frontend's `localStorage['mealLogs']`, which meant health data
 * lived only on one device and was lost when site data was cleared.
 */
import mongoose from 'mongoose';

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

/** Macro fields, in the vocabulary the inference service expects. */
export const MACRO_FIELDS = ['energy_kcal', 'fat_g', 'carb_g', 'protein_g',
  'sugar_g', 'fibre_g', 'satfat_g'];

const mealLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  loggedAt: { type: Date, default: Date.now, index: true },

  foodName: { type: String, required: true, trim: true },
  foodCode: { type: String },
  mealType: { type: String, enum: MEAL_TYPES, default: 'snack' },
  servings: { type: Number, default: 1, min: 0.05, max: 50 },

  energy_kcal: { type: Number, required: true, min: 0 },
  fat_g: { type: Number, min: 0, default: 0 },
  carb_g: { type: Number, min: 0, default: 0 },
  protein_g: { type: Number, min: 0, default: 0 },
  sugar_g: { type: Number, min: 0, default: 0 },
  fibre_g: { type: Number, min: 0, default: 0 },
  satfat_g: { type: Number, min: 0, default: 0 },
}, { timestamps: true });

// Daily aggregation always filters by user and orders by time.
mealLogSchema.index({ user: 1, loggedAt: -1 });

export default mongoose.models.MealLog || mongoose.model('MealLog', mealLogSchema);
