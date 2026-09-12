# Niyantrana — 15-Day Completion Plan

**Goal:** a deployed, honest, defensible portfolio project.
**How to use:** say **"Day N"** and only that day's scope gets built. Each day is self-contained.
**Update rule:** at the end of each day, tick the checkboxes and fill in "Result".

---

## Current state (updated end of Day 1)

| Subsystem | Status |
|---|---|
| `ml/` prediction path | ✅ Fixed, tested, ONNX-served |
| `ml/` real data | ✅ 17,961 NHANES adults ingested |
| `ml/` risk engine | ✅ Regression + classification + composition + trajectory (Days 2–4), monotonically constrained |
| `rag_engine/` | ✅ Merged into `ml/src/recommendation/`, directory removed |
| `backend2/` | ✅ Layered, 0 npm vulnerabilities, **79 integration tests** green against real Mongo + ML |
| `frontend/` | ⬜ Out of scope — being replaced wholesale (Days 8-9 skipped; dead Google Fit code and 2.2 MB of duplicate data removed) |
| Deployment | 🟡 Blueprint + guide ready and validated; awaiting Atlas + Render accounts |

**Restructure (done alongside Day 1):** both services rebuilt on a layered
architecture following refactoring.guru principles. See
**[docs/REFACTORING.md](docs/REFACTORING.md)** for every decision mapped to a
named smell, pattern or technique.

```
ml/src/     domain -> features -> inference -> risk -> api      (+ training, data, recommendation)
backend2/src/  config -> domain -> models -> repositories -> services -> controllers -> routes
```

Dependencies point inward; `domain/` imports nothing from the layers above it.

**Ground truth to remember:** the original model scored R² **0.900/0.974** only because of leakage. On a proper user-level split it scores **−0.89 / −0.87 — worse than guessing the mean.** 15 synthetic personas cannot support this task. That finding is *why* Days 2–4 exist.

---

## Data sources

### Tier 1 — in use
| Source | Size | What it gives | Access |
|---|---|---|---|
| **NHANES** 2013–18 | **17,961 adults** ✅ ingested | TG, GGT, HbA1c, BP + 24h diet recall + sleep hrs + activity min | Free, no application |

### Tier 2 — to evaluate (Day 4)
| Source | Size | Why it matters | Access |
|---|---|---|---|
| **PMData** (SimulaMet) | 16 × 5 months | Fitbit + **MyFitnessPal food logs** — matches app input exactly | ✅ Free, **no registration** |
| **LifeSnaps** (Zenodo) | 71 × 4 months, 71M rows | Fitbit + surveys, large temporal volume | ✅ Free, **no registration** |
| **AI-READI** (NIH) | 2,280 (3.8 TB) | Multimodal diabetes: CGM + wearable + labs | Registration + DUA; likely overkill |
| ~~WEAR-ME~~ | ~~1,165~~ | ❌ **Not obtainable** — verified Google-internal cohort, data availability restricted. Withdrawn from the plan. | — |

### Tier 3 — India calibration
| Source | Size | Notes |
|---|---|---|
| **LASI** Wave 1 | ~72,000 | ⭐ HbA1c + BP biomarkers on Indians. Via IIPS / Gateway to Global Aging | Registration |
| **NFHS-5** | ~700,000 | BP, glucose, BMI. No TG/GGT | Free, registration |
| **ICMR-INDIAB** | 113,043 | Published prevalence tables for threshold calibration (raw data not open) | Paper only |
| **Anuvaad INDB** | 1,014 foods | ✅ already in repo — Indian food composition | In repo |

**Dropped:** UK Biobank (£3–9k, months of review) and WEAR-ME (not publicly available) — remove both from the decks.

📄 Full access details, registration times and deadlines: **[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)**
📄 Target system design: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

**Registrations with a lead time — start these now if you want them:**
- **GitHub Student Pack** (~1 day approval) — optional, buys always-on hosting
- **NFHS-5 / DHS Program** (1–2 days) — apply by Day 3 if you want India calibration on Day 4

Everything needed for Days 1–9 requires **no registration at all**.

---

## Day 1 — ML forensics & real-data foundation ✅ DONE

