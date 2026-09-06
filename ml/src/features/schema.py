"""Canonical feature schema shared by training and inference.

Both `data_processing.create_sequences` (training) and `predict.predict_risk`
(serving) import these lists. Keeping a single definition is what prevents the
two paths from drifting apart -- an earlier version of this project hardcoded
the ordering separately in each file, placed `gender_numeric` at index 0 during
inference and index 1 during training, and silently fed every MLP feature to the
wrong weight column.
"""

SEQUENCE_LENGTH = 14

# Wearable channels fed to the LSTM branch, one row per day.
TIME_SERIES_FEATURES = [
    'daily_steps', 'active_minutes', 'sleep_hours',
    'sleep_quality_score', 'resting_heart_rate', 'heart_rate_variability',
]

# Static profile + daily diet totals fed to the MLP branch. ORDER IS LOAD-BEARING.
MLP_FEATURES = [
    'age', 'gender_numeric', 'bmi', 'has_hereditary_risk',
    'calorie_intake', 'fat_grams', 'carbs_grams', 'protein_grams',
]

TARGET_FEATURES = ['triglycerides', 'ggt']

# Columns excluded from the feature scaler: identifiers, the raw gender string
# (encoded separately as gender_numeric), the targets, and the generator label.
NON_FEATURE_COLUMNS = ['user_id', 'date', 'gender', 'triglycerides', 'ggt', 'trend_type']
