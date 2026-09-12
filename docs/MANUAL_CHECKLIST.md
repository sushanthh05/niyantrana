# Manual checklist — what only you can do

Everything in the 15-day plan that cannot be completed from a terminal, grouped by why it is blocked. **Nothing here is a code task.** Each item names the day it came from, what it unblocks, and roughly how long it takes.

**Total on the critical path: about 45 minutes of account setup.** Everything else is optional or waits on the frontend rebuild.

---

## ✅ Deployed — verified live 2026-09-12

Both services are up and answering:

| | |
|---|---|
| API | `https://niyantrana-api.onrender.com/health` → `status: ok`, `database: connected` |
| Inference | `https://niyantrana-inference.onrender.com/health` → `status: ok`, `functional: true` |

Confirmed working in production: register → login (**cookie issued, so `TRUST_PROXY` is right**) → authenticated request → food search returning *Mutton biryani/biriyani* (**foods seeded**) → 90 days of demo data → `v2.0.0` tagged, preflight clean.

---

## Priority 0 — Two production bugs the smoke test found (~5 min)

Both are fixed in code, but production is still running the old build.

### ☐ `ML_SERVICE_URL` does not resolve

`/api/predict` currently returns `provenance: "unavailable"` and
`/api/inference/health` reports `ENOTFOUND` — while the inference service
answers fine from the public internet.

**Cause:** `render.yaml` wired it with `fromService … property: host`, which
returns the hostname on Render's **private network**. Private networking between
web services is not available on the free plan, so the name never resolved.

**Fix now** — Render dashboard → `niyantrana-api` → Environment:

```
ML_SERVICE_URL = https://niyantrana-inference.onrender.com
```

`render.yaml` is already corrected, so a redeploy from git also fixes it.

*Silver lining: this accidentally proved the core contract in production. An
unreachable model produced a 503 with `provenance: "unavailable"` and **no
invented scores** — exactly what v1 got wrong three different ways.*

### ☐ The Gemini model name was retired

`/api/chat` returns `404: this model models/gemini-2.5-flash is no longer
available to new users` — months before its published October 2026 date.

**Fix now** — set on **both** services:

```
GEMINI_MODEL = gemini-3.5-flash
```

**Durable fix (already in code, needs a push):** both clients now try
`gemini-3.5-flash` → `gemini-3.5-flash-lite` → `gemini-2.5-flash`, cache the
first that answers, and do *not* walk the chain on a 401 or 429 since those are
not model-specific. Google shipped three Flash generations in a year, so a
single hardcoded name is a liability. Four tests cover it.

### ☐ Then re-verify

```bash
API=https://niyantrana-api.onrender.com
curl -s $API/api/inference/health | jq          # reachable: true, and now reports the url
curl -s -b j -X POST $API/api/predict -H 'Content-Type: application/json' -d '{}' | jq '.provenance, .risks'
curl -s -b j -X POST $API/api/chat -H 'Content-Type: application/json' -d '{"message":"How is my blood pressure?"}' | jq '.reply'
```

`/api/predict` should return `provenance: "model"` with four risks. That closes
the last **Definition of done** item.

---

## Priority 2 — Optional, improves the portfolio

### ☐ GitHub Student Developer Pack — ~1 day approval

DigitalOcean $200 + Azure $100. Buys always-on hosting if the 15-minute cold starts annoy you. Apply early because of the queue.

### ☐ NFHS-5 / DHS Program registration *(Day 4)* — 1–2 day approval

`dhsprogram.com`, free, short project description. ~700,000 Indians with BP, blood glucose and BMI.

**What it unblocks:** the model is currently **US-calibrated** (NHANES). South Asians develop metabolic disease at lower BMI and waist thresholds, so every score is systematically off for the target population. This is the single biggest scientific gap remaining.

**LASI** (`g2aging.org`, ~72,000 Indians **with HbA1c and BP biomarkers**) is the stronger option if you only do one — it has actual biomarkers, which NFHS-5 lacks.

### ☐ Update the pitch decks *(Day 15)*

Both `Main-idea.pptx` and `PU-idea.pptx` slide 8 still literally read `RMSE = __, R² = __`. Fill in:

```
Hypertension  AUROC 0.802   sensitivity 91%
Dysglycaemia  AUROC 0.799   sensitivity 93%
Diabetes      AUROC 0.799   sensitivity 90%
Fatty liver   AUROC 0.958   sensitivity 92%   (see caveat below)

Trained on NHANES 2013-2018, n = 17,961 adults.
Reported on a cycle holdout: train 2013-16, test 2017-18.
```

Two edits that matter more than the numbers:

- **Remove UK Biobank** from the data-sources slide. It costs £3,000–9,000 and takes months; it was never realistic. Replace with NHANES (free, no application) and NFHS-5 / LASI.
- **Caveat the fatty-liver figure.** 0.958 is close to a tautology: `bmi + waist` alone scores 0.9548, so the other 14 features add +0.003. Quoting it bare is the same category of error as v1's fake 0.974.

I can't edit .pptx reliably, so this one is genuinely manual.

### ☐ Final commit and tag *(Day 15)*

Deliberately left to you — I don't commit without being asked.

```bash
git add -A && git commit -m "Niyantrana v2: real-data risk engine, honest provenance"
git tag -a v2.0.0 -m "v2.0.0"
```

---

## Blocked on the frontend rebuild

You descoped the frontend on Day 4 ("we are gonna change entire frontend"). These wait on that.

| Item | Day | Note |
|---|---|---|
| ☐ Deploy frontend to Cloudflare Pages | 12 | `render.yaml` covers only the two backend services |
| ☐ Verify CORS + cookies across origins on real HTTPS | 12 | Config is tested locally; real cross-site needs both deployed |
| ☐ Full smoke test **from a phone** | 12 | The definition-of-done item |
| ☐ Screenshots + 60-second GIF for the README | 14 | Needs a working UI |
| ☐ Loading / error / empty states | 14 | |
| ☐ Mobile responsiveness pass | 14 | |
| ☐ Lighthouse + bundle-size check | 14 | |

**Already done for you, so the rebuild has a foundation:**

- `POST /api/wearable/demo` seeds 90 days of deterministic, correlated history — so a reviewer sees a populated app instantly, with every row tagged `source: "demo"`
- `frontend/src/services/apiService.jsx` is now a real 103-line HTTP client (was a 772-line mock)
- `AuthContext` uses real session cookies, and the double-wrap bug that blanked the dashboard on every refresh is fixed
- Every fabricated health value is gone from the frontend

---

## Known gaps I could not close

Honest list. None of these block a deploy; all belong in the README's limitations section, where they already are.

| Gap | Why it's open |
|---|---|
| **Chat and recommendation success paths still unverified** | The key is set, but the model name was retired — fix in Priority 0, then they are testable for the first time |
| **Model is US-calibrated** | Needs NFHS-5 / LASI (above). The most significant scientific limitation |
| **Self-report vs sensor mismatch unquantified** | NHANES measures sleep/activity by questionnaire; the app uses sensors. NHANES `PAXDAY` accelerometry could quantify it — it's paired within-person |
| **GGT is unpredictable** (R² −0.001) | Genuinely not learnable from lifestyle features. Reported as a negative result |
| **High probabilities are overconfident** | Dysglycaemia predicts 0.88 where 0.64 are observed. Thin bins (n=22), partly noise |
| **Trajectory driven by wearable change only** | The profile is held constant across the window walk, so it understates improvement for someone also losing weight. Needs historical profile snapshots |
| **No live wearable OAuth** | Every API a solo developer could register for has closed (Fitbit sunset this month; Google Health API gated behind restricted-scope review). Withings and Oura remain open if you want one |

---

## Quick status

| | |
|---|---|
| Tests | **167** — 84 Python, 83 Node |
| npm vulnerabilities | 0 |
| Inference image | 627 MB, runs at 145 MiB of a 512 MiB cap |
| `/predict` latency | 54–66 ms in-container |
| Fabricated health values in any `src/` tree | **0** |
| Deployed | ✅ Both backend services live on Render; two env vars to correct (Priority 0) |