- [x] Reproduce and fix the fatal inference bug (`predict.py` fed the MLP branch all-NaN → identical output for every user)
- [x] Fix the feature-order bug (`gender_numeric` at index 0 vs 1 in training)
- [x] Create `src/features.py` as the single shared schema (kills the drift class of bug)
- [x] Rewrite `data_processing.py`: split **before** scaling, **disjoint users** across train/val/test
- [x] Rewrite `train.py`: record history, add ReduceLROnPlateau
- [x] Add `src/evaluate.py`: MAE/RMSE/R² vs a mean-predictor baseline
- [x] 13 regression tests in `tests/` — verified they **fail** on the original code
- [x] ONNX export + parity check (`src/export_onnx.py`)
- [x] Port RAG engine into `src/recommender.py` with 5 bug fixes
- [x] NHANES downloader + dataset builder → **17,961 adults**

**Result:** honest metrics exposed the real problem. TF 358 MB → onnxruntime 33 MB RSS (deployment unblocked). Real data acquired.

---

## Day 2 — Risk Engine v1 (regression on real data) ✅ DONE

- [x] `src/training/train_risk_engine.py` — multi-target `HistGradientBoostingRegressor`
- [x] Targets: `triglycerides`, `ggt`, `hba1c`, `systolic_bp`, `diastolic_bp`, **plus `fli` predicted directly**
- [x] 16 features, all app-collectable
- [x] Train/val/test split **and** cycle holdout (2013–16 → 2017–18)
- [x] MAE/RMSE/R² per target vs mean-predictor baseline
- [x] `src/inference/risk_engine.py` — serving side, substitutable for `BiomarkerPredictor`
- [x] Persisted `models/risk_engine.joblib` + `reports/nhanes_metrics.json` + **[ml/RESULTS.md](ml/RESULTS.md)**
- [x] 16 new tests (35 total, all passing)

**Result: 6/6 targets beat baseline on both splits.** Cycle-holdout R²:
systolic_bp **+0.270** · hba1c **+0.129** · diastolic_bp +0.089 · triglycerides +0.045 ·
ggt **−0.001** · fli +0.852

**Two findings that shape the rest of the project:**

1. **The FLI R² of 0.85 is mostly arithmetic, not learning.** Ablation shows the
   Bedogni formula with cohort-median TG/GGT scores R² **0.843 with no ML at all**,
   because BMI and waist are two of its four terms and we measure them exactly.
   The model adds +6.1% MAE over that. FLI is therefore scored against the
   *formula reference*, not the mean predictor.
2. **GGT is effectively unpredictable from lifestyle** (R² −0.001). Reported as a
   negative result. This caps how far the fatty-liver estimate can improve, and
   is why predicting FLI directly (R² 0.86) beats composing it from predicted
   TG + GGT (R² ~0.05).

**Product conclusion:** waist circumference is the single most valuable input
across every target — more than BMI in all six. Onboarding must insist on it.

---

## Day 3 — Risk Engine v2 (classification, calibration, interpretability) ✅ DONE

- [x] **Four** classification heads: fatty_liver, dysglycaemia, diabetes, hypertension
- [x] AUROC / AUPRC / sensitivity / specificity / PPV at a 90%-sensitivity operating point
- [x] Isotonic calibration on a held-out split + per-decile reliability curves
- [x] SHAP (exact TreeExplainer) per head → `reports/shap/`
- [x] Sanity check: high-risk profile out-ranks low-risk on all four
- [x] `src/inference/risk_classifier.py` serving loader; 13 new tests (48 total)

**Result:**

| Condition | Prevalence | AUROC | Sens | Spec | PPV |
|---|---|---|---|---|---|
| hypertension | 49.8% | 0.802 | 91% | 0.53 | 0.66 |
| dysglycaemia | 41.2% | 0.799 | 93% | 0.43 | 0.54 |
| diabetes | 16.9% | 0.799 | 90% | 0.55 | 0.29 |
| fatty_liver | 42.7% | 0.958 | 92% | 0.83 | 0.80 |

**All three pitched conditions now exist.** v1 shipped fatty liver only.

**Three findings:**

1. **fatty_liver AUROC 0.958 is close to a tautology** — bmi+waist alone scores
   0.9548, so the other 14 features add **+0.003**. Same story as the Day 2
   regression head. A test keeps that baseline recorded so it is never quoted bare.
2. **Labels must count treated patients as cases.** 26.7% of adults take BP
   medication and read normal; a naive `BP≥130/80` label would have taught the
   model that a quarter of the positive class is healthy. Medication is used in
   the label only, never as a feature.
3. **Calibration is overconfident at the top** — dysglycaemia predicts 0.88 where
   0.64 are observed (thin bins, n=22). High probabilities mean "high risk", not
   near-certainty.

**Product note:** at the screening threshold, diabetes PPV is 0.29 — 7 of 10
flagged people do not have it. Correct for 90% sensitivity at 16.9% prevalence,
but the UI must word a flag as *get tested*, never as a diagnosis.

