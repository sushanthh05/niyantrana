# Niyantrana API

Node 20+ / Express 5 / MongoDB / Passport sessions. Orchestrates authentication,
profiles, wearable ingest and food search, and delegates risk assessment to the
Python inference service.

## Local setup

Both dependencies run in Docker. On this machine Docker Desktop is a user-level
install, so the CLI needs a PATH export first (see `../ml/DOCKER.md`).

```bash
# 1. MongoDB
docker run -d --name niy-mongo -p 27017:27017 mongo:7

# 2. Inference service (build it once: cd ../ml && docker build -t niyantrana-inference:v2 .)
docker run -d --name niy-ml --memory=512m -p 8000:8000 niyantrana-inference:v2

# 3. Dependencies and food data
npm install
npm run seed          # loads 1,014 Indian foods from ../ml/data/raw/*.csv

# 4. Run
cp .env.example .env  # then fill in SESSION_SECRET
npm start
```

## Tests

Integration tests use the built-in `node:test` runner against a real database
and a real inference service. No test framework dependency.

```bash
MONGO_URI=mongodb://127.0.0.1:27017/niyantrana_test \
SESSION_SECRET=integration-test-secret-key-long-enough \
ML_SERVICE_URL=http://127.0.0.1:8000 \
npm test
```

24 tests, ~1.4s.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | – | Liveness plus database status |
| POST | `/auth/register` | – | Create an account |
| POST | `/auth/login` | – | Start a session |
| POST | `/auth/logout` | – | Destroy the session |
| GET | `/auth/me` | session | Current user |
| GET | `/api/user/status` | session | Profile completeness |
| POST | `/api/user/profile` | session | Save profile, compute BMR |
| POST | `/api/user/weight` | session | Update weight, recompute BMR |
| GET/POST | `/api/user/wearable` | session | Read / append wearable days |
| GET | `/api/food/search?q=` | session | Indian food composition search |
| POST/GET | `/api/logs/meals` | session | Log a meal / list meals |
| DELETE | `/api/logs/meals/:id` | session | Remove a meal |
| GET | `/api/logs/macros/daily` | session | Today's macro totals |
| GET | `/api/logs/macros/trend` | session | Per-day macro totals |
| POST/GET | `/api/logs/vitals` | session | Record / list vitals and lab values |
| POST | `/api/wearable/import` | session | Import any provider export (CSV or JSON) |
| POST | `/api/wearable/demo` | session | Seed 90 days of labelled demo history |
| GET | `/api/wearable/formats` | – | Accepted formats and field aliases |
| POST | `/api/logs/activity` | session | Manually log exercise |
| POST | `/api/chat` | session | Health assistant, grounded in the user record |
| POST | `/api/predict` | session | Multi-condition risk assessment |
| POST | `/api/recommend` | session | Meal recommendation |
| GET | `/api/inference/health` | – | Upstream model service status |

## Where the numbers come from

Two inputs are computed server-side and cannot be asserted by the client:

* **Dietary macros** are resolved against the Anuvaad food database at log time.
  A client sends a food name and a serving count; the server stores the
  resulting macros. Previously the client sent `dietTotals` straight into the
  model, so a browser could claim any intake it liked.
* **Measured biomarkers** come from `/api/logs/vitals`. A recorded blood
  pressure or HbA1c overrides the model estimate for that field, and
  `inputs.measuredBiomarkers` in the response names which were real.

A day with no meals logged reports `null`, not zero. "Logged nothing" and "ate
nothing" are different facts, and sending zero calories would tell the model the
user fasted.

## Wearable data: why import, not OAuth

Every consumer wearable API a solo developer could register for has closed.
Verified September 2026:

| Provider | Status |
|---|---|
| Google Fit | New signups closed 1 May 2024; APIs deprecating through 2026 |
| **Fitbit Web API** | New signups closed 1 May 2024; **sunsets September 2026** |
| Google Health API | Replacement for both; every scope is Restricted, so production access is gated behind a privacy and security review |
| Garmin | Connect Developer Program requires a legal entity; rejects personal-use applications |
| Withings, Oura | Still open to individual developers |

So `POST /api/wearable/import` is the primary path. It accepts CSV or JSON from
any provider, matching column names against a wide alias list, and cannot be
deprecated out from under the project. It also needs no device, which matters
when the person reviewing this owns none.

`POST /api/wearable/demo` seeds 90 days of realistic history. Every generated
day is stored with `source: 'demo'`, so seeded data is distinguishable from a
real export at the record level rather than only by a banner in the UI.

Adding Withings or Oura later means writing one provider that emits records in
the canonical shape; nothing downstream changes.

## The one rule

**No endpoint ever invents a number.** When the inference service is
unreachable, `/api/predict` returns **503** with `provenance: "unavailable"` and
no risk scores. It does not fall back to a plausible-looking default.

v1 did exactly that, in three separate places — `TG: 150 + Math.random() * 50`
returned with HTTP 200, indistinguishable from a real prediction. The
integration test `fails loudly when the ML service is unreachable` exists to
stop that regressing.

Every persisted health report carries a required `provenance` field, so a score
cannot be written to the database without recording where it came from.
