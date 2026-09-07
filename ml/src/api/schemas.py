"""Wire-format DTOs.

Refactoring applied: **Extract Class** -- separating transport shape from domain
shape. The old Flask handler read raw dicts straight out of `request.get_json()`
and passed them into the model, so a malformed payload surfaced as a KeyError
deep inside pandas rather than a 400 at the boundary.

These DTOs are deliberately permissive about *names* (the Express backend still
sends legacy spellings such as `calorie_intake` and `gender`) and strict about
*types*. Translation to domain objects happens in one place, the `to_domain`
methods, so the legacy vocabulary cannot leak inward.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from ..domain.models import (Biomarkers, RiskAssessment, UserProfile,
                             WearableDay, WearableWindow)


class ProfileDTO(BaseModel):
    """Incoming user profile. Extra keys are tolerated and ignored."""

    model_config = ConfigDict(extra="allow")

    def to_domain(self) -> UserProfile:
        return UserProfile.from_dict(self.model_dump())


class WearableDayDTO(BaseModel):
    model_config = ConfigDict(extra="allow")


class MeasuredBiomarkersDTO(BaseModel):
    """Real lab values, when the user has them. All optional."""

    triglycerides: float | None = None
    ggt: float | None = None
    hba1c: float | None = None
    systolic_bp: float | None = None
    diastolic_bp: float | None = None

    def to_domain(self) -> Biomarkers:
        return Biomarkers(**self.model_dump())


class PredictRequest(BaseModel):
    user_data: ProfileDTO = Field(..., description="Static profile plus daily dietary totals")
    watch_data: list[WearableDayDTO] = Field(
        default_factory=list,
        description="Most recent 14 days, oldest first. Optional: the risk engine "
                    "handles absent sleep and activity natively rather than "
                    "having values invented for it.")
    history: list[WearableDayDTO] = Field(
        default_factory=list,
        description="Full wearable history, oldest first. Supply at least 28 days "
                    "to receive risk trajectories.")
    measured: MeasuredBiomarkersDTO | None = Field(
        default=None, description="Real lab values, which override every estimate")

    def to_domain(self):
        profile = self.user_data.to_domain()
        window = (WearableWindow.from_records([d.model_dump() for d in self.watch_data])
                  if self.watch_data else None)
        history = ([WearableDay.from_dict(d.model_dump()) for d in self.history]
                   if self.history else None)
        # A supplied history implies the most recent window when none was given.
        if window is None and history and len(history) >= 14:
            window = WearableWindow(tuple(history[-14:]))
        measured = self.measured.to_domain() if self.measured else None
        return profile, window, history, measured


class RiskScoreDTO(BaseModel):
    condition: str
    score: float
    band: str
    provenance: str
    basis: str = Field(..., description="calibrated_classifier or clinical_formula")
    rationale: str
    contributors: list[str]


class TrajectoryPointDTO(BaseModel):
    day_index: int
    score: float


class TrajectoryDTO(BaseModel):
    condition: str
    points: list[TrajectoryPointDTO]
    slope_per_week: float | None = Field(
        None, description="Least-squares gradient. Null when history is too short "
                          "to fit a trend -- an abstention, not a flat line.")
    direction: str = Field(..., description="improving | stable | worsening | unknown")
    provenance: str


class BiomarkersDTO(BaseModel):
    triglycerides: float | None = None
    ggt: float | None = None
    hba1c: float | None = None
    systolic_bp: float | None = None
    diastolic_bp: float | None = None
    fli: float | None = None


class AssessmentResponse(BaseModel):
    """Outgoing assessment.

    `provenance` is a required field, not an optional extra. A caller can always
    tell a real prediction from a fallback -- which was impossible in v1, where
    three separate layers returned `Math.random()` with HTTP 200.
    """

    risks: list[RiskScoreDTO]
    biomarkers: BiomarkersDTO
    trajectories: list[TrajectoryDTO] = Field(default_factory=list)
    provenance: str
    disclaimer: str

    @classmethod
    def from_domain(cls, assessment: RiskAssessment) -> "AssessmentResponse":
        return cls(
            risks=[RiskScoreDTO(condition=s.condition, score=s.score, band=s.band.value,
                                provenance=s.provenance.value, basis=s.basis.value,
                                rationale=s.rationale, contributors=list(s.contributors))
                   for s in assessment.scores],
            biomarkers=BiomarkersDTO(**vars(assessment.biomarkers)),
            trajectories=[
                TrajectoryDTO(
                    condition=t.condition,
                    points=[TrajectoryPointDTO(day_index=p.day_index,
                                               score=p.scores.get(t.condition, 0.0))
                            for p in t.points],
                    slope_per_week=t.slope_per_week,
                    direction=t.direction,
                    provenance=t.provenance.value)
                for t in assessment.trajectories],
            provenance=assessment.provenance.value,
            disclaimer=assessment.disclaimer,
        )


class MealDTO(BaseModel):
    name: str
    calories: float = 0.0
    fat: float = 0.0
    protein: float = 0.0


class RecommendRequest(BaseModel):
    user_context: dict = Field(default_factory=dict)
    original_meal: MealDTO


class RecommendResponse(BaseModel):
    recommendation: str
    alternatives_considered: list[str]
    source: str


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None
    provenance: str = "unavailable"
