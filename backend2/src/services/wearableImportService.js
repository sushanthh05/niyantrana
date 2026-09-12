/**
 * Provider-agnostic wearable data import.
 *
 * Why import is the PRIMARY path rather than a fallback:
 *
 * Every consumer wearable API that a solo developer could plausibly use has
 * closed or is closing. Verified September 2026:
 *
 *   Google Fit          new signups closed 1 May 2024, APIs deprecating 2026
 *   Fitbit Web API      new signups closed 1 May 2024, sunsets September 2026
 *   Google Health API   replacement for both; every scope is Restricted, so
 *                       production access is gated behind a privacy and
 *                       security review
 *   Garmin              Connect Developer Program requires a legal entity and
 *                       rejects personal-use applications
 *
 * Withings and Oura still accept individual developers, and the ingest seam
 * here is deliberately shaped so either can be added as a provider later
 * (Strategy): a provider only has to produce records in the canonical shape.
 *
 * But an OAuth integration also requires the reviewer to own the device. File
 * import needs nothing, cannot be deprecated out from under the project, and
 * works for every provider that offers a data export -- which all of them do,
 * because data portability is a legal requirement in most of their markets.
 */
import { ValidationError } from '../domain/errors.js';
import { parseCsv } from '../domain/csv.js';

/**
 * The canonical shape, matching `watchDataSchema` and the six features the
 * model consumes.
 *
 * Each entry lists the aliases seen in real exports. Fitbit, Apple Health,
 * Oura, Withings and Google Takeout all name these differently; normalising at
 * the boundary means nothing downstream has to know which device produced a row.
 */
export const FIELD_ALIASES = {
  daily_steps: ['daily_steps', 'steps', 'step_count', 'totalSteps', 'stepCount',
    'Steps', 'value'],
  active_minutes: ['active_minutes', 'activeMinutes', 'fairlyActiveMinutes',
    'veryActiveMinutes', 'minutesVeryActive', 'minutesFairlyActive',
    'exercise_minutes', 'activity_minutes', 'moderate_activity'],
  sleep_hours: ['sleep_hours', 'sleepHours', 'hours_of_sleep', 'total_sleep_hours'],
  sleep_minutes: ['minutesAsleep', 'sleep_minutes', 'total_sleep_minutes',
    'total_sleep_duration', 'asleep_minutes'],
  sleep_quality_score: ['sleep_quality_score', 'efficiency', 'sleep_efficiency',
    'sleep_score', 'score', 'sleepScore'],
  resting_heart_rate: ['resting_heart_rate', 'restingHeartRate', 'resting_hr',
    'heart_rate', 'rhr', 'average_heart_rate'],
  heart_rate_variability: ['heart_rate_variability', 'hrv', 'dailyRmssd',
    'rmssd', 'average_hrv', 'hrv_rmssd'],
  calories_burned: ['calories_burned', 'caloriesOut', 'active_calories',
    'calories', 'total_calories'],
};

const DATE_ALIASES = ['date', 'dateTime', 'day', 'timestamp', 'startTime',
  'dateOfSleep', 'summary_date', 'Date'];

/** Plausible ranges. A value outside these is a unit error or a typo. */
const RANGES = {
  daily_steps: [0, 100000],
  active_minutes: [0, 1440],
  sleep_hours: [0, 24],
  sleep_quality_score: [0, 100],
  resting_heart_rate: [20, 220],
  heart_rate_variability: [0, 500],
  calories_burned: [0, 20000],
};

const SUPPORTED_SOURCES = ['fitbit', 'apple_health', 'oura', 'withings',
  'google_takeout', 'import', 'manual', 'demo'];

function pick(record, aliases) {
  for (const alias of aliases) {
    if (record[alias] !== undefined && record[alias] !== null && record[alias] !== '') {
      return record[alias];
    }
  }
  return undefined;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : undefined;
}

