"""Per-condition risk scorers.

Patterns applied: **Strategy** + **Template Method**.

The v1 code computed one condition (fatty liver) inline inside an Express route
handler, mixing the clinical formula with HTTP concerns and a random fallback.
Adding diabetes and hypertension that way would have meant a growing `if`
cascade in the same handler -- textbook **Divergent Change**.

Each condition is now a strategy object. `RiskScorer.score()` is the template
method: it fixes the invariant skeleton (compute -> clamp -> band -> package
with provenance) so no scorer can forget to declare where its number came from,
while `_compute` and `_rationale` vary per condition. Registering a fourth
condition requires no change to any existing class (Open/Closed).
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from ..domain.models import (DIASTOLIC_HYPERTENSION, FLI_STEATOSIS_THRESHOLD,
                             HBA1C_DIABETES, HBA1C_PREDIABETES,
                             SYSTOLIC_HYPERTENSION, Biomarkers, Provenance,
                             RiskScore, UserProfile)


class RiskScorer(ABC):
    """Strategy interface for scoring one condition."""

    condition: str = "unknown"

    def score(self, profile: UserProfile, biomarkers: Biomarkers,
              provenance: Provenance) -> RiskScore | None:
        """Template method. Subclasses override `_compute` and `_rationale`.

        Returns None when the inputs this scorer needs are unavailable -- an
        honest abstention, not a fabricated default.
        """
        raw = self._compute(profile, biomarkers)
        if raw is None:
            return None
        value = max(0.0, min(100.0, float(raw)))
        return RiskScore(
            condition=self.condition,
            score=round(value, 1),
            band=RiskScore.band_for(value),
            provenance=provenance,
            rationale=self._rationale(profile, biomarkers, value),
            contributors=self._contributors(profile, biomarkers),
        )

    @abstractmethod
    def _compute(self, profile: UserProfile, biomarkers: Biomarkers) -> float | None:
        """Return a 0-100 risk value, or None if inputs are insufficient."""

    @abstractmethod
    def _rationale(self, profile: UserProfile, biomarkers: Biomarkers, value: float) -> str:
        """One sentence the user can act on."""

    def _contributors(self, profile: UserProfile, biomarkers: Biomarkers) -> tuple[str, ...]:
        """Modifiable factors pushing this score up. Default: none identified."""
        return ()


class FattyLiverScorer(RiskScorer):
    """Fatty Liver Index (Bedogni 2006). FLI >= 60 rules steatosis in."""

    condition = "fatty_liver"

    def _compute(self, profile, biomarkers):
        return biomarkers.fatty_liver_index(profile.bmi, profile.waist_cm)

    def _rationale(self, profile, biomarkers, value):
        if value >= FLI_STEATOSIS_THRESHOLD:
            return (f"Fatty Liver Index {value:.0f} is at or above the {FLI_STEATOSIS_THRESHOLD:.0f} "
                    "threshold associated with hepatic steatosis. Discuss a liver ultrasound "
                    "with a clinician.")
        if value >= 30:
            return f"Fatty Liver Index {value:.0f} is intermediate. Waist reduction has the largest effect."
        return f"Fatty Liver Index {value:.0f} suggests low likelihood of steatosis."

    def _contributors(self, profile, biomarkers):
        factors = []
        # Sex-specific waist thresholds; South Asian cut-offs are lower than
        # the European ones most calculators assume.
        waist_limit = 90.0 if profile.sex.numeric == 1.0 else 80.0
        if profile.waist_cm > waist_limit:
            factors.append("waist circumference")
        if profile.bmi >= 25:
            factors.append("BMI")
        if biomarkers.triglycerides and biomarkers.triglycerides > 150:
            factors.append("triglycerides")
        if profile.alcohol_drinks_week > 7:
            factors.append("alcohol intake")
        if profile.sugar_g > 50:
            factors.append("free sugar intake")
        return tuple(factors)


class DysglycaemiaScorer(RiskScorer):
    """Prediabetes / diabetes risk from HbA1c (ADA thresholds)."""

    condition = "dysglycaemia"

    def _compute(self, profile, biomarkers):
        if biomarkers.hba1c is None:
            return None
        hba1c = biomarkers.hba1c
        # Piecewise-linear map onto 0-100 anchored at the clinical cut-offs, so
        # the score band changes exactly where the diagnosis does.
        if hba1c < HBA1C_PREDIABETES:
            return 100.0 * (hba1c - 4.0) / (HBA1C_PREDIABETES - 4.0) * 0.30
        if hba1c < HBA1C_DIABETES:
            span = (hba1c - HBA1C_PREDIABETES) / (HBA1C_DIABETES - HBA1C_PREDIABETES)
            return 30.0 + 30.0 * span
        return min(100.0, 60.0 + 40.0 * (hba1c - HBA1C_DIABETES) / 4.0)

    def _rationale(self, profile, biomarkers, value):
        hba1c = biomarkers.hba1c
        if hba1c >= HBA1C_DIABETES:
            return (f"Estimated HbA1c {hba1c:.1f}% is at or above the {HBA1C_DIABETES}% "
                    "diabetes threshold. Confirm with a clinical HbA1c test.")
        if hba1c >= HBA1C_PREDIABETES:
            return (f"Estimated HbA1c {hba1c:.1f}% falls in the prediabetes range "
                    f"({HBA1C_PREDIABETES}-{HBA1C_DIABETES}%). This stage is often reversible.")
        return f"Estimated HbA1c {hba1c:.1f}% is within the normal range."

    def _contributors(self, profile, biomarkers):
        factors = []
        if profile.bmi >= 23:  # South Asian overweight cut-off
            factors.append("BMI")
        if profile.sugar_g > 50:
            factors.append("free sugar intake")
        if profile.fibre_g < 25:
            factors.append("low fibre intake")
        if profile.has_hereditary_risk:
            factors.append("family history")
        return tuple(factors)


class HypertensionScorer(RiskScorer):
    """Hypertension risk from blood pressure (ACC/AHA 2017: >= 130/80)."""

    condition = "hypertension"

    def _compute(self, profile, biomarkers):
        systolic, diastolic = biomarkers.systolic_bp, biomarkers.diastolic_bp
        if systolic is None and diastolic is None:
            return None
        # Score each reading against its own threshold, then take the worse --
        # either alone is sufficient for a diagnosis.
        parts = []
        if systolic is not None:
            parts.append(60.0 * systolic / SYSTOLIC_HYPERTENSION)
        if diastolic is not None:
            parts.append(60.0 * diastolic / DIASTOLIC_HYPERTENSION)
        return max(parts)

    def _rationale(self, profile, biomarkers, value):
        systolic = biomarkers.systolic_bp or 0
        diastolic = biomarkers.diastolic_bp or 0
        if systolic >= SYSTOLIC_HYPERTENSION or diastolic >= DIASTOLIC_HYPERTENSION:
            return (f"Estimated blood pressure {systolic:.0f}/{diastolic:.0f} mmHg is at or above "
                    f"{SYSTOLIC_HYPERTENSION:.0f}/{DIASTOLIC_HYPERTENSION:.0f}. "
                    "Confirm with repeated cuff measurements.")
        return f"Estimated blood pressure {systolic:.0f}/{diastolic:.0f} mmHg is within range."

    def _contributors(self, profile, biomarkers):
        factors = []
        if profile.bmi >= 25:
            factors.append("BMI")
        if profile.alcohol_drinks_week > 7:
            factors.append("alcohol intake")
        if profile.smoking_status == 2:
            factors.append("current smoking")
        return tuple(factors)


# Registry of available strategies. Adding a condition means adding one entry.
DEFAULT_SCORERS: tuple[RiskScorer, ...] = (
    FattyLiverScorer(),
    DysglycaemiaScorer(),
    HypertensionScorer(),
)
