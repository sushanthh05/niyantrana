"""The single entry point for producing a risk assessment.

Pattern applied: **Facade**.

Callers (the FastAPI layer, notebooks, the Express backend) need one call:
profile in, multi-condition assessment out. They should not have to know that a
regression engine estimates biomarkers, a calibrated classifier ensemble
estimates probabilities, four scorer strategies interpret the result, and a
trajectory analyser walks rolling windows of history.

Also **Remove Middle Man** in the other direction: the Express route used to
reach through to the ML service, re-implement the FLI formula in JavaScript, and
attach its own hardcoded action plan. That logic belongs here, once.

**Composition, and what supplies each number:**

* Condition probability -> calibrated classifier (real NHANES data, isotonic
  calibration on a held-out split).
* Biomarker levels -> the NHANES regression engine, so the UI can show the
  estimated HbA1c or blood pressure behind a score.
* Rationale and contributors -> the clinical scorers, which explain *why*.
* Trajectory -> the same real model applied to rolling windows of history.
* Measured labs, when the user supplies them, override every estimate.

The synthetic-data LSTM is deliberately absent from `build()`. It remains
constructible for comparison, but anything it touches is tagged
`Provenance.SIMULATION`.
"""
from __future__ import annotations

from ..domain.errors import InferenceError
from ..domain.models import (AssessmentContext, Biomarkers, Provenance,
                             RiskAssessment, UserProfile, WearableDay,
                             WearableWindow)
from ..inference.risk_classifier import RiskClassifierEnsemble
from ..inference.risk_engine import RiskEnginePredictor
from .scorers import DEFAULT_SCORERS, RiskScorer
from .trajectory import TrajectoryAnalyser

MEASURABLE_FIELDS = ("triglycerides", "ggt", "hba1c", "systolic_bp", "diastolic_bp")


class RiskAssessor:
    """Composes biomarker estimation, calibrated classification and scoring."""

    def __init__(self, predictor, classifiers: RiskClassifierEnsemble | None = None,
                 scorers: tuple[RiskScorer, ...] = DEFAULT_SCORERS,
                 trajectory_analyser: TrajectoryAnalyser | None = None):
        self._predictor = predictor
        self._classifiers = classifiers
        self._scorers = scorers
        self._trajectory = trajectory_analyser

    @classmethod
    def build(cls) -> "RiskAssessor":
        """Factory Method: assemble the production object graph from real-data models."""
        classifiers = RiskClassifierEnsemble.load()
        return cls(
            predictor=RiskEnginePredictor.load(),
            classifiers=classifiers,
            trajectory_analyser=TrajectoryAnalyser(classifiers=classifiers),
        )

    def assess(self, profile: UserProfile,
               window: WearableWindow | None = None,
               measured: Biomarkers | None = None,
               history: list[WearableDay] | None = None) -> RiskAssessment:
        """Produce an assessment.

        `window` is optional: the risk engine handles absent sleep and activity
        natively rather than having values invented for it. `history` (oldest
        first) enables the trajectory.
        """
        predicted = self._predict_biomarkers(profile, window)
        biomarkers, provenance = self._merge(predicted, measured)

        probabilities = {}
        if self._classifiers is not None:
            probabilities = {
                condition: result.probability
                for condition, result in self._classifiers.predict(profile, window).items()
            }

        context = AssessmentContext(profile=profile, biomarkers=biomarkers,
                                    window=window, probabilities=probabilities)

        scores = tuple(filter(None, (scorer.score(context, provenance)
                                     for scorer in self._scorers)))
        if not scores:
            raise InferenceError(
                "No condition could be scored from the available inputs. "
                "This is reported rather than substituted with a default."
            )

        return RiskAssessment(
            scores=scores,
            biomarkers=biomarkers,
            provenance=provenance,
            trajectories=self._build_trajectories(profile, history),
        )

    def _predict_biomarkers(self, profile: UserProfile,
                            window: WearableWindow | None) -> Biomarkers:
        """Call the predictor, tolerating those that require a window."""
        try:
            return self._predictor.predict(profile, window)
        except TypeError:
            # The legacy multimodal predictor takes a mandatory window.
            if window is None:
                raise
            return self._predictor.predict(profile, window)

    def _build_trajectories(self, profile: UserProfile,
                            history: list[WearableDay] | None):
        if not self._trajectory or not history:
            return ()
        return self._trajectory.compute(profile, history)

    @staticmethod
    def _merge(predicted: Biomarkers,
               measured: Biomarkers | None) -> tuple[Biomarkers, Provenance]:
        """Prefer measured values; report provenance honestly."""
        if measured is None:
            return predicted, Provenance.MODEL

        merged = {"fli": predicted.fli}
        used_measurement = False
        for name in MEASURABLE_FIELDS:
            actual = getattr(measured, name)
            if actual is not None:
                merged[name] = actual
                used_measurement = True
            else:
                merged[name] = getattr(predicted, name)

        # A measured TG and GGT make the FLI formula exact, so drop the
        # model's direct estimate and let it be recomputed from real values.
        if measured.triglycerides is not None and measured.ggt is not None:
            merged["fli"] = None

        all_measured = all(getattr(measured, name) is not None for name in MEASURABLE_FIELDS)
        provenance = Provenance.HEURISTIC if all_measured else Provenance.MODEL
        return Biomarkers(**merged), (provenance if used_measurement else Provenance.MODEL)
