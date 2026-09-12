/**
 * Day 10 integration tests: wearable import and demo seeding.
 *
 * Import replaced the planned Fitbit OAuth integration. Verified September
 * 2026: Fitbit Web API closed to new developers on 1 May 2024 and sunsets this
 * month; its replacement (Google Health API) gates every scope behind a
 * restricted-scope privacy review; Google Fit closed the same day; Garmin
 * requires a legal entity. A file export is the only wearable path that cannot
 * be deprecated out from under this project, and it needs no device -- which
 * matters when the reviewer of a portfolio project owns none.
 *
 * Prerequisites:
 *   docker run -d --name niy-mongo -p 27017:27017 mongo:7
 *   docker run -d --name niy-ml -p 8000:8000 niyantrana-inference:v2
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/niyantrana_test';
process.env.SESSION_SECRET ??= 'integration-test-secret-key-long-enough';
process.env.ML_SERVICE_URL ??= 'http://127.0.0.1:8000';

const { default: mongoose } = await import('mongoose');
const { createApp } = await import('../src/app.js');
const { default: MealLog } = await import('../src/models/MealLog.js');
const { default: User } = await import('../src/models/User.js');
const { default: WearableImportService } = await import('../src/services/wearableImportService.js');
const { DemoDataService } = await import('../src/services/demoDataService.js');
const { parseCsv } = await import('../src/domain/csv.js');

const RUN = `wear${Date.now()}`;
const OWNED = new RegExp(`^[a-z]+-${RUN}@niyantrana\\.test$`);
const EMAIL = `wear-${RUN}@niyantrana.test`;
const PASSWORD = 'a-sufficiently-long-password';

let server;
let baseUrl;
let cookie = '';
let userId;

async function call(path, { method = 'GET', body, auth = true, raw, contentType } = {}) {
  const headers = { 'Content-Type': contentType || 'application/json' };
  if (auth && cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, body: json };
}

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await call('/auth/register', { method: 'POST', auth: false, body: { email: EMAIL, password: PASSWORD } });
  await call('/auth/login', { method: 'POST', auth: false, body: { email: EMAIL, password: PASSWORD } });
  userId = (await User.findOne({ email: EMAIL }).lean())._id;
});

after(async () => {
  await MealLog.deleteMany({ user: userId });
  await User.deleteMany({ email: OWNED });
  await mongoose.disconnect();
  server?.close();
});

// --- Normalisation, no database needed --------------------------------------
describe('export normalisation', () => {
  it('reads a generic CSV with quoted comma-formatted numbers', () => {
    const csv = 'date,steps,minutesAsleep,restingHeartRate,hrv\n'
      + '2026-09-01,"9,412",431,63,48\n2026-09-02,7100,402,65,44\n';
    const { days } = WearableImportService.parse(csv, 'fitbit');
    assert.equal(days.length, 2);
    assert.equal(days[0].daily_steps, 9412, 'the thousands separator must not break parsing');
    assert.equal(days[0].sleep_hours, 7.18, '431 minutes must convert to hours');
    assert.equal(days[0].source, 'fitbit');
  });

  it('reads Oura-style field names', () => {
    const { days } = WearableImportService.parse(
      [{ day: '2026-09-01', score: 82, average_heart_rate: 61, total_sleep_duration: 420 }],
      'oura');
    assert.equal(days[0].sleep_quality_score, 82);
    assert.equal(days[0].resting_heart_rate, 61);
    assert.equal(days[0].sleep_hours, 7);
  });

  it('flattens the per-metric shape Google Takeout produces', () => {
    const { days } = WearableImportService.parse({
      steps: [{ dateTime: '2026-09-01', value: '8800' }, { dateTime: '2026-09-02', value: '6100' }],
      resting_heart_rate: [{ dateTime: '2026-09-01', value: { value: 62 } }],
    }, 'google_takeout');
    assert.equal(days.length, 2);
    assert.equal(days[0].daily_steps, 8800);
    assert.equal(days[0].resting_heart_rate, 62, 'a nested value object must be unwrapped');
  });

  it('drops out-of-range values rather than clamping them', () => {
    // Clamping would invent a plausible number, which is the failure mode this
    // whole project exists to remove.
    const { days } = WearableImportService.parse(
      [{ date: '2026-09-03', steps: 999999, resting_heart_rate: 61 }], 'import');
    assert.equal(days[0].daily_steps, undefined, '999,999 steps must be discarded');
    assert.equal(days[0].resting_heart_rate, 61, 'valid fields on the same row survive');
  });

  it('collapses duplicate dates, keeping the later row', () => {
    const { days } = WearableImportService.parse(
      [{ date: '2026-09-04', steps: 100 }, { date: '2026-09-04', steps: 200 }], 'import');
    assert.equal(days.length, 1);
    assert.equal(days[0].daily_steps, 200);
  });

  it('skips rows with no date or no usable metric', () => {
    const { days, skipped } = WearableImportService.parse(
      [{ steps: 5000 }, { date: '2026-09-05' }, { date: '2026-09-06', steps: 7000 }], 'import');
    assert.equal(days.length, 1);
    assert.equal(skipped, 2);
  });

  it('rejects malformed and empty uploads', () => {
    assert.throws(() => WearableImportService.parse('', 'import'), /empty/i);
    assert.throws(() => WearableImportService.parse('{not json', 'import'), /Malformed JSON/);
    assert.throws(() => WearableImportService.parse([{ nothing: 1 }], 'import'), /No usable rows/);
    assert.throws(() => WearableImportService.parse([{ date: '2026-09-01' }], 'nope'), /source must be/);
  });

  it('parses CSV fields containing commas', () => {
    const rows = parseCsv('a,b\n1,"x, y"\n');
    assert.equal(rows[0].b, 'x, y');
  });
});

// --- Import over HTTP -------------------------------------------------------
describe('import endpoint', () => {
  it('documents its accepted formats without authentication', async () => {
    const { status, body } = await call('/api/wearable/formats', { auth: false });
    assert.equal(status, 200);
    assert.ok(body.canonicalFields.includes('daily_steps'));
    assert.ok(body.sources.includes('oura'));
  });

  it('requires authentication to import', async () => {
    const saved = cookie;
    cookie = '';
    const { status } = await call('/api/wearable/import', {
      method: 'POST', auth: false, body: { data: [{ date: '2026-09-01', steps: 5000 }] },
    });
    assert.equal(status, 401);
    cookie = saved;
  });

  it('imports raw CSV posted as text/csv', async () => {
    let csv = 'date,steps,active_minutes,minutesAsleep,efficiency,restingHeartRate,hrv\n';
    for (let i = 20; i >= 1; i -= 1) {
      const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      csv += `${date},${6000 + i * 50},${25 + i},${400 + i},${72},${68},${42}\n`;
    }
    const { status, body } = await call('/api/wearable/import?source=fitbit', {
      method: 'POST', raw: csv, contentType: 'text/csv',
    });
    assert.equal(status, 201);
    assert.equal(body.imported, 20);
    assert.equal(body.added, 20);
  });

  it('re-importing the same range updates rather than duplicates', async () => {
    const day = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const first = await call('/api/wearable/import', {
      method: 'POST', body: { source: 'import', data: [{ date: day, steps: 11111 }] },
    });
    assert.equal(first.body.updated, 1, 'the day already existed from the CSV import');

    const stored = await User.findById(userId).lean();
    const matching = stored.watchHistory.filter(
      (d) => new Date(d.date).toISOString().slice(0, 10) === day);
    assert.equal(matching.length, 1, 'a duplicate day would corrupt the 14-day window');
    assert.equal(matching[0].daily_steps, 11111);
  });

  it('an import makes an assessment possible', async () => {
    await call('/api/user/profile', {
      method: 'POST',
      body: { age: 52, height: 174, weight: 94, gender: 'M', waist: 106 },
    });
    const { status, body } = await call('/api/predict', { method: 'POST', body: {} });
    if (status === 503) return;   // ML service unavailable
    assert.equal(status, 200);
    assert.equal(body.inputs.wearableDays, 14);
    assert.equal(body.risks.length, 4);
  });
});

// --- Demo seeding -----------------------------------------------------------
describe('demo seeding', () => {
  it('generates correlated, not independently random, data', () => {
    const days = DemoDataService.generateWearableDays({ days: 90, trend: 'improving' });
    assert.equal(days.length, 90);

    const first = days.slice(0, 14);
    const last = days.slice(-14);
    const mean = (rows, key) => rows.reduce((sum, r) => sum + r[key], 0) / rows.length;

    // As activity and sleep improve, resting heart rate must fall and HRV rise.
    // Independent noise would let the trajectory show contradictory metrics.
    assert.ok(mean(last, 'daily_steps') > mean(first, 'daily_steps'));
    assert.ok(mean(last, 'sleep_hours') > mean(first, 'sleep_hours'));
    assert.ok(mean(last, 'resting_heart_rate') < mean(first, 'resting_heart_rate'));
    assert.ok(mean(last, 'heart_rate_variability') > mean(first, 'heart_rate_variability'));
  });

  it('is deterministic, so a README screenshot keeps matching', () => {
    const a = DemoDataService.generateWearableDays({ days: 30, seed: 7 });
    const b = DemoDataService.generateWearableDays({ days: 30, seed: 7 });
    assert.deepEqual(a.map((d) => d.daily_steps), b.map((d) => d.daily_steps));
  });

  it('labels every generated day as demo data', () => {
    // Not just a UI banner: seeded data must be distinguishable at the record
    // level, in a health product.
    const days = DemoDataService.generateWearableDays({ days: 10 });
    assert.ok(days.every((d) => d.source === 'demo'));
  });

  it('produces physiologically plausible values throughout', () => {
    for (const trend of ['improving', 'declining', 'stable']) {
      for (const day of DemoDataService.generateWearableDays({ days: 120, trend })) {
        assert.ok(day.daily_steps >= 0 && day.daily_steps < 30000, `steps ${day.daily_steps}`);
        assert.ok(day.sleep_hours >= 3 && day.sleep_hours <= 11, `sleep ${day.sleep_hours}`);
        assert.ok(day.resting_heart_rate >= 40 && day.resting_heart_rate <= 120);
        assert.ok(day.sleep_quality_score >= 0 && day.sleep_quality_score <= 100);
      }
    }
  });

  it('rejects an out-of-range request', () => {
    assert.throws(() => DemoDataService.generateWearableDays({ days: 0 }), /between 1 and/);
    assert.throws(() => DemoDataService.generateWearableDays({ days: 5000 }), /between 1 and/);
    assert.throws(() => DemoDataService.generateWearableDays({ trend: 'sideways' }), /trend must be/);
  });

  it('the demo trajectory never shows risk rising while behaviour improves', async () => {
    // The Day 4 monotonic constraints cover mvpa_min_week and sedentary_min_day.
    // Sleep is deliberately unconstrained because it is U-shaped clinically, so
    // the no-rising-risk property is EMPIRICAL, not structural -- it has to be
    // re-checked for each curve. The first demo profile (BMI 31 / waist 106)
    // produced hypertension +0.23/wk while activity and sleep improved, which is
    // exactly the message a coaching product must never show.
    //
    // This asserts it for the precise profile and curve a reviewer sees.
    const fresh = `mono-${RUN}@niyantrana.test`;
    const saved = cookie;
    cookie = '';
    await call('/auth/register', { method: 'POST', auth: false, body: { email: fresh, password: PASSWORD } });
    await call('/auth/login', { method: 'POST', auth: false, body: { email: fresh, password: PASSWORD } });
    await call('/api/wearable/demo', { method: 'POST', body: { days: 90, trend: 'improving' } });

    const { status, body } = await call('/api/predict', { method: 'POST', body: {} });
    if (status === 503) { cookie = saved; return; }

    const rising = body.trajectories
      .filter((t) => t.slope_per_week !== null && t.slope_per_week > 0.01)
      .map((t) => `${t.condition} ${t.slope_per_week}`);
    assert.deepEqual(rising, [],
      `improving behaviour raised risk for: ${rising.join(', ')}`);

    // And at least one condition must visibly move, or the demo shows four
    // straight lines and demonstrates nothing.
    const moved = body.trajectories.filter(
      (t) => t.slope_per_week !== null && Math.abs(t.slope_per_week) > 0.1);
    assert.ok(moved.length > 0,
      'no condition responded to 90 days of improving behaviour; '
      + 'the demo profile is saturated and shows nothing');
    cookie = saved;
  });

  it('seeds an account end to end and is idempotent', async () => {
    const fresh = `demo-${RUN}@niyantrana.test`;
    const saved = cookie;
    cookie = '';
    await call('/auth/register', { method: 'POST', auth: false, body: { email: fresh, password: PASSWORD } });
    await call('/auth/login', { method: 'POST', auth: false, body: { email: fresh, password: PASSWORD } });

    const first = await call('/api/wearable/demo', { method: 'POST', body: { days: 90 } });
    assert.equal(first.status, 201);
    assert.equal(first.body.wearableDays, 90);
    assert.match(first.body.notice, /demonstration/i);

    // Clicking "load demo data" twice must not leave 180 days.
    const second = await call('/api/wearable/demo', { method: 'POST', body: { days: 90 } });
    assert.equal(second.body.wearableDays, 90);
    const stored = await User.findOne({ email: fresh }).lean();
    assert.equal(stored.watchHistory.length, 90);

    // And the seeded account must actually produce a working assessment.
    const assessment = await call('/api/predict', { method: 'POST', body: {} });
    if (assessment.status !== 503) {
      assert.equal(assessment.status, 200);
      assert.equal(assessment.body.risks.length, 4);
      assert.equal(assessment.body.trajectories.length, 4,
        '90 days of history must yield trajectories');
    }
    cookie = saved;
  });
});
