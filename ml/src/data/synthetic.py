"""Build model-ready arrays from the raw daily dataset.

Two properties matter here and both were violated by the original version:

1. Scalers are fit on the TRAINING SPLIT ONLY. Fitting MinMaxScaler on the full
   frame before splitting leaks the validation set's min/max into training.
2. The split is made at the USER level, not the row level. Samples are 14-day
   sliding windows that overlap by 13 of 14 days, so a random row-level split
   puts near-duplicate windows on both sides and the reported score becomes
   memorisation rather than generalisation. Splitting by user answers the
   question that actually matters: does this work on a person it has never seen?
"""
import json
import os

import joblib
import numpy as np
import pandas as pd
from sklearn.preprocessing import MinMaxScaler

from ..features.schema import (MLP_FEATURES, NON_FEATURE_COLUMNS, SEQUENCE_LENGTH,
                          TARGET_FEATURES, TIME_SERIES_FEATURES)

RAW_DATA_PATH = 'data/raw/synthetic_trig_ggt_dataset_with_watch.csv'
PROCESSED_DATA_PATH = 'data/processed/preprocessed_data.npz'
SPLIT_MANIFEST_PATH = 'data/processed/split_manifest.json'
FEATURE_SCALER_PATH = 'models/feature_scaler.pkl'
TARGET_SCALER_PATH = 'models/target_scaler.pkl'

RANDOM_SEED = 42
VAL_FRACTION = 0.2
TEST_FRACTION = 0.2


def load_data(filepath):
    """Load the raw daily dataset and add the gender indicator."""
    print(f"Loading data from {filepath}...")
    df = pd.read_csv(filepath, parse_dates=['date'])
    df['gender_numeric'] = (df['gender'].astype(str).str.upper().str[0] == 'M').astype(float)
    return df


def split_users(df, seed=RANDOM_SEED, val_fraction=VAL_FRACTION, test_fraction=TEST_FRACTION):
    """Partition user_ids into disjoint train/val/test groups.

    Returns three sorted lists of user_id. No user appears in more than one.
    """
    users = np.sort(df['user_id'].unique())
    rng = np.random.default_rng(seed)
    shuffled = rng.permutation(users)

    n = len(shuffled)
    n_test = max(1, int(round(n * test_fraction)))
    n_val = max(1, int(round(n * val_fraction)))
    if n_test + n_val >= n:
        raise ValueError(f"Not enough users ({n}) to build three disjoint splits.")

    test_users = sorted(shuffled[:n_test].tolist())
    val_users = sorted(shuffled[n_test:n_test + n_val].tolist())
    train_users = sorted(shuffled[n_test + n_val:].tolist())
    return train_users, val_users, test_users


def create_sequences(data, sequence_length=SEQUENCE_LENGTH):
    """Slide a window over each user's daily rows.

    For window ending at index i+sequence_length, the LSTM sees days
    [i, i+sequence_length) of wearable data and the MLP sees that day's static
    profile and diet totals. The target is that same day's biomarkers.

    Returns (X_lstm, X_mlp, y, groups) where `groups` is the user_id per sample,
    so downstream code can mask by split without re-deriving membership.
    """
    print(f"Creating sequences with a look-back window of {sequence_length} days...")
    X_lstm, X_mlp, y, groups = [], [], [], []

    for user_id, group in data.groupby('user_id'):
        user_data = group.sort_values('date')
        if len(user_data) <= sequence_length:
            continue
        ts = user_data[TIME_SERIES_FEATURES].to_numpy(np.float32)
        mlp = user_data[MLP_FEATURES].to_numpy(np.float32)
        tgt = user_data[TARGET_FEATURES].to_numpy(np.float32)
        for i in range(len(user_data) - sequence_length):
            X_lstm.append(ts[i:i + sequence_length])
            X_mlp.append(mlp[i + sequence_length])
            y.append(tgt[i + sequence_length])
            groups.append(user_id)

    return (np.asarray(X_lstm, dtype=np.float32),
            np.asarray(X_mlp, dtype=np.float32),
            np.asarray(y, dtype=np.float32),
            np.asarray(groups))


def main():
    df = load_data(RAW_DATA_PATH)

    # 1. Split users BEFORE any scaler sees the data.
    train_users, val_users, test_users = split_users(df)
    print(f"User split -> train {train_users} | val {val_users} | test {test_users}")

    train_rows = df['user_id'].isin(train_users)

    # 2. Fit scalers on training rows only, then transform everything.
    feature_cols = [c for c in df.columns
                    if c not in NON_FEATURE_COLUMNS and c != 'gender_numeric']
    print(f"Fitting scalers on {int(train_rows.sum())} training rows "
          f"({len(feature_cols)} features)...")

    feature_scaler = MinMaxScaler().fit(df.loc[train_rows, feature_cols])
    df[feature_cols] = feature_scaler.transform(df[feature_cols])
    os.makedirs(os.path.dirname(FEATURE_SCALER_PATH), exist_ok=True)
    joblib.dump(feature_scaler, FEATURE_SCALER_PATH)

    target_scaler = MinMaxScaler().fit(df.loc[train_rows, TARGET_FEATURES])
    df[TARGET_FEATURES] = target_scaler.transform(df[TARGET_FEATURES])
    joblib.dump(target_scaler, TARGET_SCALER_PATH)
    print(f"Scalers saved to {FEATURE_SCALER_PATH} and {TARGET_SCALER_PATH}")

    # 3. Build sequences, then mask into splits by user.
    X_lstm, X_mlp, y, groups = create_sequences(df)

    masks = {name: np.isin(groups, users) for name, users in
             (('train', train_users), ('val', val_users), ('test', test_users))}

    arrays = {}
    for name, mask in masks.items():
        arrays[f'X_lstm_{name}'] = X_lstm[mask]
        arrays[f'X_mlp_{name}'] = X_mlp[mask]
        arrays[f'y_{name}'] = y[mask]
        print(f"  {name:5s}: {int(mask.sum()):5d} samples from {len(np.unique(groups[mask]))} users")

    os.makedirs(os.path.dirname(PROCESSED_DATA_PATH), exist_ok=True)
    np.savez(PROCESSED_DATA_PATH, **arrays)

    with open(SPLIT_MANIFEST_PATH, 'w') as fh:
        json.dump({'seed': RANDOM_SEED, 'sequence_length': SEQUENCE_LENGTH,
                   'strategy': 'GroupSplit by user_id (disjoint users across splits)',
                   'train_users': train_users, 'val_users': val_users,
                   'test_users': test_users,
                   'scaler_fit_on': 'train rows only'}, fh, indent=2)

    print(f"\n--- Data Processing Complete ---")
    print(f"Processed data saved to {PROCESSED_DATA_PATH}")
    print(f"Split manifest saved to {SPLIT_MANIFEST_PATH}")


if __name__ == '__main__':
    main()
