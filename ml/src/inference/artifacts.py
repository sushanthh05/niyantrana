"""Readiness reporting for the artifacts the serving path actually uses.

Why this module exists: `/health` previously reported the status of
`multimodal_model.onnx` and the two MinMax scalers -- the multimodal LSTM path
that Day 4 retired from serving. It answered "ok" while describing files no
request touches, and would have kept answering "ok" with the real models
missing. On a platform where the health check drives restarts and load-balancer
membership, a health endpoint that monitors the wrong files is worse than none.

Two levels, because they answer different questions:

* `readiness()` -- presence only, no loading. Cheap enough to poll constantly.
* `full_readiness()` -- adds a cached functional probe that actually loads the
  models and scores a profile. Presence alone proved insufficient: a build that
  stripped numpy test modules left every file in place, so presence-only
  readiness reported "ok" and Docker reported "healthy", while every /predict
  returned 500 because scipy could not import.

The functional probe is cached for the life of the process. That means it
answers "did this instance ever work", not "is it working right now" -- which is
the right question for an immutable container image, where the model stack
cannot change after startup.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass

_ML_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _resolve(env_var: str, *default_parts: str) -> str:
    return os.environ.get(env_var) or os.path.join(_ML_ROOT, *default_parts)


@dataclass(frozen=True)
class Artifact:
    """One file the service depends on."""

    name: str
    path: str
    required: bool
    purpose: str

    @property
    def present(self) -> bool:
        return os.path.exists(self.path)

    def report(self) -> dict:
        entry = {
            "file": os.path.basename(self.path),
            "present": self.present,
            "required": self.required,
            "purpose": self.purpose,
        }
        if self.present:
            entry["size_kb"] = round(os.path.getsize(self.path) / 1024, 1)
        return entry


def serving_artifacts() -> tuple[Artifact, ...]:
    """Every artifact the request path reads, in dependency order."""
    return (
        Artifact(
            name="risk_engine",
            path=_resolve("RISK_ENGINE_PATH", "models", "risk_engine.joblib"),
            required=True,
            purpose="biomarker regression (triglycerides, GGT, HbA1c, BP, FLI)",
        ),
        Artifact(
            name="risk_classifiers",
            path=_resolve("RISK_CLASSIFIER_PATH", "models", "risk_classifiers.joblib"),
            required=True,
            purpose="calibrated condition probabilities",
        ),
        Artifact(
            name="food_database",
            path=_resolve("FOOD_DB_PATH", "data", "raw", "anuvaad_indb_2024.11.csv"),
            required=False,
            purpose="Indian food composition, used only by /recommend",
        ),
    )


def readiness() -> dict:
    """Artifact status for /health. Never raises, never loads a model."""
    artifacts = serving_artifacts()
    report = {artifact.name: artifact.report() for artifact in artifacts}

    missing_required = [a.name for a in artifacts if a.required and not a.present]
    report["ready"] = not missing_required
    if missing_required:
        report["missing_required"] = missing_required
    return report


# --- Functional readiness ----------------------------------------------------
#
# File presence is not readiness. A build that stripped numpy test modules
# produced an image where every artifact was present -- so this module reported
# "ok" and Docker reported "healthy" -- while every /predict returned 500,
# because scipy could not import. A health check that cannot detect a totally
# broken service is worse than none: it keeps a dead instance in rotation.
#
# So the probe actually loads the models and runs one prediction. It is done
# once and cached, because the first call is the expensive one and a readiness
# probe polled every 30 seconds must not reload models each time.

_probe_lock = threading.Lock()
_probe_result: dict | None = None


def _run_probe() -> dict:
    """Load the models and score one synthetic profile. Never raises."""
    try:
        from ..domain.models import Sex, UserProfile
        from .risk_classifier import RiskClassifierEnsemble
        from .risk_engine import RiskEnginePredictor

        profile = UserProfile(age=45, sex=Sex.MALE, bmi=27.0, waist_cm=95.0)

        engine = RiskEnginePredictor.load()
        biomarkers = engine.predict(profile)

        classifiers = RiskClassifierEnsemble.load()
        probabilities = classifiers.predict(profile)

        if biomarkers.fli is None or not probabilities:
            return {"functional": False,
                    "error": "models loaded but produced no usable output"}

        return {"functional": True,
                "conditions": sorted(probabilities),
                "targets": sorted(k for k, v in vars(biomarkers).items() if v is not None)}
    except Exception as exc:
        return {"functional": False, "error": f"{type(exc).__name__}: {exc}"}


def functional_check(force: bool = False) -> dict:
    """Cached end-to-end probe of the model stack.

    Cached because loading roughly 7 MB of estimators on every poll would make
    the health check the most expensive endpoint on the service.
    """
    global _probe_result
    if _probe_result is None or force:
        with _probe_lock:
            if _probe_result is None or force:
                _probe_result = _run_probe()
    return _probe_result


def reset_probe_cache() -> None:
    """Drop the cached probe result. Used by tests."""
    global _probe_result
    with _probe_lock:
        _probe_result = None


def full_readiness() -> dict:
    """Artifact presence plus a cached functional probe."""
    report = readiness()
    probe = functional_check()
    report["functional"] = probe["functional"]
    if not probe["functional"]:
        report["functional_error"] = probe.get("error")
        report["ready"] = False
    return report