function toDate(value) {
  if (!value) return undefined;
  // Bare YYYY-MM-DD is parsed as UTC midnight, which is what a daily summary means.
  const text = String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

export class WearableImportService {
  /**
   * Normalise one raw record into the canonical shape.
   *
   * Returns null when the record carries no usable metric, so a header row or
   * a blank line is skipped rather than stored as an empty day.
   */
  static normalizeRecord(raw, source = 'import') {
    if (!raw || typeof raw !== 'object') return null;

    const date = toDate(pick(raw, DATE_ALIASES));
    if (!date) return null;

    const entry = { date, source };

    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (field === 'sleep_minutes') continue;   // folded into sleep_hours below
      const value = toNumber(pick(raw, aliases));
      if (value === undefined) continue;
      const [min, max] = RANGES[field] ?? [-Infinity, Infinity];
      // Out-of-range values are dropped, not clamped: clamping would invent a
      // plausible number, which is the failure mode this project exists to fix.
      if (value >= min && value <= max) entry[field] = value;
    }

    // Most exports give sleep in minutes; the model wants hours.
    if (entry.sleep_hours === undefined) {
      const minutes = toNumber(pick(raw, FIELD_ALIASES.sleep_minutes));
      if (minutes !== undefined && minutes >= 0 && minutes <= 1440) {
        entry.sleep_hours = Math.round((minutes / 60) * 100) / 100;
      }
    }

    const hasMetric = Object.keys(entry).some(
      (key) => key !== 'date' && key !== 'source',
    );
    return hasMetric ? entry : null;
  }

  /**
   * Flatten the per-metric shape Google Takeout and the Fitbit export use:
   * one file per metric, each an array of `{dateTime, value}`.
   *
   * Input: `{ steps: [{dateTime, value}], resting_heart_rate: [...] }`
   * Output: one record per day carrying every metric present for that day.
   */
  static flattenPerMetric(payload) {
    const byDay = new Map();

    for (const [metric, series] of Object.entries(payload)) {
      if (!Array.isArray(series)) continue;
      for (const point of series) {
        if (!point || typeof point !== 'object') continue;
        const date = toDate(point.dateTime ?? point.date ?? point.day);
        if (!date) continue;
        const key = dayKey(date);
        if (!byDay.has(key)) byDay.set(key, { date: key });
        // `value` may be a scalar or a nested object, as Fitbit does for HRV.
        const value = point.value ?? point.values ?? point;
        byDay.get(key)[metric] = typeof value === 'object'
          ? (value.dailyRmssd ?? value.value ?? undefined)
          : value;
      }
    }
    return [...byDay.values()];
  }

  /**
   * Parse an upload into canonical records.
   *
   * @param {string|object|Array} payload CSV text, a JSON array, or a
   *   per-metric object
   * @param {string} source provider label stored on each day
   */
  static parse(payload, source = 'import') {
    if (!SUPPORTED_SOURCES.includes(source)) {
      throw new ValidationError(
        `source must be one of: ${SUPPORTED_SOURCES.join(', ')}`);
    }

    let records;
    if (typeof payload === 'string') {
      const text = payload.trim();
      if (!text) throw new ValidationError('The upload is empty');
      if (text.startsWith('[') || text.startsWith('{')) {
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw new ValidationError('Malformed JSON'); }
        records = Array.isArray(parsed)
          ? parsed
          : WearableImportService.flattenPerMetric(parsed);
      } else {
        records = parseCsv(text);
      }
    } else if (Array.isArray(payload)) {
      records = payload;
    } else if (payload && typeof payload === 'object') {
      records = WearableImportService.flattenPerMetric(payload);
    } else {
      throw new ValidationError('Supply CSV text, a JSON array, or a per-metric object');
    }

    if (!records.length) throw new ValidationError('No rows found in the upload');

    // Later rows win on a duplicate date: re-importing an overlapping export
    // should update a day, not create a second copy of it.
    const byDay = new Map();
    let skipped = 0;
    for (const raw of records) {
      const entry = WearableImportService.normalizeRecord(raw, source);
      if (!entry) { skipped += 1; continue; }
      byDay.set(dayKey(entry.date), entry);
    }

    const days = [...byDay.values()].sort((a, b) => a.date - b.date);
    if (!days.length) {
      throw new ValidationError(
        'No usable rows. Each row needs a date and at least one of: '
        + Object.keys(RANGES).join(', '));
    }
    return { days, skipped, source };
  }
}

export default WearableImportService;
