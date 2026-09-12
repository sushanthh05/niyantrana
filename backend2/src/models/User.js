/**
 * User persistence schema.
 *
 * Fixes carried over from v1:
 * - `watchDataSchema` declared `calories_burned` / `resting_heart_rate` while the
 *   ingest route wrote `active_calories` / `heart_rate`. Mongoose strict mode
 *   silently discarded both, so two of six model features were always absent.
 *   Aliases now accept either spelling.
 * - `password` was returned by default on every query. It is now `select: false`.
 * - `healthReportSchema` existed but nothing ever wrote to it (Dead Code); it is
 *   now actually populated by the risk service.
 */
import mongoose from 'mongoose';

const watchDataSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now, index: true },
  daily_steps: { type: Number, min: 0 },
  active_minutes: { type: Number, min: 0 },
  calories_burned: { type: Number, min: 0, alias: 'active_calories' },
  sleep_hours: { type: Number, min: 0, max: 24 },
  sleep_quality_score: { type: Number, min: 0, max: 100 },
  resting_heart_rate: { type: Number, min: 20, max: 220, alias: 'heart_rate' },
  heart_rate_variability: { type: Number, min: 0 },
  // Naming the provider matters for trust: a reviewer looking at a populated
  // demo account must be able to tell seeded data from a real device export.
  source: {
    type: String,
    enum: ['fitbit', 'apple_health', 'oura', 'withings', 'google_takeout',
      'import', 'manual', 'demo'],
    default: 'manual',
  },
}, { _id: false });

const riskScoreSchema = new mongoose.Schema({
  condition: String,
  score: Number,
  band: { type: String, enum: ['low', 'moderate', 'high'] },
  rationale: String,
}, { _id: false });

const healthReportSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  biomarkers: {
    triglycerides: Number,
    ggt: Number,
    hba1c: Number,
    systolic_bp: Number,
    diastolic_bp: Number,
  },
  risks: [riskScoreSchema],
  // Never store a score without recording where it came from.
  provenance: { type: String, enum: ['model', 'simulation', 'heuristic'], required: true },
}, { _id: false });

const staticDataSchema = new mongoose.Schema({
  age: { type: Number, min: 18, max: 120 },
  height: { type: Number, min: 50, max: 260 },
  weight: { type: Number, min: 20, max: 400 },
  gender: { type: String, enum: ['M', 'F'] },
  waist: { type: Number, min: 30, max: 250 },
  has_hereditary_risk: { type: Boolean, default: false },
  alcohol_drinks_week: { type: Number, min: 0, default: 0 },
  smoking_status: { type: Number, enum: [0, 1, 2], default: 0 },
  bmr: Number,
}, { _id: false });

const fitbitSchema = new mongoose.Schema({
  userId: String,
  accessToken: { type: String, select: false },
  refreshToken: { type: String, select: false },
  expiresAt: Date,
  connectedAt: Date,
}, { _id: false });

const userSchema = new mongoose.Schema({
  email: {
    type: String, required: true, unique: true, lowercase: true, trim: true, index: true,
  },
  password: { type: String, required: true, select: false },
  status: { type: String, enum: ['calibrating', 'active'], default: 'calibrating' },
  staticData: { type: staticDataSchema, default: () => ({}) },
  watchHistory: { type: [watchDataSchema], default: [] },
  healthHistory: { type: [healthReportSchema], default: [] },
  fitbit: { type: fitbitSchema, select: false },
}, { timestamps: true });

/** Whether enough profile data exists to run an assessment. */
userSchema.methods.canBeAssessed = function canBeAssessed() {
  const d = this.staticData || {};
  return Boolean(d.age && d.height && d.weight && d.gender && d.waist);
};

export default mongoose.models.User || mongoose.model('User', userSchema);
