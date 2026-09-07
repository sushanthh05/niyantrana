"""Tests for risk composition and the trajectory analyser.

The trajectory delivers the "early warning / risk over time" promise without a
temporal model. These tests pin the properties that make that defensible: it
must track real behaviour change, abstain when history is too short, and never
invent a trend from insufficient data.
"""
import os

import pytest

from src.domain import (AssessmentContext, Biomarkers, Provenance, ScoreBasis,
                        UserProfile, WearableDay, WearableWindow)
from src.inference.risk_classifier import RiskClassifierEnsemble
from src.inference.risk_engine import RiskEnginePredictor
from src.risk.assessor import RiskAssessor
from src.risk.scorers import DEFAULT_SCORERS, HypertensionScorer
from src.risk.trajectory import MIN_POINTS_FOR_TREND, TrajectoryAnalyser

pytestmark = pytest.mark.filterwarnings("ignore")
requires_models = pytest.mark.skipif(
    not (os.path.exists("models/risk_engine.joblib")
         and os.path.exists("models/risk_classifiers.joblib")),
    reason="run the Day 2 and Day 3 training modules first")


def _profile(**overrides):
    base = dict(age=52, gender="M", height=174, weight=94, waist=108,
                calorie_intake=3100, fat_grams=140, carbs_grams=380, protein_grams=110)
    base.update(overrides)
    return UserProfile.from_dict(base)


def _day(progress=0.0):
    """One wearable day; progress 0 = sedentary, 1 = very active."""
    return WearableDay(
        daily_steps=3000 + 9000 * progress,
        active_minutes=8 + 70 * progress,
        sleep_hours=5.4 + 2.2 * progress,
        sleep_quality_score=58 + 30 * progress,
        resting_heart_rate=78 - 12 * progress,
        heart_rate_variability=32 + 28 * progress,
    )


def _history(days, improving=True):
    return [_day((i / (days - 1)) if improving else 1 - (i / (days - 1)))
            for i in range(days)]


@pytest.fixture(scope="module")
def assessor():
    return RiskAssessor.build()


@pytest.fixture(scope="module")
def analyser():
    return TrajectoryAnalyser(classifiers=RiskClassifierEnsemble.load())


# --- Composition ------------------------------------------------------------
@requires_models
def test_scores_come_from_the_calibrated_classifier(assessor):
    """The classifier answers 'how likely'; the formula only explains 'why'."""
    assessment = assessor.assess(_profile(), WearableWindow(tuple(_history(14))))
    assert assessment.scores
    for score in assessment.scores:
        assert score.basis is ScoreBasis.CALIBRATED_CLASSIFIER, score.condition
        assert score.rationale, f"{score.condition} has no rationale"


@requires_models
def test_all_four_conditions_are_scored(assessor):
    assessment = assessor.assess(_profile())
    assert {s.condition for s in assessment.scores} == {
        "fatty_liver", "dysglycaemia", "diabetes", "hypertension"}


@requires_models
def test_biomarkers_accompany_the_scores(assessor):
    """The UI needs the estimated HbA1c or BP behind a score, not just a number."""
    biomarkers = assessor.assess(_profile()).biomarkers
    assert biomarkers.hba1c is not None
    assert biomarkers.systolic_bp is not None


@requires_models
def test_assessment_works_without_any_wearable_data(assessor):
    """v1 fabricated 14 days of fake wearable data rather than admitting absence."""
    assert assessor.assess(_profile(), None).scores


def test_scorer_falls_back_to_the_formula_without_a_classifier():
    """No classifier for a condition -> clinical formula, and the basis says so."""
    context = AssessmentContext(profile=_profile(),
                               biomarkers=Biomarkers(systolic_bp=150, diastolic_bp=95))
    score = HypertensionScorer().score(context, Provenance.MODEL)
    assert score.basis is ScoreBasis.CLINICAL_FORMULA


def test_classifier_probability_wins_over_the_formula():
    context = AssessmentContext(
        profile=_profile(),
        biomarkers=Biomarkers(systolic_bp=150, diastolic_bp=95),
        probabilities={"hypertension": 0.21})
    score = HypertensionScorer().score(context, Provenance.MODEL)
    assert score.score == pytest.approx(21.0)
    assert score.basis is ScoreBasis.CALIBRATED_CLASSIFIER


# --- Trajectory -------------------------------------------------------------
@requires_models
def test_improving_behaviour_lowers_risk(analyser):
    """12 weeks of steadily increasing activity and sleep must bend risk down.

    Asserted across all conditions rather than naming one: which condition
    responds most depends on where the profile sits, but the direction must
    never be upward.
    """
    trajectories = analyser.compute(_profile(), _history(84))
    slopes = {t.condition: t.slope_per_week for t in trajectories
              if t.slope_per_week is not None}
    assert slopes, "no trend could be fitted"
    assert any(v < -0.01 for v in slopes.values()), f"nothing improved: {slopes}"
    assert all(v <= 0.01 for v in slopes.values()), f"something worsened: {slopes}"


