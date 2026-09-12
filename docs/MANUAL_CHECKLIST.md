# Manual checklist — what only you can do

Everything in the 15-day plan that cannot be completed from a terminal, grouped by why it is blocked. **Nothing here is a code task.** Each item names the day it came from, what it unblocks, and roughly how long it takes.

**Total on the critical path: about 45 minutes of account setup.** Everything else is optional or waits on the frontend rebuild.

---

## Priority 0 — Do this first (2 minutes, no accounts needed)

### ☐ Commit the deployment artifacts *(Day 11)*

The Docker build works on your machine and **will fail on Render**, because these exist locally but are not in git:

```bash
cd d:/agnivesh/Hackathons/Niyantrana/niyantrana
git add ml/Dockerfile ml/.dockerignore ml/requirements-serve.txt \
        ml/.gitattributes ml/data/raw/anuvaad_indb_2024.11.csv \
        ml/scripts/preflight.py render.yaml
git commit -m "Add deployment artifacts"
```

Verify with `cd ml && python scripts/preflight.py` — it should say **Ready to deploy**.

> **Why `.gitattributes` is in that list.** `data/raw/*.csv` is routed to Git LFS. Without the exemption I added, committing the food CSV would store an LFS *pointer*, and a build host that doesn't fetch LFS would copy a 130-byte stub — the recommender would then load 0 foods and say nothing. `preflight.py` now fails if any artifact looks like a pointer.

---

## Priority 1 — Accounts, to get it deployed (~45 min total)

### ☐ MongoDB Atlas *(Day 11)* — 10 min

1. `cloud.mongodb.com` → free **M0** cluster (512 MB, free forever, no card)
2. **Database Access** → create a user, strong password
3. **Network Access** → allow `0.0.0.0/0`

   Render's free tier has no static outbound IP, so an allowlist isn't possible. Credentials still protect the database; if that trade-off bothers you, a paid Render plan gives static IPs.
4. Copy the SRV string and **keep `/niyantrana` on the end** — without a database name Mongo defaults to `test` and your seeded foods become invisible.

### ☐ Render — deploy both services *(Day 11)* — 15 min

Dashboard → **New** → **Blueprint** → this repo. It reads `render.yaml` and creates both services.

Paste two values (marked `sync: false`, so Render asks):

| Service | Variable | Value |
|---|---|---|
| `niyantrana-api` | `MONGO_URI` | your Atlas SRV string |
| `niyantrana-api` | `CORS_ORIGIN` | frontend origin, e.g. `https://niyantrana.pages.dev` |

**Deploy `niyantrana-inference` first** — the API's health check depends on it.

`ML_SERVICE_URL`, `SESSION_SECRET` and `TRUST_PROXY` are wired automatically. Do not remove `TRUST_PROXY=true`: without it Render terminates TLS at its proxy, Express sees plain http, refuses to send a `Secure` cookie, and **login returns 200 while issuing no session.** Nothing errors; users simply can't stay logged in.

### ☐ Seed the production food database *(Day 11)* — 2 min

```bash
cd backend2
MONGO_URI="mongodb+srv://...your-string.../niyantrana" npm run seed
```

Expect `Seeded 1014 foods`. Food search and meal logging return empty until this runs.

### ☐ Gemini API key *(Day 7)* — 2 min, optional

`aistudio.google.com` → API key → set `GEMINI_API_KEY` on **both** Render services.

Without it, `/api/chat` and `/api/recommend` return **503** and everything else works normally. This is the only way to exercise the chat and recommendation success paths — I could only test their failure paths.

### ☐ Verify production *(Day 11)* — 5 min

```bash
API=https://niyantrana-api.onrender.com
ML=https://niyantrana-inference.onrender.com

curl -s $ML/health  | jq '.status, .artifacts.functional'   # "ok", true
curl -s $API/health | jq '.status, .database'               # "ok", "connected"
```

`artifacts.functional` is the one that matters — it means the models actually loaded and scored, not just that files exist.

Then the full journey (register → login → demo data → predict) is in [DEPLOYMENT.md §4](DEPLOYMENT.md).

⏱ The **first** `/api/predict` after idle takes up to 75 seconds — it's waking the inference service. That's the cold-start retry working, not a hang.

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
| **Chat and recommendation success paths untested** | No Gemini key available. Their 503 degradation paths *are* tested |
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
| Tests | **163** — 84 Python, 79 Node |
| npm vulnerabilities | 0 |
| Inference image | 627 MB, runs at 145 MiB of a 512 MiB cap |
| `/predict` latency | 54–66 ms in-container |
| Fabricated health values in any `src/` tree | **0** |
| Deployed | Not yet — Priority 0 and 1 above |
