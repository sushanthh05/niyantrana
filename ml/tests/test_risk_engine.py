"""Tests for the NHANES-trained Risk Engine and the risk scorers.

The engine replaces a model that scored R2 -0.89 on held-out users. These tests
lock in the properties that made the replacement necessary: predictions must
respond to the inputs, must never be fabricated, and must arrive with an
explicit provenance.
"""
import json
import os

import pytest

from src.domain import (Biomarkers, InferenceError, Provenance, RiskBand,
                        UserProfile, WearableWindow)
from src.inference.risk_engine import RiskEnginePredictor
from src.risk.assessor import RiskAssessor
from src.risk.scorers import (DEFAULT_SCORERS, DysglycaemiaScorer,
                              FattyLiverScorer, HypertensionScorer)

MODEL_PATH = "models/risk_engine.joblib"
METRICS_PATH = "reports/nhanes_metrics.json"

pytestmark = pytest.mark.filterwarnings("ignore")
requires_engine = pytest.mark.skipif(
    not os.path.exists(MODEL_PATH),
    reason="run 'python -m src.training.train_risk_engine' first")


def _profile(**overrides):
    base = dict(age=45, gender="M", bmi=29.5, waist=102, has_hereditary_risk=1,
                calorie_intake=2800, fat_grams=100, carbs_grams=350, protein_grams=120)
    base.update(overrides)
    return UserProfile.from_dict(base)


def _window(**overrides):
    day = {"daily_steps": 6000, "active_minutes": 30, "sleep_hours": 7.0,
           "sleep_quality_score": 82, "resting_heart_rate": 65,
           "heart_rate_variability": 50}
    day.update(overrides)
    return WearableWindow.from_records([day] * 14)


@pytest.fixture(scope="module")
def engine():
    return RiskEnginePredictor.load()


# --- The engine responds to its inputs --------------------------------------
@requires_engine
def test_predicts_all_targets(engine):
    result = engine.predict(_profile())
    for field in ("triglycerides", "ggt", "hba1c", "systolic_bp", "diastolic_bp", "fli"):
        assert getattr(result, field) is not None, f"{field} missing"


@requires_engine
def test_higher_risk_profile_scores_worse(engine):
    """A large-waist, high-BMI profile must score above a lean one.

    Directional sanity: a model can beat a baseline on MAE and still be
    clinically nonsensical.
    """
    lean = engine.predict(_profile(age=25, bmi=20.0, waist=70,
                                   calorie_intake=1800, fat_grams=50))
    heavy = engine.predict(_profile(age=60, bmi=36.0, waist=125,
                                    calorie_intake=3800, fat_grams=180))
    assert heavy.fli > lean.fli
    assert heavy.systolic_bp > lean.systolic_bp


@requires_engine
def test_works_without_a_wearable_window(engine):
    """Sleep and activity become NaN; the estimator handles that natively.

    v1 fabricated 14 days of fake wearable data in this situation.
    """
    assert engine.predict(_profile(), None).fli is not None


@requires_engine
def test_wearable_window_changes_the_estimate(engine):
    sedentary = engine.predict(_profile(), _window(daily_steps=1500, active_minutes=2,
                                                   sleep_hours=4.5))
    active = engine.predict(_profile(), _window(daily_steps=14000, active_minutes=110,
                                                sleep_hours=8.0))
    assert sedentary != active


@requires_engine
def test_outputs_are_physiologically_plausible(engine):
    result = engine.predict(_profile())
    assert 20 < result.triglycerides < 1500
    assert 3 < result.ggt < 1000
    assert 3 < result.hba1c < 20
    assert 70 < result.systolic_bp < 260
    assert 0 <= result.fli <= 100


@requires_engine
def test_missing_artifact_raises_rather_than_degrading():
    from src.domain import ArtifactsMissingError
    with pytest.raises(ArtifactsMissingError):
        RiskEnginePredictor.load("models/does_not_exist.joblib")


@requires_engine
def test_substitutes_into_the_assessor(engine):
    """The engine is interchangeable with BiomarkerPredictor (Liskov)."""
    assessment = RiskAssessor(engine).assess(_profile(), _window())
    conditions = {s.condition for s in assessment.scores}
    assert conditions == {"fatty_liver", "dysglycaemia", "hypertension"}
    assert assessment.provenance is Provenance.MODEL


# --- Scorer behaviour, independent of any model -----------------------------
def test_scorers_abstain_when_inputs_are_missing():
    """An abstention, not a fabricated default. v1 substituted the literal 50."""
    empty = Biomarkers()
    for scorer in DEFAULT_SCORERS:
        assert scorer.score(_profile(), empty, Provenance.MODEL) is None


def test_fatty_liver_scorer_uses_a_direct_estimate():
    score = FattyLiverScorer().score(_profile(), Biomarkers(fli=78.0), Provenance.MODEL)
    assert score.score == 78.0
    assert score.band is RiskBand.HIGH
    assert "waist circumference" in score.contributors


@pytest.mark.parametrize("hba1c,band", [(5.0, RiskBand.LOW), (6.0, RiskBand.MODERATE),
                                        (7.5, RiskBand.HIGH)])
def test_dysglycaemia_bands_follow_ada_thresholds(hba1c, band):
    score = DysglycaemiaScorer().score(_profile(), Biomarkers(hba1c=hba1c), Provenance.MODEL)
    assert score.band is band


def test_hypertension_uses_the_worse_of_the_two_readings():
    """Either reading alone is sufficient for a diagnosis."""
    systolic_only = HypertensionScorer().score(
        _profile(), Biomarkers(systolic_bp=165, diastolic_bp=70), Provenance.MODEL)
    diastolic_only = HypertensionScorer().score(
        _profile(), Biomarkers(systolic_bp=115, diastolic_bp=105), Provenance.MODEL)
    assert systolic_only.band is RiskBand.HIGH
    assert diastolic_only.band is RiskBand.HIGH


def test_every_score_declares_provenance():
    biomarkers = Biomarkers(fli=50.0, hba1c=5.9, systolic_bp=135, diastolic_bp=85)
    for scorer in DEFAULT_SCORERS:
        score = scorer.score(_profile(), biomarkers, Provenance.SIMULATION)
        assert score.provenance is Provenance.SIMULATION
        assert score.rationale, "a score without a rationale is not actionable"


# --- The recorded evaluation must stay honest -------------------------------
@pytest.mark.skipif(not os.path.exists(METRICS_PATH), reason="metrics not generated")
def test_every_target_beats_its_baseline():
    report = json.load(open(METRICS_PATH))
    for name, target in report["targets"].items():
        assert target["random_split"]["beats_baseline"], f"{name} does not beat its baseline"


@pytest.mark.skipif(not os.path.exists(METRICS_PATH), reason="metrics not generated")
def test_fli_is_judged_against_the_formula_reference():
    """FLI must be compared against the no-ML formula baseline, not the mean.

    The mean predictor scores R2 0.0 on FLI while the formula alone scores
    ~0.84, so reporting only the mean comparison would flatter the model by an
    order of magnitude.
    """
    report = json.load(open(METRICS_PATH))
    fli = report["targets"]["fli"]["random_split"]
    assert "baseline_formula_reference" in fli
    assert fli["baseline_formula_reference"]["r2"] > 0.7, (
        "the formula reference should itself be strong; that is the point")
    assert fli["model"]["mae"] < fli["baseline_formula_reference"]["mae"]
