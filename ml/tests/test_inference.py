"""Regression tests for the inference path.

Every test here corresponds to a defect that actually shipped. The first two are
load-bearing: for months the served model returned a bit-identical prediction
for every user because the MLP branch was fed NaN, and the MLP feature order at
inference did not match the order used during training.
"""
import numpy as np
import pytest

from src.domain import (Biomarkers, InferenceError, Provenance, UserProfile,
                        ValidationError, WearableWindow)
from src.features.schema import MLP_FEATURES, TIME_SERIES_FEATURES
from src.inference.predictor import BiomarkerPredictor
from src.risk.assessor import RiskAssessor

pytestmark = pytest.mark.filterwarnings("ignore")


# --- Fixtures ---------------------------------------------------------------
def _window(seed=0, **overrides):
    rng = np.random.default_rng(seed)
    days = []
    for _ in range(14):
        day = {
            "daily_steps": int(rng.integers(4000, 8000)),
            "active_minutes": int(rng.integers(20, 60)),
            "sleep_hours": float(rng.uniform(6.5, 8.0)),
            "sleep_quality_score": int(rng.integers(75, 90)),
            "resting_heart_rate": int(rng.integers(60, 70)),
            "heart_rate_variability": int(rng.integers(45, 60)),
        }
        day.update(overrides)
        days.append(day)
    return WearableWindow.from_records(days)


def _profile(**overrides):
    base = dict(age=45, gender="M", bmi=29.5, waist=102, has_hereditary_risk=1,
                calorie_intake=2800, fat_grams=100, carbs_grams=350, protein_grams=120)
    base.update(overrides)
    return UserProfile.from_dict(base)


@pytest.fixture(scope="module")
def predictor():
    return BiomarkerPredictor.from_registry()


@pytest.fixture(scope="module")
def assessor(predictor):
    return RiskAssessor(predictor)


# --- The two headline regressions -------------------------------------------
def test_prediction_varies_with_profile(predictor):
    """The MLP branch must actually influence the output.

    Guards the `pd.concat(axis=1)` defect: concatenating a 1-row profile with a
    14-row window left rows 1..13 NaN, and inference read the *last* row, so the
    whole tabular branch received NaN and every user got the same answer.
    """
    window = _window()
    healthy = predictor.predict(_profile(age=20, gender="F", bmi=20.0, waist=70,
                                        has_hereditary_risk=0, calorie_intake=1200,
                                        fat_grams=42, carbs_grams=120, protein_grams=60),
                                window)
    at_risk = predictor.predict(_profile(age=73, bmi=31.9, waist=120,
                                         calorie_intake=4307, fat_grams=393,
                                         carbs_grams=530, protein_grams=135),
                                window)

    assert healthy.triglycerides != at_risk.triglycerides, (
        "Identical predictions for opposite profiles -- the MLP branch is dead."
    )
    assert healthy.ggt != at_risk.ggt


def test_mlp_feature_order_matches_training():
    """gender_numeric must sit at index 1, as in the training pipeline.

    Placing it at index 0 (the previous inference behaviour) shifts every other
    feature onto the wrong weight column without raising anything.
    """
    assert MLP_FEATURES.index("gender_numeric") == 1
    assert MLP_FEATURES == ["age", "gender_numeric", "bmi", "has_hereditary_risk",
                            "calorie_intake", "fat_grams", "carbs_grams", "protein_grams"]
    assert len(TIME_SERIES_FEATURES) == 6


# --- Both branches must be live ---------------------------------------------
def test_sex_changes_prediction(predictor):
    window = _window(1)
    assert (predictor.predict(_profile(gender="M"), window)
            != predictor.predict(_profile(gender="F"), window))


def test_wearable_window_changes_prediction(predictor):
    profile = _profile()
    sedentary = _window(2, daily_steps=2000, active_minutes=5, sleep_hours=5.0)
    active = _window(2, daily_steps=13000, active_minutes=120, sleep_hours=8.0)
    assert (predictor.predict(profile, sedentary)
            != predictor.predict(profile, active)), "The LSTM branch is dead."


# --- Validation happens at the boundary -------------------------------------
@pytest.mark.parametrize("count", [0, 7, 13, 15])
def test_rejects_wrong_window_length(count):
    with pytest.raises(ValidationError, match="exactly 14 days"):
        WearableWindow.from_records([{
            "daily_steps": 5000, "active_minutes": 30, "sleep_hours": 7,
            "sleep_quality_score": 80, "resting_heart_rate": 65,
            "heart_rate_variability": 50}] * count)


def test_rejects_missing_wearable_field():
    with pytest.raises(ValidationError, match="daily_steps"):
        WearableWindow.from_records([{"active_minutes": 30}] * 14)


def test_rejects_implausible_profile():
    with pytest.raises(ValidationError, match="bmi"):
        _profile(bmi=400)


def test_rejects_missing_sex():
    with pytest.raises(ValidationError, match="sex"):
        UserProfile.from_dict({"age": 40, "bmi": 25, "waist": 90})


def test_rejects_nan_input():
    """NaN must raise, not sail through the ReLUs as an implicit zero."""
    with pytest.raises(ValidationError):
        _profile(bmi=float("nan"))


# --- Output sanity ----------------------------------------------------------
def test_output_is_plausible(predictor):
    result = predictor.predict(_profile(), _window())
    assert 30 < result.triglycerides < 600, result
    assert 5 < result.ggt < 400, result


def test_assessment_carries_provenance(assessor):
    assessment = assessor.assess(_profile(), _window())
    assert assessment.provenance is Provenance.MODEL
    assert assessment.scores, "assessment produced no scores"
    for score in assessment.scores:
        assert score.provenance is Provenance.MODEL
        assert 0 <= score.score <= 100
    assert "not a medical device" in assessment.disclaimer


def test_failed_inference_raises_rather_than_substituting():
    """A dead backend must surface as an error, never as a plausible number.

    This is the property v1 violated in three places, each returning
    `Math.random()` with HTTP 200.
    """
    class DeadBackend:
        name = "dead"

        def run(self, feeds):
            raise InferenceError("backend unavailable")

    registry_predictor = BiomarkerPredictor.from_registry()
    broken = BiomarkerPredictor(DeadBackend(), registry_predictor._bridge,
                                registry_predictor._target_scaler)
    with pytest.raises(InferenceError):
        RiskAssessor(broken).assess(_profile(), _window())


def test_measured_labs_override_predictions(assessor):
    """Real lab values beat estimates, and provenance says so."""
    measured = Biomarkers(triglycerides=210.0, ggt=88.0, hba1c=6.9,
                          systolic_bp=145.0, diastolic_bp=95.0)
    assessment = assessor.assess(_profile(), _window(), measured)
    assert assessment.biomarkers.triglycerides == 210.0
    assert assessment.provenance is Provenance.HEURISTIC