---

## Day 4 — Composition & trajectory ✅ DONE

> **Plan changed.** Two items were replaced after the evidence contradicted them.
> Both changes are recorded here rather than silently absorbed.

- [x] Feature bridge: 14-day window → NHANES-comparable features (already built in the restructure)
- [x] Compose: calibrated classifier supplies the score, regression engine the biomarkers, scorers the explanation
- [x] Risk **trajectory**: rolling windows → real risk over time → least-squares trend
- [x] Every output tagged with `provenance` **and** a new `basis` field
- [x] API exposes `trajectories`, `basis`, optional `watch_data`, and `history`
- [x] 19 new tests (67 total)

### Plan change 1 — wearable datasets rejected

| Dataset | Size | Verdict |
|---|---|---|
| PMData | 1.35 GB | 16 people, **no biomarkers** |
| LifeSnaps | 586 MB | 71 people, **no biomarkers** |

Neither can supervise a temporal biomarker model. Downloading ~2 GB to validate
feature distributions was not worth it. **Cost:** the instrument-mismatch
limitation (NHANES self-reported sleep/activity vs sensor-measured) stays
unquantified. A cheaper future option is NHANES `PAXDAY` accelerometry, which is
paired *within-person* with the self-reports.

### Plan change 2 — the LSTM is retired, not retrained

The plan said "retrain the LSTM as a trend/delta model". Retraining changes the
output but not the supervision problem: **no open dataset pairs longitudinal
wearable data with repeated blood draws.** Instead, the trajectory applies the
real NHANES model over rolling windows of the user own history. That is honest,
simpler, and needs no synthetic data. The LSTM remains in
`src/inference/predictor.py` for comparison, tagged `Provenance.SIMULATION`.

### Unplanned finding — the model told users exercise raised their risk

Walking a trajectory over 12 weeks of *improving* behaviour, a mid-range profile
showed hypertension risk **rising +0.79 points/week**. Gradient boosting fits
non-monotonic relationships freely, and it did. Aggregate metrics were all
healthy — AUROC 0.80, calibration within 0.05, sanity check passing. Only the
trajectory exposed it.

**Fixed with monotonic constraints** on `mvpa_min_week` (decreasing) and
`sedentary_min_day` (increasing). Sleep left unconstrained because it is
U-shaped clinically. Cost: at most −0.005 AUROC; two heads actually improved.
After the fix, **zero conditions rise with improving behaviour** across five
profiles, enforced by `test_improving_behaviour_never_raises_any_risk`.

**Verified end-to-end:** `POST /predict` returns four calibrated risks, estimated
biomarkers, and four trajectories; a 3-day window returns 400 with a clear message.

---

## Day 5 — Unified inference service ✅ DONE

- [x] `ml/src/api/app.py` → FastAPI replacing both Flask apps: `/health`, `/predict`, `/recommend`
- [x] Pydantic DTOs; no `debug=True`; `PORT` and CORS from env
- [x] Graceful degradation: no `GEMINI_API_KEY` → `/recommend` 503, `/predict` unaffected
- [x] `rag_engine/` deleted
- [x] `Dockerfile` + `.dockerignore` + pinned `requirements-serve.txt`
- [x] **Measured** peak RSS: **199.9 MB** in-process, **249 MB** under uvicorn (limit 512 MB)
- [x] Service run under uvicorn; all endpoints exercised over real HTTP
- [x] 14 HTTP contract tests added (81 total)

### Measured, not assumed

| | |
|---|---|
| Peak RSS (in-process, models loaded, 20 requests) | **199.9 MB** |
| Peak RSS (uvicorn worker under load) | **249.4 MB** |
| `/predict` latency over HTTP, 84 days of history | **~100 ms** |
| TensorFlow imported by the serving path | **No** |
| onnxruntime imported by the serving path | **No** |

### Three problems found and fixed

**1. `/health` was monitoring the wrong files.** It reported
`multimodal_model.onnx` and the two MinMax scalers — the LSTM path Day 4
retired. It answered `"ok"` while describing files no request touches, and
would have kept answering `"ok"` with the real models missing. On a platform
where health drives restarts and load-balancer membership, that is worse than
having no health check. Now reports `risk_engine.joblib`,
`risk_classifiers.joblib` and the food database, and returns **503** when a
required artifact is absent.

**2. The trajectory was 98% of request latency.** Walking 11 windows made 44
separate `predict_proba` calls on 1-row frames, ~6.4 ms of scikit-learn
overhead each. Batched into one call per classifier:

