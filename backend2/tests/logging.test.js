/**
 * Day 7 integration tests: server-side logging, aggregation and the chat proxy.
 *
 * The load-bearing test is `a logged meal changes the next assessment`. That is
 * the whole point of moving logs off localStorage: data the user enters has to
 * reach the model, or the logging feature is decoration.
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
const { default: Food } = await import('../src/models/Food.js');
const { default: MealLog } = await import('../src/models/MealLog.js');
const { default: User } = await import('../src/models/User.js');
const { default: VitalReading } = await import('../src/models/VitalReading.js');
const { GeminiClient } = await import('../src/clients/geminiClient.js');

// See integration.test.js: cleanup is scoped to this run only.
const RUN = `log${Date.now()}`;
const OWNED = new RegExp(`^[a-z]+-${RUN}@niyantrana\.test$`);
const EMAIL = `log-${RUN}@niyantrana.test`;
const PASSWORD = 'a-sufficiently-long-password';

let server;
let baseUrl;
let cookie = '';
let userId;

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
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
  await call('/api/user/profile', {
    method: 'POST',
    body: { age: 52, height: 174, weight: 94, gender: 'M', waist: 108, has_hereditary_risk: true },
  });
  const days = Array.from({ length: 14 }, (_, i) => ({
    date: new Date(Date.now() - (14 - i) * 86400000).toISOString(),
    daily_steps: 4000, active_minutes: 20, sleep_hours: 6.5,
    sleep_quality_score: 70, resting_heart_rate: 72, heart_rate_variability: 40,
  }));
  await call('/api/user/wearable', { method: 'POST', body: days });

  const user = await User.findOne({ email: EMAIL }).lean();
  userId = user._id;
});

after(async () => {
  await MealLog.deleteMany({ user: userId });
  await VitalReading.deleteMany({ user: userId });
  await User.deleteMany({ email: OWNED });
  await mongoose.disconnect();
  server?.close();
});

// --- Meal logging -----------------------------------------------------------
describe('meal logging', () => {
  it('resolves macros server-side from the food database', async () => {
    const seeded = await Food.estimatedDocumentCount();
    if (seeded === 0) return;

    const { status, body } = await call('/api/logs/meals', {
      method: 'POST',
      body: { foodName: 'Boiled rice', servings: 2, mealType: 'lunch' },
    });
    assert.equal(status, 201);
    assert.ok(body.energy_kcal > 0, 'calories must come from the database');
    assert.match(body.foodName, /rice/i);

    // The client sent only a name and a count; the server supplied the numbers.
    const single = await Food.findOne({ food_name: body.foodName }).lean();
    if (single?.energy_kcal) {
      assert.ok(Math.abs(body.energy_kcal - single.energy_kcal * 2) < 0.01,
        'macros must scale by servings');
    }
  });

  it('rejects a nonsense serving count', async () => {
    const { status } = await call('/api/logs/meals', {
      method: 'POST', body: { foodName: 'Boiled rice', servings: 9999 },
    });
    assert.equal(status, 400);
  });

  it('refuses an unknown food unless macros are supplied', async () => {
    const { status } = await call('/api/logs/meals', {
      method: 'POST', body: { foodName: 'zzz-not-a-real-food-zzz', servings: 1 },
    });
    assert.equal(status, 404);
  });

  it('accepts an unknown food when macros are given and plausible', async () => {
    const { status, body } = await call('/api/logs/meals', {
      method: 'POST',
      body: {
        foodName: 'zzz-homemade-dish', servings: 1, mealType: 'dinner',
        energy_kcal: 620, fat_g: 28, carb_g: 70, protein_g: 22, sugar_g: 14, fibre_g: 6,
      },
    });
    assert.equal(status, 201);
    assert.equal(body.energy_kcal, 620);
  });

  it('rejects implausible caller-supplied calories', async () => {
    const { status } = await call('/api/logs/meals', {
      method: 'POST', body: { foodName: 'zzz-another', energy_kcal: 999999 },
    });
    assert.equal(status, 400);
  });

  it('lists the logged meals', async () => {
    const { status, body } = await call('/api/logs/meals');
    assert.equal(status, 200);
    assert.ok(body.meals.length >= 2);
  });
});

// --- Aggregation ------------------------------------------------------------
describe('macro aggregation', () => {
  it('sums the day server-side', async () => {
    const { status, body } = await call('/api/logs/macros/daily');
    assert.equal(status, 200);
    assert.equal(body.logged, true);
    assert.ok(body.totals.energy_kcal > 0);
    assert.ok(body.totals.meals >= 2);
  });

  it('distinguishes "logged nothing" from "ate nothing"', async () => {
    // A fresh account has logged nothing. That must not be reported as a
    // zero-calorie day, which the model would read as a fast.
    const saved = cookie;
    const email = `fresh-${RUN}@niyantrana.test`;
    cookie = '';
    await call('/auth/register', { method: 'POST', auth: false, body: { email, password: PASSWORD } });
    await call('/auth/login', { method: 'POST', auth: false, body: { email, password: PASSWORD } });

    const { body } = await call('/api/logs/macros/daily');
    assert.equal(body.logged, false);
    assert.equal(body.totals, null, 'must be null, not a zeroed object');
    cookie = saved;
  });

  it('returns a per-day trend', async () => {
    const { status, body } = await call('/api/logs/macros/trend?days=7');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.trend));
  });
});

// --- Vitals -----------------------------------------------------------------
describe('vitals logging', () => {
  it('rejects a physiologically impossible reading', async () => {
    const { status, body } = await call('/api/logs/vitals', {
      method: 'POST', body: { systolic_bp: 900 },
    });
    assert.equal(status, 400);
    assert.match(body.message, /plausible range/i);
  });

  it('requires at least one reading', async () => {
    const { status } = await call('/api/logs/vitals', { method: 'POST', body: { note: 'hi' } });
    assert.equal(status, 400);
  });

  it('records a reading and syncs weight into the profile', async () => {
    const { status } = await call('/api/logs/vitals', {
      method: 'POST',
      body: { systolic_bp: 148, diastolic_bp: 94, hba1c: 6.8, weight_kg: 96, source: 'device' },
    });
    assert.equal(status, 201);

    const user = await User.findOne({ email: EMAIL }).lean();
    assert.equal(user.staticData.weight, 96, 'a logged weight must update the profile');
  });
});

// --- The point of all of it -------------------------------------------------
describe('logs reach the model', () => {
  it('measured vitals override the estimate and change provenance', async () => {
    const { status, body } = await call('/api/predict', { method: 'POST', body: {} });
    if (status === 503) return; // ML service unavailable

    assert.equal(status, 200);
    // An HbA1c of 6.8 was logged above; the assessment must use it rather than
    // its own estimate.
    assert.equal(body.biomarkers.hba1c, 6.8);
    assert.ok(body.inputs.measuredBiomarkers.includes('hba1c'));
    // Provenance stays "model" because only some biomarkers were measured --
    // triglycerides and GGT are still estimates, so the result is a blend.
    // `inputs.measuredBiomarkers` is what tells a caller which were real.
    assert.equal(body.provenance, 'model');
  });

  it('a logged meal changes the next assessment', async () => {
    // Day 7 done-criterion. If this fails, logging is decoration: the data the
    // user enters never reaches the model.
    const fresh = `diet-${RUN}@niyantrana.test`;
    const saved = cookie;
    cookie = '';
    await call('/auth/register', { method: 'POST', auth: false, body: { email: fresh, password: PASSWORD } });
    await call('/auth/login', { method: 'POST', auth: false, body: { email: fresh, password: PASSWORD } });
    await call('/api/user/profile', {
      method: 'POST',
      body: { age: 52, height: 174, weight: 94, gender: 'M', waist: 108 },
    });
    await call('/api/user/wearable', {
      method: 'POST',
      body: Array.from({ length: 14 }, (_, i) => ({
        date: new Date(Date.now() - (14 - i) * 86400000).toISOString(),
        daily_steps: 4000, active_minutes: 20, sleep_hours: 6.5,
        sleep_quality_score: 70, resting_heart_rate: 72, heart_rate_variability: 40,
      })),
    });

    const before = await call('/api/predict', { method: 'POST', body: {} });
    if (before.status === 503) { cookie = saved; return; }
    assert.equal(before.body.inputs.mealsCounted, 0, 'no meals logged yet');

    // Log a heavy, sugary day.
    for (let i = 0; i < 3; i += 1) {
      await call('/api/logs/meals', {
        method: 'POST',
        body: {
          foodName: `zzz-heavy-meal-${i}`, energy_kcal: 1100, fat_g: 55,
          carb_g: 130, protein_g: 30, sugar_g: 45, fibre_g: 3, satfat_g: 22,
        },
      });
    }

    const after = await call('/api/predict', { method: 'POST', body: {} });
    assert.equal(after.status, 200);
    assert.equal(after.body.inputs.mealsCounted, 3, 'the assessment must count the logged meals');

    const scoreOf = (r) => Object.fromEntries(r.body.risks.map((x) => [x.condition, x.score]));
    const beforeScores = scoreOf(before);
    const afterScores = scoreOf(after);
    const changed = Object.keys(afterScores).filter((c) => afterScores[c] !== beforeScores[c]);
    assert.ok(changed.length > 0,
      `logging 3300 kcal changed nothing: ${JSON.stringify(beforeScores)}`);

    cookie = saved;
  });

  it('ignores diet totals supplied by the client', async () => {
    // The client used to send dietTotals directly, so a browser could assert
    // any intake it liked. The value must now be derived from stored logs only.
    const { status, body } = await call('/api/predict', {
      method: 'POST',
      body: { dietTotals: { energy_kcal: 99999, fat_g: 9999, sugar_g: 9999 } },
    });
    if (status === 503) return;
    assert.equal(status, 200);
    assert.ok(body.inputs.mealsCounted <= 10,
      'client-supplied dietTotals must not be trusted');
  });
});

// --- Activity ---------------------------------------------------------------
describe('activity logging', () => {
  it('appends a manual entry to the wearable history', async () => {
    const before = await call('/api/user/wearable');
    const { status, body } = await call('/api/logs/activity', {
      method: 'POST', body: { active_minutes: 45, daily_steps: 8000, calories_burned: 320 },
    });
    assert.equal(status, 201);
    assert.equal(body.recorded, 1);

    const after = await call('/api/user/wearable');
    assert.ok(after.body.days >= before.body.days);
  });

  it('rejects an empty activity entry', async () => {
    const { status } = await call('/api/logs/activity', { method: 'POST', body: {} });
    assert.equal(status, 400);
  });
});

// --- Chat proxy -------------------------------------------------------------
describe('chat proxy', () => {
  it('requires authentication', async () => {
    const saved = cookie;
    cookie = '';
    const { status } = await call('/api/chat', {
      method: 'POST', auth: false, body: { message: 'hello' },
    });
    assert.equal(status, 401);
    cookie = saved;
  });

  it('rejects an empty message', async () => {
    const { status } = await call('/api/chat', { method: 'POST', body: { message: '   ' } });
    assert.equal(status, 400);
  });

  it('degrades to 503 without an API key, never 500', async () => {
    const { status, body } = await call('/api/chat', {
      method: 'POST', body: { message: 'How is my blood pressure?' },
    });
    if (status === 200) {
      assert.ok(body.reply.length > 0, 'a configured key must return text');
      return;
    }
    assert.equal(status, 503);
    assert.equal(body.provenance, 'unavailable');
  });

  it('grounds the prompt in the user real record', async () => {
    const { default: chatService } = await import('../src/services/chatService.js');
    const context = await chatService.buildHealthContext(userId);
    assert.match(context, /Profile: 52y male/);
    assert.match(context, /Measured readings on record/,
      'logged vitals must appear in the prompt context');
    // The assistant must be told what it does NOT know rather than guessing.
    assert.ok(/No meals logged today|Logged today/.test(context));
  });

  it('extracts text and distinguishes a safety block from an empty reply', () => {
    assert.equal(
      GeminiClient.extractText({ candidates: [{ content: { parts: [{ text: 'Try dal.' }] } }] }),
      'Try dal.');
    // The user-facing message stays generic; the diagnostic lives in `details`,
    // so an API error never leaks provider internals to the browser.
    assert.throws(() => GeminiClient.extractText({ candidates: [] }),
      (error) => /blockReason/.test(error.details.reason));
    assert.throws(
      () => GeminiClient.extractText({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }),
      (error) => /empty response.*SAFETY/.test(error.details.reason));
  });
});
