"""Risk trajectory: how a user's risk has moved over their logged history.

This delivers the deck's "long-term risk trajectory" and "early warning"
promise **without** a temporal model, and that is a deliberate choice.

Why no LSTM here. The v1 design trained a sequence model to map 14 days of
wearable data onto same-day biomarkers. No real dataset can supervise that --
nobody draws blood daily -- which is precisely why the original data had to be
synthetic, and why that model scored R2 -0.89 on held-out users. Retraining it
as a delta model changes the output but not the supervision problem: there is
still no open dataset pairing longitudinal wearable data with repeated blood
draws at usable scale. (PMData is 16 people with no biomarkers; LifeSnaps is 71
people with no biomarkers.)

What works instead. The NHANES risk engine is a function of behaviour: change
sleep, activity and diet and its output changes. Applying that real,
cross-sectionally-validated model to successive windows of a user's own history
produces a genuine risk-over-time series. The trend is then a least-squares fit
over those points.

The honest limitation: this measures how risk responds to *observed behaviour
change*, using a model fitted across people rather than within one. It is a
trajectory of estimates, not a forecast of the individual's biology.
"""
from __future__ import annotations

from typing import Sequence

import numpy as np

from ..domain.models import (SEQUENCE_LENGTH, Provenance, RiskTrajectory,
                             TrajectoryPoint, UserProfile, WearableDay,
                             WearableWindow)

DEFAULT_STEP_DAYS = 7
MIN_POINTS_FOR_TREND = 3

# Score points per week below which a change is treated as noise rather than a
# real direction. The engine's own MAE is several points, so a shallower slope
# is not distinguishable from measurement error.
STABLE_SLOPE_THRESHOLD = 0.5


class TrajectoryAnalyser:
    """Runs a risk model over rolling windows of a user's wearable history."""

    def __init__(self, classifiers=None, engine=None,
                 window_length: int = SEQUENCE_LENGTH,
                 step_days: int = DEFAULT_STEP_DAYS):
        if classifiers is None and engine is None:
            raise ValueError("A classifier ensemble or a risk engine is required")
        self._classifiers = classifiers
        self._engine = engine
        self._window_length = window_length
        self._step_days = step_days

    @property
    def minimum_history_days(self) -> int:
        """Days of wearable data needed before any trajectory can be produced."""
        return self._window_length + self._step_days * (MIN_POINTS_FOR_TREND - 1)

    def _scores_for(self, profile: UserProfile, window: WearableWindow) -> dict:
        """Risk per condition for one window, on the 0-100 scale."""
        if self._classifiers is not None:
            return {condition: result.score
                    for condition, result in self._classifiers.predict(profile, window).items()}

        biomarkers = self._engine.predict(profile, window)
        fli = biomarkers.fatty_liver_index(profile.bmi, profile.waist_cm)
        return {"fatty_liver": fli} if fli is not None else {}

    def compute(self, profile: UserProfile,
                history: Sequence[WearableDay]) -> tuple[RiskTrajectory, ...]:
        """Build one trajectory per condition from oldest-first wearable history.

        Returns an empty tuple when history is too short. An abstention, not an
        extrapolation from a single point.
        """
        days = list(history)
        if len(days) < self._window_length:
            return ()

        points: list[TrajectoryPoint] = []
        # Walk windows forward, always ending on the most recent day so the
        # final point reflects the user's current state.
        starts = range(0, len(days) - self._window_length + 1, self._step_days)
        for start in starts:
            window = WearableWindow(tuple(days[start:start + self._window_length]))
            points.append(TrajectoryPoint(
                day_index=start + self._window_length - 1,
                scores=self._scores_for(profile, window),
                provenance=Provenance.MODEL,
            ))

        last_start = len(days) - self._window_length
        if points and points[-1].day_index != len(days) - 1:
            window = WearableWindow(tuple(days[last_start:]))
            points.append(TrajectoryPoint(
                day_index=len(days) - 1,
                scores=self._scores_for(profile, window),
                provenance=Provenance.MODEL,
            ))

        conditions = sorted({c for point in points for c in point.scores})
        return tuple(self._trajectory_for(condition, points) for condition in conditions)

    def _trajectory_for(self, condition: str,
                        points: list[TrajectoryPoint]) -> RiskTrajectory:
        usable = [p for p in points if condition in p.scores]
        slope, direction = self._fit_slope(condition, usable)
        return RiskTrajectory(
            condition=condition,
            points=tuple(usable),
            slope_per_week=slope,
            direction=direction,
            provenance=Provenance.MODEL,
        )

    @staticmethod
    def _fit_slope(condition: str, points: list[TrajectoryPoint]):
        """Least-squares gradient in score points per week.

        Returns (None, "unknown") below MIN_POINTS_FOR_TREND rather than
        drawing a line through two points and calling it a trend.
        """
        if len(points) < MIN_POINTS_FOR_TREND:
            return None, "unknown"

        weeks = np.array([p.day_index / 7.0 for p in points], dtype=float)
        values = np.array([p.scores[condition] for p in points], dtype=float)
        if np.ptp(weeks) == 0:
            return None, "unknown"

        slope = float(np.polyfit(weeks, values, 1)[0])
        if slope > STABLE_SLOPE_THRESHOLD:
            direction = "worsening"
        elif slope < -STABLE_SLOPE_THRESHOLD:
            direction = "improving"
        else:
            direction = "stable"
        return round(slope, 3), direction
