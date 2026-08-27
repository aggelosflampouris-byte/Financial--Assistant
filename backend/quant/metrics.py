"""
backend/quant/metrics.py
=========================
Quantitative portfolio performance metrics.

ARCHITECTURAL CONSTRAINT:
All numerical computations are performed exclusively here, never by the LLM.
Functions are pure (no side effects), stateless, and designed to be callable
from PyO3 bindings when a Rust replacement is available.

Formulas implemented:
  - Sharpe Ratio:   (Rp - Rf) / σp
  - Sortino Ratio:  (Rp - Rf) / σd  (σd = downside deviation)
  - Max Drawdown:   peak-to-trough maximum loss
  - Beta:           Cov(Rp, Rm) / Var(Rm)
  - Alpha:          Rp - [Rf + β(Rm - Rf)]  (Jensen's Alpha, annualized)
  - CAGR:           (V_end / V_start)^(1/years) - 1

References:
  - Sharpe, W.F. (1994). The Sharpe Ratio. Journal of Portfolio Management.
  - Sortino, F.A., Price, L.N. (1994). Performance Measurement in a Downside
    Risk Framework. Journal of Investing.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np
import numpy.typing as npt


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TRADING_DAYS_PER_YEAR: int = 252
_MIN_OBSERVATIONS: int = 30  # Minimum data points for statistically meaningful results


# ---------------------------------------------------------------------------
# Result dataclasses (immutable, typed, no magic numbers)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MetricsResult:
    """Container for all computed portfolio metrics."""
    sharpe_ratio: float
    sortino_ratio: float
    max_drawdown: float           # Negative decimal (e.g. -0.25 = -25%)
    beta: float
    alpha: float                  # Jensen's Alpha, annualized
    cagr: float                   # Compound Annual Growth Rate
    annualized_return: float      # Mean annualized return
    annualized_volatility: float  # Standard deviation, annualized
    downside_deviation: float     # Annualized downside deviation
    total_return: float           # Simple total return over full period
    observations: int             # Number of return periods used


# ---------------------------------------------------------------------------
# Core metric functions
# ---------------------------------------------------------------------------

def sharpe_ratio(
    returns: npt.NDArray[np.float64],
    risk_free_rate: float,
    periods_per_year: int = _TRADING_DAYS_PER_YEAR,
) -> float:
    """
    Compute annualized Sharpe Ratio.

    Sharpe = (Rp_annualized - Rf) / σp_annualized

    Args:
        returns: 1-D array of periodic (e.g. daily) simple or log returns.
        risk_free_rate: Annual risk-free rate as a decimal (e.g. 0.0525 = 5.25%).
        periods_per_year: Number of return periods per year (252 for daily).

    Returns:
        Annualized Sharpe Ratio. Returns NaN if insufficient data or zero volatility.

    Raises:
        ValueError: If returns array has fewer than MIN_OBSERVATIONS periods.
    """
    _validate_returns(returns)

    rf_per_period = risk_free_rate / periods_per_year
    excess_returns = returns - rf_per_period

    sigma = float(np.std(excess_returns, ddof=1))
    if sigma == 0.0:
        return float("nan")

    mean_excess = float(np.mean(excess_returns))
    # Annualize: multiply by sqrt(periods_per_year)
    return (mean_excess / sigma) * math.sqrt(periods_per_year)


def sortino_ratio(
    returns: npt.NDArray[np.float64],
    risk_free_rate: float,
    periods_per_year: int = _TRADING_DAYS_PER_YEAR,
    mar: float = 0.0,
) -> float:
    """
    Compute annualized Sortino Ratio.

    Sortino = (Rp_annualized - Rf) / σd_annualized
    where σd (downside deviation) uses only negative deviations below MAR.

    Args:
        returns: 1-D array of periodic returns.
        risk_free_rate: Annual risk-free rate as decimal.
        periods_per_year: Periods per year for annualization.
        mar: Minimum Acceptable Return per period (default 0.0).

    Returns:
        Annualized Sortino Ratio.
    """
    _validate_returns(returns)

    rf_per_period = risk_free_rate / periods_per_year
    annualized_return = float(np.mean(returns)) * periods_per_year
    downside_dev = _downside_deviation(returns, mar=mar, periods_per_year=periods_per_year)

    if downside_dev == 0.0:
        return float("nan")

    return (annualized_return - risk_free_rate) / downside_dev


def max_drawdown(equity_curve: npt.NDArray[np.float64]) -> float:
    """
    Compute Maximum Drawdown (MDD) from an equity curve.

    MDD = max of [(trough - peak) / peak] over all (peak, trough) pairs
    where trough follows peak chronologically.

    Args:
        equity_curve: 1-D array of portfolio values (prices or NAV), not returns.

    Returns:
        Maximum drawdown as a negative decimal (e.g. -0.35 = -35%).

    Raises:
        ValueError: If equity_curve is empty or all zeros.
    """
    if len(equity_curve) < 2:
        raise ValueError("equity_curve must have at least 2 data points")
    if np.any(equity_curve <= 0):
        raise ValueError("equity_curve values must be strictly positive")

    # Compute running maximum
    peak = np.maximum.accumulate(equity_curve)
    drawdown = (equity_curve - peak) / peak
    return float(np.min(drawdown))


def beta(
    portfolio_returns: npt.NDArray[np.float64],
    benchmark_returns: npt.NDArray[np.float64],
) -> float:
    """
    Compute portfolio Beta relative to a benchmark.

    β = Cov(Rp, Rm) / Var(Rm)

    Args:
        portfolio_returns: 1-D array of portfolio periodic returns.
        benchmark_returns: 1-D array of benchmark periodic returns.
                           Must be same length as portfolio_returns.

    Returns:
        Beta coefficient.

    Raises:
        ValueError: If arrays have different lengths or insufficient data.
    """
    _validate_returns(portfolio_returns)
    _validate_returns(benchmark_returns)
    if len(portfolio_returns) != len(benchmark_returns):
        raise ValueError(
            f"portfolio_returns length ({len(portfolio_returns)}) must equal "
            f"benchmark_returns length ({len(benchmark_returns)})"
        )

    benchmark_var = float(np.var(benchmark_returns, ddof=1))
    if benchmark_var == 0.0:
        return float("nan")

    covariance = float(np.cov(portfolio_returns, benchmark_returns, ddof=1)[0, 1])
    return covariance / benchmark_var


def alpha(
    portfolio_returns: npt.NDArray[np.float64],
    benchmark_returns: npt.NDArray[np.float64],
    risk_free_rate: float,
    periods_per_year: int = _TRADING_DAYS_PER_YEAR,
) -> float:
    """
    Compute Jensen's Alpha (annualized).

    α = Rp_annualized - [Rf + β * (Rm_annualized - Rf)]

    Args:
        portfolio_returns: 1-D array of periodic portfolio returns.
        benchmark_returns: 1-D array of periodic benchmark returns.
        risk_free_rate: Annual risk-free rate as decimal.
        periods_per_year: Periods per year.

    Returns:
        Jensen's Alpha, annualized.
    """
    beta_val = beta(portfolio_returns, benchmark_returns)
    rp_annualized = float(np.mean(portfolio_returns)) * periods_per_year
    rm_annualized = float(np.mean(benchmark_returns)) * periods_per_year
    return rp_annualized - (risk_free_rate + beta_val * (rm_annualized - risk_free_rate))


def cagr(
    equity_curve: npt.NDArray[np.float64],
    periods_per_year: int = _TRADING_DAYS_PER_YEAR,
) -> float:
    """
    Compute Compound Annual Growth Rate (CAGR).

    CAGR = (V_end / V_start) ^ (periods_per_year / n_periods) - 1

    Args:
        equity_curve: 1-D array of portfolio values (not returns).
        periods_per_year: Number of periods per year.

    Returns:
        CAGR as a decimal (e.g. 0.15 = 15% p.a.).
    """
    if len(equity_curve) < 2:
        raise ValueError("equity_curve must have at least 2 data points")
    if equity_curve[0] <= 0:
        raise ValueError("Initial portfolio value must be positive")

    n_periods = len(equity_curve) - 1
    years = n_periods / periods_per_year
    total_return = equity_curve[-1] / equity_curve[0]
    return float(total_return ** (1.0 / years)) - 1.0


def compute_all_metrics(
    portfolio_returns: npt.NDArray[np.float64],
    benchmark_returns: npt.NDArray[np.float64],
    equity_curve: npt.NDArray[np.float64],
    risk_free_rate: float,
    periods_per_year: int = _TRADING_DAYS_PER_YEAR,
) -> MetricsResult:
    """
    Compute the full set of portfolio metrics in one call.

    This is the primary entry point called by the FastAPI router and agent tools.

    Args:
        portfolio_returns: Daily returns of the portfolio.
        benchmark_returns: Daily returns of the benchmark (same length).
        equity_curve: Equity curve (cumulative portfolio value).
        risk_free_rate: Annual risk-free rate (decimal).
        periods_per_year: Trading periods per year.

    Returns:
        MetricsResult dataclass with all computed values.
    """
    _validate_returns(portfolio_returns)
    _validate_returns(benchmark_returns)

    sharpe = sharpe_ratio(portfolio_returns, risk_free_rate, periods_per_year)
    sortino = sortino_ratio(portfolio_returns, risk_free_rate, periods_per_year)
    mdd = max_drawdown(equity_curve)
    beta_val = beta(portfolio_returns, benchmark_returns)
    alpha_val = alpha(portfolio_returns, benchmark_returns, risk_free_rate, periods_per_year)
    cagr_val = cagr(equity_curve, periods_per_year)
    ann_return = float(np.mean(portfolio_returns)) * periods_per_year
    ann_vol = float(np.std(portfolio_returns, ddof=1)) * math.sqrt(periods_per_year)
    dd = _downside_deviation(portfolio_returns, periods_per_year=periods_per_year)
    total_ret = float((equity_curve[-1] / equity_curve[0]) - 1.0)

    return MetricsResult(
        sharpe_ratio=sharpe,
        sortino_ratio=sortino,
        max_drawdown=mdd,
        beta=beta_val,
        alpha=alpha_val,
        cagr=cagr_val,
        annualized_return=ann_return,
        annualized_volatility=ann_vol,
        downside_deviation=dd,
        total_return=total_ret,
        observations=len(portfolio_returns),
    )


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _validate_returns(returns: npt.NDArray[np.float64]) -> None:
    """Validate that the returns array is 1-D, numeric, and has sufficient data."""
    if not isinstance(returns, np.ndarray):
        raise TypeError(f"returns must be a numpy ndarray, got {type(returns).__name__}")
    if returns.ndim != 1:
        raise ValueError(f"returns must be 1-D, got shape {returns.shape}")
    if len(returns) < _MIN_OBSERVATIONS:
        raise ValueError(
            f"Insufficient observations: need ≥{_MIN_OBSERVATIONS}, got {len(returns)}"
        )
    if not np.issubdtype(returns.dtype, np.floating):
        raise ValueError(f"returns dtype must be float, got {returns.dtype}")
    if np.any(np.isnan(returns)) or np.any(np.isinf(returns)):
        raise ValueError("returns array contains NaN or Inf values")


def _downside_deviation(
    returns: npt.NDArray[np.float64],
    mar: float = 0.0,
    periods_per_year: int = _TRADING_DAYS_PER_YEAR,
) -> float:
    """
    Compute annualized downside deviation (semi-deviation below MAR).

    σd = sqrt(mean(min(Ri - MAR, 0)^2)) * sqrt(periods_per_year)
    """
    downside = np.minimum(returns - mar, 0.0)
    variance = float(np.mean(downside ** 2))
    return math.sqrt(variance) * math.sqrt(periods_per_year)
