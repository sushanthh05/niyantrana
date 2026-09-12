/**
 * Integration tests: real Express app, real MongoDB, real session cookies.
 *
 * Uses the built-in `node:test` runner and `fetch`, so no test framework is
 * added to a service that is meant to stay small.
 *
 * The load-bearing test here is `predict fails loudly when the ML service is
 * unreachable`. v1 answered that situation with
 * `TG: 150 + Math.random() * 50` and HTTP 200, in three separate places. If
 * that test ever passes with a 200 body containing risk scores, the single most
 * important property of this rewrite has regressed.
 *
 * Prerequisites:
 *   docker run -d --name niy-mongo -p 27017:27017 mongo:7
 *   docker run -d --name niy-ml -p 8000:8000 niyantrana-inference:v2
 *
 * Run:  npm run test:integration
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

// Defaults so `npm test` works against the local Docker services without a
// wrapper. Set BEFORE importing the app: config/env.js reads process.env once,
// at import time, and express-session throws without a secret.
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/niyantrana_test';
process.env.SESSION_SECRET ??= 'integration-test-secret-key-long-enough';
process.env.ML_SERVICE_URL ??= 'http://127.0.0.1:8000';

const { default: mongoose } = await import('mongoose');

const { createApp } = await import('../src/app.js');
const { default: inferenceClient } = await import('../src/clients/inferenceClient.js');
const { default: Food } = await import('../src/models/Food.js');
const { default: User } = await import('../src/models/User.js');

// Every account this file creates carries the same run tag, so cleanup can be
// scoped to it. Deleting all @niyantrana.test users would wipe rows another
// suite is still using -- which is exactly what happened when both files ran.
const RUN = `int${Date.now()}`;
const OWNED = new RegExp(`^[a-z]+-${RUN}@niyantrana\.test$`);
const EMAIL = `test-${RUN}@niyantrana.test`;
const PASSWORD = 'a-sufficiently-long-password';

let server;
let baseUrl;
let cookie = '';
const realInferenceUrl = inferenceClient.baseUrl;

/** fetch that carries the session cookie, the way a browser would. */
async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && cookie) headers.Cookie = cookie;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, body: json };
}

function wearableDay(progress = 0.5, daysAgo = 0) {
  return {
    date: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    daily_steps: Math.round(3000 + 9000 * progress),
    active_minutes: Math.round(8 + 70 * progress),
    sleep_hours: 5.4 + 2.2 * progress,
    sleep_quality_score: Math.round(58 + 30 * progress),
    resting_heart_rate: Math.round(78 - 12 * progress),
    heart_rate_variability: Math.round(32 + 28 * progress),
  };
}

const PROFILE = {
  age: 52, height: 174, weight: 94, gender: 'M', waist: 108,
  has_hereditary_risk: true, alcohol_drinks_week: 10, smoking_status: 1,
};

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await User.deleteMany({ email: OWNED });

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  inferenceClient.baseUrl = realInferenceUrl;
  await User.deleteMany({ email: OWNED });
  await mongoose.disconnect();
  server?.close();
});

// --- Health -----------------------------------------------------------------
describe('health', () => {
  it('reports the database connection', async () => {
    const { status, body } = await call('/health', { auth: false });
    assert.equal(status, 200);
    assert.equal(body.database, 'connected');
  });

  it('returns 404 with a message for an unknown route', async () => {
    const { status, body } = await call('/no/such/route', { auth: false });
    assert.equal(status, 404);
    assert.match(body.message, /not found/i);
  });
});

