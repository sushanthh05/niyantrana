import mongoose from 'mongoose';

// Schema for the ongoing daily watch data from Google Fit
const watchDataSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  daily_steps: Number,
  active_minutes: Number,
  calories_burned: Number,
  sleep_hours: Number,
  sleep_quality_score: Number,
  resting_heart_rate: Number,
  heart_rate_variability: Number,
});

// Schema for each final health report/prediction
const healthReportSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  prediction: {
    TG: Number,
    GGT: Number,
  },
  recommendations: {
    dietPlan: Object,
    exercisePlan: Object,
  },
});

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['calibrating', 'active'],
    default: 'active',
  },
  staticData: {
    age: Number,
    height: Number,
    weight: Number,
    gender: String,
    waist: Number,
    has_hereditary_risk: Boolean,
    bmr: Number,
  },
  watchHistory: [watchDataSchema], // New field for ongoing watch data
  healthHistory: [healthReportSchema],
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

export default User;