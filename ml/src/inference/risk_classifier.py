"""Serving side of the calibrated risk classifiers.

Returns a calibrated probability per condition, plus the screening threshold
selected during training. Composition with the regression engine and the
temporal model happens in the assessor (Day 4); this module only loads and
predicts.

Design notes:

* **Thresholds travel with the model.** The operating point was chosen on a
  held-out split to hit ~90% sensitivity, so hardcoding 0.5 at the call site
  would silently discard that work.
* **Probabilities are clamped, never fabricated.** If the bundle is missing the
  loader raises rather than degrading to a default -- the property the whole
  v2 rewrite exists to guarantee.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass

import joblib
import numpy as np
import pandas as pd

from ..domain.errors import ArtifactsMissingError, InferenceError
from ..domain.models import RiskBand, UserProfile, WearableWindow
from ..features.bridge import FeatureBridge

_ML_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_PATH = os.path.join(_ML_ROOT, "models", "risk_classifiers.joblib")


@dataclass(frozen=True)
class ConditionProbability:
    """A calibrated probability for one condition, with its screening verdict."""

    condition: str
    probability: float
    threshold: float
    definition: str

    @property
    def flagged(self) -> bool:
        """True when the screening threshold is met.

        The threshold targets high sensitivity, so a flag means "worth a
        confirmatory test", not "you have this condition".
        """
        return self.probability >= self.threshold

    @property
    def band(self) -> RiskBand:
        return RiskBand.HIGH if self.probability >= 0.6 else (
            RiskBand.MODERATE if self.probability >= 0.3 else RiskBand.LOW)

    @property
    def score(self) -> float:
        """Probability expressed on the 0-100 scale used by RiskScore."""
        return round(self.probability * 100.0, 1)


class RiskClassifierEnsemble:
    """Loads the calibrated classifiers and scores a profile against all of them."""

    _lock = threading.Lock()

    def __init__(self, bundle: dict):
        self._models = bundle["models"]
        self._features = list(bundle["features"])
        self._thresholds = bundle.get("thresholds", {})
        self._definitions = bundle.get("definitions", {})

    @classmethod
    def load(cls, path: str | None = None) -> "RiskClassifierEnsemble":
        """Factory Method: build from the persisted training bundle."""
        target = path or os.environ.get("RISK_CLASSIFIER_PATH", DEFAULT_PATH)
        if not os.path.exists(target):
            raise ArtifactsMissingError(
                f"Risk classifiers not found at {target}. Run "
                "'python -m src.training.train_classifiers' from the ml/ directory."
            )
        with cls._lock:
            return cls(joblib.load(target))

    @property
    def conditions(self) -> tuple[str, ...]:
        return tuple(self._models)

    def predict(self, profile: UserProfile,
                window: WearableWindow | None = None) -> dict[str, ConditionProbability]:
        """Calibrated probability per condition.

        Without a wearable window, sleep and activity features are NaN; the
        gradient-boosting estimators handle that natively rather than having
        values invented for them.
        """
        row = FeatureBridge.risk_engine_row(profile, window)
        frame = pd.DataFrame([[row.get(name) for name in self._features]],
                             columns=self._features).astype(float)

        results = {}
        for condition, model in self._models.items():
            try:
                probability = float(model.predict_proba(frame)[0][1])
            except Exception as exc:
                raise InferenceError(
                    f"Risk classifier failed for {condition}: {exc}") from exc
            if not np.isfinite(probability):
                raise InferenceError(f"Non-finite probability for {condition}")

            results[condition] = ConditionProbability(
                condition=condition,
                probability=round(min(1.0, max(0.0, probability)), 4),
                threshold=float(self._thresholds.get(condition, 0.5)),
                definition=self._definitions.get(condition, ""),
            )
        return results
