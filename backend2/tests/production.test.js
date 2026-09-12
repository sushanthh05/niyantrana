/**
 * Day 11: production configuration guards.
 *
 * These cover the failure modes that only appear once the app is deployed
 * cross-origin behind a TLS-terminating proxy, where they are miserable to
 * debug because nothing errors -- the user simply cannot stay logged in, or
 * every first prediction 503s.
 *
 * Each test corresponds to a specific way the deployment breaks:
 *
 *   TRUST_PROXY unset      login returns 200 but issues NO cookie, so every
 *                          subsequent request is 401
 *   SameSite wrong         the browser silently drops the cookie on a
 *                          cross-site request
 *   CORS_ORIGIN wrong      the preflight fails and the frontend cannot call
 *                          the API at all
 *   cold start             the free tier sleeps after 15 min and takes ~1 min
 *                          to wake, so a 15s timeout guarantees the first
 *                          request after idle fails
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const FRONTEND_ORIGIN = 'https://niyantrana.pages.dev';

process.env.NODE_ENV = 'production';
process.env.SESSION_SECRET = 'a-long-enough-production-secret-value';
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/niyantrana_test';
process.env.CORS_ORIGIN = FRONTEND_ORIGIN;
process.env.TRUST_PROXY = 'true';

const { default: mongoose } = await import('mongoose');
const { createApp } = await import('../src/app.js');
const { default: config, assertValidConfig } = await import('../src/config/env.js');
const { InferenceClient } = await import('../src/clients/inferenceClient.js');
const { default: User } = await import('../src/models/User.js');

const RUN = `prod${Date.now()}`;
const OWNED = new RegExp(`^[a-z]+-${RUN}@niyantrana\\.test$`);
const EMAIL = `prod-${RUN}@niyantrana.test`;
const PASSWORD = 'a-sufficiently-long-password';

let server;
let baseUrl;

/** Request as a browser on the deployed frontend would, through Render's proxy. */
function proxied(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Forwarded-Proto': 'https',
    Origin: FRONTEND_ORIGIN,
    ...extra,
  };
}

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/auth/register`, {
    method: 'POST', headers: proxied(),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
});

after(async () => {
  await User.deleteMany({ email: OWNED });
  await mongoose.disconnect();
  server?.close();
});

// --- Configuration validation ----------------------------------------------
describe('production configuration', () => {
  it('is production, with trust proxy on', () => {
    assert.equal(config.isProduction, true);
    assert.equal(config.trustProxy, true);
  });

  it('accepts this configuration', () => {
    assert.doesNotThrow(() => assertValidConfig());
  });

  it('has a longer cold-start window than the normal timeout', () => {
    assert.ok(config.inferenceColdStartTimeoutMs > config.inferenceTimeoutMs,
      'the retry window must exceed the first-attempt timeout or it is pointless');
    assert.ok(config.inferenceColdStartTimeoutMs >= 60000,
      'a free instance takes roughly a minute to wake');
  });
});

// --- Cross-origin cookie, the classic deployment failure ---------------------
describe('cross-origin session', () => {
  it('issues a Secure SameSite=None HttpOnly cookie behind the proxy', async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: proxied(),
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(response.status, 200);

    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie, 'no cookie was issued');
    // All three are required for a cookie to survive a cross-site XHR.
    assert.match(cookie, /Secure/, 'a cross-site cookie must be Secure');
    assert.match(cookie, /SameSite=None/i,
      'SameSite=Lax would be dropped by the browser on a cross-site request');
    assert.match(cookie, /HttpOnly/, 'the session cookie must not be readable by JS');
  });

  it('withholds the cookie when the request is not seen as HTTPS', async () => {
    // This is what happens when TRUST_PROXY is not set on the host: express
    // sees plain http, refuses to send a Secure cookie, and login "succeeds"
    // with no session. Nothing errors; the user just cannot stay logged in.
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(response.status, 200, 'login itself still succeeds, which is the trap');
    assert.equal(response.headers.get('set-cookie'), null,
      'a Secure cookie must not be sent over plain http');
  });

  it('round-trips an authenticated request with the cookie', async () => {
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: proxied(),
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const me = await fetch(`${baseUrl}/auth/me`, { headers: proxied({ Cookie: cookie }) });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, EMAIL);
  });
});

// --- CORS -------------------------------------------------------------------
describe('CORS', () => {
  it('allows the configured frontend origin with credentials', async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: FRONTEND_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.ok([200, 204].includes(response.status));
    assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN);
    // Without this the browser discards the response of every credentialed call.
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  });

  it('does not allow an origin outside the allowlist', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null,
      'echoing an arbitrary origin back would defeat CORS entirely');
  });

  it('never echoes a wildcard, which cannot be combined with credentials', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: FRONTEND_ORIGIN },
    });
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  });
});

// --- Cold start -------------------------------------------------------------
describe('inference cold start', () => {
  function countingClient(behaviour, options = {}) {
    const calls = [];
    const http = {
      post: async (url, body, opts) => {
        calls.push(opts.timeout);
        return behaviour(calls.length);
      },
    };
    return { client: new InferenceClient({ http, timeout: 50, coldStartTimeout: 500, ...options }), calls };
  }

  it('retries once with a longer window when the service is asleep', async () => {
    const { client, calls } = countingClient((attempt) => {
      if (attempt === 1) {
        const error = new Error('timeout of 50ms exceeded');
        error.code = 'ECONNABORTED';
        throw error;
      }
      return { data: { risks: [{ condition: 'fatty_liver', score: 50 }], provenance: 'model' } };
    });

    const result = await client.assessRisk({ profile: {}, wearableWindow: [] });
    assert.equal(result.provenance, 'model', 'the retry must recover');
    assert.deepEqual(calls, [50, 500], 'the second attempt must use the longer window');
  });

  it('does NOT retry a 5xx, because the service answered', async () => {
    const { client, calls } = countingClient(() => {
      const error = new Error('boom');
      error.response = { status: 500, data: {} };
      throw error;
    });
    await assert.rejects(() => client.assessRisk({ profile: {}, wearableWindow: [] }),
      /temporarily unavailable/);
    assert.equal(calls.length, 1,
      'retrying a service that already answered just doubles the latency');
  });

  it('does NOT retry a 4xx, and reports it as a client error', async () => {
    const { client, calls } = countingClient(() => {
      const error = new Error('bad request');
      error.response = { status: 400, data: { detail: 'window must be 14 days' } };
      throw error;
    });
    await assert.rejects(() => client.assessRisk({ profile: {}, wearableWindow: [] }),
      (error) => error.statusCode === 400);
    assert.equal(calls.length, 1);
  });

  it('gives up after the retry and never invents a score', async () => {
    const { client, calls } = countingClient(() => {
      const error = new Error('refused');
      error.code = 'ECONNREFUSED';
      throw error;
    });
    await assert.rejects(
      () => client.assessRisk({ profile: {}, wearableWindow: [] }),
      (error) => {
        assert.equal(error.provenance, 'unavailable');
        assert.match(error.details.reason, /cold-start retry/);
        return true;
      });
    assert.equal(calls.length, 2, 'one attempt plus one retry, then stop');
  });
});