@requires_models
def test_worsening_behaviour_raises_risk(analyser):
    """The mirror image: 12 weeks of decline must not look like an improvement."""
    trajectories = analyser.compute(_profile(), _history(84, improving=False))
    slopes = {t.condition: t.slope_per_week for t in trajectories
              if t.slope_per_week is not None}
    assert slopes, "no trend could be fitted"
    assert any(v > 0.01 for v in slopes.values()), f"nothing worsened: {slopes}"
    assert all(v >= -0.01 for v in slopes.values()), f"something improved: {slopes}"


@requires_models
@pytest.mark.parametrize("label,profile", [
    ("lean", dict(age=30, gender="F", height=163, weight=55, waist=72,
                  calorie_intake=1900, fat_grams=60, carbs_grams=230, protein_grams=70)),
    ("mid", dict(age=45, gender="M", height=175, weight=82, waist=95,
                 calorie_intake=2500, fat_grams=95, carbs_grams=310, protein_grams=95)),
    ("obese", dict(age=52, gender="M", height=174, weight=94, waist=108,
                   calorie_intake=3100, fat_grams=140, carbs_grams=380, protein_grams=110)),
    ("severe", dict(age=60, gender="M", height=172, weight=110, waist=125,
                    calorie_intake=3500, fat_grams=160, carbs_grams=430, protein_grams=115)),
])
def test_improving_behaviour_never_raises_any_risk(analyser, label, profile):
    """The single most important property for a coaching product.

    Before monotonic constraints were added this FAILED: for a mid-range
    profile, hypertension risk rose +0.79 points/week while activity and sleep
    steadily improved. Gradient boosting is free to fit non-monotonic
    relationships, and it did. An app cannot tell a user to exercise and then
    show their risk climbing.

    Fixed by constraining mvpa_min_week (decreasing) and sedentary_min_day
    (increasing) in the classifiers. Cost: at most -0.005 AUROC.
    """
    trajectories = analyser.compute(UserProfile.from_dict(profile), _history(84))
    rising = {t.condition: t.slope_per_week for t in trajectories
              if t.slope_per_week is not None and t.slope_per_week > 0.01}
    assert not rising, (
        f"{label} profile: improving behaviour raised risk for {rising}")


@requires_models
def test_every_trajectory_point_declares_provenance(analyser):
    for trajectory in analyser.compute(_profile(), _history(84)):
        assert trajectory.provenance is Provenance.MODEL
        for point in trajectory.points:
            assert point.provenance is Provenance.MODEL
            assert point.scores


@requires_models
def test_short_history_yields_no_trajectory(analyser):
    """Fewer than 14 days cannot form a single window."""
    assert analyser.compute(_profile(), _history(10)) == ()


@requires_models
def test_trend_abstains_below_the_minimum_point_count(analyser):
    """Two points is a line through noise, not a trend.

    The slope must be None and the direction 'unknown' -- an abstention rather
    than a confident extrapolation.
    """
    days = 14 + 7 * (MIN_POINTS_FOR_TREND - 2)
    for trajectory in analyser.compute(_profile(), _history(days)):
        if len(trajectory.points) < MIN_POINTS_FOR_TREND:
            assert trajectory.slope_per_week is None
            assert trajectory.direction == "unknown"


@requires_models
def test_trajectory_ends_on_the_most_recent_day(analyser):
    """The final point must reflect the user's current state, not a stale window."""
    history = _history(80)   # not a whole number of 7-day steps past the window
    for trajectory in analyser.compute(_profile(), history):
        assert trajectory.points[-1].day_index == len(history) - 1


@requires_models
def test_assessment_includes_trajectories_when_history_is_supplied(assessor):
    history = _history(84)
    assessment = assessor.assess(
        _profile(), WearableWindow(tuple(history[-14:])), history=history)
    assert len(assessment.trajectories) == 4
    assert assessor.assess(_profile()).trajectories == ()


def test_analyser_requires_a_model():
    with pytest.raises(ValueError):
        TrajectoryAnalyser()


@requires_models
def test_engine_only_analyser_still_produces_fatty_liver():
    """Falls back to the regression engine when no classifiers are supplied."""
    analyser = TrajectoryAnalyser(engine=RiskEnginePredictor.load())
    trajectories = analyser.compute(_profile(), _history(84))
    assert {t.condition for t in trajectories} == {"fatty_liver"}
