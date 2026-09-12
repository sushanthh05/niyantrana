# Inference service: risk assessment and meal recommendation.
#
# Sized for a free 512 MB instance. The two decisions that make that possible:
#   1. TensorFlow is never installed -- importing it alone costs ~358 MB RSS.
#      Training happens offline; only scikit-learn estimators are served.
#   2. The food database ships as CSV, not xlsx, removing openpyxl and cutting
#      cold-start load from 0.71s to 0.01s. On a tier that spins down after
#      15 minutes idle, cold start is a user-visible cost.
#
# Measured peak RSS: 199.9 MB with all models loaded.

FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

WORKDIR /app

# Dependencies first: this layer is cached across source changes.
COPY requirements-serve.txt .

# Strip test suites from the heavy scientific packages: ~130 MB never imported
# at runtime. numpy is EXCLUDED deliberately -- scipy star-imports
# numpy.testing, which imports numpy._core.tests._natype, so numpy test code is
# genuinely on the import path. Stripping it produced an image whose /health
# reported "ok" while every /predict returned 500.
#
# __pycache__ is also kept: PYTHONDONTWRITEBYTECODE=1 means deleting it would
# force a full recompile of scipy, pandas and scikit-learn on every cold start,
# and this tier spins down after 15 minutes idle.
RUN pip install --no-cache-dir -r requirements-serve.txt \
 && for pkg in scipy sklearn pandas; do \
      find /usr/local/lib/python3.13/site-packages/$pkg -type d -name tests -prune -exec rm -rf {} + 2>/dev/null || true; \
    done \
 && python -c "import sklearn, scipy, pandas, numpy, joblib; from sklearn.calibration import CalibratedClassifierCV; print('import check OK')"

# Only what the service actually reads at runtime.
COPY src/ ./src/
COPY models/risk_engine.joblib models/risk_classifiers.joblib ./models/
COPY data/raw/anuvaad_indb_2024.11.csv ./data/raw/

# Run unprivileged.
RUN useradd --create-home --uid 10001 niyantrana && chown -R niyantrana:niyantrana /app
USER niyantrana

EXPOSE 8000

# Reports "degraded" rather than failing when artifacts are missing, so a
# misprovisioned deploy is visible instead of crash-looping.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4).status==200 else 1)"

# Single worker: the free tier has 0.1 CPU, and each worker loads its own copy
# of the models. Scale with instances, not workers.
CMD ["sh", "-c", "uvicorn src.api.app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
