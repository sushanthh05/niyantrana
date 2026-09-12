"""Per-condition risk scorers.

Patterns applied: **Strategy** + **Template Method**.

The v1 code computed one condition (fatty liver) inline inside an Express route
handler, mixing the clinical formula with HTTP concerns and a random fallback.
Adding diabetes and hypertension that way would have meant a growing `if`
cascade in the same handler -- textbook **Divergent Change**.

Each condition is now a strategy object. `RiskScorer.score()` is the template
method: it fixes the invariant skeleton (obtain a value -> clamp -> band ->
package with provenance AND basis) so no scorer can emit a number without
declaring both where the data came from and which model produced it.

**Score source precedence.** Where a calibrated classifier covers the condition,
its probability is the score: it is a direct estimate of "does this person have
this condition", trained and calibrated on 17,961 real adults. The clinical
formula is the fallback for conditions no classifier covers, and it still
supplies the rationale and contributor list in both cases -- the classifier
answers *how likely*, the formula explains *why*.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from ..domain.models import (DIASTOLIC_HYPERTENSION, FLI_STEATOSIS_THRESHOLD,
                             HBA1C_DIABETES, HBA1C_PREDIABETES,
                             SYSTOLIC_HYPERTENSION, AssessmentContext,
                             Biomarkers, Provenance, RiskScore, ScoreBasis,
                             UserProfile)


def _above(value, threshold) -> bool:
    """True only when the value is KNOWN and exceeds the threshold.

    A dietary field is None when the user has logged no meals. An unlogged
    value is not evidence, so it must never be cited as a contributor -- the
    app cannot tell someone their sugar intake is high when it has no idea what
    they ate.
    """
    return value is not None and value > threshold


def _below(value, threshold) -> bool:
    """True only when the value is KNOWN and falls below the threshold."""
    return value is not None and value < threshold


class RiskScorer(ABC):
    """Strategy interface for scoring one condition."""

    condition: str = "unknown"

    def score(self, context: AssessmentContext,
              provenance: Provenance) -> RiskScore | None:
        """Template method. Subclasses override `_compute` and `_rationale`.

        Returns None when neither a classifier nor the required biomarkers are
        available -- an honest abstention, not a fabricated default.
        """
        probability = context.probability_for(self.condition)
        if probability is not None:
            raw, basis = probability * 100.0, ScoreBasis.CALIBRATED_CLASSIFIER
        else:
            raw, basis = self._compute(context.profile, context.biomarkers), \
                ScoreBasis.CLINICAL_FORMULA

        if raw is None:
            return None

        value = max(0.0, min(100.0, float(raw)))
        return RiskScore(
            condition=self.condition,
            score=round(value, 1),
            band=RiskScore.band_for(value),
            provenance=provenance,
            basis=basis,
            rationale=self._rationale(context.profile, context.biomarkers, value),
            contributors=self._contributors(context.profile, context.biomarkers),
        )

    @abstractmethod
    def _compute(self, profile: UserProfile, biomarkers: Biomarkers) -> float | None:
        """Fallback 0-100 risk value, or None if inputs are insufficient."""

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
            return ("Body measurements indicate elevated likelihood of fatty liver. "
                    "This estimate is driven mainly by waist circumference and BMI; "
                    "it is a prompt to discuss a liver ultrasound, not a diagnosis.")
        if value >= 30:
            return ("Intermediate likelihood of fatty liver. Waist reduction has the "
                    "largest single effect on this score.")
        return "Low likelihood of hepatic steatosis on current measurements."

    def _contributors(self, profile, biomarkers):
        factors = []
        # Sex-specific waist thresholds. South Asian cut-offs are lower than the
        # European ones most calculators assume.
        waist_limit = 90.0 if profile.sex.numeric == 1.0 else 80.0
        if profile.waist_cm > waist_limit:
            factors.append("waist circumference")
        if profile.bmi >= 25:
            factors.append("BMI")
        if _above(biomarkers.triglycerides, 150):
            factors.append("triglycerides")
        if _above(profile.alcohol_drinks_week, 7):
            factors.append("alcohol intake")
        if _above(profile.sugar_g, 50):
            factors.append("free sugar intake")
        return tuple(factors)


class DysglycaemiaScorer(RiskScorer):
    """Prediabetes risk. HbA1c >= 5.7 (ADA), or a diagnosis on record."""

    condition = "dysglycaemia"

    def _compute(self, profile, biomarkers):
        if biomarkers.hba1c is None:
            return None
        hba1c = biomarkers.hba1c
        # Piecewise-linear map onto 0-100 anchored at the clinical cut-offs, so
        # the band changes exactly where the diagnosis does.
        if hba1c < HBA1C_PREDIABETES:
            return 100.0 * (hba1c - 4.0) / (HBA1C_PREDIABETES - 4.0) * 0.30
        if hba1c < HBA1C_DIABETES:
            span = (hba1c - HBA1C_PREDIABETES) / (HBA1C_DIABETES - HBA1C_PREDIABETES)
            return 30.0 + 30.0 * span
        return min(100.0, 60.0 + 40.0 * (hba1c - HBA1C_DIABETES) / 4.0)

    def _rationale(self, profile, biomarkers, value):
        hba1c = biomarkers.hba1c
        if hba1c is None:
            return ("Estimated risk of raised blood sugar. Confirm with a clinical "
                    "HbA1c test before drawing conclusions.")
        if hba1c >= HBA1C_DIABETES:
            return (f"Estimated HbA1c {hba1c:.1f}% is at or above the {HBA1C_DIABETES}% "
                    "diabetes threshold. Confirm with a clinical test.")
        if hba1c >= HBA1C_PREDIABETES:
            return (f"Estimated HbA1c {hba1c:.1f}% falls in the prediabetes range "
                    f"({HBA1C_PREDIABETES}-{HBA1C_DIABETES}%). This stage is often reversible.")
        return f"Estimated HbA1c {hba1c:.1f}% is within the normal range."

    def _contributors(self, profile, biomarkers):
        factors = []
        if profile.bmi >= 23:  # South Asian overweight cut-off
            factors.append("BMI")
        if _above(profile.sugar_g, 50):
            # SHAP ranks free sugar third for the diabetes head -- the strongest
            # showing of any dietary variable.
            factors.append("free sugar intake")
        if _below(profile.fibre_g, 25):
            factors.append("low fibre intake")
        if profile.has_hereditary_risk:
            factors.append("family history")
        return tuple(factors)


class DiabetesScorer(DysglycaemiaScorer):
    """Diabetes risk. HbA1c >= 6.5 (ADA), or a diagnosis on record.

    Shares the dysglycaemia feature reasoning; only the threshold and wording
    differ, so it extends rather than duplicates (**Pull Up Method**).
    """

    condition = "diabetes"

    def _compute(self, profile, biomarkers):
        if biomarkers.hba1c is None:
            return None
        hba1c = biomarkers.hba1c
        if hba1c < HBA1C_DIABETES:
            return 60.0 * max(0.0, hba1c - 4.0) / (HBA1C_DIABETES - 4.0)
        return min(100.0, 60.0 + 40.0 * (hba1c - HBA1C_DIABETES) / 4.0)

    def _rationale(self, profile, biomarkers, value):
        hba1c = biomarkers.hba1c
        if hba1c is not None and hba1c >= HBA1C_DIABETES:
            return (f"Estimated HbA1c {hba1c:.1f}% is at or above the diabetes threshold. "
                    "A confirmatory clinical test is the necessary next step.")
        return ("Estimated risk of type-2 diabetes. At this screening sensitivity most "
                "flagged people will not have it, so treat this as a prompt to test.")


class HypertensionScorer(RiskScorer):
    """Hypertension risk. BP >= 130/80 (ACC/AHA 2017), or on BP medication."""

    condition = "hypertension"

    def _compute(self, profile, biomarkers):
        systolic, diastolic = biomarkers.systolic_bp, biomarkers.diastolic_bp
        if systolic is None and diastolic is None:
            return None
        # Score each reading against its own threshold and take the worse --
        # either alone is sufficient for a diagnosis.
        parts = []
        if systolic is not None:
            parts.append(60.0 * systolic / SYSTOLIC_HYPERTENSION)
        if diastolic is not None:
            parts.append(60.0 * diastolic / DIASTOLIC_HYPERTENSION)
        return max(parts)

    def _rationale(self, profile, biomarkers, value):
        systolic, diastolic = biomarkers.systolic_bp, biomarkers.diastolic_bp
        if systolic is None and diastolic is None:
            return ("Estimated hypertension risk. Confirm with repeated cuff "
                    "measurements taken on separate days.")
        if (systolic or 0) >= SYSTOLIC_HYPERTENSION or (diastolic or 0) >= DIASTOLIC_HYPERTENSION:
            return (f"Estimated blood pressure {systolic:.0f}/{diastolic:.0f} mmHg is at or "
                    f"above {SYSTOLIC_HYPERTENSION:.0f}/{DIASTOLIC_HYPERTENSION:.0f}. "
                    "Confirm with repeated cuff measurements.")
        return f"Estimated blood pressure {systolic:.0f}/{diastolic:.0f} mmHg is within range."

    def _contributors(self, profile, biomarkers):
        factors = []
        if profile.bmi >= 25:
            factors.append("BMI")
        if _above(profile.alcohol_drinks_week, 7):
            factors.append("alcohol intake")
        if profile.smoking_status == 2:
            factors.append("current smoking")
        if _above(profile.satfat_g, 22):
            factors.append("saturated fat intake")
        return tuple(factors)


# Registry of available strategies. Adding a condition means adding one entry.
DEFAULT_SCORERS: tuple[RiskScorer, ...] = (
    FattyLiverScorer(),
    DysglycaemiaScorer(),
    DiabetesScorer(),
    HypertensionScorer(),
)
