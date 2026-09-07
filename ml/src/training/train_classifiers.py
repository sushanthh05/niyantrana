"""Train calibrated binary risk classifiers for the three headline conditions.

Day 2 produced regressors that estimate biomarker *levels*. This module turns
those into the clinical question a user actually asks: "am I at risk?" -- as a
calibrated probability, so a reported 30% means roughly three in ten such people
are affected.

Design decisions and why:

* **Labels count treated patients as cases.** 26.7% of NHANES adults take blood
  pressure medication and therefore have controlled readings. Labelling purely
  on `BP >= 130/80` would teach the model that a medicated hypertensive is
  healthy, which inverts the clinical meaning. The same applies to diagnosed
  diabetics whose HbA1c is controlled. Medication status is used in the LABEL
  only -- never as a feature, since it is a proxy for the diagnosis itself.

* **Isotonic calibration on a held-out split.** Gradient boosting outputs
  ranking scores, not probabilities. Without calibration a "0.7" means nothing
  in particular; with it, the number can be shown to a user.

* **Thresholds chosen for sensitivity, not accuracy.** This is a screening tool.
  Missing an at-risk person costs more than a false alarm that resolves with a
  confirmatory blood test, so the operating point targets 90% sensitivity and
  the resulting specificity and PPV are reported honestly alongside it.

* **The fatty-liver head is judged against a BMI+waist-only classifier**, not
  against chance. FLI is a formula whose four terms include BMI and waist, both
  measured exactly, so most of its apparent skill is arithmetic. Day 2 found the
  same thing for the regression head.

Run from the ml/ directory:
    python -m src.training.train_classifiers
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Callable

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import (average_precision_score, brier_score_loss,
                             roc_auc_score)
from sklearn.model_selection import train_test_split

from ..domain.models import (DIASTOLIC_HYPERTENSION, FLI_STEATOSIS_THRESHOLD,
                             HBA1C_DIABETES, HBA1C_PREDIABETES,
                             SYSTOLIC_HYPERTENSION)
from ..features.bridge import RISK_ENGINE_FEATURES

DATASET_PATH = "data/processed/nhanes_metabolic.csv"
MODEL_PATH = "models/risk_classifiers.joblib"
METRICS_PATH = "reports/classifier_metrics.json"
SHAP_DIR = "reports/shap"

RANDOM_SEED = 42
TEST_FRACTION = 0.2
CALIBRATION_FRACTION = 0.2
TARGET_SENSITIVITY = 0.90

CLASSIFIER_PARAMS = {
    "max_iter": 400,
    "learning_rate": 0.05,
    "max_leaf_nodes": 15,
    "min_samples_leaf": 60,
    "random_state": RANDOM_SEED,
    "early_stopping": False,
}


@dataclass(frozen=True)
class ConditionSpec:
    """One binary risk head."""

    name: str
    definition: str
    label: Callable[[pd.DataFrame], pd.Series]
    determinable: Callable[[pd.DataFrame], pd.Series]
    clinical_note: str


def _flag(series: pd.Series) -> pd.Series:
    """Treat a missing medication/diagnosis flag as absent rather than unknown."""
    return series.fillna(0).astype(bool)


CONDITIONS = (
    ConditionSpec(
        name="fatty_liver",
        definition=f"FLI >= {FLI_STEATOSIS_THRESHOLD:.0f}",
        label=lambda df: df["fli"] >= FLI_STEATOSIS_THRESHOLD,
        determinable=lambda df: df["fli"].notna(),
        clinical_note="Bedogni 2006 Fatty Liver Index; >= 60 rules steatosis in.",
    ),
    ConditionSpec(
        name="dysglycaemia",
        definition=f"HbA1c >= {HBA1C_PREDIABETES} or diagnosed diabetes",
        label=lambda df: (df["hba1c"] >= HBA1C_PREDIABETES) | _flag(df["diagnosed_diabetes"]),
        determinable=lambda df: df["hba1c"].notna(),
        clinical_note="ADA prediabetes threshold. Diagnosed diabetics count as cases "
                      "even when treatment has brought HbA1c back under 5.7.",
    ),
    ConditionSpec(
        name="diabetes",
        definition=f"HbA1c >= {HBA1C_DIABETES} or diagnosed diabetes",
        label=lambda df: (df["hba1c"] >= HBA1C_DIABETES) | _flag(df["diagnosed_diabetes"]),
        determinable=lambda df: df["hba1c"].notna(),
        clinical_note="ADA diabetes threshold. The lower-prevalence, higher-stakes head.",
    ),
    ConditionSpec(
        name="hypertension",
        definition=f"BP >= {SYSTOLIC_HYPERTENSION:.0f}/{DIASTOLIC_HYPERTENSION:.0f} "
                   "or on BP medication",
        label=lambda df: ((df["systolic_bp"] >= SYSTOLIC_HYPERTENSION)
                          | (df["diastolic_bp"] >= DIASTOLIC_HYPERTENSION)
                          | _flag(df["bp_medication"])),
        determinable=lambda df: df["systolic_bp"].notna() | df["diastolic_bp"].notna(),
        clinical_note="ACC/AHA 2017. 26.7% of adults take BP medication and therefore "
                      "read normal; excluding them would invert the label.",
    ),
)


# --- Metrics ----------------------------------------------------------------
def confusion_at(y_true: np.ndarray, probability: np.ndarray, threshold: float) -> dict:
    predicted = probability >= threshold
    tp = int(np.sum(predicted & (y_true == 1)))
    fp = int(np.sum(predicted & (y_true == 0)))
    fn = int(np.sum(~predicted & (y_true == 1)))
    tn = int(np.sum(~predicted & (y_true == 0)))
    safe = lambda num, den: float(num / den) if den else float("nan")  # noqa: E731
    return {
        "threshold": round(float(threshold), 4),
        "sensitivity": round(safe(tp, tp + fn), 4),
        "specificity": round(safe(tn, tn + fp), 4),
        "ppv": round(safe(tp, tp + fp), 4),
        "npv": round(safe(tn, tn + fn), 4),
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
    }


def threshold_for_sensitivity(y_true: np.ndarray, probability: np.ndarray,
                              target: float = TARGET_SENSITIVITY) -> float:
    """Lowest-alarm threshold that still catches `target` of true cases.

    Screening asymmetry: a false negative sends someone away reassured, a false
    positive sends them for a blood test.
    """
    candidates = np.unique(np.round(probability, 4))
    best = candidates.min()
    for threshold in sorted(candidates, reverse=True):
        recall = confusion_at(y_true, probability, threshold)["sensitivity"]
        if recall >= target:
            best = threshold
            break
    return float(best)


def youden_threshold(y_true: np.ndarray, probability: np.ndarray) -> float:
    """Threshold maximising sensitivity + specificity - 1."""
    candidates = np.unique(np.round(probability, 3))
    scores = [(confusion_at(y_true, probability, t)["sensitivity"]
               + confusion_at(y_true, probability, t)["specificity"] - 1, t)
              for t in candidates]
    return float(max(scores)[1])


def reliability_curve(y_true: np.ndarray, probability: np.ndarray, bins: int = 10) -> list:
    """Observed frequency against predicted probability, per decile."""
    edges = np.linspace(0.0, 1.0, bins + 1)
    curve = []
    for low, high in zip(edges[:-1], edges[1:]):
        mask = (probability >= low) & (probability < high if high < 1.0 else probability <= 1.0)
        if mask.sum() < 10:
            continue
        curve.append({
            "bin": f"{low:.1f}-{high:.1f}",
            "n": int(mask.sum()),
            "mean_predicted": round(float(probability[mask].mean()), 4),
            "observed_frequency": round(float(y_true[mask].mean()), 4),
        })
    return curve


# --- Training ---------------------------------------------------------------
def _build_frame(df: pd.DataFrame, spec: ConditionSpec):
    usable = df[spec.determinable(df)].copy()
    y = spec.label(usable).astype(int).to_numpy()
    X = usable[list(RISK_ENGINE_FEATURES)]
    return X, y


def train_condition(df: pd.DataFrame, spec: ConditionSpec):
    X, y = _build_frame(df, spec)

    X_fit, X_test, y_fit, y_test = train_test_split(
        X, y, test_size=TEST_FRACTION, random_state=RANDOM_SEED, stratify=y)
    calib_share = CALIBRATION_FRACTION / (1.0 - TEST_FRACTION)
    X_train, X_calib, y_train, y_calib = train_test_split(
        X_fit, y_fit, test_size=calib_share, random_state=RANDOM_SEED, stratify=y_fit)

    raw = HistGradientBoostingClassifier(**CLASSIFIER_PARAMS).fit(X_train, y_train)

    # Isotonic calibration on data the model has not seen.
    calibrated = CalibratedClassifierCV(raw, method="isotonic", cv="prefit")
    calibrated.fit(X_calib, y_calib)

    raw_probability = raw.predict_proba(X_test)[:, 1]
    probability = calibrated.predict_proba(X_test)[:, 1]

    sensitivity_threshold = threshold_for_sensitivity(y_test, probability)
    operating_points = {
        "high_sensitivity": confusion_at(y_test, probability, sensitivity_threshold),
        "youden": confusion_at(y_test, probability, youden_threshold(y_test, probability)),
        "default_0.5": confusion_at(y_test, probability, 0.5),
    }

    result = {
        "definition": spec.definition,
        "clinical_note": spec.clinical_note,
        "n_train": int(len(y_train)),
        "n_test": int(len(y_test)),
        "prevalence": round(float(y.mean()), 4),
        "auroc": round(float(roc_auc_score(y_test, probability)), 4),
        "auprc": round(float(average_precision_score(y_test, probability)), 4),
        "brier_uncalibrated": round(float(brier_score_loss(y_test, raw_probability)), 4),
        "brier_calibrated": round(float(brier_score_loss(y_test, probability)), 4),
        "operating_points": operating_points,
        "reliability_curve": reliability_curve(y_test, probability),
        "selected_threshold": sensitivity_threshold,
    }

    # Honest baseline for the fatty-liver head: BMI and waist are two of the four
    # FLI terms, so a two-feature model already captures most of the signal.
    if spec.name == "fatty_liver":
        anthropometry = ["bmi", "waist_cm"]
        simple = HistGradientBoostingClassifier(**CLASSIFIER_PARAMS).fit(
            X_train[anthropometry], y_train)
        simple_auroc = float(roc_auc_score(y_test, simple.predict_proba(X_test[anthropometry])[:, 1]))
        result["baseline_bmi_waist_only"] = {
            "auroc": round(simple_auroc, 4),
            "auroc_gain_from_other_features": round(result["auroc"] - simple_auroc, 4),
        }

    return result, calibrated, raw, X_test, y_test


def shap_importance(raw_model, X_sample: pd.DataFrame) -> dict:
    """Mean absolute SHAP value per feature.

    TreeExplainer is exact for gradient-boosted trees, so this attributes each
    prediction to its inputs rather than approximating with permutation.
    """
    import shap

    explainer = shap.TreeExplainer(raw_model)
    values = explainer.shap_values(X_sample)
    if isinstance(values, list):          # older SHAP returns one array per class
        values = values[1]
    if values.ndim == 3:                  # (n, features, classes)
        values = values[:, :, -1]
    mean_abs = np.abs(values).mean(axis=0)
    ranked = sorted(zip(X_sample.columns, mean_abs), key=lambda kv: kv[1], reverse=True)
    return {name: round(float(value), 5) for name, value in ranked}


def sanity_check(calibrated_models: dict) -> dict:
    """A high-risk profile must out-rank a low-risk one for every condition.

    A model can beat every baseline on aggregate metrics and still be
    clinically nonsensical on an individual. This is the cheapest guard.
    """
    low = {"age": 25, "sex_male": 1.0, "bmi": 21.0, "waist_cm": 74.0,
           "energy_kcal": 2000, "fat_g": 55, "carb_g": 250, "protein_g": 90,
           "sugar_g": 30, "fibre_g": 30, "satfat_g": 15,
           "sleep_hours": 8.0, "mvpa_min_week": 400, "sedentary_min_day": 300,
           "alcohol_drinks_week": 0, "smoking_status": 0}
    high = {"age": 62, "sex_male": 1.0, "bmi": 36.0, "waist_cm": 124.0,
            "energy_kcal": 3600, "fat_g": 165, "carb_g": 470, "protein_g": 110,
            "sugar_g": 140, "fibre_g": 9, "satfat_g": 70,
            "sleep_hours": 5.0, "mvpa_min_week": 0, "sedentary_min_day": 720,
            "alcohol_drinks_week": 21, "smoking_status": 2}

    frame = pd.DataFrame([low, high])[list(RISK_ENGINE_FEATURES)]
    report = {}
    for name, model in calibrated_models.items():
        probabilities = model.predict_proba(frame)[:, 1]
        report[name] = {
            "low_risk_profile": round(float(probabilities[0]), 4),
            "high_risk_profile": round(float(probabilities[1]), 4),
            "ordered_correctly": bool(probabilities[1] > probabilities[0]),
        }
    return report


def main():
    if not os.path.exists(DATASET_PATH):
        raise SystemExit(f"{DATASET_PATH} not found. Run the NHANES ingest first.")
    df = pd.read_csv(DATASET_PATH)
    print(f"Loaded {len(df)} NHANES adults\n")

    report = {
        "dataset": {"source": "NHANES 2013-2018 (CDC, public domain)", "rows": int(len(df))},
        "calibration": "isotonic, fitted on a held-out 20% split",
        "threshold_policy": f"operating point targets {TARGET_SENSITIVITY:.0%} sensitivity "
                            "because this is a screening tool",
        "conditions": {},
    }
    models, importances = {}, {}
    os.makedirs(SHAP_DIR, exist_ok=True)

    for spec in CONDITIONS:
        print(f"--- {spec.name} ({spec.definition}) ---")
        result, calibrated, raw, X_test, y_test = train_condition(df, spec)
        report["conditions"][spec.name] = result
        models[spec.name] = calibrated

        sample = X_test.sample(min(1500, len(X_test)), random_state=RANDOM_SEED)
        importances[spec.name] = shap_importance(raw, sample)
        with open(os.path.join(SHAP_DIR, f"{spec.name}.json"), "w") as fh:
            json.dump(importances[spec.name], fh, indent=2)

        operating = result["operating_points"]["high_sensitivity"]
        print(f"  n={result['n_train']} train / {result['n_test']} test, "
              f"prevalence {result['prevalence']:.1%}")
        print(f"  AUROC {result['auroc']:.3f}   AUPRC {result['auprc']:.3f}")
        print(f"  Brier {result['brier_uncalibrated']:.4f} -> "
              f"{result['brier_calibrated']:.4f} after calibration")
        print(f"  at {operating['sensitivity']:.0%} sensitivity: "
              f"specificity {operating['specificity']:.2f}, PPV {operating['ppv']:.2f} "
              f"(threshold {operating['threshold']})")
        if "baseline_bmi_waist_only" in result:
            baseline = result["baseline_bmi_waist_only"]
            print(f"  bmi+waist only AUROC {baseline['auroc']:.3f} -> "
                  f"other 14 features add {baseline['auroc_gain_from_other_features']:+.3f}")
        top = list(importances[spec.name].items())[:4]
        print("  SHAP top: " + ", ".join(f"{k} ({v:.3f})" for k, v in top) + "\n")

    report["shap_importance"] = importances
    report["sanity_check"] = sanity_check(models)

    print("--- sanity check: low-risk vs high-risk profile ---")
    for name, check in report["sanity_check"].items():
        mark = "OK " if check["ordered_correctly"] else "FAIL"
        print(f"  {mark} {name:14s} {check['low_risk_profile']:.3f} -> "
              f"{check['high_risk_profile']:.3f}")

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    joblib.dump({
        "models": models,
        "features": list(RISK_ENGINE_FEATURES),
        "thresholds": {name: report["conditions"][name]["selected_threshold"]
                       for name in report["conditions"]},
        "definitions": {name: report["conditions"][name]["definition"]
                        for name in report["conditions"]},
    }, MODEL_PATH)

    os.makedirs(os.path.dirname(METRICS_PATH), exist_ok=True)
    with open(METRICS_PATH, "w") as fh:
        json.dump(report, fh, indent=2)

    print(f"\nModels  -> {MODEL_PATH}")
    print(f"Metrics -> {METRICS_PATH}")
    print(f"SHAP    -> {SHAP_DIR}/")
    return report


if __name__ == "__main__":
    main()
