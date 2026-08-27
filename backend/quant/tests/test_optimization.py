"""
backend/quant/tests/test_optimization.py
==========================================
Unit tests for MPT and Black-Litterman portfolio optimization.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.quant.optimization import (
    BlackLittermanResult,
    EfficientPortfolio,
    FrontierResult,
    View,
    black_litterman,
    efficient_frontier,
    mean_variance_optimize,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

N_PERIODS = 504  # 2 years of daily data
N_ASSETS = 5
ASSET_NAMES = ["AAPL", "MSFT", "GOOGL", "AMZN", "META"]


@pytest.fixture()
def returns_matrix() -> np.ndarray:
    """
    Synthetic 5-asset return matrix with known correlation structure.
    Assets have different mean returns and volatilities.
    """
    rng = np.random.default_rng(seed=42)
    means = np.array([0.001, 0.0008, 0.0006, 0.0009, 0.0007])
    vols = np.array([0.015, 0.013, 0.012, 0.016, 0.014])
    # Correlated returns via Cholesky decomposition
    corr = np.array([
        [1.00, 0.65, 0.60, 0.55, 0.70],
        [0.65, 1.00, 0.70, 0.60, 0.65],
        [0.60, 0.70, 1.00, 0.65, 0.62],
        [0.55, 0.60, 0.65, 1.00, 0.58],
        [0.70, 0.65, 0.62, 0.58, 1.00],
    ])
    cov = np.diag(vols) @ corr @ np.diag(vols)
    L = np.linalg.cholesky(cov)
    z = rng.standard_normal((N_PERIODS, N_ASSETS))
    return (z @ L.T + means).astype(np.float64)


@pytest.fixture()
def market_caps() -> np.ndarray:
    """Approximate market cap weights (sum to 1)."""
    caps = np.array([3.0, 2.8, 1.8, 1.6, 1.2])  # Trillion USD
    return (caps / caps.sum()).astype(np.float64)


# ---------------------------------------------------------------------------
# Efficient Frontier Tests
# ---------------------------------------------------------------------------

class TestEfficientFrontier:
    def test_returns_frontier_result(self, returns_matrix: np.ndarray) -> None:
        result = efficient_frontier(returns_matrix, ASSET_NAMES, n_points=20)
        assert isinstance(result, FrontierResult)
        assert len(result.portfolios) > 0
        assert result.n_assets == N_ASSETS

    def test_weights_sum_to_one(self, returns_matrix: np.ndarray) -> None:
        result = efficient_frontier(returns_matrix, ASSET_NAMES, n_points=20)
        for p in result.portfolios:
            total = float(np.sum(p.weights))
            assert abs(total - 1.0) < 1e-4, f"Weights sum to {total}, expected 1.0"

    def test_weights_non_negative_long_only(self, returns_matrix: np.ndarray) -> None:
        """Default long-only constraint: all weights ≥ 0."""
        result = efficient_frontier(returns_matrix, ASSET_NAMES, n_points=20)
        for p in result.portfolios:
            assert np.all(p.weights >= -1e-8), "Negative weights found in long-only portfolio"

    def test_min_variance_has_lowest_volatility(self, returns_matrix: np.ndarray) -> None:
        result = efficient_frontier(returns_matrix, ASSET_NAMES, n_points=30)
        min_vol = min(p.expected_volatility for p in result.portfolios)
        assert abs(result.min_variance_portfolio.expected_volatility - min_vol) < 1e-4

    def test_max_sharpe_has_highest_sharpe(self, returns_matrix: np.ndarray) -> None:
        result = efficient_frontier(returns_matrix, ASSET_NAMES, n_points=30)
        max_sharpe = max(
            p.sharpe_ratio for p in result.portfolios if not math.isnan(p.sharpe_ratio)
        )
        assert abs(result.max_sharpe_portfolio.sharpe_ratio - max_sharpe) < 1e-4

    def test_mismatched_assets_raises(self, returns_matrix: np.ndarray) -> None:
        with pytest.raises(ValueError, match="columns"):
            efficient_frontier(returns_matrix, ["AAPL", "MSFT"])  # Wrong number of assets

    def test_per_asset_constraints_respected(self, returns_matrix: np.ndarray) -> None:
        """Max 30% in any single asset."""
        constraints = {name: 0.30 for name in ASSET_NAMES}
        result = efficient_frontier(
            returns_matrix, ASSET_NAMES, n_points=20, constraints=constraints
        )
        for p in result.portfolios:
            assert np.all(p.weights <= 0.30 + 1e-6), "Weight constraint violated"


# ---------------------------------------------------------------------------
# mean_variance_optimize Tests
# ---------------------------------------------------------------------------

class TestMeanVarianceOptimize:
    def test_volatility_at_or_below_target(self, returns_matrix: np.ndarray) -> None:
        target_risk = 0.18  # 18% annualized
        result = mean_variance_optimize(returns_matrix, ASSET_NAMES, target_risk=target_risk)
        assert result.expected_volatility <= target_risk + 1e-4

    def test_weights_valid(self, returns_matrix: np.ndarray) -> None:
        result = mean_variance_optimize(returns_matrix, ASSET_NAMES, target_risk=0.20)
        assert abs(np.sum(result.weights) - 1.0) < 1e-4
        assert np.all(result.weights >= -1e-8)

    def test_returns_efficient_portfolio(self, returns_matrix: np.ndarray) -> None:
        result = mean_variance_optimize(returns_matrix, ASSET_NAMES, target_risk=0.20)
        assert isinstance(result, EfficientPortfolio)
        assert result.assets == tuple(ASSET_NAMES)


# ---------------------------------------------------------------------------
# Black-Litterman Tests
# ---------------------------------------------------------------------------

class TestBlackLitterman:
    def test_no_views_returns_market_portfolio(
        self, returns_matrix: np.ndarray, market_caps: np.ndarray
    ) -> None:
        """With no views, BL should return weights close to market weights."""
        result = black_litterman(
            market_caps=market_caps,
            returns_df=returns_matrix,
            assets=ASSET_NAMES,
            views=[],
        )
        assert isinstance(result, BlackLittermanResult)
        assert np.allclose(result.optimal_weights, market_caps, atol=1e-4)

    def test_with_views_deviates_from_market(
        self, returns_matrix: np.ndarray, market_caps: np.ndarray
    ) -> None:
        """Strong bullish view on AAPL should increase AAPL weight above market weight."""
        views = [View(asset="AAPL", expected_return=0.35, confidence=0.90)]
        result = black_litterman(
            market_caps=market_caps,
            returns_df=returns_matrix,
            assets=ASSET_NAMES,
            views=views,
        )
        aapl_mkt_weight = float(market_caps[0])
        aapl_opt_weight = float(result.optimal_weights[0])
        assert aapl_opt_weight > aapl_mkt_weight - 0.05, (
            f"AAPL weight {aapl_opt_weight:.4f} not higher than market {aapl_mkt_weight:.4f}"
        )

    def test_weights_sum_to_one(
        self, returns_matrix: np.ndarray, market_caps: np.ndarray
    ) -> None:
        views = [
            View(asset="AAPL", expected_return=0.20, confidence=0.80),
            View(asset="MSFT", expected_return=0.15, confidence=0.70),
        ]
        result = black_litterman(
            market_caps=market_caps, returns_df=returns_matrix,
            assets=ASSET_NAMES, views=views,
        )
        total = float(np.sum(result.optimal_weights))
        assert abs(total - 1.0) < 1e-4

    def test_invalid_view_asset_raises(
        self, returns_matrix: np.ndarray, market_caps: np.ndarray
    ) -> None:
        views = [View(asset="UNKNOWN_TICKER", expected_return=0.20, confidence=0.80)]
        with pytest.raises(ValueError, match="not in assets list"):
            black_litterman(
                market_caps=market_caps, returns_df=returns_matrix,
                assets=ASSET_NAMES, views=views,
            )

    def test_high_confidence_view_strongly_tilts(
        self, returns_matrix: np.ndarray, market_caps: np.ndarray
    ) -> None:
        """Near-certain view (confidence=0.99) should produce large weight tilt."""
        low_conf = [View(asset="AAPL", expected_return=0.40, confidence=0.20)]
        high_conf = [View(asset="AAPL", expected_return=0.40, confidence=0.99)]
        r_low = black_litterman(market_caps, returns_matrix, ASSET_NAMES, low_conf)
        r_high = black_litterman(market_caps, returns_matrix, ASSET_NAMES, high_conf)
        # Higher confidence should produce larger AAPL allocation
        assert r_high.optimal_weights[0] >= r_low.optimal_weights[0] - 0.01
