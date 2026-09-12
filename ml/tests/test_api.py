"""HTTP contract tests for the inference service.

The unit tests prove the domain behaves. These prove the *wire contract* does --
that a caller on the other side of the network can tell a real prediction from a
failure, which is the single property v1 violated in three separate places.
"""
import os

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.inference.artifacts import readiness

pytestmark = pytest.mark.filterwarnings("ignore")

MODELS_PRESENT = (os.path.exists("models/risk_engine.joblib")
                  and os.path.exists("models/risk_classifiers.joblib"))
requires_models = pytest.mark.skipif(
    not MODELS_PRESENT, reason="run the Day 2 and Day 3 training modules first")

EXPECTED_CONDITIONS = {"fatty_liver", "dysglycaemia", "diabetes", "hypertension"}


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _day(progress):
    return {
        "daily_steps": 3000 + 9000 * progress,
        "active_minutes": 8 + 70 * progress,
        "sleep_hours": 5.4 + 2.2 * progress,
        "sleep_quality_score": 58 + 30 * progress,
        "resting_heart_rate": 78 - 12 * progress,
        "heart_rate_variability": 32 + 28 * progress,
    }


def _profile(**overrides):
    base = {"age": 52, "gender": "M", "height": 174, "weight": 94, "waist": 108,
            "calorie_intake": 3100, "fat_grams": 140, "carbs_grams": 380,
            "protein_grams": 110}
    base.update(overrides)
    return base


def _payload(days=84, **profile_overrides):
    return {"user_data": _profile(**profile_overrides),
            "history": [_day(i / (days - 1)) for i in range(days)]}


# --- Health -----------------------------------------------------------------
@requires_models
def test_health_reports_the_artifacts_actually_served(client):
    """Regression: /health used to report the retired ONNX model and scalers.

    It answered "ok" while describing files no request touches, and would have
    kept answering "ok" with the real models missing.
    """
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert set(body["artifacts"]) >= {"risk_engine", "risk_classifiers", "food_database"}
    assert "multimodal_model" not in str(body), "health still references the retired LSTM path"
    for name in ("risk_engine", "risk_classifiers"):
        assert body["artifacts"][name]["present"]
        assert body["artifacts"][name]["required"]


def test_health_returns_503_when_a_required_model_is_missing(client, monkeypatch):
    """An under-provisioned deploy must leave rotation, not serve errors."""
    monkeypatch.setenv("RISK_ENGINE_PATH", "models/definitely_not_here.joblib")
    response = client.get("/health")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert "risk_engine" in body["artifacts"]["missing_required"]


def test_readiness_never_raises_with_everything_missing(monkeypatch):
    for variable in ("RISK_ENGINE_PATH", "RISK_CLASSIFIER_PATH", "FOOD_DB_PATH"):
        monkeypatch.setenv(variable, "/nonexistent/path.bin")
    report = readiness()
    assert report["ready"] is False
    assert len(report["missing_required"]) == 2


@requires_models
def test_missing_recommendation_key_is_not_a_health_failure(client):
    """/recommend being disabled must not take the service out of rotation."""
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["recommendation_enabled"] in (True, False)


# --- Predict ----------------------------------------------------------------
@requires_models
def test_predict_returns_all_conditions_with_provenance_and_basis(client):
    body = client.post("/predict", json=_payload()).json()
    assert body["provenance"] == "model"
    assert {r["condition"] for r in body["risks"]} == EXPECTED_CONDITIONS
    for risk in body["risks"]:
        assert risk["basis"] in ("calibrated_classifier", "clinical_formula")
        assert risk["provenance"] == "model"
        assert 0 <= risk["score"] <= 100
        assert risk["rationale"]
    assert "not a medical device" in body["disclaimer"]


@requires_models
def test_predict_returns_trajectories_when_history_is_supplied(client):
    body = client.post("/predict", json=_payload(days=84)).json()
    assert len(body["trajectories"]) == len(EXPECTED_CONDITIONS)
    for trajectory in body["trajectories"]:
        assert trajectory["direction"] in ("improving", "stable", "worsening", "unknown")
        assert trajectory["provenance"] == "model"
        assert len(trajectory["points"]) >= 3


