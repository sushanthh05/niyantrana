"""Train the multi-target Risk Engine on real NHANES data.

This is the scientific core of Niyantrana v2. It replaces the synthetic-data
LSTM as the source of biomarker estimates, because that model scored R^2 -0.89
on held-out *users* -- worse than predicting the mean -- once the leakage was
removed. Fifteen synthetic personas is nine training examples at the person
level; no architecture recovers from that.

Design decisions and why:

* **HistGradientBoostingRegressor**, not XGBoost/LightGBM. It handles NaN
  natively, which matters because NHANES has real missingness in every column
  (sleep_hours is only 66% complete), and it adds zero deployment dependencies
  beyond the scikit-learn already needed for scalers.

* **Log-transformed targets** for triglycerides, GGT and HbA1c. All three are
  strongly right-skewed (TG median 92, IQR 62-138), so squared error on the raw
  scale is dominated by a handful of extreme values. Training on log and
  inverting for reporting optimises what we actually care about: relative error
  across the normal range.

* **Two independent held-out evaluations.** A random split answers "does this
  generalise to another person from the same survey?"; a cycle holdout (train
  2013-2016, test 2017-2018) answers the harder question, "does it survive a
  different survey wave, collected years later?" The second is the honest
  proxy for deployment.

* **Every target is compared against a mean-predictor baseline.** A model that
  cannot beat "always guess the training mean" has learned nothing, and that
  comparison is the one number the v1 project never computed.

Run from the ml/ directory:
    python -m src.training.train_risk_engine
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import train_test_split

from ..features.bridge import RISK_ENGINE_FEATURES

DATASET_PATH = "data/processed/nhanes_metabolic.csv"
MODEL_PATH = "models/risk_engine.joblib"
METRICS_PATH = "reports/nhanes_metrics.json"

RANDOM_SEED = 42
VAL_FRACTION = 0.2
TEST_FRACTION = 0.2

# Cycles used to train the temporal-generalisation check; the newest is held out.
TEMPORAL_TRAIN_CYCLES = ("2013-2014", "2015-2016")
TEMPORAL_TEST_CYCLE = "2017-2018"


@dataclass(frozen=True)
class TargetSpec:
    """How one biomarker is modelled and reported."""

    name: str
    unit: str
    log_transform: bool

    def forward(self, y: np.ndarray) -> np.ndarray:
        return np.log(y) if self.log_transform else y

    def inverse(self, y: np.ndarray) -> np.ndarray:
        return np.exp(y) if self.log_transform else y


TARGETS = (
    TargetSpec("triglycerides", "mg/dL", log_transform=True),
    TargetSpec("ggt", "U/L", log_transform=True),
    TargetSpec("hba1c", "%", log_transform=True),
    TargetSpec("systolic_bp", "mmHg", log_transform=False),
    TargetSpec("diastolic_bp", "mmHg", log_transform=False),
    # Predicted DIRECTLY rather than composed from predicted TG and GGT.
    # Composing scores R2 ~0.05, because both components are poorly predictable
    # from lifestyle; predicting FLI directly scores ~0.86, because two of its
    # four terms (BMI, waist) are measured inputs we know exactly.
    TargetSpec("fli", "index 0-100", log_transform=False),
)

# Modest grid. The point of this project is honest evaluation, not squeezing
# the last percent out of a hyperparameter search.
PARAM_GRID = (
    {"max_iter": 300, "learning_rate": 0.05, "max_leaf_nodes": 31, "min_samples_leaf": 40},
    {"max_iter": 400, "learning_rate": 0.05, "max_leaf_nodes": 15, "min_samples_leaf": 60},
    {"max_iter": 500, "learning_rate": 0.03, "max_leaf_nodes": 31, "min_samples_leaf": 20},
)


def formula_reference_baseline(train_frame: pd.DataFrame, test_frame: pd.DataFrame) -> np.ndarray:
    """The honest baseline for FLI: the Bedogni formula with no ML at all.

    Substitutes cohort-median triglycerides and GGT into the real equation
    alongside each person's MEASURED BMI and waist. This scores R2 ~0.84 by
    itself, so comparing an FLI model against a mean predictor (R2 0.0) would
    flatter it enormously -- the variance is in the formula, not in anything
    the model learned. Any FLI model must beat THIS to have earned its place.
    """
    tg_median = float(train_frame["triglycerides"].median())
    ggt_median = float(train_frame["ggt"].median())
    z = (0.953 * np.log(tg_median)
         + 0.139 * test_frame["bmi"].to_numpy(float)
         + 0.718 * np.log(ggt_median)
         + 0.053 * test_frame["waist_cm"].to_numpy(float)
         - 15.745)
    return 100.0 * np.exp(z) / (1.0 + np.exp(z))


def regression_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    error = y_pred - y_true
    ss_res = float(np.sum(error ** 2))
    ss_tot = float(np.sum((y_true - y_true.mean()) ** 2))
    return {
        "mae": float(np.mean(np.abs(error))),
        "rmse": float(np.sqrt(np.mean(error ** 2))),
        "r2": float(1 - ss_res / ss_tot) if ss_tot > 0 else float("nan"),
        "n": int(len(y_true)),
    }


def load_dataset(path: str = DATASET_PATH) -> pd.DataFrame:
    if not os.path.exists(path):
        raise SystemExit(
            f"{path} not found. Run 'python -m src.data.nhanes.download' then "
            "'python -m src.data.nhanes.build_dataset' from the ml/ directory."
        )
    return pd.read_csv(path)


def _target_frame(df: pd.DataFrame, target: str) -> pd.DataFrame:
    """Rows usable for one target: the label must be present.

    Features may contain NaN -- the estimator handles that natively, and
    dropping those rows would discard a third of the data.
    """
    # dict.fromkeys de-duplicates: bmi and waist_cm are already features.
    columns = list(dict.fromkeys(
        list(RISK_ENGINE_FEATURES) + [target, "cycle", "triglycerides", "ggt"]))
    return df[columns].dropna(subset=[target])


def _fit_best(X_train, y_train, X_val, y_val, spec: TargetSpec):
    """Select hyperparameters on the validation split, in transformed space."""
    best, best_params, best_loss = None, None, np.inf
    for params in PARAM_GRID:
        model = HistGradientBoostingRegressor(
            random_state=RANDOM_SEED, early_stopping=False, **params)
        model.fit(X_train, spec.forward(y_train))
        loss = float(np.mean((model.predict(X_val) - spec.forward(y_val)) ** 2))
        if loss < best_loss:
            best, best_params, best_loss = model, params, loss
    return best, best_params


def evaluate_target(df: pd.DataFrame, spec: TargetSpec) -> tuple[dict, HistGradientBoostingRegressor]:
    """Train, tune and evaluate one target on both split strategies."""
    frame = _target_frame(df, spec.name)
    X = frame[list(RISK_ENGINE_FEATURES)]
    y = frame[spec.name].to_numpy(float)

    # --- Random split: train / val / test ---
    X_fit, X_test, y_fit, y_test = train_test_split(
        X, y, test_size=TEST_FRACTION, random_state=RANDOM_SEED)
    val_share = VAL_FRACTION / (1.0 - TEST_FRACTION)
    X_train, X_val, y_train, y_val = train_test_split(
        X_fit, y_fit, test_size=val_share, random_state=RANDOM_SEED)

    model, params = _fit_best(X_train, y_train, X_val, y_val, spec)

    predicted = spec.inverse(model.predict(X_test))
    baseline = np.full_like(y_test, y_train.mean())

    model_metrics = regression_metrics(y_test, predicted)
    baseline_metrics = regression_metrics(y_test, baseline)

    # FLI gets an additional, much stronger domain baseline.
    if spec.name == "fli":
        reference = formula_reference_baseline(
            frame.loc[X_train.index], frame.loc[X_test.index])
        reference_metrics = regression_metrics(y_test, reference)
    else:
        reference_metrics = None

    result = {
        "unit": spec.unit,
        "log_transform": spec.log_transform,
        "hyperparameters": params,
        "train_n": int(len(y_train)),
        "random_split": {
            "model": model_metrics,
            "baseline_mean_predictor": baseline_metrics,
            "mae_improvement_pct": round(
                100 * (1 - model_metrics["mae"] / baseline_metrics["mae"]), 1),
            "beats_baseline": model_metrics["mae"] < baseline_metrics["mae"],
        },
    }

    if reference_metrics is not None:
        result["random_split"]["baseline_formula_reference"] = reference_metrics
        result["random_split"]["gain_over_formula_pct"] = round(
            100 * (1 - model_metrics["mae"] / reference_metrics["mae"]), 1)
        # The bar that actually matters for FLI.
        result["random_split"]["beats_baseline"] = (
            model_metrics["mae"] < reference_metrics["mae"])

    # --- Cycle holdout: train on older waves, test on the newest ---
    older = frame[frame["cycle"].isin(TEMPORAL_TRAIN_CYCLES)]
    newest = frame[frame["cycle"] == TEMPORAL_TEST_CYCLE]
    if len(older) > 100 and len(newest) > 100:
        temporal = HistGradientBoostingRegressor(
            random_state=RANDOM_SEED, early_stopping=False, **params)
        y_older = older[spec.name].to_numpy(float)
        temporal.fit(older[list(RISK_ENGINE_FEATURES)], spec.forward(y_older))

        y_newest = newest[spec.name].to_numpy(float)
        temporal_pred = spec.inverse(temporal.predict(newest[list(RISK_ENGINE_FEATURES)]))
        temporal_metrics = regression_metrics(y_newest, temporal_pred)
        temporal_baseline = regression_metrics(y_newest, np.full_like(y_newest, y_older.mean()))
        result["cycle_holdout"] = {
            "train_cycles": list(TEMPORAL_TRAIN_CYCLES),
            "test_cycle": TEMPORAL_TEST_CYCLE,
            "model": temporal_metrics,
            "baseline_mean_predictor": temporal_baseline,
            "mae_improvement_pct": round(
                100 * (1 - temporal_metrics["mae"] / temporal_baseline["mae"]), 1),
            "beats_baseline": temporal_metrics["mae"] < temporal_baseline["mae"],
        }

    # Refit on everything for the shipped artifact: the evaluation above already
    # established generalisation, so the deployed model should use all the data.
    final = HistGradientBoostingRegressor(
        random_state=RANDOM_SEED, early_stopping=False, **params)
    final.fit(X, spec.forward(y))
    return result, final


def permutation_importance(model, X, y, spec, repeats=3) -> dict:
    """Feature importance by shuffling each column and measuring MAE damage.

    Model-agnostic and cheap; SHAP arrives on Day 3 for the classification heads.
    """
    rng = np.random.default_rng(RANDOM_SEED)
    baseline = float(np.mean(np.abs(spec.inverse(model.predict(X)) - y)))
    scores = {}
    for column in RISK_ENGINE_FEATURES:
        damage = []
        for _ in range(repeats):
            shuffled = X.copy()
            shuffled[column] = rng.permutation(shuffled[column].to_numpy())
            damage.append(float(np.mean(np.abs(spec.inverse(model.predict(shuffled)) - y))))
        scores[column] = round(float(np.mean(damage)) - baseline, 4)
    return dict(sorted(scores.items(), key=lambda kv: kv[1], reverse=True))


def main():
    df = load_dataset()
    print(f"Loaded {len(df)} NHANES adults across {df['cycle'].nunique()} cycles")
    print(f"Features: {len(RISK_ENGINE_FEATURES)}\n")

    report = {
        "dataset": {
            "source": "NHANES 2013-2018 (CDC, public domain)",
            "rows": int(len(df)),
            "cycles": sorted(df["cycle"].unique().tolist()),
            "features": list(RISK_ENGINE_FEATURES),
        },
        "targets": {},
    }
    models, importances = {}, {}

    for spec in TARGETS:
        print(f"--- {spec.name} ---")
        result, model = evaluate_target(df, spec)
        report["targets"][spec.name] = result
        models[spec.name] = model

        frame = _target_frame(df, spec.name)
        importances[spec.name] = permutation_importance(
            model, frame[list(RISK_ENGINE_FEATURES)], frame[spec.name].to_numpy(float), spec)

        random_split = result["random_split"]
        print(f"  n={result['train_n']}  params={result['hyperparameters']}")
        print(f"  random split : MAE {random_split['model']['mae']:7.2f} "
              f"vs baseline {random_split['baseline_mean_predictor']['mae']:7.2f} "
              f"({random_split['mae_improvement_pct']:+.1f}%)  R2 {random_split['model']['r2']:+.3f}")
        if "baseline_formula_reference" in random_split:
            reference = random_split["baseline_formula_reference"]
            print(f"  vs FORMULA reference (no ML): MAE {reference['mae']:7.2f} "
                  f"R2 {reference['r2']:+.3f} -> model gains "
                  f"{random_split['gain_over_formula_pct']:+.1f}%")
        if "cycle_holdout" in result:
            holdout = result["cycle_holdout"]
            print(f"  cycle holdout: MAE {holdout['model']['mae']:7.2f} "
                  f"vs baseline {holdout['baseline_mean_predictor']['mae']:7.2f} "
                  f"({holdout['mae_improvement_pct']:+.1f}%)  R2 {holdout['model']['r2']:+.3f}")
        top = list(importances[spec.name].items())[:4]
        print("  top features : " + ", ".join(f"{k} ({v:+.2f})" for k, v in top) + "\n")

    report["feature_importance"] = importances

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    joblib.dump({
        "models": models,
        "features": list(RISK_ENGINE_FEATURES),
        "target_specs": {s.name: {"unit": s.unit, "log_transform": s.log_transform}
                         for s in TARGETS},
        "trained_on": report["dataset"],
    }, MODEL_PATH)

    os.makedirs(os.path.dirname(METRICS_PATH), exist_ok=True)
    with open(METRICS_PATH, "w") as fh:
        json.dump(report, fh, indent=2)

    passed = sum(1 for t in report["targets"].values() if t["random_split"]["beats_baseline"])
    print(f"=== {passed}/{len(TARGETS)} targets beat the mean-predictor baseline ===")
    print(f"Model  -> {MODEL_PATH}")
    print(f"Metrics-> {METRICS_PATH}")
    return report


if __name__ == "__main__":
    main()
