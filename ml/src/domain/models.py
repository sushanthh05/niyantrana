"""Immutable domain value objects.

Refactorings applied:

* **Introduce Parameter Object** / **Replace Data Value with Object** -- the old
  code passed an 11-key raw dict as `user_data` and a 14-row DataFrame as
  `watch_data` through every layer (a **Data Clump**). Those are now
  `UserProfile` and `WearableWindow`, which validate themselves once at the
  boundary instead of every consumer re-checking.
* **Replace Magic Number with Symbolic Constant** -- clinical thresholds
  (FLI >= 60, HbA1c >= 5.7, BP >= 130/80) were previously inline literals
  duplicated across Python and JavaScript. They live here once.
* **Encapsulate Field** -- these are frozen dataclasses; nothing downstream can
  mutate a profile mid-pipeline. The old `predict.py` mutated its caller's
  DataFrame in place.

This module deliberately has **no I/O and no framework imports**. It is the
stable core that the inference, risk, API and training layers all depend on --
dependencies point inward (Dependency Inversion).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Sequence

from .errors import ValidationError

SEQUENCE_LENGTH = 14


class Provenance(str, Enum):
    """Where a number came from. Every emitted value carries one.

    The v1 codebase returned `Math.random()` as an "AI risk assessment" in three
    separate places with no way for a caller to tell. Making provenance part of
    the type system means a value cannot be constructed without declaring it.
    """

    MODEL = "model"              # real prediction from the NHANES-trained engine
    SIMULATION = "simulation"    # involves the simulation-trained trajectory model
    HEURISTIC = "heuristic"      # rule-based, e.g. FLI from user-entered labs
    UNAVAILABLE = "unavailable"  # inference failed; never a substituted value


class RiskBand(str, Enum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"


class Sex(str, Enum):
    MALE = "M"
    FEMALE = "F"

    @classmethod
    def parse(cls, value) -> "Sex":
        text = str(value).strip().upper()
        if text.startswith("M"):
            return cls.MALE
        if text.startswith("F"):
            return cls.FEMALE
        raise ValidationError(f"Unrecognised sex value: {value!r} (expected M or F)")

    @property
    def numeric(self) -> float:
        """1.0 for male, 0.0 for female -- matches the training encoding."""
        return 1.0 if self is Sex.MALE else 0.0


# Clinical thresholds, each with its source. Single source of truth.
FLI_STEATOSIS_THRESHOLD = 60.0      # Bedogni 2006
HBA1C_PREDIABETES = 5.7             # ADA
HBA1C_DIABETES = 6.5                # ADA
SYSTOLIC_HYPERTENSION = 130.0       # ACC/AHA 2017
DIASTOLIC_HYPERTENSION = 80.0       # ACC/AHA 2017

# Physiologically plausible input ranges, used to reject nonsense at the boundary.
PROFILE_RANGES = {
    "age": (18.0, 120.0),
    "bmi": (12.0, 70.0),
    "waist_cm": (50.0, 200.0),
    "energy_kcal": (0.0, 10000.0),
    "sleep_hours": (0.0, 24.0),
}


def _require_in_range(name: str, value: float) -> float:
    low, high = PROFILE_RANGES[name]
    if value is None or (isinstance(value, float) and math.isnan(value)):
        raise ValidationError(f"{name} is required")
    if not low <= float(value) <= high:
        raise ValidationError(f"{name}={value} is outside the plausible range [{low}, {high}]")
    return float(value)


@dataclass(frozen=True)
class UserProfile:
    """Static profile plus daily dietary totals.

    Replaces the untyped `user_data` dict. Validation happens once, here, rather
    than being re-implemented (inconsistently) by each consumer.
    """

    age: float
    sex: Sex
    bmi: float
    waist_cm: float
    has_hereditary_risk: bool = False

    # Optional anthropometrics. Present -> BMR uses Mifflin-St Jeor directly;
    # absent -> it is estimated from BMI with a nominal height.
    height_cm: float | None = None
    weight_kg: float | None = None

    # Daily dietary totals, aggregated from meal logs.
    energy_kcal: float = 0.0
    fat_g: float = 0.0
    carb_g: float = 0.0
    protein_g: float = 0.0
    sugar_g: float = 0.0
    fibre_g: float = 0.0
    satfat_g: float = 0.0

    # Lifestyle. Alcohol is a major GGT confounder that v1 ignored entirely
    # while using GGT as a headline output.
    alcohol_drinks_week: float = 0.0
    smoking_status: int = 0  # 0 never, 1 former, 2 current

    def __post_init__(self):
        _require_in_range("age", self.age)
        _require_in_range("bmi", self.bmi)
        _require_in_range("waist_cm", self.waist_cm)
        _require_in_range("energy_kcal", self.energy_kcal)

    @property
    def basal_metabolic_rate(self) -> float:
        """Mifflin-St Jeor BMR in kcal/day.

        Moved here from `userRoutes.js`, where it was implemented twice
        (**Duplicate Code**) and recomputed on every weight update.
        """
        height = self.height_cm or 170.0
        weight = self.weight_kg or self.bmi * (height / 100.0) ** 2
        base = 10.0 * weight + 6.25 * height - 5.0 * self.age
        return base + (5.0 if self.sex is Sex.MALE else -161.0)

    @property
    def total_energy_expenditure(self) -> float:
        """BMR scaled by a light-activity factor."""
        return self.basal_metabolic_rate * 1.375

    @property
    def energy_balance(self) -> float:
        """Daily surplus/deficit. Positive means eating above expenditure."""
        return self.energy_kcal - self.total_energy_expenditure

    @classmethod
    def from_dict(cls, data: dict) -> "UserProfile":
        """Factory Method: build from an untrusted external payload.

        Accepts the legacy key spellings the Express backend sends so the two
        services can be migrated independently.
        """
        if not isinstance(data, dict):
            raise ValidationError("Profile payload must be an object")

        def pick(*names, default=0.0):
            for name in names:
                if data.get(name) is not None:
                    return data[name]
            return default

        height_cm = pick("height", "height_cm", default=None)
        weight_kg = pick("weight", "weight_kg", default=None)
        bmi = pick("bmi", default=None)
        if bmi is None and height_cm and weight_kg:
            bmi = float(weight_kg) / (float(height_cm) / 100.0) ** 2

        if "sex" not in data and "gender" not in data:
            raise ValidationError("Profile must include 'sex' or 'gender'")

        return cls(
            age=pick("age", default=None),
            sex=Sex.parse(data.get("sex", data.get("gender"))),
            bmi=bmi,
            waist_cm=pick("waist_cm", "waist", default=None),
            has_hereditary_risk=bool(pick("has_hereditary_risk", "hereditary_risk", default=False)),
            height_cm=(float(height_cm) if height_cm else None),
            weight_kg=(float(weight_kg) if weight_kg else None),
            energy_kcal=float(pick("energy_kcal", "calorie_intake", default=0.0)),
            fat_g=float(pick("fat_g", "fat_grams", default=0.0)),
            carb_g=float(pick("carb_g", "carbs_grams", default=0.0)),
            protein_g=float(pick("protein_g", "protein_grams", default=0.0)),
            sugar_g=float(pick("sugar_g", default=0.0)),
            fibre_g=float(pick("fibre_g", default=0.0)),
            satfat_g=float(pick("satfat_g", default=0.0)),
            alcohol_drinks_week=float(pick("alcohol_drinks_week", default=0.0)),
            smoking_status=int(pick("smoking_status", default=0)),
        )


@dataclass(frozen=True)
class WearableDay:
    """One day of wearable measurements."""

    daily_steps: float
    active_minutes: float
    sleep_hours: float
    sleep_quality_score: float
    resting_heart_rate: float
    heart_rate_variability: float

    @classmethod
    def from_dict(cls, data: dict) -> "WearableDay":
        def pick(*names):
            for name in names:
                if data.get(name) is not None:
                    return float(data[name])
            raise ValidationError(f"Wearable day missing {names[0]}")

        return cls(
            daily_steps=pick("daily_steps", "steps"),
            active_minutes=pick("active_minutes", "activeMinutes"),
            sleep_hours=pick("sleep_hours", "sleepHours"),
            sleep_quality_score=pick("sleep_quality_score", "sleep_efficiency", "efficiency"),
            # The Express backend wrote `heart_rate`, the Mongoose schema declared
            # `resting_heart_rate`, and Mongoose silently dropped the mismatch.
            resting_heart_rate=pick("resting_heart_rate", "heart_rate", "restingHeartRate"),
            heart_rate_variability=pick("heart_rate_variability", "hrv", "dailyRmssd"),
        )


@dataclass(frozen=True)
class WearableWindow:
    """An ordered run of wearable days, oldest first.

    Encapsulates the sequence-length invariant that was previously re-checked by
    hand in `predict_risk`, and exposes the aggregate queries the feature bridge
    needs (**Replace Temp with Query**).
    """

    days: tuple[WearableDay, ...]

    def __post_init__(self):
        if len(self.days) != SEQUENCE_LENGTH:
            raise ValidationError(
                f"Wearable window must contain exactly {SEQUENCE_LENGTH} days, got {len(self.days)}"
            )

    @classmethod
    def from_records(cls, records: Sequence[dict]) -> "WearableWindow":
        if not isinstance(records, Sequence) or isinstance(records, (str, bytes)):
            raise ValidationError("Wearable window must be a list of daily records")
        return cls(tuple(WearableDay.from_dict(r) for r in records))

    def _mean(self, attr: str) -> float:
        return sum(getattr(d, attr) for d in self.days) / len(self.days)

    @property
    def mean_sleep_hours(self) -> float:
        return self._mean("sleep_hours")

    @property
    def mean_daily_steps(self) -> float:
        return self._mean("daily_steps")

    @property
    def mvpa_minutes_week(self) -> float:
        """Weekly moderate-to-vigorous minutes, scaled from the window mean.

        This is the feature bridge: NHANES measures weekly activity minutes via
        questionnaire, a wearable measures daily active minutes. Same quantity,
        different instrument -- which is what lets a model trained on NHANES be
        served on wearable input.
        """
        return self._mean("active_minutes") * 7.0

    @property
    def sedentary_minutes_day(self) -> float:
        """Waking minutes not spent active."""
        return max(0.0, (24.0 - self.mean_sleep_hours) * 60.0 - self._mean("active_minutes"))


@dataclass(frozen=True)
class Biomarkers:
    """Predicted or measured blood/vital markers."""

    triglycerides: float | None = None
    ggt: float | None = None
    hba1c: float | None = None
    systolic_bp: float | None = None
    diastolic_bp: float | None = None

    def fatty_liver_index(self, bmi: float, waist_cm: float) -> float | None:
        """Bedogni 2006 Fatty Liver Index, 0-100.

        Previously duplicated in `apiRoutes.js`, `predict.py` and a notebook
        (**Duplicate Code**), which meant three places to fix a coefficient.
        """
        if not (self.triglycerides and self.ggt and bmi and waist_cm):
            return None
        if self.triglycerides <= 0 or self.ggt <= 0:
            return None
        z = (0.953 * math.log(self.triglycerides) + 0.139 * bmi
             + 0.718 * math.log(self.ggt) + 0.053 * waist_cm - 15.745)
        return 100.0 * math.exp(z) / (1.0 + math.exp(z))


@dataclass(frozen=True)
class RiskScore:
    """A single condition's risk, inseparable from its provenance."""

    condition: str
    score: float                  # 0-100
    band: RiskBand
    provenance: Provenance
    rationale: str = ""
    contributors: tuple[str, ...] = field(default_factory=tuple)

    @staticmethod
    def band_for(score: float) -> RiskBand:
        if score >= 60:
            return RiskBand.HIGH
        if score >= 30:
            return RiskBand.MODERATE
        return RiskBand.LOW


@dataclass(frozen=True)
class RiskAssessment:
    """The full multi-condition result returned to callers."""

    scores: tuple[RiskScore, ...]
    biomarkers: Biomarkers
    provenance: Provenance
    disclaimer: str = (
        "Advisory only. Niyantrana is not a medical device and does not diagnose. "
        "Confirm any concern with clinical testing."
    )

    def by_condition(self, condition: str) -> RiskScore | None:
        return next((s for s in self.scores if s.condition == condition), None)
