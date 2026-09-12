/**
 * HTTP adapters for wearable import and demo seeding.
 *
 * Import is the primary wearable path. Every consumer API a solo developer
 * could use has closed to new registrations (see wearableImportService.js), so
 * a file export is the only route that cannot be deprecated out from under the
 * project -- and it needs no device, which matters when the reviewer of a
 * portfolio project owns none.
 */
import { ValidationError } from '../domain/errors.js';
import demoDataService from '../services/demoDataService.js';
import userRepository from '../repositories/userRepository.js';
import WearableImportService, { FIELD_ALIASES } from '../services/wearableImportService.js';

const MAX_IMPORT_DAYS = 400;

export async function importWearableData(req, res) {
  // Accept a raw CSV/JSON body, or a JSON envelope carrying the payload.
  const isEnvelope = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    && (req.body.data !== undefined || req.body.payload !== undefined);
  const payload = isEnvelope ? (req.body.data ?? req.body.payload) : req.body;
  const source = (isEnvelope ? req.body.source : req.query.source) || 'import';

  const { days, skipped } = WearableImportService.parse(payload, source);
  if (days.length > MAX_IMPORT_DAYS) {
    throw new ValidationError(`Import is limited to ${MAX_IMPORT_DAYS} days per request`, {
      received: days.length,
    });
  }

  const result = await userRepository.upsertWatchData(req.user.id, days);
  res.status(201).json({
    imported: days.length,
    skipped,
    source,
    ...result,
    range: { from: days[0].date, to: days[days.length - 1].date },
  });
}

export async function loadDemoData(req, res) {
  const days = Number(req.body?.days) || 90;
  const trend = req.body?.trend || 'improving';
  const result = await demoDataService.seed(req.user.id, { days, trend });
  res.status(201).json(result);
}

export function importFormats(_req, res) {
  res.json({
    accepts: ['text/csv', 'application/json'],
    sources: ['fitbit', 'apple_health', 'oura', 'withings', 'google_takeout', 'import', 'manual'],
    canonicalFields: Object.keys(FIELD_ALIASES).filter((f) => f !== 'sleep_minutes'),
    fieldAliases: FIELD_ALIASES,
    note: 'Send CSV text, a JSON array of daily records, or a per-metric object '
      + '({ steps: [{dateTime, value}], ... }) as produced by Google Takeout. '
      + 'Column names are matched against a wide alias list, so most exports '
      + 'import without transformation.',
  });
}