@requires_models
def test_predict_works_without_any_wearable_data(client):
    """v1 fabricated 14 days of fake data here rather than admitting absence."""
    response = client.post("/predict", json={"user_data": _profile()})
    assert response.status_code == 200
    body = response.json()
    assert body["risks"]
    assert body["trajectories"] == []


@requires_models
def test_predict_surfaces_estimated_biomarkers(client):
    biomarkers = client.post("/predict", json=_payload()).json()["biomarkers"]
    for field in ("hba1c", "systolic_bp", "diastolic_bp", "fli"):
        assert biomarkers[field] is not None, field


@requires_models
def test_measured_labs_override_estimates_over_the_wire(client):
    payload = _payload()
    payload["measured"] = {"triglycerides": 210.0, "ggt": 88.0, "hba1c": 6.9,
                           "systolic_bp": 145.0, "diastolic_bp": 95.0}
    body = client.post("/predict", json=payload).json()
    assert body["biomarkers"]["hba1c"] == 6.9
    assert body["provenance"] == "heuristic"


# --- Failure contract -------------------------------------------------------
@pytest.mark.parametrize("payload,expected", [
    ({"user_data": {"age": 45, "gender": "M", "bmi": 28, "waist": 100},
      "watch_data": [_day(0.5)] * 3}, 400),                       # short window
    ({"user_data": {"age": 45, "bmi": 28, "waist": 100}}, 400),   # no sex
    ({"user_data": {"age": 45, "gender": "M", "bmi": 400, "waist": 100}}, 400),  # absurd BMI
    ({}, 422),                                                     # no user_data at all
])
def test_bad_input_is_rejected_never_guessed(client, payload, expected):
    """Every rejection is an explicit status code.

    v1 responded to malformed input by substituting `Math.random()` biomarkers
    and returning HTTP 200.
    """
    response = client.post("/predict", json=payload)
    assert response.status_code == expected
    assert "risks" not in response.json()


@requires_models
def test_recommend_degrades_to_503_without_a_key(client):
    """A missing optional dependency is a deployment state, not a server fault.

    Critically it is 503 and not 500, and /predict keeps working.
    """
    response = client.post("/recommend", json={
        "user_context": {"predicted_tg": 180},
        "original_meal": {"name": "Mutton Biryani", "calories": 600,
                          "fat": 30, "protein": 22}})
    if response.status_code == 200:
        pytest.skip("GEMINI_API_KEY is configured in this environment")
    assert response.status_code == 503
    body = response.json()
    assert body["provenance"] == "unavailable"
    assert "unaffected" in body["detail"]
    assert client.post("/predict", json=_payload()).status_code == 200


# --- Functional readiness ---------------------------------------------------
@requires_models
def test_health_probe_actually_loads_the_models(client):
    """Presence is not readiness.

    A build that stripped numpy test modules left every artifact in place, so a
    presence-only check reported "ok" and Docker reported "healthy" while every
    /predict returned 500. The probe must load the stack and score a profile.
    """
    from src.inference.artifacts import functional_check, reset_probe_cache

    reset_probe_cache()
    body = client.get("/health").json()
    assert body["artifacts"]["functional"] is True
    probe = functional_check()
    assert set(probe["conditions"]) == EXPECTED_CONDITIONS
    assert "fli" in probe["targets"]
    reset_probe_cache()


def test_health_probe_reports_a_broken_model_stack(monkeypatch):
    """An unloadable model must fail the probe, not pass silently."""
    from src.inference.artifacts import full_readiness, reset_probe_cache

    reset_probe_cache()
    monkeypatch.setenv("RISK_ENGINE_PATH", "models/definitely_not_here.joblib")
    report = full_readiness()
    assert report["functional"] is False
    assert report["ready"] is False
    assert "ArtifactsMissingError" in report["functional_error"]
    reset_probe_cache()


def test_probe_result_is_cached(monkeypatch):
    """Loading ~7 MB of estimators on every poll would make /health the most
    expensive endpoint on the service."""
    from src.inference import artifacts

    artifacts.reset_probe_cache()
    calls = {"n": 0}
    original = artifacts._run_probe

    def counting_probe():
        calls["n"] += 1
        return original()

    monkeypatch.setattr(artifacts, "_run_probe", counting_probe)
    for _ in range(5):
        artifacts.functional_check()
    assert calls["n"] == 1, f"probe ran {calls['n']} times instead of being cached"
    artifacts.reset_probe_cache()
