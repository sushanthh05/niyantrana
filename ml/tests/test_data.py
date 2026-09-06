"""Tests for split integrity -- the property that made the old metrics fiction."""
import json
import os

import numpy as np
import pytest

from src.data.synthetic import load_data, split_users
from src.features.schema import MLP_FEATURES, TIME_SERIES_FEATURES

PROCESSED = 'data/processed/preprocessed_data.npz'
MANIFEST = 'data/processed/split_manifest.json'


def test_user_splits_are_disjoint():
    df = load_data('data/raw/synthetic_trig_ggt_dataset_with_watch.csv')
    train, val, test = split_users(df)
    assert not (set(train) & set(val)), "train/val share users"
    assert not (set(train) & set(test)), "train/test share users"
    assert not (set(val) & set(test)), "val/test share users"
    assert set(train) | set(val) | set(test) == set(df['user_id'].unique())


@pytest.mark.skipif(not os.path.exists(PROCESSED), reason="run src.data.synthetic first")
def test_processed_arrays_have_expected_shapes():
    data = np.load(PROCESSED)
    for split in ('train', 'val', 'test'):
        X_lstm, X_mlp, y = (data[f'X_lstm_{split}'], data[f'X_mlp_{split}'], data[f'y_{split}'])
        assert X_lstm.shape[1:] == (14, len(TIME_SERIES_FEATURES))
        assert X_mlp.shape[1] == len(MLP_FEATURES)
        assert y.shape[1] == 2
        assert len(X_lstm) == len(X_mlp) == len(y) > 0
        assert not np.isnan(X_lstm).any() and not np.isnan(X_mlp).any()


@pytest.mark.skipif(not os.path.exists(MANIFEST), reason="run src.data.synthetic first")
def test_manifest_records_leak_free_strategy():
    with open(MANIFEST) as fh:
        manifest = json.load(fh)
    assert manifest['scaler_fit_on'] == 'train rows only'
    assert 'user_id' in manifest['strategy']
