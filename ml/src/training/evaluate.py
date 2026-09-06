"""Evaluate the trained model in original units against a mean-predictor baseline.

Reports MAE / RMSE / R2 per target on the validation and test splits, both of
which contain users the model has never seen. A model that cannot beat the
"always predict the training mean" baseline has learned nothing useful.
"""
import json
import os

import joblib
import numpy as np
from tensorflow.keras.models import load_model

from ..features.schema import TARGET_FEATURES

PROCESSED_DATA_PATH = 'data/processed/preprocessed_data.npz'
SPLIT_MANIFEST_PATH = 'data/processed/split_manifest.json'
MODEL_PATH = 'models/multimodal_model.h5'
TARGET_SCALER_PATH = 'models/target_scaler.pkl'
METRICS_PATH = 'reports/metrics.json'

UNITS = {'triglycerides': 'mg/dL', 'ggt': 'U/L'}


def _metrics(y_true, y_pred):
    err = y_pred - y_true
    ss_res = float(np.sum(err ** 2))
    ss_tot = float(np.sum((y_true - y_true.mean()) ** 2))
    return {
        'mae': float(np.mean(np.abs(err))),
        'rmse': float(np.sqrt(np.mean(err ** 2))),
        'r2': float(1 - ss_res / ss_tot) if ss_tot > 0 else float('nan'),
    }


def evaluate_split(model, target_scaler, data, split, baseline):
    X_lstm, X_mlp = data[f'X_lstm_{split}'], data[f'X_mlp_{split}']
    y_true = target_scaler.inverse_transform(data[f'y_{split}'])
    y_pred = target_scaler.inverse_transform(model.predict([X_lstm, X_mlp], verbose=0))

    out = {}
    for i, name in enumerate(TARGET_FEATURES):
        model_m = _metrics(y_true[:, i], y_pred[:, i])
        base_m = _metrics(y_true[:, i], np.full_like(y_true[:, i], baseline[i]))
        out[name] = {
            'unit': UNITS.get(name, ''),
            'n': int(len(y_true)),
            'model': model_m,
            'baseline_mean_predictor': base_m,
            'mae_improvement_pct': round(100 * (1 - model_m['mae'] / base_m['mae']), 1)
            if base_m['mae'] > 0 else None,
        }
    return out


def main():
    for path in (PROCESSED_DATA_PATH, MODEL_PATH, TARGET_SCALER_PATH):
        if not os.path.exists(path):
            raise SystemExit(f"Missing {path}. Run data_processing then train first.")

    data = np.load(PROCESSED_DATA_PATH)
    model = load_model(MODEL_PATH)
    target_scaler = joblib.load(TARGET_SCALER_PATH)

    # Baseline = mean of the TRAINING targets, in original units.
    baseline = target_scaler.inverse_transform(data['y_train']).mean(axis=0)

    results = {'baseline_train_mean': {n: float(baseline[i])
                                       for i, n in enumerate(TARGET_FEATURES)}}
    if os.path.exists(SPLIT_MANIFEST_PATH):
        with open(SPLIT_MANIFEST_PATH) as fh:
            results['split'] = json.load(fh)

    for split in ('val', 'test'):
        results[split] = evaluate_split(model, target_scaler, data, split, baseline)

    os.makedirs(os.path.dirname(METRICS_PATH), exist_ok=True)
    with open(METRICS_PATH, 'w') as fh:
        json.dump(results, fh, indent=2)

    for split in ('val', 'test'):
        print(f"\n=== {split.upper()} (unseen users) ===")
        print(f"{'target':16s} {'MAE':>9s} {'RMSE':>9s} {'R2':>8s} | {'base MAE':>9s} {'vs base':>8s}")
        for name in TARGET_FEATURES:
            r = results[split][name]
            m, b = r['model'], r['baseline_mean_predictor']
            print(f"{name:16s} {m['mae']:9.2f} {m['rmse']:9.2f} {m['r2']:8.3f} | "
                  f"{b['mae']:9.2f} {r['mae_improvement_pct']:7.1f}%")
    print(f"\nMetrics written to {METRICS_PATH}")


if __name__ == '__main__':
    main()