| | before | after |
|---|---|---|
| `trajectory.compute` | 348.1 ms | **24.7 ms** (14×) |
| full assessment with history | 354.6 ms | **85.8 ms** (4.1×) |

**3. `onnxruntime` was dead weight in the deployment image.** Day 4 retired the
LSTM from serving, so nothing imports it. Verified by asserting
`"onnxruntime" not in sys.modules` after importing the app. Removed from
`requirements-serve.txt`.

### Plan change — the food database ships as CSV

The recommender read a 1.01 MB xlsx via openpyxl on first `/recommend`.
Converted to a 12-column CSV as a build step (`src/data/build_food_csv.py`):
**0.71s → 0.01s load (58×), 1.01 MB → 0.19 MB**, and `openpyxl` leaves the
image. On a tier that spins down after 15 minutes idle, cold start is a
user-visible cost.

### Docker: built and verified ✅

Docker was installed mid-session, so the image was actually built and run under
the free tier constraints (`--memory=512m --cpus=0.5`).

| | |
|---|---|
| Image size | **627 MB** (947 MB before slimming) |
| Memory under load | **144.9 MiB / 512 MiB (28%)** |
| `/predict` latency in-container | **54-66 ms** |
| Cold start to first healthy response | **5.4 s** |
| OOM kills | none |
| Docker HEALTHCHECK | `healthy` |

All four endpoints exercised in-container: `/health` 200, `/predict` 200 with 4
risks + 4 trajectories, `/recommend` 503 without a key, malformed input 400.
See **[ml/DOCKER.md](ml/DOCKER.md)** — Docker Desktop is a user-level install
here, so `docker` needs a PATH export before it will run.

### Two more bugs found by actually building it

**1. Stripping `tests/` broke the image, silently.** Removing test directories
to save 156 MB looked safe. It was not: `scipy` star-imports `numpy.testing`,
which imports `numpy._core.tests._natype`. numpy test code is genuinely on the
import path. Now only scipy/sklearn/pandas are stripped, numpy is excluded, and
the build runs an import check so this can never ship again.

**2. `/health` reported "ok" on a completely broken service.** During that
failure every artifact file was present, so presence-only readiness returned
`"status": "ok"` and Docker reported `healthy` — while every `/predict`
returned 500. A health check that cannot detect a dead service is worse than
none: it keeps the instance in rotation.

`/health` now runs a **cached functional probe** that loads both model bundles
and scores a profile. Verified: a container started with a bad
`RISK_ENGINE_PATH` returns **503**, not 200. The probe is cached, so it costs
one model load per process rather than one per poll — and because the first
`/health` call warms the models, a 200 means the service is genuinely ready,
not merely running.

### Plan change — the Gemini SDK was replaced with a REST call

`google-generativeai` pulled in `googleapiclient` (103 MB), `google` (25 MB),
`grpc` (18 MB) and `cryptography` (16 MB) — about **162 MB of image** to make a
single text-generation POST. `GeminiClient` now calls the REST endpoint with
`urllib` from the standard library: same Adapter interface, zero dependencies.
Combined with the `tests/` strip, the image went **947 MB → 627 MB (-34%)**.

### Concurrency caveat

12 simultaneous requests took 11.9s against ~100 ms solo — a single worker on
one CPU serialises CPU-bound scikit-learn work. Fine for a portfolio demo;
the free tier is a single instance anyway. Scale with instances, not workers,
since each worker loads its own ~7 MB of models.

---

## Day 6 — Backend truth pass ✅ DONE

- [x] All three silent mock fallbacks deleted; `InferenceClient` throws instead
- [x] Every response carries `provenance`; required field on the schema
- [x] Payload contract fixed — `RiskService.toProfilePayload` sends the diet fields
- [x] `watchDataSchema` drift fixed via field aliases
- [x] All config from env; API-key `console.log` removed
- [x] `package.json` scripts + `.env.example` + `scripts/seedFoods.js`
- [x] **`npm install` and booted against real MongoDB in Docker**
- [x] **24 integration tests** against a real database and a real inference service
- [x] 1,014 Indian foods seeded and searchable
- [x] `backend2/README.md` with local setup

### The contract, verified end to end

| ML service | `/api/predict` |
|---|---|
| up | **200** — 4 calibrated risks, `provenance: model` |
| **stopped** | **503** — `provenance: unavailable`, **zero invented scores** |
| restarted | **200** — recovers with no intervention |

