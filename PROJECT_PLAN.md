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
| `ml/` risk engine | ✅ Regression (Day 2) + calibrated classification (Day 3); composition pending (Day 4) |
| `rag_engine/` | ✅ Merged into `ml/src/recommendation/`, directory removed |
| `backend2/` | ✅ Restructured into layers; all 3 silent mock fallbacks deleted |
| `frontend/` | ⬜ Out of scope — being replaced wholesale |
| Deployment | ⬜ Nothing deployed |

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

## Day 4 — Temporal model & composition

**Goal:** make the wearable time series earn its place, honestly.

- [ ] Ingest PMData / LifeSnaps (direct download, no registration)
- [ ] Feature bridge: 14-day wearable window → NHANES-comparable features (weekly MVPA, mean sleep, sedentary)
- [ ] Retrain the LSTM as a **trend/delta** model, not an absolute predictor
- [ ] Compose: `risk = RiskEngine(baseline features) adjusted by TemporalModel(trend)`
- [ ] Risk **trajectory**: run the engine over rolling windows → fit trend → forecast
- [ ] Label every simulation-trained output explicitly in the API response

**Done when:** `/predict` returns a real risk score plus a trajectory, each tagged with its provenance.

---

## Day 5 — Unified inference service  (mostly done in the restructure)

- [x] `ml/src/api/app.py` → FastAPI replacing both Flask apps: `/health`, `/predict`, `/recommend`
- [x] Pydantic request/response models; no `debug=True`; `PORT` from env; CORS from env
- [x] Graceful degradation: no `GEMINI_API_KEY` → `/recommend` 503, `/predict` unaffected
- [x] Delete the now-redundant `rag_engine/`
- [x] Contract test: `test_failed_inference_raises_rather_than_substituting`
- [ ] `Dockerfile` (onnxruntime only, no TensorFlow) + verify RSS under ~300 MB
- [ ] Run the service and exercise both endpoints over HTTP

**Done when:** one container serves prediction + recommendation and stays under ~300 MB RSS.

---

## Day 6 — Backend truth pass  (mostly done in the restructure)

- [x] **All three silent mock fallbacks deleted**; `InferenceClient` throws instead
- [x] Every response carries `provenance`; it is a required field on the schema
- [x] Payload contract fixed — `RiskService.toProfilePayload` sends the diet fields
- [x] `watchDataSchema` drift fixed via field aliases
- [x] All config from env via `config/env.js`; API-key `console.log` removed
- [x] `package.json` scripts + `.env.example` + `scripts/seedFoods.js`
- [ ] `npm install` and boot against a real MongoDB
- [ ] Integration tests for the auth and assessment flows

**Done when:** stopping the ML service makes `/api/predict` return an error, not a plausible random number.

---

## Day 7 — Backend features

- [ ] Persist meal/vitals/activity logs server-side (currently localStorage only)
- [ ] Aggregate meal logs → daily macro totals for the model
- [ ] `POST /api/recommend` proxying the Python service
- [ ] **Gemini proxy** `POST /api/chat` — removes the API key from the browser bundle
- [ ] Seed the `foods` collection (fix `importXLSX.js`: relative path, correct DB name)

**Done when:** a logged meal reaches Mongo and changes the next prediction.

---

## Day 8 — Frontend: real API layer

- [ ] Rewrite `apiService.jsx` around `fetch(..., { credentials: 'include' })` — delete ~450 lines of dead mocks
- [ ] Switch auth to **session cookies** (backend is Passport, not JWT)
- [ ] Fix the `AuthContext.jsx:28` double-wrap bug that blanks the dashboard on refresh
- [ ] Add `/signup`, `/forgot-password`, `*` 404, `errorElement`
- [ ] `.env.example` with `VITE_API_BASE_URL`

**Done when:** sign-up → login → profile round-trips through Mongo.

---

## Day 9 — Frontend: real data surfaces

- [ ] Dashboard reads the real FLI + three risk scores; remove hardcoded `dailyMetrics`
- [ ] Show the `source` badge and a **medical disclaimer**
- [ ] Trends page reads server data
- [ ] **Delete `profileService.generateDoctorsReport`** — it currently returns a stranger's fabricated 2023 labs
- [ ] Replace `alert()` with toasts; persist gamification state
- [ ] Delete `public/index.html` (breaks `vite build`), stray scripts, 2.2 MB duplicate data files

**Done when:** no `Math.random()` and no fabricated health data anywhere in the UI.

---

## Day 10 — Fitbit integration

- [ ] Register at `dev.fitbit.com`; scopes `activity heartrate sleep profile`
- [ ] `GET /auth/fitbit` + `/callback` — **server-side token exchange**, PKCE
- [ ] Store tokens on the user; refresh-on-401
- [ ] Backfill last 14 days on connect → prediction available immediately
- [ ] Map the 6 LSTM features (steps, active min, sleep hrs, efficiency, RHR, HRV)
- [ ] JSON/CSV import fallback so a reviewer without a Fitbit can still demo
- [ ] Delete `googleFitService.jsx` + `GOOGLE_FIT_SETUP.md`

**Done when:** a Fitbit account populates `watchHistory` and drives a prediction.

---

## Day 11 — Deploy: data + backend

- [ ] MongoDB Atlas M0, seed foods collection
- [ ] Node API → Render free (`PORT` env, `trust proxy`, `secure`+`sameSite:none` cookies)
- [ ] Python service → Render free
- [ ] `render.yaml`, all secrets as env vars
- [ ] Verify cross-service calls in production

**Done when:** both services respond to public `/health`.

---

## Day 12 — Deploy: frontend + end-to-end

- [ ] Frontend → Cloudflare Pages with `VITE_API_BASE_URL`
- [ ] CORS + cookie domain correct across origins
- [ ] Full production smoke test **from a phone**: register → onboard → log meal → risk score → recommendation
- [ ] Document the 15-min cold start; add a wake-up ping

**Done when:** the whole flow works on mobile data on a public URL.

---

## Day 13 — Documentation

- [ ] Rewrite `README.md` (resolve the merge conflict; it currently documents a CRA stack that no longer exists): problem, architecture diagram, **live URL + demo credentials**, headline metrics, honest limitations
- [ ] `ml/RESULTS.md`: provenance, splits, metrics vs baseline, SHAP, the leakage finding, simulation-trained disclosure
- [ ] `.env.example` in all three services
- [ ] Architecture diagram

**Done when:** a reviewer understands the project without running it.

---

## Day 14 — Demo polish

- [ ] Seed a demo account with 30 days of realistic history
- [ ] Screenshots + a 60-second GIF in the README
- [ ] Loading/error/empty states
- [ ] Mobile responsiveness pass
- [ ] Lighthouse + bundle-size check

**Done when:** first click on the live URL shows a populated, working app.

---

## Day 15 — Buffer & ship

- [ ] Full regression pass; all tests green
- [ ] Security sweep: no secrets in the bundle, no keys in logs
- [ ] Optional: update decks (fill slide 8's `RMSE = __, R² = __`, drop UK Biobank)
- [ ] Portfolio write-up: the problem, the leakage discovery, the fix, the numbers
- [ ] Final commit + tag

---

## Definition of done

- [ ] Live URL, working from a phone
- [ ] ML service down → visible error, **never** a fake number
- [ ] Different profiles → different predictions (regression-tested)
- [ ] Real held-out metrics on real data, beating a mean-predictor baseline
- [ ] All three diseases scored
- [ ] No API key reachable from the browser
- [ ] README a reviewer can trust
