"""Tests for the calibrated risk classifiers.

These lock in the properties that make a screening tool trustworthy: it must
rank sick above healthy, its probabilities must mean what they say, its
sensitivity must be high enough to be worth running, and it must fail loudly
rather than guess.
"""
import json
import os

import pytest

from src.domain import ArtifactsMissingError, RiskBand, UserProfile, WearableWindow
from src.inference.risk_classifier import RiskClassifierEnsemble

MODEL_PATH = "models/risk_classifiers.joblib"
METRICS_PATH = "reports/classifier_metrics.json"
SHAP_DIR = "reports/shap"

pytestmark = pytest.mark.filterwarnings("ignore")
requires_models = pytest.mark.skipif(
    not os.path.exists(MODEL_PATH),
    reason="run 'python -m src.training.train_classifiers' first")
requires_metrics = pytest.mark.skipif(
    not os.path.exists(METRICS_PATH), reason="metrics not generated")

EXPECTED_CONDITIONS = {"fatty_liver", "dysglycaemia", "diabetes", "hypertension"}


def _profile(**overrides):
    base = dict(age=45, gender="M", bmi=29.5, waist=102, calorie_intake=2800,
                fat_grams=100, carbs_grams=350, protein_grams=120)
    base.update(overrides)
    return UserProfile.from_dict(base)


def _window(**overrides):
    day = {"daily_steps": 6000, "active_minutes": 30, "sleep_hours": 7.0,
           "sleep_quality_score": 82, "resting_heart_rate": 65,
           "heart_rate_variability": 50}
    day.update(overrides)
    return WearableWindow.from_records([day] * 14)


@pytest.fixture(scope="module")
def ensemble():
    return RiskClassifierEnsemble.load()


# --- Structure --------------------------------------------------------------
@requires_models
def test_covers_all_headline_conditions(ensemble):
    """The pitch promises fatty liver, diabetes and hypertension jointly.

    v1 shipped only fatty liver.
    """
    assert set(ensemble.conditions) == EXPECTED_CONDITIONS


@requires_models
def test_probabilities_are_valid(ensemble):
    for condition, result in ensemble.predict(_profile(), _window()).items():
        assert 0.0 <= result.probability <= 1.0, condition
        assert 0.0 <= result.score <= 100.0
        assert result.band in (RiskBand.LOW, RiskBand.MODERATE, RiskBand.HIGH)
        assert result.definition, f"{condition} has no stated definition"


@requires_models
def test_thresholds_travel_with_the_model(ensemble):
    """The screening operating point was chosen on held-out data.

    Defaulting to 0.5 at the call site would discard that calibration.
    """
    for result in ensemble.predict(_profile()).values():
        assert 0.0 < result.threshold < 1.0
        assert result.threshold != 0.5 or result.condition == "unknown"


# --- Clinical direction -----------------------------------------------------
@requires_models
def test_high_risk_profile_outranks_low_risk(ensemble):
    """Aggregate metrics can look fine while individual predictions are absurd."""
    healthy = ensemble.predict(_profile(age=25, bmi=21.0, waist=74,
                                        calorie_intake=2000, fat_grams=55))
    at_risk = ensemble.predict(_profile(age=62, bmi=36.0, waist=124,
                                        calorie_intake=3600, fat_grams=165))
    for condition in EXPECTED_CONDITIONS:
        assert at_risk[condition].probability > healthy[condition].probability, condition


@requires_models
def test_waist_dominates_fatty_liver(ensemble):
    """Waist is two of the four FLI terms; the model must respond to it."""
    slim = ensemble.predict(_profile(waist=72))["fatty_liver"].probability
    wide = ensemble.predict(_profile(waist=130))["fatty_liver"].probability
    assert wide > slim


@requires_models
def test_works_without_a_wearable_window(ensemble):
    """Sleep and activity go NaN; the estimator handles it natively.

    v1 fabricated 14 days of fake wearable data in this situation.
    """
    assert set(ensemble.predict(_profile(), None)) == EXPECTED_CONDITIONS


@requires_models
def test_missing_artifact_raises(ensemble):
    with pytest.raises(ArtifactsMissingError):
        RiskClassifierEnsemble.load("models/does_not_exist.joblib")


# --- Recorded evaluation must stay honest -----------------------------------
@requires_metrics
def test_screening_sensitivity_is_actually_high():
    """A screening tool that misses cases is not worth deploying."""
    report = json.load(open(METRICS_PATH))
    for name, condition in report["conditions"].items():
        sensitivity = condition["operating_points"]["high_sensitivity"]["sensitivity"]
        assert sensitivity >= 0.85, f"{name} sensitivity only {sensitivity}"


@requires_metrics
def test_predictive_heads_beat_chance():
    """The three genuinely predictive conditions must clear a useful bar."""
    report = json.load(open(METRICS_PATH))
    for name in ("dysglycaemia", "diabetes", "hypertension"):
        assert report["conditions"][name]["auroc"] >= 0.70, name


@requires_metrics
def test_fatty_liver_records_its_anthropometry_baseline():
    """FLI is a formula containing BMI and waist, both measured exactly.

    Its AUROC of ~0.96 is therefore close to a tautology. The training code must
    record the bmi+waist-only comparison so the number is never quoted bare.
    """
    report = json.load(open(METRICS_PATH))
    baseline = report["conditions"]["fatty_liver"]["baseline_bmi_waist_only"]
    assert baseline["auroc"] > 0.9, (
        "two anthropometric features alone should already score highly; that is the point")
    assert baseline["auroc_gain_from_other_features"] < 0.05, (
        "if the other features suddenly matter a lot, the label definition changed")


@requires_metrics
def test_sanity_check_passed_at_training_time():
    report = json.load(open(METRICS_PATH))
    for name, check in report["sanity_check"].items():
        assert check["ordered_correctly"], f"{name} ranked high risk below low risk"


@requires_metrics
def test_calibration_is_reasonable_in_populated_bins():
    """Predicted probability should track observed frequency.

    Only bins with enough support are checked; the extreme bins are known to be
    thinly populated and overconfident, which RESULTS.md documents.
    """
    report = json.load(open(METRICS_PATH))
    for name, condition in report["conditions"].items():
        for bucket in condition["reliability_curve"]:
            if bucket["n"] < 100:
                continue
            gap = abs(bucket["observed_frequency"] - bucket["mean_predicted"])
            assert gap < 0.15, f"{name} bin {bucket['bin']} off by {gap:.3f}"


@pytest.mark.skipif(not os.path.isdir(SHAP_DIR), reason="SHAP not generated")
def test_shap_importances_exist_per_condition():
    for condition in EXPECTED_CONDITIONS:
        path = os.path.join(SHAP_DIR, f"{condition}.json")
        assert os.path.exists(path), f"missing SHAP for {condition}"
        assert json.load(open(path)), f"empty SHAP for {condition}"
