"""The single entry point for producing a risk assessment.

Pattern applied: **Facade**.

Callers (the FastAPI layer, notebooks, the Express backend) need one call:
profile + wearable window in, multi-condition assessment out. They should not
have to know that a registry loads artifacts, a bridge assembles features, a
backend runs a graph and three scorer strategies interpret the result.

Also **Remove Middle Man** in the other direction: the Express route used to
reach through to the ML service, re-implement the FLI formula in JavaScript, and
attach its own hardcoded action plan. That logic belongs here, once.
"""
from __future__ import annotations

from ..domain.errors import InferenceError
from ..domain.models import (Biomarkers, Provenance, RiskAssessment,
                             UserProfile, WearableWindow)
from ..inference.predictor import BiomarkerPredictor
from .scorers import DEFAULT_SCORERS, RiskScorer


class RiskAssessor:
    """Composes biomarker prediction with per-condition scoring."""

    def __init__(self, predictor: BiomarkerPredictor,
                 scorers: tuple[RiskScorer, ...] = DEFAULT_SCORERS):
        self._predictor = predictor
        self._scorers = scorers

    @classmethod
    def build(cls) -> "RiskAssessor":
        """Factory Method: assemble the production object graph."""
        return cls(BiomarkerPredictor.from_registry())

    def assess(self, profile: UserProfile, window: WearableWindow,
               measured: Biomarkers | None = None) -> RiskAssessment:
        """Produce an assessment.

        When `measured` carries real lab values they take precedence over
        predictions -- a measured triglyceride beats an estimated one, and the
        resulting provenance says so.
        """
        predicted = self._predictor.predict(profile, window)
        biomarkers, provenance = self._merge(predicted, measured)

        scores = tuple(filter(None, (scorer.score(profile, biomarkers, provenance)
                                     for scorer in self._scorers)))
        if not scores:
            raise InferenceError(
                "No condition could be scored from the available inputs. "
                "This is reported rather than substituted with a default."
            )
        return RiskAssessment(scores=scores, biomarkers=biomarkers, provenance=provenance)

    @staticmethod
    def _merge(predicted: Biomarkers, measured: Biomarkers | None) -> tuple[Biomarkers, Provenance]:
        """Prefer measured values; report provenance honestly."""
        if measured is None:
            return predicted, Provenance.MODEL

        fields = ("triglycerides", "ggt", "hba1c", "systolic_bp", "diastolic_bp")
        merged, used_measurement = {}, False
        for name in fields:
            actual = getattr(measured, name)
            if actual is not None:
                merged[name] = actual
                used_measurement = True
            else:
                merged[name] = getattr(predicted, name)

        # A blend of measured labs and model estimates is still model-derived
        # overall; only an all-measured set is purely heuristic.
        all_measured = all(getattr(measured, name) is not None for name in fields)
        provenance = Provenance.HEURISTIC if all_measured else Provenance.MODEL
        return Biomarkers(**merged), (provenance if used_measurement else Provenance.MODEL)
