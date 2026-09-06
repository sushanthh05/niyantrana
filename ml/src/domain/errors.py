"""Domain exception hierarchy.

Refactoring applied: **Replace Error Code with Exception**.

The previous code signalled failure three different ways -- `exit()` at import
time, returning `None`, and (worst) substituting a plausible random number. A
caller could not distinguish success from failure. Every failure mode is now a
typed exception, and the API layer is the only place that maps them to status
codes.
"""


class NiyantranaError(Exception):
    """Base for every domain error. Lets callers catch the whole family."""

    status_code = 500


class ValidationError(NiyantranaError):
    """Caller supplied malformed or physiologically impossible input."""

    status_code = 400


class MissingFeatureError(ValidationError):
    """A feature the model requires was not supplied."""

    def __init__(self, missing):
        self.missing = list(missing)
        super().__init__(f"Missing required feature(s): {', '.join(self.missing)}")


class ArtifactsMissingError(NiyantranaError):
    """Model or scaler files are absent. The service cannot serve predictions."""

    status_code = 503


class InferenceError(NiyantranaError):
    """The model failed to produce a prediction.

    Deliberately NOT caught-and-substituted anywhere. A failed prediction must
    surface as an error, never as a fabricated value.
    """

    status_code = 503


class RecommenderUnavailableError(NiyantranaError):
    """The LLM backend is not configured. Prediction endpoints are unaffected."""

    status_code = 503