v1 answered the middle row with `TG: 150 + Math.random() * 50` and HTTP 200, in
three separate places. `fails loudly when the ML service is unreachable` exists
so that cannot come back.

Full journey exercised against the running server: register 201 → login 200 →
profile 200 (BMR computed server-side) → 14 wearable days 201 → food search
(*Mutton biryani/biriyani*) → assessment with `hba1c=5.73, bp=131.56/80.24,
fli=79.05`.

### Three bugs found by actually running it

**1. Two MongoDB connections instead of one.** `MongoStore.create({ mongoUrl })`
opened its own `MongoClient` alongside mongoose. That doubles the connection
count against a free Atlas tier for no benefit, and its socket kept the event
loop alive — the integration suite passed all 24 assertions and then hung until
the runner timed out. The store now reuses `mongoose.connection.getClient()`.
Suite went from a 120 s timeout to exiting in **1.4 s**.

**2. `npm audit`: 9 vulnerabilities, 5 high** — including a mongoose NoSQL
sanitization flaw and DoS vectors in axios and the express family. `npm audit
fix` cleared 8. The last was `xlsx` (prototype pollution + ReDoS, **no fix
available** — the npm build of SheetJS is abandoned).

**3. The seed script never ran.** Its is-main guard compared `import.meta.url`
to a hand-built `file://` string, which on Windows produces `file://D:/...`
against Node's `file:///D:/...`. It exited silently with status 0. Now uses
`pathToFileURL`.

### Plan change — `xlsx` dropped entirely

Rather than accept an unpatchable HIGH advisory, `seedFoods.js` now reads the
CSV that Day 5 already generates for the inference service, parsed by a ~25-line
RFC 4180 parser (food names contain commas, so a naive split would corrupt
rows). Both services now read one canonical file.

**Result: `npm audit` reports 0 vulnerabilities.**

---

## Day 7 — Backend features ✅ DONE

- [x] Meal, vitals and activity logs persisted server-side (`MealLog`, `VitalReading`)
- [x] Meal macros aggregated by Mongo pipeline into daily totals
- [x] `POST /api/recommend` proxying the Python service
- [x] **`POST /api/chat`** — Gemini proxied server-side, grounded in the user record
- [x] Food collection seeded (done Day 6)
- [x] **22 new integration tests** (46 backend total, 84 ML)

### Done-criterion met

`a logged meal changes the next assessment` — a fresh account assesses with
`mealsCounted: 0`, then three logged meals produce `mealsCounted: 3` and
different risk scores. If that test fails, logging is decoration.

### New endpoints

`/api/logs/meals` · `/api/logs/macros/daily` · `/api/logs/macros/trend` ·
`/api/logs/vitals` · `/api/logs/activity` · `/api/chat`

### Two design decisions worth knowing

**The client can no longer assert its own nutrition.** `dietTotals` used to
arrive in the request body and go straight to the model. Macros are now resolved
against the Anuvaad database at log time from a food name plus a serving count.
A test asserts that a request claiming 99,999 kcal is ignored.

**Logged vitals outrank the model.** A recorded blood pressure or HbA1c replaces
the estimate for that field, and `inputs.measuredBiomarkers` names which values
were real. This uses the `measured` path the inference service already had.

### Plan change — "unlogged" is no longer sent as zero

The old payload sent `calorie_intake: 0` when nothing was logged, which tells
the model the user fasted. `UserProfile` diet fields are now `float | None`, the
feature bridge passes `None` through, and the gradient-boosting estimators
handle the missing feature natively. Verified: no-diet-logged, logged-a-fast and
logged-3100-kcal now produce three different estimates, because they are three
different facts.

This required a matching fix in the scorers, which compared `profile.sugar_g >
50` and crashed on `None`. An unlogged value is now never cited as a risk
contributor — the app cannot tell someone their sugar intake is high when it has
no idea what they ate.

### Three bugs found

**1. Aggregation silently matched nothing.** `Model.find()` casts a string id to
an ObjectId via the schema; `Model.aggregate()` hands the pipeline to MongoDB
untouched. `$match: { user: "65f..." }` matched zero documents and returned an
empty result rather than an error — so daily macro totals reported "no meals
logged" while the meals sat in the collection. Caught by the done-criterion test
asserting `mealsCounted === 3`.

**2. Test files corrupted each other.** Both suites ran in parallel against one
database and each `after()` hook deleted every `@niyantrana.test` user,
including the other suite's rows mid-run. Each file now tags its accounts and
deletes only its own, and the runner uses `--test-concurrency=1` — integration
tests sharing a database must not interleave.

