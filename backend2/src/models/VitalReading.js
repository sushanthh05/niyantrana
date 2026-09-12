/**
 * A measured vital sign or lab value.
 *
 * These are the one input that outranks the model. When a user records a real
 * blood pressure or a real HbA1c from a lab report, the assessment must use
 * that number rather than an estimate, and report `provenance: "heuristic"`
 * instead of `"model"`. The inference service already accepts a `measured`
 * block for exactly this; this collection is what fills it.
 *
 * Replaces the frontend's `localStorage['vitalLogs']` and the write-only
 * `localStorage['bloodTestReports']`, which nothing ever read back.
 */
import mongoose from 'mongoose';

/**
 * Fields the inference service recognises as measured biomarkers, with the
 * plausible range each is accepted within. Anything outside is a typo, not a
 * reading -- and a typo that reaches the assessment is worse than a rejection.
 */
export const MEASURED_FIELDS = {
  systolic_bp: [60, 260],
  diastolic_bp: [30, 160],
  hba1c: [3, 20],
  triglycerides: [20, 1500],
  ggt: [3, 1000],
};

/** Recorded for context and trends, but not sent to the model. */
export const CONTEXT_FIELDS = {
  fasting_glucose: [30, 600],
  weight_kg: [20, 400],
  waist_cm: [30, 250],
};

const shape = (ranges) => Object.fromEntries(
  Object.entries(ranges).map(([name, [min, max]]) => [name, { type: Number, min, max }]),
);

const vitalReadingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  measuredAt: { type: Date, default: Date.now, index: true },

  ...shape(MEASURED_FIELDS),
  ...shape(CONTEXT_FIELDS),

  // 'lab' readings are the most trustworthy; 'device' covers a home BP cuff.
  source: { type: String, enum: ['manual', 'device', 'lab'], default: 'manual' },
  note: { type: String, maxlength: 500 },
}, { timestamps: true });

vitalReadingSchema.index({ user: 1, measuredAt: -1 });

/** True when the reading carries at least one value the model can use. */
vitalReadingSchema.methods.hasMeasuredBiomarker = function hasMeasuredBiomarker() {
  return Object.keys(MEASURED_FIELDS).some((field) => this[field] != null);
};

export default mongoose.models.VitalReading
  || mongoose.model('VitalReading', vitalReadingSchema);
