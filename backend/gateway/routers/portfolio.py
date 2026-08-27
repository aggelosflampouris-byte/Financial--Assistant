"""
backend/gateway/routers/portfolio.py
======================================
Portfolio management API endpoints.

Endpoints:
  GET  /portfolio/{portfolio_id}/metrics   → Compute & return all risk metrics
  POST /portfolio/{portfolio_id}/rebalance → Generate rebalancing plan (requires HITL)
  GET  /portfolio/{portfolio_id}/holdings  → List current holdings
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Annotated, Optional

import numpy as np
import yfinance as yf
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status

from backend.gateway.middleware.audit import make_audit_task
from backend.gateway.middleware.auth import RequireAnalyst, RequireTrader, TokenPayload, get_current_user
from backend.gateway.schemas.compliance import (
    AdvisoryResponse,
    HITLConfirmationRequest,
    RiskWarningLevel,
)
from backend.gateway.schemas.portfolio import AllocationPlan, MetricsResponse, OptimizationModel, VaRResult, View
from backend.gateway.schemas.tools import RebalancePortfolioInput
from backend.quant.metrics import compute_all_metrics
from backend.quant.optimization import View as QuantView
from backend.quant.optimization import black_litterman, mean_variance_optimize
from backend.quant.risk import compute_var_suite

logger = logging.getLogger(__name__)
router = APIRouter()

_TRADING_DAYS_PER_YEAR: int = 252


# ---------------------------------------------------------------------------
# GET /portfolio/{portfolio_id}/metrics
# ---------------------------------------------------------------------------

@router.get(
    "/{portfolio_id}/metrics",
    response_model=MetricsResponse,
    summary="Compute portfolio risk & performance metrics",
    description=(
        "Fetches historical return data and computes Sharpe, Sortino, VaR (95% & 99%), "
        "MDD, Beta, Alpha, and CAGR. All computation is performed by the Quant Engine."
    ),
)
async def get_portfolio_metrics(
    portfolio_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    user: Annotated[TokenPayload, RequireAnalyst],
    benchmark: str = Query(default="SPY", min_length=1, max_length=20),
    lookback_days: int = Query(default=252, ge=30, le=1825),
    # TODO: replace with DB-fetched portfolio tickers in production
    tickers: str = Query(default="AAPL,MSFT,GOOGL,AMZN,META", description="Comma-separated tickers"),
) -> MetricsResponse:
    """
    Compute the full metrics suite for a portfolio.

    In production, `tickers` and `weights` would be fetched from the portfolio
    holdings stored in TimescaleDB. For this implementation, they are passed
    as query parameters for flexibility during development.
    """
    ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]

    try:
        portfolio_returns, benchmark_returns, equity_curve = await _fetch_returns(
            ticker_list, benchmark, lookback_days
        )
    except Exception as exc:
        logger.error("Failed to fetch market data: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Market data unavailable: {exc}",
        ) from exc

    import os
    risk_free_rate = float(os.environ.get("RISK_FREE_RATE_ANNUAL", "0.0525"))

    try:
        metrics = compute_all_metrics(
            portfolio_returns=portfolio_returns,
            benchmark_returns=benchmark_returns,
            equity_curve=equity_curve,
            risk_free_rate=risk_free_rate,
        )
        var_suite = compute_var_suite(
            returns=portfolio_returns,
            portfolio_value=float(equity_curve[-1]),
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Metrics computation failed: {exc}",
        ) from exc

    from decimal import Decimal
    response = MetricsResponse(
        portfolio_id=portfolio_id,
        benchmark=benchmark,
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
        benchmark_return=float(
            (np.prod(1.0 + benchmark_returns) - 1.0)
        ),
        risk_free_rate=risk_free_rate,
        analysis_period_days=metrics.observations,
    )

    # Fire-and-forget audit log
    background_tasks.add_task(
        make_audit_task(
            user_id=user.sub,
            session_id=str(portfolio_id),
            raw_input=f"GET /portfolio/{portfolio_id}/metrics?benchmark={benchmark}",
            intent_class="ANALYTICAL",
        )
    )

    return response


# ---------------------------------------------------------------------------
# POST /portfolio/{portfolio_id}/rebalance
# ---------------------------------------------------------------------------

@router.post(
    "/{portfolio_id}/rebalance",
    response_model=HITLConfirmationRequest,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Generate a rebalancing plan (requires HITL confirmation)",
    description=(
        "Computes an optimized allocation plan using MPT or Black-Litterman. "
        "Returns a HITL confirmation request — the plan is NOT executed until "
        "the user confirms via /advisor/confirm."
    ),
)
async def rebalance_portfolio(
    portfolio_id: uuid.UUID,
    request: RebalancePortfolioInput,
    background_tasks: BackgroundTasks,
    user: Annotated[TokenPayload, RequireTrader],
    tickers: str = Query(default="AAPL,MSFT,GOOGL,AMZN,META"),
) -> HITLConfirmationRequest:
    """
    Generate a portfolio rebalancing plan without executing it.
    The plan is staged as a HITL confirmation request.
    """
    ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]

    try:
        portfolio_returns, _, equity_curve = await _fetch_returns(ticker_list, "SPY", 504)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Market data unavailable: {exc}",
        ) from exc

    import os
    risk_free_rate = float(os.environ.get("RISK_FREE_RATE_ANNUAL", "0.0525"))

    try:
        if request.model == OptimizationModel.BLACK_LITTERMAN:
            quant_views = [
                QuantView(
                    asset=v.asset,
                    expected_return=v.expected_return,
                    confidence=v.confidence,
                )
                for v in (request.views or [])
            ]
            market_caps = np.ones(len(ticker_list)) / len(ticker_list)  # Equal mkt caps for demo
            bl_result = black_litterman(
                market_caps=market_caps,
                returns_df=portfolio_returns.reshape(-1, len(ticker_list))
                if portfolio_returns.ndim == 1
                else _fetch_multi_asset_returns(ticker_list, 504),
                assets=ticker_list,
                views=quant_views,
                risk_free_rate=risk_free_rate,
            )
            optimal_weights = bl_result.optimal_weights
            exp_return = bl_result.expected_return
            exp_vol = bl_result.expected_volatility
            exp_sharpe = bl_result.sharpe_ratio
        else:
            multi_returns = _fetch_multi_asset_returns(ticker_list, 504)
            mpt_result = mean_variance_optimize(
                returns_df=multi_returns,
                assets=ticker_list,
                target_risk=request.target_risk,
                risk_free_rate=risk_free_rate,
            )
            optimal_weights = mpt_result.weights
            exp_return = mpt_result.expected_return
            exp_vol = mpt_result.expected_volatility
            exp_sharpe = mpt_result.sharpe_ratio

    except (ValueError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Optimization failed: {exc}",
        ) from exc

    # Build action summary for HITL display
    action_id = uuid.uuid4()
    weight_summary = ", ".join(
        f"{t}: {w*100:.1f}%" for t, w in zip(ticker_list, optimal_weights)
    )
    action_summary = (
        f"Rebalance portfolio to {request.model.value} optimal allocation: {weight_summary}. "
        f"Expected return: {exp_return*100:.1f}%, volatility: {exp_vol*100:.1f}%, "
        f"Sharpe: {exp_sharpe:.2f}"
    )

    from datetime import timedelta
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()

    hitl_request = HITLConfirmationRequest(
        action_id=action_id,
        session_id=str(portfolio_id),
        action_type="rebalance_portfolio",
        action_summary=action_summary,
        action_payload={
            "portfolio_id": str(portfolio_id),
            "model": request.model.value,
            "target_risk": request.target_risk,
            "optimal_weights": {t: float(w) for t, w in zip(ticker_list, optimal_weights)},
            "expected_return": exp_return,
            "expected_volatility": exp_vol,
            "expected_sharpe": exp_sharpe,
        },
        risk_level=RiskWarningLevel.HIGH,
        expires_at=expires_at,
    )

    background_tasks.add_task(
        make_audit_task(
            user_id=user.sub,
            session_id=str(portfolio_id),
            raw_input=f"Rebalance {portfolio_id} via {request.model.value}",
            intent_class="TRANSACTIONAL",
            tool_payload=hitl_request.action_payload,
            is_transactional=True,
        )
    )

    return hitl_request


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

async def _fetch_returns(
    tickers: list[str],
    benchmark: str,
    lookback_days: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Fetch historical data via yfinance and compute daily returns.

    Returns:
        (portfolio_returns, benchmark_returns, equity_curve)
        portfolio_returns: Equal-weighted portfolio daily returns.
        benchmark_returns: Benchmark daily returns.
        equity_curve: Cumulative equity curve (starting at 100).
    """
    all_tickers = list(set(tickers + [benchmark]))
    period = f"{max(lookback_days // 252, 1)}y"

    data = yf.download(all_tickers, period=period, progress=False, auto_adjust=True)["Close"]
    if data.empty:
        raise ValueError("No price data returned from yfinance")

    data = data.dropna()
    pct_returns = data.pct_change().dropna()

    benchmark_returns = pct_returns[benchmark].to_numpy(dtype=np.float64)

    portfolio_cols = [t for t in tickers if t in pct_returns.columns]
    if not portfolio_cols:
        raise ValueError(f"None of the tickers {tickers} have available data")

    portfolio_returns = pct_returns[portfolio_cols].mean(axis=1).to_numpy(dtype=np.float64)
    equity_curve = 100.0 * np.cumprod(1.0 + portfolio_returns)

    return portfolio_returns, benchmark_returns, equity_curve


def _fetch_multi_asset_returns(
    tickers: list[str],
    lookback_days: int,
) -> np.ndarray:
    """Fetch per-asset returns matrix for optimization (n_periods × n_assets)."""
    period = f"{max(lookback_days // 252, 1)}y"
    data = yf.download(tickers, period=period, progress=False, auto_adjust=True)["Close"]
    data = data.dropna()
    returns = data.pct_change().dropna()
    available = [t for t in tickers if t in returns.columns]
    return returns[available].to_numpy(dtype=np.float64)