**3. `npm audit` clean.** Carried over from Day 6: 0 vulnerabilities.

---

## Days 8-9 — Frontend ⏭️ SKIPPED (out of scope)

Both days operated entirely on `frontend/`, which is being replaced wholesale.
Rewriting `apiService.jsx` and re-wiring the dashboard would be work on files
that a rewrite discards. Decided 2026-09-10.

**Carried forward into the frontend rewrite:**
- Session-cookie auth (the backend is Passport, not JWT)
- The `AuthContext.jsx:28` double-wrap bug that blanks the dashboard on refresh
- Missing `/signup`, `/forgot-password`, `*` 404 and `errorElement` routes
- `source` / `basis` badges and a standing medical disclaimer
- Deleting `profileService.generateDoctorsReport` — it returns a stranger's
  fabricated 2023 labs
- Replacing `alert()` with toasts; persisting gamification state

**Done anyway during Day 10 cleanup:** deleted the 2.2 MB duplicate
CSV/XLSX, `public/index.html` (which collides with the real entry during
`vite build`), three stray one-shot migration scripts, and the whole dead
Google Fit integration. `frontend/` went from ~5 MB to 3 MB.

---

## Day 10 — Wearable data ✅ DONE

> **Plan changed.** The planned Fitbit OAuth integration is impossible. Recorded
> here rather than quietly substituted.

- [x] Provider-agnostic import: CSV, JSON array, or per-metric object
- [x] Wide alias map so most exports import without transformation
- [x] Idempotent upsert by date — re-importing an overlap updates, never duplicates
- [x] Demo seeder: 90 days of correlated, deterministic, `source: 'demo'` history
- [x] Deleted `googleFitService.jsx`, `GOOGLE_FIT_SETUP.md`, `GoogleFitWidget.jsx`
- [x] **20 new tests** (65 backend total, 84 ML)

### Plan change — no wearable API is available

Verified 2026-09-10:

| Provider | Status |
|---|---|
| Google Fit | New signups closed **1 May 2024**; deprecating through 2026 |
| **Fitbit Web API** | New signups closed **1 May 2024**; **sunsets September 2026** |
| Google Health API | Replacement for both; every scope **Restricted**, gated behind a privacy and security review |
| Garmin | Requires a legal entity; rejects personal-use applications |
| Withings, Oura | ✅ Still open to individual developers |

My Day 4 recommendation of Fitbit — "open registration, not sunsetting" — was
wrong. It closed to new developers on the same day Google Fit did, and sunsets
this month.

`POST /api/wearable/import` is therefore the primary path. It needs no device,
which matters because the person reviewing a portfolio project owns none, and it
cannot be deprecated. The ingest seam is shaped so Withings or Oura can be added
later as a provider emitting canonical records, with nothing downstream changing.

### Three bugs found

**1. The trajectory feature was unreachable through the API.** The inference
service has accepted a `history` field since Day 4, but `inferenceClient` never
sent it — so every response carried an empty `trajectories` array and the deck's
"risk trajectory" promise could not be demonstrated. `riskService` now reads 90
days in one query and sends the tail as the scoring window plus the whole run as
history. Caught by a demo-seeding test asserting that 90 days yields trends.

**2. The demo profile was saturated, so the demo showed nothing.** The first
version used BMI 31 / waist 106. That scores convincingly high — and produces
four straight lines, because the classifiers saturate where waist and BMI
dominate. Measured over the generator's own improving curve:

| Profile | fatty | hyper | dysgl | diab |
|---|---|---|---|---|
| BMI 31 / waist 106 | −0.12 | **+0.23** | −0.39 | −0.39 |
| **BMI 28 / waist 97** | **−2.16** | −0.00 | 0.00 | −0.20 |
| BMI 25 / waist 90 | −0.12 | 0.00 | −0.01 | −0.00 |

Note the **+0.23**: hypertension *rising* while behaviour improved. Day 4's
monotonic constraints cover activity and sedentary time but deliberately leave
sleep unconstrained (it is U-shaped clinically), so that guarantee is
**empirical, not structural** — it has to be re-checked per curve. A test now
asserts it for the exact profile and curve a reviewer sees, and also that at
least one condition visibly moves.

Demo now shows fatty_liver **82.3 → 56.9 (−2.27/wk, improving)** with nothing
rising, in the informative moderate band rather than pinned at 97.

**3. A stale server served three test runs.** `TaskStop` killed the `npm start`
wrapper but not its `node server.js` child, so a new process could not bind 8080
and the old code answered — showing the old demo profile and masking the fix.
Worth remembering: verify the port is actually free after stopping a server.

