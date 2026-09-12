"""Translate domain objects into the numeric arrays a model consumes.

Refactorings applied:

* **Extract Class** -- feature assembly used to live inside `predict_risk`,
  tangled together with validation, scaling, reshaping and inverse-transforming
  (a **Long Method** doing five jobs).
* **Replace Conditional with Polymorphism** (table-driven form) -- the column
  mapping is a declarative dict of extractor callables rather than a chain of
  ifs, so adding a feature means adding one row, not editing control flow.
* **Replace Temp with Query** -- derived quantities (TEE, energy balance) are
  properties on `UserProfile` instead of locals recomputed per call site.

The bug this design eliminates: the original built its feature frame by
`pd.concat`-ing a 1-row profile with a 14-row window on `axis=1`, leaving rows
1..13 NaN, then read row 13 -- so the entire tabular branch received NaN and
every user received an identical prediction. Here the profile is explicitly
broadcast across the window, because static features *are* constant over it.
"""
from __future__ import annotations

import numpy as np

from ..domain.errors import MissingFeatureError, ValidationError
from ..domain.models import UserProfile, WearableWindow
from .schema import MLP_FEATURES, TIME_SERIES_FEATURES

# Column name -> how to obtain it. `profile` is the UserProfile, `day` the
# WearableDay for that row, `index` its 0-based position in the window.
COLUMN_SOURCES = {
    # Static profile, broadcast across every day of the window.
    "age": lambda profile, day, index: profile.age,
    "bmi": lambda profile, day, index: profile.bmi,
    "has_hereditary_risk": lambda profile, day, index: float(profile.has_hereditary_risk),
    "tee": lambda profile, day, index: profile.total_energy_expenditure,
    "calorie_intake": lambda profile, day, index: profile.energy_kcal,
    "fat_grams": lambda profile, day, index: profile.fat_g,
    "carbs_grams": lambda profile, day, index: profile.carb_g,
    "protein_grams": lambda profile, day, index: profile.protein_g,
    "energy_balance": lambda profile, day, index: profile.energy_balance,
    # Running surplus over the window.
    "cumulative_balance": lambda profile, day, index: profile.energy_balance * (index + 1),
    # Per-day wearable channels.
    "daily_steps": lambda profile, day, index: day.daily_steps,
    "active_minutes": lambda profile, day, index: day.active_minutes,
    "sleep_hours": lambda profile, day, index: day.sleep_hours,
    "sleep_quality_score": lambda profile, day, index: day.sleep_quality_score,
    "resting_heart_rate": lambda profile, day, index: day.resting_heart_rate,
    "heart_rate_variability": lambda profile, day, index: day.heart_rate_variability,
}

# Features the NHANES-trained risk engine consumes. This is the bridge proper:
# each entry is a quantity NHANES measures by questionnaire and a wearable
# measures by sensor -- the same quantity, a different instrument.
RISK_ENGINE_FEATURES = (
    "age", "sex_male", "bmi", "waist_cm",
    "energy_kcal", "fat_g", "carb_g", "protein_g", "sugar_g", "fibre_g", "satfat_g",
    "sleep_hours", "mvpa_min_week", "sedentary_min_day",
    "alcohol_drinks_week", "smoking_status",
)


class FeatureBridge:
    """Builds scaled model inputs from domain objects."""

    def __init__(self, feature_scaler, scaler_column_order: tuple[str, ...]):
        self._scaler = feature_scaler
        self._columns = tuple(scaler_column_order)
        unsupported = [c for c in self._columns if c not in COLUMN_SOURCES]
        if unsupported:
            raise MissingFeatureError(unsupported)

    def build_matrix(self, profile: UserProfile, window: WearableWindow) -> np.ndarray:
        """One row per day, columns in the scaler's fitted order."""
        rows = [
            [COLUMN_SOURCES[column](profile, day, index) for column in self._columns]
            for index, day in enumerate(window.days)
        ]
        matrix = np.asarray(rows, dtype=np.float64)
        if np.isnan(matrix).any():
            bad = [self._columns[i] for i in np.where(np.isnan(matrix).any(axis=0))[0]]
            raise ValidationError(f"Feature(s) resolved to NaN: {', '.join(bad)}")
        return matrix

    def to_model_inputs(self, profile: UserProfile,
                        window: WearableWindow) -> dict[str, np.ndarray]:
        """Produce the named arrays the multimodal backend expects."""
        scaled = self._scaler.transform(self.build_matrix(profile, window))
        by_name = {name: scaled[:, i] for i, name in enumerate(self._columns)}

        # gender_numeric is derived *after* scaling during training, so it enters
        # the model as a raw 0/1 indicator rather than a scaled value.
        by_name["gender_numeric"] = np.full(len(window.days), profile.sex.numeric)

        lstm = np.stack([by_name[name] for name in TIME_SERIES_FEATURES], axis=1)
        # The MLP sees the final day: the window predicts that day's biomarkers.
        mlp = np.array([by_name[name][-1] for name in MLP_FEATURES], dtype=np.float32)

        inputs = {
            "lstm_input": lstm.astype(np.float32)[np.newaxis, ...],
            "mlp_input": mlp[np.newaxis, ...],
        }
        for name, array in inputs.items():
            if np.isnan(array).any():
                raise ValidationError(f"NaN present in {name} after preprocessing")
        return inputs

    @staticmethod
    def risk_engine_row(profile: UserProfile, window: WearableWindow | None = None) -> dict:
        """Feature dict for the NHANES-trained risk engine.

        When a wearable window is present its aggregates supply sleep and
        activity; otherwise those stay None and the gradient-boosting model
        handles the missingness natively.
        """
        # Diet fields pass through as None when nothing was logged. The
        # estimators handle NaN natively; substituting 0 would assert a fast.
        return {
            "age": profile.age,
            "sex_male": profile.sex.numeric,
            "bmi": profile.bmi,
            "waist_cm": profile.waist_cm,
            "energy_kcal": profile.energy_kcal,
            "fat_g": profile.fat_g,
            "carb_g": profile.carb_g,
            "protein_g": profile.protein_g,
            "sugar_g": profile.sugar_g,
            "fibre_g": profile.fibre_g,
            "satfat_g": profile.satfat_g,
            "sleep_hours": window.mean_sleep_hours if window else None,
            "mvpa_min_week": window.mvpa_minutes_week if window else None,
            "sedentary_min_day": window.sedentary_minutes_day if window else None,
            "alcohol_drinks_week": profile.alcohol_drinks_week,
            "smoking_status": float(profile.smoking_status),
        }
