"""
backend/agents/tools/portfolio_tools.py
=========================================
Portfolio-related tool executors — wraps the Quant Engine for use
as LangGraph-compatible tool functions.

These functions are the ONLY path through which portfolio metrics
reach the LLM. The LLM may request these tools but never generates
numerical values directly.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from backend.gateway.schemas.portfolio import (
    AllocationPlan,
    AllocationTarget,
    MetricsResponse,
    OptimizationModel,
    VaRResult,
    View,
)
from backend.gateway.schemas.tools import (
    GetPortfolioMetricsInput,
    RebalancePortfolioInput,
)
from backend.quant.metrics import compute_all_metrics
from backend.quant.optimization import (
    View as QuantView,
    black_litterman,
    mean_variance_optimize,
)
from backend.quant.risk import compute_var_suite

logger = logging.getLogger(__name__)

# Default demo portfolio holdings (replace with DB fetch in production)
_DEMO_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "META"]


async def tool_get_portfolio_metrics(
    inputs: GetPortfolioMetricsInput,
) -> MetricsResponse:
    """
    Tool: Compute all portfolio metrics via the Quant Engine.

    Fetches market data from yfinance, computes metrics deterministically,
    and returns a validated MetricsResponse.
    """
    from backend.gateway.routers.portfolio import _fetch_returns

    risk_free_rate = float(os.environ.get("RISK_FREE_RATE_ANNUAL", "0.0525"))
    tickers = _DEMO_TICKERS  # Production: fetch from DB by portfolio_id

    portfolio_returns, benchmark_returns, equity_curve = await _fetch_returns(
        tickers, inputs.benchmark, inputs.lookback_days
    )

    metrics = compute_all_metrics(
        portfolio_returns=portfolio_returns,
        benchmark_returns=benchmark_returns,
        equity_curve=equity_curve,
        risk_free_rate=risk_free_rate,
    )
    var_suite = compute_var_suite(portfolio_returns, float(equity_curve[-1]))
    benchmark_total_ret = float(np.prod(1.0 + benchmark_returns) - 1.0)

    from decimal import Decimal
    return MetricsResponse(
        portfolio_id=inputs.portfolio_id,
        benchmark=inputs.benchmark,
        calculated_at=datetime.now(timezone.utc).isoformat(),
        sharpe_ratio=metrics.sharpe_ratio,
        sortino_ratio=metrics.sortino_ratio,
        cagr=metrics.cagr,
        max_drawdown=metrics.max_drawdown,
        beta=metrics.beta,
        alpha=metrics.alpha,
        var_95=VaRResult(
            confidence=0.95,
            var_amount=var_suite["historical_95"].var_amount,
            var_pct=var_suite["historical_95"].var_pct,
            method="historical",
        ),
        var_99=VaRResult(
            confidence=0.99,
            var_amount=var_suite["historical_99"].var_amount,
            var_pct=var_suite["historical_99"].var_pct,
            method="historical",
        ),
        annualized_volatility=metrics.annualized_volatility,
        total_return=metrics.total_return,
        benchmark_return=benchmark_total_ret,
        risk_free_rate=risk_free_rate,
        analysis_period_days=metrics.observations,
    )


async def tool_rebalance_portfolio(
    inputs: RebalancePortfolioInput,
) -> AllocationPlan:
    """
    Tool: Compute optimal portfolio allocation (MPT or Black-Litterman).

    Returns an AllocationPlan — this is a PROPOSED plan only.
    Actual execution requires HITL confirmation via execute_order.
    """
    from backend.gateway.routers.portfolio import _fetch_multi_asset_returns

    tickers = _DEMO_TICKERS
    risk_free_rate = float(os.environ.get("RISK_FREE_RATE_ANNUAL", "0.0525"))

    multi_returns = _fetch_multi_asset_returns(tickers, 504)

    if inputs.model == OptimizationModel.BLACK_LITTERMAN:
        quant_views = [
            QuantView(
                asset=v.asset,
                expected_return=v.expected_return,
                confidence=v.confidence,
            )
            for v in (inputs.views or [])
        ]
        mkt_caps = np.ones(len(tickers)) / len(tickers)
        result = black_litterman(
            market_caps=mkt_caps,
            returns_df=multi_returns,
            assets=tickers,
            views=quant_views,
            risk_free_rate=risk_free_rate,
        )
        weights = result.optimal_weights
        exp_ret = result.expected_return
        exp_vol = result.expected_volatility
        exp_sharpe = result.sharpe_ratio
    else:
        result = mean_variance_optimize(
            returns_df=multi_returns,
            assets=tickers,
            target_risk=inputs.target_risk,
            risk_free_rate=risk_free_rate,
        )
        weights = result.weights
        exp_ret = result.expected_return
        exp_vol = result.expected_volatility
        exp_sharpe = result.sharpe_ratio

    # Equal current weights (production: fetch from DB)
    current_weights = np.ones(len(tickers)) / len(tickers)
    mean_returns = np.mean(multi_returns, axis=0) * 252
    vol_per_asset = np.std(multi_returns, axis=0, ddof=1) * np.sqrt(252)

    allocations = [
        AllocationTarget(
            asset=ticker,
            target_weight=float(w),
            current_weight=float(cw),
            delta_weight=float(w - cw),
            expected_return=float(mean_returns[i]),
            expected_volatility=float(vol_per_asset[i]),
        )
        for i, (ticker, w, cw) in enumerate(zip(tickers, weights, current_weights))
    ]

    trades_needed = sum(1 for a in allocations if abs(a.delta_weight) > 0.01)

    return AllocationPlan(
        portfolio_id=inputs.portfolio_id,
        optimization_model=inputs.model,
        target_risk=inputs.target_risk,
        allocations=allocations,
        expected_portfolio_return=exp_ret,
        expected_portfolio_volatility=exp_vol,
        expected_sharpe=exp_sharpe,
        requires_trades=trades_needed,
        estimated_transaction_cost_bps=trades_needed * 2.0,  # 2 bps per trade
    )