---

## Day 11 — Deploy: data + backend 🟡 PREPARED (needs your accounts)

- [x] `render.yaml` Blueprint for both services; validated (YAML parses, the
      inter-service reference resolves, every env var it sets is one the code reads)
- [x] Production config verified locally: `Secure` + `SameSite=None` + `HttpOnly`
      cookies behind a TLS proxy, exact-origin CORS with credentials
- [x] `ml/scripts/preflight.py` — catches artifacts that are uncommitted or are
      LFS pointer stubs, and confirms the models load and score
- [x] **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — step by step, plus the five
      failure modes that bite
- [x] **13 new production-config tests** (79 backend total, 84 ML)
- [ ] Create the Atlas cluster and run the Blueprint — **needs your accounts**
- [ ] Seed foods against the deployed database
- [ ] Verify cross-service calls in production

### Four problems found and fixed before deploying

**1. The Docker build would fail on Render.** `ml/Dockerfile` and
`ml/data/raw/anuvaad_indb_2024.11.csv` exist locally but are **not committed**,
so the image builds here and fails on a fresh clone. `preflight.py` reports both.

**2. Committing the food CSV would have silently broken it.**
`ml/.gitattributes` routes `data/raw/*.csv` to Git LFS. A build host that does
not fetch LFS objects copies a ~130-byte **pointer stub** instead of the
database — and the recommender loads 0 foods and carries on quietly. The file is
now exempted from LFS, and preflight fails if any artifact looks like a pointer.

**3. Every first prediction after idle would have 503'd.** A free instance sleeps
after 15 minutes and takes ~1 minute to wake, but the ML call timeout was 15s —
so the timeout fired before the service could answer, guaranteed. The client now
retries **once** with a 75-second window, and only for failures that look like a
sleeping service (`ECONNABORTED`, `ECONNREFUSED`, …). A 5xx is *not* retried:
the service answered, so repeating the call only doubles the latency.

**4. The blueprint could not wire the services together.** Render's
`fromService` + `property: host` yields a bare hostname with no scheme, which
axios cannot use. `InferenceClient.normalizeBaseUrl` now accepts either form, so
`ML_SERVICE_URL` resolves automatically instead of needing manual editing.

### The deployment trap worth remembering

Without `TRUST_PROXY=true`, Render terminates TLS at its proxy, Express sees
plain `http`, refuses to send a `Secure` cookie — and **login returns 200 with no
session**. Nothing errors; the user simply cannot stay logged in. Two tests pin
this: one asserts the cookie carries all three flags behind the proxy header, the
other asserts it is withheld without it.

### What you need to do

Two accounts, both free, ~20 minutes:

| Account | Notes |
|---|---|
| **MongoDB Atlas** M0 | 512 MB, free forever, no card. Allow `0.0.0.0/0` — Render free has no static outbound IP |
| **Render** | New → Blueprint → this repo. Paste `MONGO_URI` and `CORS_ORIGIN` |

Optional: `GEMINI_API_KEY` from `aistudio.google.com`. Without it `/api/chat` and
`/api/recommend` return 503 and everything else works.

**First:** `git add ml/Dockerfile ml/.dockerignore ml/requirements-serve.txt
ml/data/raw/anuvaad_indb_2024.11.csv render.yaml` — otherwise the build fails.

---

## Day 12 — Deploy: frontend + end-to-end ⛔ BLOCKED

Blocked on the frontend rebuild you descoped, and on the accounts in
**[docs/MANUAL_CHECKLIST.md](docs/MANUAL_CHECKLIST.md)**. `render.yaml` covers
the two backend services only.

- [ ] Frontend → Cloudflare Pages with `VITE_API_BASE_URL`
- [ ] CORS + cookie domain correct across real origins
- [ ] Full production smoke test **from a phone**
- [x] Cold start documented, and handled: one retry with a 75s window

Cross-origin cookie and CORS behaviour is already tested locally in
`backend2/tests/production.test.js` — what remains is confirming it on real
HTTPS with both ends deployed.

---

## Day 13 — Documentation ✅ DONE

- [x] **`README.md` rewritten** — the unresolved git merge conflict is gone, and
      it no longer documents a CRA stack with Zustand and localStorage
      persistence that has not existed for weeks
- [x] `ml/RESULTS.md` — 25 sections: provenance, splits, every metric against a
      baseline, SHAP, the ablations, the leakage post-mortem, every negative result
