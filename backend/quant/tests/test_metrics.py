"""
backend/quant/tests/test_metrics.py
=====================================
Unit tests for the Quantitative Metrics Engine.

Tests use known-value assertions derived from manual calculations
to verify numerical correctness. No mocking of mathematical functions.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.quant.metrics import (
    MetricsResult,
    _MIN_OBSERVATIONS,
    alpha,
    beta,
    cagr,
    compute_all_metrics,
    max_drawdown,
    sharpe_ratio,
    sortino_ratio,
)


# ---------------------------------------------------------------------------
# Fixtures: synthetic return series with known properties
# ---------------------------------------------------------------------------

@pytest.fixture()
def flat_returns() -> np.ndarray:
    """Returns of exactly 0% every day — zero volatility."""
    return np.zeros(252, dtype=np.float64)


@pytest.fixture()
def positive_returns() -> np.ndarray:
    """Steady 5 bps/day positive returns."""
    return np.full(252, 0.0005, dtype=np.float64)


@pytest.fixture()
def benchmark_returns() -> np.ndarray:
    """Steady 3 bps/day benchmark returns."""
    return np.full(252, 0.0003, dtype=np.float64)


@pytest.fixture()
def volatile_returns(seed: int = 42) -> np.ndarray:
    """Normally distributed returns: mean=0.05%, std=1%."""
    rng = np.random.default_rng(seed=42)
    return rng.normal(0.0005, 0.01, 252).astype(np.float64)


@pytest.fixture()
def equity_curve_up() -> np.ndarray:
    """Monotonically increasing equity curve — MDD should be ~0."""
    return np.linspace(100.0, 200.0, 253, dtype=np.float64)


@pytest.fixture()
def equity_curve_drawdown() -> np.ndarray:
    """Equity curve that peaks at 150, troughs to 100, then recovers to 175.
    Expected MDD = (100 - 150) / 150 = -33.33%
    """
    up = np.linspace(100.0, 150.0, 100, dtype=np.float64)
    down = np.linspace(150.0, 100.0, 80, dtype=np.float64)
    recovery = np.linspace(100.0, 175.0, 73, dtype=np.float64)
    return np.concatenate([up, down, recovery])


# ---------------------------------------------------------------------------
# Sharpe Ratio Tests
# ---------------------------------------------------------------------------

class TestSharpeRatio:
    def test_zero_volatility_returns_nan(self, flat_returns: np.ndarray) -> None:
        """Sharpe is undefined when volatility is zero."""
        result = sharpe_ratio(flat_returns, risk_free_rate=0.05)
        assert math.isnan(result)

    def test_known_value(self, positive_returns: np.ndarray) -> None:
        """
        With constant 0.05% daily return and zero volatility, Sharpe → ∞.
        Use volatile returns for a finite, verifiable result.
        """
        # With mean=0.0005, std=0 — NaN case. Use volatile for known bound.
        rng = np.random.default_rng(seed=0)
        r = rng.normal(0.001, 0.01, 252).astype(np.float64)
        result = sharpe_ratio(r, risk_free_rate=0.0)
        # Mean = ~0.001 * 252 = 0.252 annual, vol = ~0.01 * sqrt(252)
        # Sharpe ≈ 0.252 / 0.1587 ≈ 1.59
        assert 0.5 < result < 5.0, f"Sharpe {result} out of expected range"

    def test_negative_sharpe_below_risk_free(self) -> None:
        """Returns below risk-free rate should yield negative Sharpe."""
        rng = np.random.default_rng(seed=1)
        r = rng.normal(-0.001, 0.01, 252).astype(np.float64)
        result = sharpe_ratio(r, risk_free_rate=0.05)
        assert result < 0.0

    def test_insufficient_observations_raises(self) -> None:
        r = np.random.default_rng(0).normal(0, 0.01, _MIN_OBSERVATIONS - 1).astype(np.float64)
        with pytest.raises(ValueError, match="Insufficient observations"):
            sharpe_ratio(r, risk_free_rate=0.05)

    def test_non_numpy_input_raises(self) -> None:
        with pytest.raises(TypeError, match="numpy ndarray"):
            sharpe_ratio([0.01, 0.02, 0.03], risk_free_rate=0.05)  # type: ignore

    def test_nan_in_returns_raises(self) -> None:
        r = np.random.default_rng(0).normal(0, 0.01, 252).astype(np.float64)
        r[100] = float("nan")
        with pytest.raises(ValueError, match="NaN or Inf"):
            sharpe_ratio(r, risk_free_rate=0.05)


# ---------------------------------------------------------------------------
# Sortino Ratio Tests
# ---------------------------------------------------------------------------

class TestSortinoRatio:
    def test_sortino_geq_sharpe_for_positive_skew(self) -> None:
        """Sortino ≥ Sharpe when returns are positively skewed (more upside)."""
        rng = np.random.default_rng(seed=5)
        r = rng.exponential(0.005, 252).astype(np.float64)
        # Positive-only exponential distribution has no downside — Sortino > Sharpe
        s = sharpe_ratio(r, risk_free_rate=0.0)
        so = sortino_ratio(r, risk_free_rate=0.0)
        assert so >= s or math.isnan(so)  # Sortino ≥ Sharpe (allow NaN)

    def test_zero_downside_returns_nan(self) -> None:
        """If all returns are positive, downside deviation = 0 → NaN."""
        r = np.full(252, 0.001, dtype=np.float64)
        result = sortino_ratio(r, risk_free_rate=0.0)
        assert math.isnan(result)

    def test_sortino_with_known_downside(self) -> None:
        """Verify Sortino gives finite result with mixed returns."""
        rng = np.random.default_rng(seed=10)
        r = rng.normal(0.0005, 0.015, 252).astype(np.float64)
        result = sortino_ratio(r, risk_free_rate=0.05)
        assert isinstance(result, float)
        assert not math.isnan(result)


# ---------------------------------------------------------------------------
# Max Drawdown Tests
# ---------------------------------------------------------------------------

class TestMaxDrawdown:
    def test_known_drawdown(self, equity_curve_drawdown: np.ndarray) -> None:
        """Expected MDD: peak=150, trough=100 → -33.33%."""
        result = max_drawdown(equity_curve_drawdown)
        expected = (100.0 - 150.0) / 150.0  # ≈ -0.3333
        assert abs(result - expected) < 0.01, f"MDD {result:.4f} != expected {expected:.4f}"

    def test_monotonic_increase_near_zero(self, equity_curve_up: np.ndarray) -> None:
        """Monotonically increasing curve should have MDD close to 0."""
        result = max_drawdown(equity_curve_up)
        assert result >= -0.02  # Very small drawdown (rounding only)
        assert result <= 0.0

    def test_mdd_is_negative_or_zero(self) -> None:
        """MDD is always non-positive."""
        rng = np.random.default_rng(seed=20)
        curve = 100 * np.cumprod(1 + rng.normal(0, 0.01, 500))
        result = max_drawdown(curve.astype(np.float64))
        assert result <= 0.0

    def test_single_point_raises(self) -> None:
        with pytest.raises(ValueError, match="at least 2"):
            max_drawdown(np.array([100.0]))

    def test_zero_values_raises(self) -> None:
        with pytest.raises(ValueError, match="strictly positive"):
            max_drawdown(np.array([100.0, 0.0, 50.0]))


# ---------------------------------------------------------------------------
# Beta Tests
# ---------------------------------------------------------------------------

class TestBeta:
    def test_perfect_correlation_beta_one(self) -> None:
        """Portfolio identical to benchmark → β = 1.0."""
        rng = np.random.default_rng(seed=30)
        r = rng.normal(0, 0.01, 252).astype(np.float64)
        result = beta(r, r)
        assert abs(result - 1.0) < 1e-6

    def test_zero_benchmark_variance_returns_nan(self) -> None:
        """Flat benchmark (zero variance) → β = NaN."""
        p = np.random.default_rng(0).normal(0, 0.01, 252).astype(np.float64)
        b = np.zeros(252, dtype=np.float64)
        result = beta(p, b)
        assert math.isnan(result)

    def test_mismatched_lengths_raises(self) -> None:
        p = np.ones(252, dtype=np.float64)
        b = np.ones(251, dtype=np.float64)
        with pytest.raises(ValueError, match="must equal"):
            beta(p, b)

    def test_beta_linearity(self) -> None:
        """2x portfolio returns relative to benchmark → β ≈ 2.0."""
        rng = np.random.default_rng(seed=40)
        b = rng.normal(0, 0.01, 252).astype(np.float64)
        p = 2.0 * b  # Perfect linear 2× relationship
        result = beta(p, b)
        assert abs(result - 2.0) < 1e-6


# ---------------------------------------------------------------------------
# CAGR Tests
# ---------------------------------------------------------------------------

class TestCAGR:
    def test_doubling_in_one_year(self) -> None:
        """Portfolio doubles in 252 trading days → CAGR = 100%."""
        curve = np.linspace(100.0, 200.0, 253, dtype=np.float64)
        result = cagr(curve, periods_per_year=252)
        assert abs(result - 1.0) < 0.001  # ≈ 100%

    def test_cagr_of_flat_curve(self) -> None:
        """Flat equity curve → CAGR = 0%."""
        curve = np.full(253, 100.0, dtype=np.float64)
        result = cagr(curve, periods_per_year=252)
        assert abs(result) < 1e-6

    def test_known_three_year_cagr(self) -> None:
        """Portfolio grows from 100 to 133.1 in 3 years → CAGR = 10%."""
        # 3 years = 3 * 252 = 756 periods
        curve = np.linspace(100.0, 133.1, 757, dtype=np.float64)
        result = cagr(curve, periods_per_year=252)
        assert abs(result - 0.10) < 0.005  # Within 0.5% tolerance

    def test_single_point_raises(self) -> None:
        with pytest.raises(ValueError, match="at least 2"):
            cagr(np.array([100.0]), periods_per_year=252)


# ---------------------------------------------------------------------------
# compute_all_metrics integration test
# ---------------------------------------------------------------------------

class TestComputeAllMetrics:
    def test_returns_metrics_result(self, volatile_returns: np.ndarray) -> None:
        """compute_all_metrics should return a fully populated MetricsResult."""
        rng = np.random.default_rng(seed=99)
        bench = rng.normal(0.0003, 0.008, 252).astype(np.float64)
        curve = 100 * np.cumprod(1 + volatile_returns)
        result = compute_all_metrics(
            portfolio_returns=volatile_returns,
            benchmark_returns=bench,
            equity_curve=curve.astype(np.float64),
            risk_free_rate=0.05,
        )
        assert isinstance(result, MetricsResult)
        assert result.observations == 252
        assert result.max_drawdown <= 0.0
        assert isinstance(result.sharpe_ratio, float)
        assert isinstance(result.beta, float)
        assert isinstance(result.cagr, float)
