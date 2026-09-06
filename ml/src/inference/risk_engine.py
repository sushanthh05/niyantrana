"""Serving side of the NHANES-trained Risk Engine.

Substitutable with `BiomarkerPredictor`: both expose
`predict(profile, window) -> Biomarkers`, so `RiskAssessor` accepts either
without modification (Liskov Substitution, and Strategy at the assessor level).

Why this exists: the synthetic-data LSTM scores R2 -0.89 on held-out users --
worse than a mean predictor. This engine is trained on 17,961 real NHANES
adults and beats a mean-predictor baseline on all six targets, using only
features the app actually collects.
"""
from __future__ import annotations

import os
import threading

import joblib
import numpy as np
import pandas as pd

from ..domain.errors import ArtifactsMissingError, InferenceError
from ..domain.models import Biomarkers, UserProfile, WearableWindow
from ..features.bridge import FeatureBridge

_ML_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_MODEL_PATH = os.path.join(_ML_ROOT, "models", "risk_engine.joblib")

# Targets that map onto Biomarkers fields. Extra targets in the bundle are
# ignored rather than causing a failure, so the two can version independently.
BIOMARKER_TARGETS = ("triglycerides", "ggt", "hba1c", "systolic_bp", "diastolic_bp", "fli")


class RiskEnginePredictor:
    """Predicts biomarkers from a profile plus optional wearable aggregates."""

    _lock = threading.Lock()

    def __init__(self, bundle: dict):
        self._models = bundle["models"]
        self._features = list(bundle["features"])
        self._specs = bundle.get("target_specs", {})
        self.trained_on = bundle.get("trained_on", {})

    @classmethod
    def load(cls, path: str | None = None) -> "RiskEnginePredictor":
        """Factory Method: build from the persisted training bundle."""
        target = path or os.environ.get("RISK_ENGINE_PATH", DEFAULT_MODEL_PATH)
        if not os.path.exists(target):
            raise ArtifactsMissingError(
                f"Risk engine not found at {target}. Run "
                "'python -m src.training.train_risk_engine' from the ml/ directory."
            )
        with cls._lock:
            return cls(joblib.load(target))

    @property
    def targets(self) -> tuple[str, ...]:
        return tuple(self._models)

    def predict(self, profile: UserProfile,
                window: WearableWindow | None = None) -> Biomarkers:
        """Estimate biomarkers. `window` is optional.

        Without a wearable window, sleep and activity features are NaN and the
        gradient-boosting estimator handles that natively -- it does not
        fabricate values, which is the failure mode this project exists to fix.
        """
        row = FeatureBridge.risk_engine_row(profile, window)
        frame = pd.DataFrame([[row.get(name) for name in self._features]],
                             columns=self._features).astype(float)

        readings = {}
        for name in BIOMARKER_TARGETS:
            model = self._models.get(name)
            if model is None:
                continue
            try:
                value = float(model.predict(frame)[0])
            except Exception as exc:
                raise InferenceError(f"Risk engine failed on target {name}: {exc}") from exc

            if self._specs.get(name, {}).get("log_transform"):
                value = float(np.exp(value))
            if not np.isfinite(value):
                raise InferenceError(f"Risk engine produced a non-finite value for {name}")
            readings[name] = round(value, 2)

        if not readings:
            raise InferenceError("Risk engine produced no usable targets")

        # FLI is bounded by construction; clamp rather than emit an impossible index.
        if "fli" in readings:
            readings["fli"] = round(min(100.0, max(0.0, readings["fli"])), 2)

        return Biomarkers(**readings)