- [x] `.env.example` in **all three** services (ml and frontend were missing)
- [x] Architecture diagrams — mermaid in `docs/ARCHITECTURE.md` and the README
- [x] `docs/MANUAL_CHECKLIST.md` — everything only you can do
- [x] `docs/PORTFOLIO_NOTES.md` — interview talking points

---

## Day 14 — Demo polish 🟡 PARTIAL (backend done, UI blocked)

- [x] **Demo seeding** — `POST /api/wearable/demo` generates 90 days of
      deterministic, *correlated* history: as activity and sleep improve,
      resting heart rate falls and HRV rises. Every row stored with
      `source: "demo"`, so seeded data is distinguishable at the record level
      rather than by a banner someone could remove
- [x] The demo profile was chosen **by measurement**: BMI 31 / waist 106 scored
      convincingly high but produced an almost flat trajectory, because the
      classifiers saturate there — a reviewer would see four red dials and four
      straight lines. BMI 28 / waist 97 sits in the responsive band
- [ ] Screenshots + 60-second GIF — needs a working UI
- [ ] Loading / error / empty states — frontend
- [ ] Mobile responsiveness pass — frontend
- [ ] Lighthouse + bundle-size check — frontend

---

## Day 15 — Buffer & ship ✅ DONE (except the commit, which is yours)

- [x] **Full regression pass: 163/163 green** — 84 Python, 79 Node, against
      real MongoDB and a real containerised inference service
- [x] **Security sweep** — and it found a live hole (below)
- [x] `docs/PORTFOLIO_NOTES.md` — the problem, the leakage discovery, the fix,
      the numbers, and what not to say
- [ ] Update the decks — manual, .pptx. Exact replacement text is in the checklist
- [ ] Final commit + tag — deliberately left to you

### The security sweep found a real leak

`frontend/src/services/geminiClient.jsx` still read `VITE_GEMINI_API_KEY`. Vite
inlines anything `VITE_`-prefixed into the bundle, so that key would have been
readable by anyone opening devtools — the exact vulnerability the README claimed
was already fixed. The backend proxy existed, but this file was still there.

Deleted, and `ChatContext` rewritten to call `POST /api/chat`. It also no longer
fakes token-by-token streaming from seven canned strings when the API fails, so
a user can tell a real answer from a stub.

### And it found the fabricated health data was still reachable

`apiService.jsx` still contained **twenty** `Math.random()` health values —
risk scores presented as AI assessments, plus invented cholesterol, glucose and
haemoglobin returned as if extracted from an uploaded lab report. Six of its
eight namespaces were imported by nothing: ~600 lines of dead code that was also
the project's worst safety problem.

Replaced with a real 103-line HTTP client. `AuthContext` now uses session
cookies, and the double-wrap bug that blanked the dashboard on every refresh is
fixed. `profileService.generateDoctorsReport` — which returned a **stranger's**
hardcoded June-2023 labs, complete with Metformin and a penicillin allergy, as
the user's own summary for sharing with a doctor — now refuses instead of
fabricating.

**Fabricated health values in any `src/` tree: 0.**

---

## Definition of done

- [ ] Live URL, working from a phone — **needs the accounts in [docs/MANUAL_CHECKLIST.md](docs/MANUAL_CHECKLIST.md)**
- [x] ML service down → visible error, **never** a fake number
      *(503 with `provenance: "unavailable"`; asserted in both services)*
- [x] Different profiles → different predictions *(regression-tested; verified to
      fail against the original code)*
- [x] Real held-out metrics on real data, beating a mean-predictor baseline
      *(NHANES n=17,961; 6/6 regression targets and 4/4 classifiers)*
- [x] All three diseases scored *(four heads: fatty liver, dysglycaemia,
      diabetes, hypertension — v1 shipped one)*
- [x] No API key reachable from the browser *(the last one was found and removed
      on Day 15)*
- [x] README a reviewer can trust

**Six of seven met. The seventh is 45 minutes of account setup.**

---

## Where to go next

| | |
|---|---|
| **[docs/MANUAL_CHECKLIST.md](docs/MANUAL_CHECKLIST.md)** | Everything only you can do, ordered by priority |
| [README.md](README.md) | The project as a reviewer sees it |
| [ml/RESULTS.md](ml/RESULTS.md) | Every metric, ablation and negative result |
| [docs/PORTFOLIO_NOTES.md](docs/PORTFOLIO_NOTES.md) | How to talk about it in an interview |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Step-by-step deploy, and the five things that bite |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/REFACTORING.md](docs/REFACTORING.md) | Design rationale |
