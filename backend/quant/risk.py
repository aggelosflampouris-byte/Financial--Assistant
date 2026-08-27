"""
backend/quant/risk.py
======================
Value at Risk (VaR) implementations using two methods:
  1. Parametric VaR  (Variance-Covariance, assumes normal distribution)
  2. Historical VaR  (Non-parametric, uses empirical return distribution)

Both methods support 95% and 99% confidence levels and return structured
VaRResult objects compatible with MetricsResponse.

References:
  - J.P. Morgan RiskMetrics Technical Document (1996)
  - Hull, J.C. (2018). Risk Management and Financial Institutions, 5th Ed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal

import numpy as np
import numpy.typing as npt
from scipy import stats


# ---------------------------------------------------------------------------
# Supported confidence levels
# ---------------------------------------------------------------------------

SUPPORTED_CONFIDENCE_LEVELS: frozenset[float] = frozenset({0.90, 0.95, 0.99})

_Z_SCORES: dict[float, float] = {
    0.90: 1.281551566,
    0.95: 1.644853627,
    0.99: 2.326347874,
}


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class VaRResult:
    """Value at Risk computation result."""
    confidence: float           # e.g. 0.95
    var_amount: Decimal         # Maximum expected loss in portfolio currency
    var_pct: float              # VaR as fraction of portfolio value
    method: str                 # 'parametric' or 'historical'
    portfolio_value: Decimal    # Portfolio value used in calculation
    mean_return: float          # Mean daily return of the return series
    volatility: float           # Daily standard deviation


# ---------------------------------------------------------------------------
# Parametric VaR (Variance-Covariance method)
# ---------------------------------------------------------------------------

def parametric_var(
    returns: npt.NDArray[np.float64],
    confidence: float,
    portfolio_value: float,
    horizon_days: int = 1,
) -> VaRResult:
    """
    Compute Parametric (Variance-Covariance) Value at Risk.

    Assumes portfolio returns are normally distributed.
    VaR = -[μ - z_α * σ] * √horizon * portfolio_value

    Args:
        returns: 1-D array of daily percentage returns (as decimals).
        confidence: Confidence level. Must be in {0.90, 0.95, 0.99}.
        portfolio_value: Current total portfolio value in account currency.
        horizon_days: VaR time horizon in trading days (default 1-day VaR).

    Returns:
        VaRResult with var_amount expressed as a positive loss figure.

    Raises:
        ValueError: If confidence level is not supported or data is insufficient.
    """
    _validate_var_inputs(returns, confidence, portfolio_value)

    z = _Z_SCORES[confidence]
    mu = float(np.mean(returns))
    sigma = float(np.std(returns, ddof=1))

    # Scale to horizon using square-root-of-time rule
    horizon_sigma = sigma * math.sqrt(horizon_days)
    horizon_mu = mu * horizon_days

    # VaR at confidence level (expressed as positive loss amount)
    var_pct = abs(horizon_mu - z * horizon_sigma)
    var_amount = Decimal(str(var_pct * portfolio_value))

    return VaRResult(
        confidence=confidence,
        var_amount=var_amount,
        var_pct=var_pct,
        method="parametric",
        portfolio_value=Decimal(str(portfolio_value)),
        mean_return=mu,
        volatility=sigma,
    )


def conditional_var(
    returns: npt.NDArray[np.float64],
    confidence: float,
    portfolio_value: float,
) -> VaRResult:
    """
    Compute Conditional VaR (CVaR / Expected Shortfall) — Parametric.

    CVaR = -μ + σ * φ(z_α) / (1 - α)
    where φ is the standard normal PDF.

    This represents the expected loss *beyond* the VaR threshold.
    """
    _validate_var_inputs(returns, confidence, portfolio_value)

    z = _Z_SCORES[confidence]
    mu = float(np.mean(returns))
    sigma = float(np.std(returns, ddof=1))

    # Expected Shortfall formula for normal distribution
    phi_z = float(stats.norm.pdf(z))
    cvar_pct = abs(-mu + sigma * phi_z / (1.0 - confidence))
    cvar_amount = Decimal(str(cvar_pct * portfolio_value))

    return VaRResult(
        confidence=confidence,
        var_amount=cvar_amount,
        var_pct=cvar_pct,
        method="parametric_cvar",
        portfolio_value=Decimal(str(portfolio_value)),
        mean_return=mu,
        volatility=sigma,
    )


# ---------------------------------------------------------------------------
# Historical VaR (Non-parametric)
# ---------------------------------------------------------------------------

def historical_var(
    returns: npt.NDArray[np.float64],
    confidence: float,
    portfolio_value: float,
    horizon_days: int = 1,
) -> VaRResult:
    """
    Compute Historical Simulation Value at Risk.

    Uses the empirical return distribution — no distributional assumptions.
    VaR = -percentile(returns, 1 - confidence) * portfolio_value

    Args:
        returns: 1-D array of daily percentage returns (as decimals).
        confidence: Confidence level. Must be in {0.90, 0.95, 0.99}.
        portfolio_value: Current total portfolio value in account currency.
        horizon_days: VaR horizon. For multi-day, applies square-root scaling.

    Returns:
        VaRResult with var_amount as a positive loss figure.
    """
    _validate_var_inputs(returns, confidence, portfolio_value)

    percentile = (1.0 - confidence) * 100.0
    threshold_return = float(np.percentile(returns, percentile))

    # Scale to horizon using square-root-of-time rule
    mu = float(np.mean(returns))
    sigma = float(np.std(returns, ddof=1))
    scaled_threshold = threshold_return * math.sqrt(horizon_days)

    var_pct = abs(scaled_threshold)
    var_amount = Decimal(str(var_pct * portfolio_value))

    return VaRResult(
        confidence=confidence,
        var_amount=var_amount,
        var_pct=var_pct,
        method="historical",
        portfolio_value=Decimal(str(portfolio_value)),
        mean_return=mu,
        volatility=sigma,
    )


def compute_var_suite(
    returns: npt.NDArray[np.float64],
    portfolio_value: float,
) -> dict[str, VaRResult]:
    """
    Compute the full VaR suite: parametric and historical at 95% and 99%.

    This is the primary entry point called by the portfolio metrics endpoint.

    Returns:
        dict with keys: 'parametric_95', 'parametric_99', 'historical_95', 'historical_99'
    """
    return {
        "parametric_95": parametric_var(returns, 0.95, portfolio_value),
        "parametric_99": parametric_var(returns, 0.99, portfolio_value),
        "historical_95": historical_var(returns, 0.95, portfolio_value),
        "historical_99": historical_var(returns, 0.99, portfolio_value),
    }


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

def _validate_var_inputs(
    returns: npt.NDArray[np.float64],
    confidence: float,
    portfolio_value: float,
) -> None:
    """Validate VaR computation inputs."""
    if not isinstance(returns, np.ndarray) or returns.ndim != 1:
        raise TypeError("returns must be a 1-D numpy ndarray")
    if len(returns) < 30:
        raise ValueError(f"Need ≥30 observations for VaR, got {len(returns)}")
    if confidence not in SUPPORTED_CONFIDENCE_LEVELS:
        raise ValueError(
            f"confidence must be one of {sorted(SUPPORTED_CONFIDENCE_LEVELS)}, "
            f"got {confidence}"
        )
    if portfolio_value <= 0:
        raise ValueError(f"portfolio_value must be positive, got {portfolio_value}")
    if np.any(np.isnan(returns)) or np.any(np.isinf(returns)):
        raise ValueError("returns contains NaN or Inf values")
