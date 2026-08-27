"""
backend/quant/optimization.py
===============================
Portfolio optimization algorithms:
  1. Modern Portfolio Theory (MPT) — Mean-Variance Optimization & Efficient Frontier
  2. Black-Litterman model — Bayesian equilibrium with investor views

ARCHITECTURAL CONSTRAINT:
All computations use SciPy + NumPy. The LLM may request these computations
via tool calls but must never generate the numerical outputs itself.

References:
  - Markowitz, H. (1952). Portfolio Selection. Journal of Finance.
  - Black, F. & Litterman, R. (1992). Global Portfolio Optimization. FAJ.
  - He, G. & Litterman, R. (1999). The Intuition Behind Black-Litterman. Goldman Sachs.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np
import numpy.typing as npt
from scipy.optimize import LinearConstraint, minimize

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Type aliases
# ---------------------------------------------------------------------------

ReturnMatrix = npt.NDArray[np.float64]    # Shape: (n_periods, n_assets)
WeightVector = npt.NDArray[np.float64]    # Shape: (n_assets,)
CovMatrix = npt.NDArray[np.float64]       # Shape: (n_assets, n_assets)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TRADING_DAYS_PER_YEAR: int = 252
_RISK_AVERSION: float = 2.5       # Market risk aversion coefficient (δ) for Black-Litterman
_TAU: float = 0.05                 # Uncertainty scaling for Black-Litterman prior


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class EfficientPortfolio:
    """A single portfolio on the efficient frontier."""
    weights: WeightVector
    expected_return: float        # Annualized
    expected_volatility: float    # Annualized
    sharpe_ratio: float
    assets: tuple[str, ...]


@dataclass(frozen=True)
class FrontierResult:
    """Full efficient frontier computation result."""
    portfolios: list[EfficientPortfolio]
    min_variance_portfolio: EfficientPortfolio
    max_sharpe_portfolio: EfficientPortfolio
    assets: tuple[str, ...]
    n_assets: int
    risk_free_rate: float


@dataclass(frozen=True)
class BlackLittermanResult:
    """Result of the Black-Litterman optimization."""
    posterior_returns: npt.NDArray[np.float64]  # Blended expected returns
    posterior_covariance: CovMatrix              # Posterior covariance matrix
    optimal_weights: WeightVector               # Optimized portfolio weights
    expected_return: float                       # Annualized portfolio return
    expected_volatility: float                   # Annualized portfolio volatility
    sharpe_ratio: float
    assets: tuple[str, ...]
    tau: float
    risk_aversion: float


@dataclass(frozen=True)
class View:
    """Investor view for the Black-Litterman model."""
    asset: str
    expected_return: float    # Annualized absolute view (decimal)
    confidence: float         # [0, 1] — maps to view uncertainty


# ---------------------------------------------------------------------------
# Mean-Variance Optimization (MPT)
# ---------------------------------------------------------------------------

def efficient_frontier(
    returns_df: ReturnMatrix,
    assets: Sequence[str],
    risk_free_rate: float = 0.05,
    n_points: int = 100,
    weight_bounds: tuple[float, float] = (0.0, 1.0),
    constraints: Optional[dict[str, float]] = None,
) -> FrontierResult:
    """
    Compute the Mean-Variance Efficient Frontier via quadratic programming.

    Sweeps target returns from minimum to maximum, solving the constrained
    optimization min (w^T Σ w) s.t. w^T μ = target_return, sum(w) = 1.

    Args:
        returns_df: (n_periods × n_assets) matrix of periodic returns.
        assets: Asset names corresponding to columns of returns_df.
        risk_free_rate: Annual risk-free rate for Sharpe calculation.
        n_points: Number of points on the frontier.
        weight_bounds: (min, max) weight per asset. Default (0, 1) = long-only.
        constraints: Optional per-asset maximum weights {ticker: max_weight}.

    Returns:
        FrontierResult with all frontier portfolios plus key portfolios.
    """
    assets_tuple = tuple(assets)
    n_assets = len(assets_tuple)

    if returns_df.shape[1] != n_assets:
        raise ValueError(
            f"returns_df has {returns_df.shape[1]} columns, "
            f"but assets has {n_assets} elements"
        )

    # Annualized statistics
    mu = np.mean(returns_df, axis=0) * _TRADING_DAYS_PER_YEAR          # (n_assets,)
    sigma = np.cov(returns_df.T, ddof=1) * _TRADING_DAYS_PER_YEAR      # (n_assets, n_assets)

    logger.debug("Computing efficient frontier for %d assets, %d points", n_assets, n_points)

    # --- Constraints ---
    bounds = _build_bounds(n_assets, weight_bounds, constraints, assets_tuple)
    sum_to_one = {"type": "eq", "fun": lambda w: np.sum(w) - 1.0}

    # --- Target return range ---
    min_ret = float(np.min(mu))
    max_ret = float(np.max(mu))
    target_returns = np.linspace(min_ret, max_ret, n_points)

    portfolios: list[EfficientPortfolio] = []
    w0 = np.ones(n_assets) / n_assets  # Equal-weight starting point

    for target_ret in target_returns:
        return_constraint = {"type": "eq", "fun": lambda w, t=target_ret: w @ mu - t}
        result = minimize(
            fun=lambda w: _portfolio_variance(w, sigma),
            x0=w0,
            method="SLSQP",
            bounds=bounds,
            constraints=[sum_to_one, return_constraint],
            options={"ftol": 1e-12, "maxiter": 1000},
        )
        if not result.success:
            logger.debug("Frontier point skipped (target_ret=%.4f): %s", target_ret, result.message)
            continue

        w = result.x
        vol = math.sqrt(float(_portfolio_variance(w, sigma)))
        ret = float(w @ mu)
        sharpe = (ret - risk_free_rate) / vol if vol > 0 else float("nan")
        portfolios.append(EfficientPortfolio(
            weights=w,
            expected_return=ret,
            expected_volatility=vol,
            sharpe_ratio=sharpe,
            assets=assets_tuple,
        ))
        w0 = w  # Warm-start next iteration

    if not portfolios:
        raise RuntimeError("Efficient frontier computation produced no valid portfolios")

    # Key portfolios
    min_var = min(portfolios, key=lambda p: p.expected_volatility)
    max_sharpe = max(portfolios, key=lambda p: p.sharpe_ratio)

    return FrontierResult(
        portfolios=portfolios,
        min_variance_portfolio=min_var,
        max_sharpe_portfolio=max_sharpe,
        assets=assets_tuple,
        n_assets=n_assets,
        risk_free_rate=risk_free_rate,
    )


def mean_variance_optimize(
    returns_df: ReturnMatrix,
    assets: Sequence[str],
    target_risk: float,
    risk_free_rate: float = 0.05,
    weight_bounds: tuple[float, float] = (0.0, 1.0),
    constraints: Optional[dict[str, float]] = None,
) -> EfficientPortfolio:
    """
    Find the portfolio that maximizes Sharpe Ratio subject to a volatility constraint.

    Args:
        target_risk: Target annualized volatility (e.g. 0.15 = 15%).

    Returns:
        Optimal EfficientPortfolio at or below target_risk.
    """
    assets_tuple = tuple(assets)
    n_assets = len(assets_tuple)
    mu = np.mean(returns_df, axis=0) * _TRADING_DAYS_PER_YEAR
    sigma = np.cov(returns_df.T, ddof=1) * _TRADING_DAYS_PER_YEAR

    bounds = _build_bounds(n_assets, weight_bounds, constraints, assets_tuple)
    risk_constraint = {
        "type": "ineq",
        "fun": lambda w: target_risk**2 - _portfolio_variance(w, sigma),
    }
    sum_to_one = {"type": "eq", "fun": lambda w: np.sum(w) - 1.0}

    result = minimize(
        fun=lambda w: -_portfolio_sharpe(w, mu, sigma, risk_free_rate),
        x0=np.ones(n_assets) / n_assets,
        method="SLSQP",
        bounds=bounds,
        constraints=[sum_to_one, risk_constraint],
        options={"ftol": 1e-12, "maxiter": 2000},
    )

    if not result.success:
        raise RuntimeError(f"MPT optimization failed: {result.message}")

    w = result.x
    vol = math.sqrt(float(_portfolio_variance(w, sigma)))
    ret = float(w @ mu)
    sharpe = (ret - risk_free_rate) / vol if vol > 0 else float("nan")

    return EfficientPortfolio(
        weights=w,
        expected_return=ret,
        expected_volatility=vol,
        sharpe_ratio=sharpe,
        assets=assets_tuple,
    )


# ---------------------------------------------------------------------------
# Black-Litterman Model
# ---------------------------------------------------------------------------

def black_litterman(
    market_caps: npt.NDArray[np.float64],
    returns_df: ReturnMatrix,
    assets: Sequence[str],
    views: Sequence[View],
    risk_free_rate: float = 0.05,
    tau: float = _TAU,
    risk_aversion: float = _RISK_AVERSION,
    weight_bounds: tuple[float, float] = (0.0, 1.0),
) -> BlackLittermanResult:
    """
    Black-Litterman portfolio optimization.

    Steps:
      1. Compute market-cap implied equilibrium returns: π = δ · Σ · w_mkt
      2. Construct view matrix P and view vector q from investor views.
      3. Compute view uncertainty matrix Ω from confidence levels.
      4. Compute posterior (blended) return vector μ_BL.
      5. Optimize portfolio weights using posterior returns and covariance.

    Args:
        market_caps: Market capitalization weights for each asset (sums to 1).
        returns_df: (n_periods × n_assets) historical return matrix.
        assets: Asset names.
        views: List of investor views (absolute views supported).
        risk_free_rate: Annual risk-free rate.
        tau: Uncertainty in prior (typically 0.025–0.05).
        risk_aversion: Market risk aversion coefficient δ (typically 2–5).
        weight_bounds: Per-asset weight bounds.

    Returns:
        BlackLittermanResult with posterior returns, covariance, and optimal weights.
    """
    assets_tuple = tuple(assets)
    n_assets = len(assets_tuple)

    if len(market_caps) != n_assets:
        raise ValueError("market_caps length must equal number of assets")
    if returns_df.shape[1] != n_assets:
        raise ValueError("returns_df columns must match assets")

    # Normalize market cap weights
    w_mkt = np.array(market_caps, dtype=np.float64)
    w_mkt /= w_mkt.sum()

    # Annualized covariance
    sigma = np.cov(returns_df.T, ddof=1) * _TRADING_DAYS_PER_YEAR

    # Step 1: Equilibrium (implied) returns — reverse optimization
    pi = risk_aversion * sigma @ w_mkt  # (n_assets,)

    if not views:
        # No views: return market equilibrium portfolio
        logger.info("No Black-Litterman views provided — returning equilibrium portfolio")
        return _bl_no_views(pi, sigma, w_mkt, risk_free_rate, tau, risk_aversion, assets_tuple)

    # Step 2: Build view matrix P and view vector q
    k = len(views)
    P = np.zeros((k, n_assets), dtype=np.float64)
    q = np.zeros(k, dtype=np.float64)
    omega_diag = np.zeros(k, dtype=np.float64)

    asset_index = {name: i for i, name in enumerate(assets_tuple)}

    for i, view in enumerate(views):
        if view.asset not in asset_index:
            raise ValueError(f"View asset '{view.asset}' not in assets list")
        P[i, asset_index[view.asset]] = 1.0
        q[i] = view.expected_return
        # Ω: view uncertainty inversely proportional to confidence
        # High confidence (close to 1) → small variance → strong view
        # Using: Ω_ii = τ * (P_i · Σ · P_i^T) / confidence^2
        p_i = P[i]
        base_uncertainty = tau * float(p_i @ sigma @ p_i)
        omega_diag[i] = base_uncertainty / (view.confidence ** 2)

    omega = np.diag(omega_diag)  # (k × k) view uncertainty matrix

    # Step 3: Posterior (Black-Litterman) return vector
    # μ_BL = [(τΣ)^-1 + P^T Ω^-1 P]^-1 · [(τΣ)^-1 π + P^T Ω^-1 q]
    tau_sigma_inv = np.linalg.inv(tau * sigma)
    omega_inv = np.linalg.inv(omega)

    M1 = tau_sigma_inv + P.T @ omega_inv @ P      # (n × n)
    M2 = tau_sigma_inv @ pi + P.T @ omega_inv @ q  # (n,)
    mu_bl = np.linalg.solve(M1, M2)

    # Posterior covariance (BL formula)
    sigma_bl = sigma + np.linalg.inv(tau_sigma_inv + P.T @ omega_inv @ P)

    # Step 4: Optimize on posterior returns
    bounds = _build_bounds(n_assets, weight_bounds, None, assets_tuple)
    sum_to_one = {"type": "eq", "fun": lambda w: np.sum(w) - 1.0}

    result = minimize(
        fun=lambda w: -_portfolio_sharpe(w, mu_bl, sigma_bl, risk_free_rate),
        x0=w_mkt,  # Warm-start with market weights
        method="SLSQP",
        bounds=bounds,
        constraints=[sum_to_one],
        options={"ftol": 1e-12, "maxiter": 2000},
    )

    if not result.success:
        raise RuntimeError(f"Black-Litterman optimization failed: {result.message}")

    w_opt = result.x
    ret = float(w_opt @ mu_bl)
    vol = math.sqrt(float(_portfolio_variance(w_opt, sigma_bl)))
    sharpe = (ret - risk_free_rate) / vol if vol > 0 else float("nan")

    return BlackLittermanResult(
        posterior_returns=mu_bl,
        posterior_covariance=sigma_bl,
        optimal_weights=w_opt,
        expected_return=ret,
        expected_volatility=vol,
        sharpe_ratio=sharpe,
        assets=assets_tuple,
        tau=tau,
        risk_aversion=risk_aversion,
    )


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

import math  # Imported here to keep module-level imports at top (Python convention)


def _portfolio_variance(w: WeightVector, sigma: CovMatrix) -> float:
    """Compute portfolio variance: w^T Σ w."""
    return float(w @ sigma @ w)


def _portfolio_sharpe(
    w: WeightVector,
    mu: npt.NDArray[np.float64],
    sigma: CovMatrix,
    risk_free_rate: float,
) -> float:
    """Compute portfolio Sharpe Ratio (for maximization)."""
    ret = float(w @ mu)
    var = _portfolio_variance(w, sigma)
    if var <= 0:
        return float("-inf")
    return (ret - risk_free_rate) / math.sqrt(var)


def _build_bounds(
    n_assets: int,
    weight_bounds: tuple[float, float],
    constraints: Optional[dict[str, float]],
    assets: tuple[str, ...],
) -> list[tuple[float, float]]:
    """Build SciPy-compatible bounds list with optional per-asset caps."""
    lo, hi = weight_bounds
    bounds = [(lo, hi)] * n_assets
    if constraints:
        asset_index = {name: i for i, name in enumerate(assets)}
        for ticker, max_w in constraints.items():
            if ticker in asset_index:
                idx = asset_index[ticker]
                bounds[idx] = (lo, min(hi, max_w))
    return bounds


def _bl_no_views(
    pi: npt.NDArray[np.float64],
    sigma: CovMatrix,
    w_mkt: WeightVector,
    risk_free_rate: float,
    tau: float,
    risk_aversion: float,
    assets: tuple[str, ...],
) -> BlackLittermanResult:
    """Return equilibrium portfolio when no views are provided."""
    n_assets = len(assets)
    vol = math.sqrt(float(_portfolio_variance(w_mkt, sigma)))
    ret = float(w_mkt @ pi)
    sharpe = (ret - risk_free_rate) / vol if vol > 0 else float("nan")
    return BlackLittermanResult(
        posterior_returns=pi,
        posterior_covariance=sigma,
        optimal_weights=w_mkt,
        expected_return=ret,
        expected_volatility=vol,
        sharpe_ratio=sharpe,
        assets=assets,
        tau=tau,
        risk_aversion=risk_aversion,
    )
