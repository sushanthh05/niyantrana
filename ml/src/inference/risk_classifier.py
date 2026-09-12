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

    def _frame_for(self, profile: UserProfile,
                   windows: list) -> pd.DataFrame:
        """One feature row per window, in the order the models were fitted on."""
        rows = [[FeatureBridge.risk_engine_row(profile, w).get(name)
                 for name in self._features] for w in windows]
        return pd.DataFrame(rows, columns=self._features).astype(float)

    def _wrap(self, condition: str, probability) -> ConditionProbability:
        if not np.isfinite(probability):
            raise InferenceError(f"Non-finite probability for {condition}")
        return ConditionProbability(
            condition=condition,
            probability=round(min(1.0, max(0.0, float(probability))), 4),
            threshold=float(self._thresholds.get(condition, 0.5)),
            definition=self._definitions.get(condition, ""),
        )

    def predict(self, profile: UserProfile,
                window: WearableWindow | None = None) -> dict[str, ConditionProbability]:
        """Calibrated probability per condition.

        Without a wearable window, sleep and activity features are NaN; the
        gradient-boosting estimators handle that natively rather than having
        values invented for them.
        """
        return self.predict_batch(profile, [window])[0]

    def predict_batch(self, profile: UserProfile, windows: list) -> list:
        """Score many windows in one pass per classifier.

        The trajectory walks ~11 windows. Scoring them individually cost 44
        `predict_proba` calls on 1-row frames, roughly 6.4 ms of scikit-learn
        overhead each, and accounted for 98% of request latency. Batching makes
        it one call per classifier regardless of how many windows there are.
        """
        if not windows:
            return []

        frame = self._frame_for(profile, windows)
        columns = {}
        for condition, model in self._models.items():
            try:
                columns[condition] = model.predict_proba(frame)[:, 1]
            except Exception as exc:
                raise InferenceError(
                    f"Risk classifier failed for {condition}: {exc}") from exc

        return [{condition: self._wrap(condition, probabilities[i])
                 for condition, probabilities in columns.items()}
                for i in range(len(windows))]
