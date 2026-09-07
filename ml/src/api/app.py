"""FastAPI service: biomarker prediction and meal recommendation.

Replaces two Flask apps (`ml/src/app.py` on :5000 and `rag_engine/src/app.py` on
:5001), both of which ran `debug=True` bound to `0.0.0.0` -- a remotely
reachable Werkzeug console. Merging them also halves the number of free-tier
instances the deployment needs.

Patterns applied:

* **Facade** -- handlers are thin. Each one translates a DTO, calls one domain
  service, and translates the result back. No clinical logic lives here.
* **Chain of Responsibility** -- one exception handler per domain error type
  maps the whole hierarchy to status codes, replacing the try/except ladder
  that was copy-pasted into every Flask route (**Duplicate Code**).
* **Dependency Inversion** -- services are resolved through FastAPI's dependency
  system, so tests inject fakes rather than loading real artifacts.
"""
from __future__ import annotations

import os

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..domain.errors import NiyantranaError
from ..recommendation.engine import RecommendationEngine
from ..risk.assessor import RiskAssessor
from .schemas import (AssessmentResponse, ErrorResponse, PredictRequest,
                      RecommendRequest, RecommendResponse)

app = FastAPI(
    title="Niyantrana Inference Service",
    version="2.0.0",
    description="Metabolic risk assessment and culturally-aware meal recommendations.",
)

_origins = [o.strip() for o in os.environ.get("CORS_ORIGIN", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# --- Dependency providers (Singleton-scoped, lazily constructed) -------------
_assessor: RiskAssessor | None = None
_recommender: RecommendationEngine | None = None


def get_assessor() -> RiskAssessor:
    global _assessor
    if _assessor is None:
        _assessor = RiskAssessor.build()
    return _assessor


def get_recommender() -> RecommendationEngine:
    global _recommender
    if _recommender is None:
        _recommender = RecommendationEngine()
    return _recommender


# --- Error handling ---------------------------------------------------------
@app.exception_handler(NiyantranaError)
async def handle_domain_error(request: Request, exc: NiyantranaError):
    """Map the domain exception hierarchy onto HTTP.

    Critically, an inference failure returns its real status code. It is never
    downgraded into a 200 carrying an invented number.
    """
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(error=type(exc).__name__, detail=str(exc)).model_dump(),
    )


# --- Routes -----------------------------------------------------------------
@app.get("/health")
def health():
    """Liveness plus artifact readiness. Never raises."""
    from ..inference.registry import ModelRegistry

    artifacts = ModelRegistry.instance().health()
    return {
        "status": "ok" if artifacts.get("ready") else "degraded",
        "artifacts": artifacts,
        "recommendation_enabled": RecommendationEngine.is_configured(),
    }


@app.post("/predict", response_model=AssessmentResponse)
def predict(request: PredictRequest, assessor: RiskAssessor = Depends(get_assessor)):
    """Assess fatty-liver, dysglycaemia and hypertension risk."""
    profile, window, history, measured = request.to_domain()
    return AssessmentResponse.from_domain(
        assessor.assess(profile, window, measured, history=history))


@app.post("/recommend", response_model=RecommendResponse)
def recommend(request: RecommendRequest,
              engine: RecommendationEngine = Depends(get_recommender)):
    """Suggest a healthier Indian alternative to a logged meal."""
    result = engine.recommend(request.user_context, request.original_meal.model_dump())
    return RecommendResponse(**result)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