// --- Authentication ---------------------------------------------------------
describe('authentication', () => {
  it('rejects a short password', async () => {
    const { status, body } = await call('/auth/register', {
      method: 'POST', auth: false, body: { email: EMAIL, password: 'short' },
    });
    assert.equal(status, 400);
    assert.match(body.message, /at least 8/i);
  });

  it('rejects a malformed email', async () => {
    const { status } = await call('/auth/register', {
      method: 'POST', auth: false, body: { email: 'not-an-email', password: PASSWORD },
    });
    assert.equal(status, 400);
  });

  it('registers a new account', async () => {
    const { status, body } = await call('/auth/register', {
      method: 'POST', auth: false, body: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(status, 201);
    assert.equal(body.user.email, EMAIL);
    assert.ok(!('password' in body.user), 'password must never be returned');
  });

  it('rejects a duplicate registration', async () => {
    const { status } = await call('/auth/register', {
      method: 'POST', auth: false, body: { email: EMAIL.toUpperCase(), password: PASSWORD },
    });
    assert.equal(status, 409, 'duplicate check must be case-insensitive');
  });

  it('refuses protected routes when unauthenticated', async () => {
    const { status } = await call('/api/user/status', { auth: false });
    assert.equal(status, 401);
  });

  it('rejects a wrong password', async () => {
    const { status } = await call('/auth/login', {
      method: 'POST', auth: false, body: { email: EMAIL, password: 'wrong-password-here' },
    });
    assert.equal(status, 401);
  });

  it('logs in and issues a session cookie', async () => {
    const { status, body } = await call('/auth/login', {
      method: 'POST', auth: false, body: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(status, 200);
    assert.equal(body.user.email, EMAIL);
    assert.ok(cookie.startsWith('connect.sid'), `expected a session cookie, got ${cookie}`);
  });

  it('allows protected routes once authenticated', async () => {
    const { status, body } = await call('/api/user/status');
    assert.equal(status, 200);
    assert.equal(body.canBeAssessed, false, 'a fresh account has no profile yet');
  });
});

// --- Profile ----------------------------------------------------------------
describe('profile', () => {
  it('rejects an incomplete profile and names what is missing', async () => {
    const { status, body } = await call('/api/user/profile', {
      method: 'POST', body: { age: 52, height: 174 },
    });
    assert.equal(status, 400);
    assert.deepEqual(body.details.missing.sort(), ['gender', 'waist', 'weight']);
  });

  it('saves a profile and computes BMR server-side', async () => {
    const { status, body } = await call('/api/user/profile', { method: 'POST', body: PROFILE });
    assert.equal(status, 200);
    // Mifflin-St Jeor for a 52y male, 94 kg, 174 cm.
    const expected = 10 * 94 + 6.25 * 174 - 5 * 52 + 5;
    assert.ok(Math.abs(body.staticData.bmr - expected) < 1, `bmr was ${body.staticData.bmr}`);
  });

  it('recomputes BMR when weight changes', async () => {
    const { status, body } = await call('/api/user/weight', { method: 'POST', body: { weight: 88 } });
    assert.equal(status, 200);
    assert.equal(body.staticData.weight, 88);
    assert.ok(body.bmi > 28 && body.bmi < 30, `bmi was ${body.bmi}`);
    await call('/api/user/weight', { method: 'POST', body: { weight: 94 } });
  });

  it('rejects a non-positive weight', async () => {
    const { status } = await call('/api/user/weight', { method: 'POST', body: { weight: -5 } });
    assert.equal(status, 400);
  });
});

// --- Wearable data ----------------------------------------------------------
describe('wearable ingest', () => {
  it('returns an empty list rather than fabricated data', async () => {
    const { status, body } = await call('/api/user/wearable');
    assert.equal(status, 200);
    assert.equal(body.days, 0);
    assert.deepEqual(body.data, [], 'v1 returned a hardcoded 8432-step day here');
  });

  it('persists the legacy field spellings the schema used to drop', async () => {
    // The old ingest wrote active_calories / heart_rate while the schema
    // declared calories_burned / resting_heart_rate, so Mongoose silently
    // discarded both. Aliases now accept either.
    const { status } = await call('/api/user/wearable', {
      method: 'POST',
      body: [{ ...wearableDay(0.5, 99), active_calories: 456, heart_rate: 70 }],
    });
    assert.equal(status, 201);

    const stored = await User.findOne({ email: EMAIL }).lean();
    const day = stored.watchHistory.at(-1);
    assert.equal(day.calories_burned, 456, 'active_calories alias was dropped');
    assert.equal(day.resting_heart_rate, 70, 'heart_rate alias was dropped');
  });

  it('accepts a 14-day batch', async () => {
    const days = Array.from({ length: 14 }, (_, i) => wearableDay(i / 13, 14 - i));
    const { status, body } = await call('/api/user/wearable', { method: 'POST', body: days });
    assert.equal(status, 201);
    assert.equal(body.recorded, 14);
  });
});

// --- Food search ------------------------------------------------------------
describe('food search', () => {
  it('finds seeded Indian foods', async () => {
    const seeded = await Food.estimatedDocumentCount();
    if (seeded === 0) return; // seed not run
    const { status, body } = await call('/api/food/search?q=rice');
    assert.equal(status, 200);
    assert.ok(body.results.length > 0);
  });

  it('rejects a one-character query', async () => {
    const { status } = await call('/api/food/search?q=r');
    assert.equal(status, 400);
  });

  it('treats regex metacharacters as literal text', async () => {
    // v1 interpolated `q` straight into a $regex.
    const { status } = await call('/api/food/search?q=' + encodeURIComponent('.*(('));
    assert.equal(status, 200, 'a regex-hostile query must not crash the server');
  });
});

// --- The property this whole rewrite exists to guarantee ---------------------
describe('risk assessment', () => {
  it('produces a real assessment and records provenance', async () => {
    const { status, body } = await call('/api/predict', {
      method: 'POST',
      body: { dietTotals: { energy_kcal: 3100, fat_g: 140, carb_g: 380, protein_g: 110 } },
    });

    if (status === 503) {
      console.log('    (skipped: ML service unreachable)');
      return;
    }
    assert.equal(status, 200);
    assert.equal(body.provenance, 'model');
    assert.equal(body.risks.length, 4);
    for (const risk of body.risks) {
      assert.ok(risk.score >= 0 && risk.score <= 100);
      assert.ok(risk.basis, 'every score must declare which model produced it');
    }

    const stored = await User.findOne({ email: EMAIL }).lean();
    const report = stored.healthHistory.at(-1);
    assert.equal(report.provenance, 'model',
      'a score must not be persisted without its provenance');
  });

  it('fails loudly when the ML service is unreachable', async () => {
    // THE regression test for this project. v1 answered this situation with
    // TG: 150 + Math.random() * 50 and HTTP 200.
    inferenceClient.baseUrl = 'http://127.0.0.1:9';
    try {
      const { status, body } = await call('/api/predict', { method: 'POST', body: {} });
      assert.equal(status, 503, 'an unreachable model must not yield a 200');
      assert.equal(body.provenance, 'unavailable');
      assert.ok(!body.risks, 'no risk scores may be invented when the model is down');
      assert.ok(!body.prediction, 'no fabricated biomarkers either');
    } finally {
      inferenceClient.baseUrl = realInferenceUrl;
    }
  });

  it('refuses to assess an incomplete profile', async () => {
    const email = `bare-${RUN}@niyantrana.test`;
    const saved = cookie;
    cookie = '';
    await call('/auth/register', { method: 'POST', auth: false, body: { email, password: PASSWORD } });
    await call('/auth/login', { method: 'POST', auth: false, body: { email, password: PASSWORD } });

    const { status, body } = await call('/api/predict', { method: 'POST', body: {} });
    assert.equal(status, 400);
    assert.ok(body.details.missing.length > 0, 'the response must name what is missing');
    cookie = saved;
  });
});

// --- Logout -----------------------------------------------------------------
describe('logout', () => {
  it('destroys the session', async () => {
    await call('/auth/login', {
      method: 'POST', auth: false, body: { email: EMAIL, password: PASSWORD },
    });
    const { status } = await call('/auth/logout', { method: 'POST' });
    assert.equal(status, 200);
    // v1 called req.logout() but never destroyed the session or cleared the cookie.
    const after = await call('/api/user/status');
    assert.equal(after.status, 401, 'the session survived logout');
  });
});
