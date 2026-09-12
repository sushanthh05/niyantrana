# Portfolio notes — how to talk about this project

The README is for someone browsing the repo. This is for you, in an interview.

The temptation with a health-ML project is to lead with the best number. Don't — here the best number is the least trustworthy one, and saying so is the strongest thing you can do.

---

## The 60-second version

> "I inherited a metabolic risk app that reported R² 0.97 on its ML model. I found the number was an artifact — the scalers were fit before the train/test split, and the split was random over sliding windows that overlapped by 13 of 14 days with the same 15 people on both sides. Re-split properly by user, the same model scored **worse than predicting the mean**.
>
> Separately, the served model was feeding its entire tabular branch NaN, so every user got a bit-identical prediction regardless of age or BMI.
>
> I rebuilt it on 17,961 real NHANES adults. The honest numbers are AUROC around 0.80 for hypertension, dysglycaemia and diabetes — much lower than the fake 0.97, and actually defensible."

That's the whole pitch. It demonstrates skepticism about your own metrics, which is rarer and more valuable than a high score.

---

## The four findings, in order of how much they say about you

### 1. The leakage (shows: you don't trust your own numbers)

| | |
|---|---|
| Reported | R² 0.900 (TG) / 0.974 (GGT) |
| Leak 1 | `MinMaxScaler.fit_transform` on all 5,475 rows **before** splitting |
| Leak 2 | Random split over 14-day windows overlapping 13/14 days, same 15 users both sides |
| Corrected | Disjoint-user split, scalers on train only → **R² −0.89 / −0.87** |

The punchline: 15 synthetic personas is **nine training examples at the person level**. No architecture recovers from that. It wasn't a modelling problem; it was a data problem, and recognising which is which is the skill.

### 2. The dead model branch (shows: you test what you ship, not what you trained)

`predict.py` concatenated a 1-row profile with a 14-row window on `axis=1`. Rows 1–13 of every profile column became NaN, and the code read row 13. The MLP branch received pure NaN — and didn't crash, because NaN passes through ReLU as zero.

**How I found it:** ran the same wearable data with wildly different profiles. A healthy 20-year-old (BMI 20, 1,200 kcal) and a high-risk 73-year-old (BMI 32, 4,307 kcal) both returned `153.47 / 34.44`. Bit-identical.

Offline R² 0.90 → **as-served R² −0.44.** The model was fine; the serving path was the bug. Every regression test I wrote was verified to *fail* against the original code before I trusted it.

### 3. The monotonicity bug (shows: you think about the product, not just the metric)

Building the risk-trajectory feature, I ran 12 weeks of *improving* behaviour — steps 3,000→12,000, sleep 5.4→7.6h — across five profiles. For a mid-range profile, **hypertension risk rose (+0.79 points/week)**.

Gradient boosting fits non-monotonic relationships freely, and it did. AUROC 0.80, calibration within 0.05, sanity checks passing — **every aggregate metric looked healthy.** Only walking a trajectory exposed it.

A coaching app cannot tell someone to exercise and then show their risk climbing. Fixed with monotonic constraints on activity and sedentary time; cost **≤0.005 AUROC**. Sleep deliberately left unconstrained because it's U-shaped clinically — both too little and too much are harmful.

If asked "what's the best trade you made": this one. Half a thousandth of AUROC for a product that can't contradict its own advice.

### 4. The tautology (shows: you'd rather be right than look good)

Fatty liver scores **AUROC 0.958** — by far the best number in the project. It's nearly meaningless.

FLI is a formula whose four terms include BMI and waist, which we *measure*, not estimate. So:

| Model | AUROC |
|---|---|
| All 16 features | 0.9577 |
| **`bmi` + `waist_cm` only** | **0.9548** |
| Gain from the other 14 | **+0.003** |

And on the regression side, the formula with *cohort-median* TG/GGT — **no ML at all** — explains **84.3%** of FLI variance.

A test now keeps that baseline recorded so the headline can never be quoted bare. Volunteering this is the point: it's the same category of error as the fake 0.974, and catching it in your own work is what distinguishes the two.

---

## Numbers to quote (all cycle-holdout: train 2013–16, test 2017–18)

| Condition | AUROC | Sensitivity | PPV |
|---|---|---|---|
| Hypertension | 0.802 | 91% | 0.66 |
| Dysglycaemia | 0.799 | 93% | 0.54 |
| Diabetes | 0.799 | 90% | 0.29 |

