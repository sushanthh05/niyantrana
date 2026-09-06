"""Interchangeable model-execution backends.

Pattern applied: **Strategy**.

`predict.py` previously hardcoded `tensorflow.keras.models.load_model` at module
scope, so swapping to ONNX meant editing the prediction function itself
(a violation of the Open/Closed Principle, and the reason the earlier ONNX
migration had to rewrite working code). The execution engine is now a strategy
selected at load time; callers program to the `InferenceBackend` interface and
neither know nor care which engine is underneath.

This is what makes the deployment decision reversible: onnxruntime imports at
~33 MB RSS against TensorFlow's ~358 MB, which is the difference between fitting
and OOM-ing on a free 512 MB instance -- but training still needs Keras, so both
must coexist without the serving path importing TensorFlow.
"""
from __future__ import annotations

import os
from abc import ABC, abstractmethod

import numpy as np

from ..domain.errors import ArtifactsMissingError, InferenceError


class InferenceBackend(ABC):
    """The strategy interface. One method, deliberately.

    Refactoring: **Extract Interface**. Everything the prediction pipeline needs
    from a model is "given named input arrays, return an output array".
    """

    @abstractmethod
    def run(self, feeds: dict[str, np.ndarray]) -> np.ndarray:
        """Execute the model on the given named inputs."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable backend identifier, surfaced on /health."""


class OnnxBackend(InferenceBackend):
    """Serving strategy: onnxruntime. No TensorFlow import."""

    def __init__(self, model_path: str):
        if not os.path.exists(model_path):
            raise ArtifactsMissingError(
                f"ONNX model not found at {model_path}. "
                "Run 'python -m src.training.export_onnx' from the ml/ directory."
            )
        import onnxruntime as ort  # imported lazily so the module is importable without it

        self._path = model_path
        self._session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self._input_names = {i.name for i in self._session.get_inputs()}

    @property
    def name(self) -> str:
        return f"onnxruntime:{os.path.basename(self._path)}"

    def run(self, feeds: dict[str, np.ndarray]) -> np.ndarray:
        unknown = set(feeds) - self._input_names
        if unknown:
            raise InferenceError(
                f"Unknown model input(s) {sorted(unknown)}; expected {sorted(self._input_names)}"
            )
        try:
            return self._session.run(None, feeds)[0]
        except Exception as exc:  # onnxruntime raises bare RuntimeError
            raise InferenceError(f"ONNX inference failed: {exc}") from exc


class KerasBackend(InferenceBackend):
    """Development / parity-checking strategy. Never used in deployment."""

    def __init__(self, model_path: str, input_order: tuple[str, ...]):
        if not os.path.exists(model_path):
            raise ArtifactsMissingError(f"Keras model not found at {model_path}")
        from tensorflow.keras.models import load_model

        self._path = model_path
        self._model = load_model(model_path)
        self._input_order = input_order

    @property
    def name(self) -> str:
        return f"keras:{os.path.basename(self._path)}"

    def run(self, feeds: dict[str, np.ndarray]) -> np.ndarray:
        try:
            ordered = [feeds[name] for name in self._input_order]
        except KeyError as exc:
            raise InferenceError(f"Missing model input {exc}") from exc
        try:
            return self._model.predict(ordered, verbose=0)
        except Exception as exc:
            raise InferenceError(f"Keras inference failed: {exc}") from exc


class SklearnBackend(InferenceBackend):
    """Strategy for the NHANES-trained gradient-boosting risk engine.

    Wraps a dict of per-target estimators so a multi-output model presents the
    same single-array interface as the neural backends.
    """

    def __init__(self, estimators: dict, feature_order: tuple[str, ...], label: str = "risk_engine"):
        self._estimators = estimators
        self._feature_order = feature_order
        self._label = label

    @property
    def name(self) -> str:
        return f"sklearn:{self._label}"

    @property
    def targets(self) -> tuple[str, ...]:
        return tuple(self._estimators)

    def run(self, feeds: dict[str, np.ndarray]) -> np.ndarray:
        matrix = feeds.get("features")
        if matrix is None:
            raise InferenceError("SklearnBackend expects a 'features' input")
        try:
            columns = [np.asarray(est.predict(matrix)).reshape(-1)
                       for est in self._estimators.values()]
        except Exception as exc:
            raise InferenceError(f"Risk-engine inference failed: {exc}") from exc
        return np.column_stack(columns)
