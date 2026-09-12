# Data Sources — access status & what you need to register for

Verified 2026-09-06. **Short answer: nothing you need for Days 1–9 requires any registration.** The accounts you actually need are for *deployment*, not data.

---

## 1. In use now — no registration ✅

### NHANES (CDC, USA)
**Registration: NONE.** Already downloaded and built.

- **17,961 adults** across cycles 2013-14, 2015-16, 2017-18
- Direct HTTP download, no account, no agreement, no rate limit
- URL pattern: `https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/{year}/DataFiles/{COMPONENT}_{suffix}.xpt`
- Reproduce with: `python -m src.nhanes.download && python -m src.nhanes.build_dataset`
- Public domain (US federal government work)

This alone carries Days 2–3. It gives TG, GGT, HbA1c and blood pressure alongside a 24-hour dietary recall, sleep hours and activity minutes — the same quantities the app collects.

### Anuvaad INDB 2024.11
**Registration: NONE.** Already in the repo — 1,014 Indian foods × 82 nutrients.

---

## 2. Worth adding — no registration, direct download 🟢

| Source | Size | Why | Where |
|---|---|---|---|
| **PMData** (SimulaMet) | 16 people × 5 months | Fitbit **plus MyFitnessPal food logs** — the only free dataset matching the app's exact input combination | `datasets.simula.no/pmdata/` — also mirrored on Kaggle |
| **LifeSnaps** (Zenodo) | 71 people × 4 months, 71M rows | Largest free Fitbit corpus; good for the trajectory model | Zenodo, direct download |

Both are direct downloads. Kaggle mirrors need a free Kaggle account; the primary sources do not.

**Relevant to:** Day 4 (trajectory model).

---

## 3. Needs registration — optional, only if you want more 🟡

### NFHS-5 (India) — **recommended for the India-calibration story**
- **Registration: YES.** Free DHS Program account at `dhsprogram.com`
- You submit a short project description; approval typically **1–2 business days**
- ~700,000 Indians: BP, blood glucose, BMI, anthropometry, urban/rural, state
- No TG/GGT — use it to calibrate thresholds and the hypertension/diabetes heads to an Indian population
- **Already cited in your own decks**

### LASI Wave 1 (India)
- **Registration: YES.** Via IIPS or Gateway to Global Aging (`g2aging.org`)
- ~72,000 Indians **with HbA1c and BP biomarkers** — the Indian biomarker anchor NFHS-5 can't give you
- Turnaround: days to weeks

### AI-READI (NIH)
- **Registration: YES.** CILogon auth + data use agreement + attest your research is type-2-diabetes related + show research-ethics training
- 2,280 participants, **3.8 TB / 350k files** — far more than you need, and heavy to handle
- Free including commercial use
- **Verdict: skip unless Day 4 stalls.** The size alone is a burden for a student laptop.

### CAPTURE-24 (Oxford)
- **Registration: light.** Oxford ORA download
- 151 participants, labelled accelerometry. Cited in your decks
- Activity only, no biomarkers

---

## 4. Do not pursue ❌

| Source | Why not |
|---|---|
| **WEAR-ME** (Google Health Studies) | ⚠️ **Correction to an earlier recommendation.** I flagged this as ideal — 1,165 people with Fitbit data paired with Quest blood panels. On verification it is **not obtainable**: every paper using it is Google-authored, and data availability statements state restrictions apply and the data is not publicly available. It is an internal cohort. |
| **UK Biobank** | £3,000–9,000 application fee, months of review. **Cited in your decks — remove it.** |
| **MIMIC-IV** | Requires PhysioNet credentialing + CITI human-subjects training (1–2 weeks). Real longitudinal TG/GGT, but the effort exceeds the payoff here. |

---

## 5. What you DO need to register for — deployment accounts

These are the real blockers, and they gate specific days:

| Account | Cost | Time | Needed by | Notes |
|---|---|---|---|---|
| **Google AI Studio** (Gemini key) | Free | 2 min | Day 5 | `aistudio.google.com` → API key. Free tier ~10 RPM on 2.5 Flash |
| ~~Fitbit Developer~~ | — | — | — | ❌ **Not available.** New developer signups closed 1 May 2024 and the Fitbit Web API sunsets September 2026. Its replacement, the Google Health API, gates every scope behind a restricted-scope privacy review. Garmin requires a legal entity. **No wearable OAuth is needed:** wearable data arrives via `POST /api/wearable/import` (any provider export) or `POST /api/wearable/demo`. Withings and Oura remain open if you later want a live integration. |
| **MongoDB Atlas** | Free forever | 10 min | Day 11 | M0 tier, 512 MB, no credit card |
| **Render** | Free | 5 min | Day 11 | Two free web services (Node + Python) |
| **Cloudflare Pages** | Free | 5 min | Day 12 | Or Vercel Hobby |
| **GitHub Student Pack** | Free | ~1 day approval | Optional | DigitalOcean $200 + Azure $100 — buys always-on hosting if cold starts annoy you |

### ⏰ Do these early
- **GitHub Student Pack** — approval takes ~a day, and it's the only one with a wait. Apply now if you want it.
- **NFHS-5 / DHS** — 1–2 day approval. Apply by Day 3 if you want the India calibration on Day 4.

Everything else is instant and can be done on the day it's needed.

---

## 6. Bottom line

**Days 1–9 need zero data registrations.** NHANES is already downloaded, and it is enough to build the entire Risk Engine and get real, defensible metrics.

The only registration with a real deadline is **NFHS-5** (apply by Day 3 if you want it for Day 4), and the only one with a queue is the **GitHub Student Pack**.
