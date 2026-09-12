/**
 * Data access for meal logs and vital readings.
 *
 * Refactoring applied: Extract Class + Hide Delegate. Aggregation runs as a
 * Mongo pipeline rather than fetching every log and summing in JavaScript --
 * a year of meal logs is thousands of documents, and the database is better at
 * grouping than the API process is.
 */
import mongoose from 'mongoose';

import MealLog, { MACRO_FIELDS } from '../models/MealLog.js';
import VitalReading, { MEASURED_FIELDS } from '../models/VitalReading.js';

/**
 * Cast a user id for use in an aggregation pipeline.
 *
 * `Model.find()` casts a string to an ObjectId using the schema, but
 * `Model.aggregate()` hands the pipeline to MongoDB untouched. A string in
 * `$match` therefore matches nothing -- and returns an empty result rather than
 * an error, so daily macro totals silently came back as "no meals logged" while
 * the meals sat in the collection.
 */
function asObjectId(id) {
  return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
}

/** Start of the UTC day containing `date`. */
function startOfDay(date) {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

export class LogRepository {
  // --- Meals ---------------------------------------------------------------
  createMeal(userId, attributes) {
    return MealLog.create({ ...attributes, user: userId });
  }

  listMeals(userId, { from, to, limit = 100 } = {}) {
    const query = { user: userId };
    if (from || to) {
      query.loggedAt = {};
      if (from) query.loggedAt.$gte = from;
      if (to) query.loggedAt.$lte = to;
    }
    return MealLog.find(query).sort({ loggedAt: -1 }).limit(limit).lean();
  }

  deleteMeal(userId, id) {
    return MealLog.findOneAndDelete({ _id: id, user: userId });
  }

  /**
   * Sum macros for one day. Returns null when nothing was logged.
   *
   * Null rather than a zeroed object on purpose: "ate nothing" and "logged
   * nothing" are different states, and the caller has to distinguish them to
   * avoid telling the model a user consumed 0 kcal.
   */
  async dailyMacroTotals(userId, date = new Date()) {
    const start = startOfDay(date);
    const end = new Date(start.getTime() + 86400000);

    const sums = Object.fromEntries(
      MACRO_FIELDS.map((field) => [field, { $sum: `$${field}` }]),
    );

    const [result] = await MealLog.aggregate([
      { $match: { user: asObjectId(userId), loggedAt: { $gte: start, $lt: end } } },
      { $group: { _id: null, meals: { $sum: 1 }, ...sums } },
    ]);

    if (!result) return null;
    const { _id, ...totals } = result;
    return { ...totals, date: start };
  }

  /**
   * Per-day macro totals over a window, newest first. Used for trends and for
   * the typical-intake fallback.
   */
  async macroTotalsByDay(userId, days = 14) {
    const since = startOfDay(new Date(Date.now() - days * 86400000));
    const sums = Object.fromEntries(
      MACRO_FIELDS.map((field) => [field, { $sum: `$${field}` }]),
    );

    return MealLog.aggregate([
      { $match: { user: asObjectId(userId), loggedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$loggedAt' } },
          meals: { $sum: 1 },
          ...sums,
        },
      },
      { $sort: { _id: -1 } },
    ]);
  }

  // --- Vitals --------------------------------------------------------------
  createVitalReading(userId, attributes) {
    return VitalReading.create({ ...attributes, user: userId });
  }

  listVitalReadings(userId, { limit = 100 } = {}) {
    return VitalReading.find({ user: userId }).sort({ measuredAt: -1 }).limit(limit).lean();
  }

  /**
   * The most recent value for each measurable biomarker, within `maxAgeDays`.
   *
   * Each field is resolved independently: a blood pressure taken this morning
   * and an HbA1c from a lab three weeks ago are both current for their own
   * measurement, and forcing them to come from one reading would discard the
   * older-but-still-valid one.
   *
   * Stale readings are excluded rather than used, because a year-old blood
   * pressure is not evidence about today.
   */
  async latestMeasuredBiomarkers(userId, maxAgeDays = 90) {
    const since = new Date(Date.now() - maxAgeDays * 86400000);
    const fields = Object.keys(MEASURED_FIELDS);

    const readings = await VitalReading.find({ user: userId, measuredAt: { $gte: since } })
      .sort({ measuredAt: -1 })
      .select([...fields, 'measuredAt'].join(' '))
      .lean();

    const measured = {};
    const measuredAt = {};
    for (const reading of readings) {
      for (const field of fields) {
        if (measured[field] == null && reading[field] != null) {
          measured[field] = reading[field];
          measuredAt[field] = reading.measuredAt;
        }
      }
    }
    return Object.keys(measured).length ? { measured, measuredAt } : null;
  }
}

export default new LogRepository();
