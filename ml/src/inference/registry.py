"""Lazy, thread-safe registry of loaded model artifacts.

Patterns applied: **Singleton** (one set of loaded weights per process) and
**Facade** (one place that knows where artifacts live and how to load them).

What this replaces: `predict.py` loaded the model, both scalers and the food
database at *module import time*, and called `exit()` if any file was missing.
Three consequences, all bad:

* importing anything from the package -- including in a unit test that never
  predicts -- paid the full model-load cost;
* a missing artifact killed the process instead of returning 503, so a
  half-provisioned deploy crash-looped rather than reporting unhealthy;
* nothing could be swapped for a fake in tests.

Loading is now deferred to first use, guarded by a lock, and every failure is a
typed exception the API layer maps to a status code.
"""
from __future__ import annotations

import os
import threading

import joblib

from ..domain.errors import ArtifactsMissingError
from .backends import InferenceBackend, OnnxBackend

# Resolved relative to the ml/ package root, not the process CWD. The old
# retriever used a CWD-relative path and only worked when launched from one
# specific directory.
_ML_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _artifact(*parts: str) -> str:
    return os.path.join(_ML_ROOT, *parts)


class ModelRegistry:
    """Holds every loaded artifact. Obtain via `ModelRegistry.instance()`."""

    _instance: "ModelRegistry | None" = None
    _instance_lock = threading.Lock()

    def __init__(self, model_path: str | None = None,
                 feature_scaler_path: str | None = None,
                 target_scaler_path: str | None = None):
        self.model_path = model_path or os.environ.get(
            "MODEL_PATH", _artifact("models", "multimodal_model.onnx"))
        self.feature_scaler_path = feature_scaler_path or os.environ.get(
            "FEATURE_SCALER_PATH", _artifact("models", "feature_scaler.pkl"))
        self.target_scaler_path = target_scaler_path or os.environ.get(
            "TARGET_SCALER_PATH", _artifact("models", "target_scaler.pkl"))

        self._lock = threading.Lock()
        self._backend: InferenceBackend | None = None
        self._feature_scaler = None
        self._target_scaler = None

    # -- Singleton access -------------------------------------------------
    @classmethod
    def instance(cls) -> "ModelRegistry":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @classmethod
    def reset(cls) -> None:
        """Drop the cached instance. Tests use this to inject fakes."""
        with cls._instance_lock:
            cls._instance = None

    # -- Lazy loading -----------------------------------------------------
    def _load_once(self, attr: str, loader):
        # Double-checked locking: the fast path takes no lock after warm-up.
        value = getattr(self, attr)
        if value is None:
            with self._lock:
                value = getattr(self, attr)
                if value is None:
                    value = loader()
                    setattr(self, attr, value)
        return value

    def _load_scaler(self, path: str, label: str):
        if not os.path.exists(path):
            raise ArtifactsMissingError(
                f"{label} not found at {path}. Run 'python -m src.data.synthetic' "
                "then 'python -m src.training.train' from the ml/ directory."
            )
        return joblib.load(path)

    @property
    def backend(self) -> InferenceBackend:
        return self._load_once("_backend", lambda: OnnxBackend(self.model_path))

    @property
    def feature_scaler(self):
        return self._load_once(
            "_feature_scaler",
            lambda: self._load_scaler(self.feature_scaler_path, "Feature scaler"))

    @property
    def target_scaler(self):
        return self._load_once(
            "_target_scaler",
            lambda: self._load_scaler(self.target_scaler_path, "Target scaler"))

    @property
    def scaler_feature_order(self) -> tuple[str, ...]:
        """Column order the feature scaler was fitted on.

        Read from the artifact rather than duplicated as a literal, so training
        and serving cannot drift -- the exact defect that put `gender_numeric`
        at index 0 during inference and index 1 during training.
        """
        return tuple(self.feature_scaler.feature_names_in_)

    # -- Health ------------------------------------------------------------
    def health(self) -> dict:
        """Artifact status for /health. Never raises."""
        report = {}
        for label, path in (("model", self.model_path),
                            ("feature_scaler", self.feature_scaler_path),
                            ("target_scaler", self.target_scaler_path)):
            report[label] = {"path": os.path.basename(path), "present": os.path.exists(path)}
        report["ready"] = all(v["present"] for v in report.values() if isinstance(v, dict))
        report["backend"] = self._backend.name if self._backend else "not loaded"
        return report