**Lead with sensitivity, not accuracy.** This is a screening tool: missing an at-risk person costs more than a false alarm that resolves with a blood test. Then volunteer the consequence — at the diabetes threshold, **roughly 7 in 10 flagged people don't have it.** That's correct for 90% sensitivity at 16.9% prevalence, and it's why the product says *get tested*, never *you have this*.

If someone challenges 0.80 as low: predicting blood chemistry from lifestyle alone is genuinely hard, and these figures are in line with the NHANES literature. The alternative on offer was 0.97 that meant nothing.

---

## Engineering points worth raising

**A health service must never invent a number.** v1 returned `Math.random()` as an AI risk assessment in three places, always with HTTP 200 — indistinguishable from a real prediction. One even returned a *stranger's* hardcoded 2023 lab values as the user's own "Doctor's Report" for sharing with a physician.

v2 makes that structurally impossible: `provenance` is a **required** field on the score object, the API response, and the database schema. A score cannot be persisted or returned without declaring its origin. Tests assert that killing the inference service produces a 503, not a plausible number.

**Deployment decisions were measured, not guessed.**

| | |
|---|---|
| TensorFlow import cost | **358 MB RSS** vs onnxruntime's 33 MB — so the image ships neither, since the models are scikit-learn |
| Image slimmed | 947 MB → **627 MB** (dropped the Gemini SDK for a stdlib REST call: 162 MB for one HTTP POST) |
| Runs at | **145 MiB of a 512 MiB cap**, `/predict` at 54–66 ms |
| Trajectory latency | 348 ms → **24.7 ms** by batching 44 one-row `predict_proba` calls into 4 |

**Bugs that only appeared under real conditions** — worth mentioning because they show you deploy, not just build:

- Stripping `tests/` from site-packages to save 156 MB broke the image: `scipy` star-imports `numpy.testing`, which imports `numpy._core.tests`. And `/health` still reported `"ok"` while every `/predict` returned 500, because it only checked file presence. Health now loads the models and scores a profile.
- Mongoose `find()` casts a string id to ObjectId via the schema; `aggregate()` does not. `$match` silently matched nothing, so daily macro totals reported "no meals logged" while the meals sat in the collection.
- Without `TRUST_PROXY`, Render terminates TLS at its proxy, Express sees plain http, refuses a `Secure` cookie — and login returns **200 with no session.** Nothing errors; users just can't stay logged in.

**Two APIs died mid-project.** I recommended Fitbit on Day 4 as "open registration, not sunsetting" — then found it closed to new developers in May 2024 and sunsets September 2026, with its replacement gated behind restricted-scope review. Pivoted to provider-agnostic file import, which needs no device and cannot be deprecated. Being wrong and correcting it in writing is better than being quietly wrong.

---

## Questions you should expect

**"Why is your best model your least trusted one?"**
Because FLI is a formula containing two features I measure exactly. The high AUROC is arithmetic, not learning — the ablation shows +0.003 from everything else.

**"How do you know the 0.80 is real?"**
Two independent held-out evaluations. The headline uses a cycle holdout — trained on 2013–16, tested on a survey wave collected years later — plus a mean-predictor baseline for every target. A model that can't beat "always guess the average" has learned nothing, and that's the comparison the original project never computed.

**"What would you do next?"**
Recalibrate on LASI — ~72,000 Indians with HbA1c and BP. The model is US-calibrated, and South Asians develop metabolic disease at lower BMI and waist thresholds, so every score is systematically off for the target population. That's the biggest remaining gap and it's in the README.

**"What's the weakest part?"**
GGT: R² −0.001, genuinely not learnable from lifestyle. It's driven by alcohol, medication and genetics. I report it as a negative result, and it caps how far the fatty-liver estimate can go — which is exactly why predicting FLI directly beats composing it from predicted TG and GGT.

---

## What not to say

- Don't quote R² 0.900 / 0.974. They're in the repo only as a documented artifact.
- Don't say "AI-powered" — say gradient boosting on 17,961 NHANES adults.
- Don't call it diagnostic. It's screening, and the API disclaimer says so.
- Don't claim the wearable integration is live. It's file import, deliberately, and the reasoning is the interesting part.
