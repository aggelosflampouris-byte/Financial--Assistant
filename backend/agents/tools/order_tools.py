"""
backend/agents/tools/order_tools.py
======================================
Paper trading order execution tool.

Simulates realistic trade fills with configurable:
  - Fill latency (PAPER_TRADING_LATENCY_MS)
  - Slippage (PAPER_TRADING_SLIPPAGE_BPS)
  - Market impact (simplified linear model)

In production: swap _execute_paper_trade() for an Alpaca/IBKR adapter
while keeping the ExecuteOrderInput → ExecutionStatus interface unchanged.

SECURITY: This tool is NEVER called without a valid confirmation_token.
The HITL gate in human_approval_node.py enforces this at the graph level.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import yfinance as yf

from backend.gateway.schemas.portfolio import ExecutionStatus, OrderSide, OrderStatus, OrderType
from backend.gateway.schemas.tools import ExecuteOrderInput

logger = logging.getLogger(__name__)

_LATENCY_MS: int = int(os.environ.get("PAPER_TRADING_LATENCY_MS", "50"))
_SLIPPAGE_BPS: float = float(os.environ.get("PAPER_TRADING_SLIPPAGE_BPS", "2"))

# In-memory paper portfolio (production: persisted in TimescaleDB)
_paper_portfolio: dict[str, Decimal] = {}
_paper_cash: Decimal = Decimal(os.environ.get("PAPER_TRADING_INITIAL_CASH", "100000"))


async def tool_execute_order(inputs: ExecuteOrderInput) -> ExecutionStatus:
    """
    Tool: Execute a paper trade order with realistic fill simulation.

    Validates the confirmation_token, fetches current market price,
    applies slippage, simulates latency, and returns ExecutionStatus.

    Args:
        inputs: Validated ExecuteOrderInput (must include confirmation_token ≥ 32 chars)

    Returns:
        ExecutionStatus with fill details.
    """
    global _paper_cash

    order_id = uuid.uuid4()
    submitted_at = datetime.now(timezone.utc).isoformat()

    # Validate confirmation token (HITL enforcement)
    if not inputs.confirmation_token or len(inputs.confirmation_token) < 32:
        logger.error(
            "execute_order BLOCKED: invalid confirmation_token | order_id=%s", order_id
        )
        return ExecutionStatus(
            order_id=order_id,
            portfolio_id=inputs.portfolio_id,
            asset=inputs.asset,
            side=inputs.side,
            order_type=inputs.order_type,
            requested_quantity=Decimal(str(inputs.amount)),
            status=OrderStatus.REJECTED,
            submitted_at=submitted_at,
            rejection_reason="Invalid or missing confirmation token",
        )

    # Fetch current market price
    try:
        ticker_data = yf.Ticker(inputs.asset)
        current_price = float(ticker_data.fast_info.last_price or 0)
        if current_price <= 0:
            raise ValueError(f"Invalid price: {current_price}")
    except Exception as exc:
        logger.error("Price fetch failed for %s: %s", inputs.asset, exc)
        return ExecutionStatus(
            order_id=order_id,
            portfolio_id=inputs.portfolio_id,
            asset=inputs.asset,
            side=inputs.side,
            order_type=inputs.order_type,
            requested_quantity=Decimal(str(inputs.amount)),
            status=OrderStatus.REJECTED,
            submitted_at=submitted_at,
            rejection_reason=f"Market data unavailable: {exc}",
        )

    # Apply slippage
    slippage_factor = (_SLIPPAGE_BPS / 10000.0)
    if inputs.side == OrderSide.BUY:
        fill_price = current_price * (1.0 + slippage_factor)
    else:
        fill_price = current_price * (1.0 - slippage_factor)

    # For LIMIT orders: check if limit price is executable
    if inputs.order_type == OrderType.LIMIT and inputs.limit_price:
        if inputs.side == OrderSide.BUY and fill_price > inputs.limit_price:
            return ExecutionStatus(
                order_id=order_id,
                portfolio_id=inputs.portfolio_id,
                asset=inputs.asset,
                side=inputs.side,
                order_type=inputs.order_type,
                requested_quantity=Decimal(str(inputs.amount)),
                status=OrderStatus.REJECTED,
                submitted_at=submitted_at,
                rejection_reason=f"Limit price {inputs.limit_price} below market {fill_price:.2f}",
            )

    # Simulate network/execution latency
    await asyncio.sleep(_LATENCY_MS / 1000.0)

    # Execute paper trade — update in-memory portfolio
    amount = Decimal(str(inputs.amount))
    fill_price_dec = Decimal(str(round(fill_price, 4)))
    trade_value = amount * fill_price_dec

    if inputs.side == OrderSide.BUY:
        if trade_value > _paper_cash:
            return ExecutionStatus(
                order_id=order_id,
                portfolio_id=inputs.portfolio_id,
                asset=inputs.asset,
                side=inputs.side,
                order_type=inputs.order_type,
                requested_quantity=amount,
                status=OrderStatus.REJECTED,
                submitted_at=submitted_at,
                rejection_reason=f"Insufficient cash: need ${trade_value:.2f}, have ${_paper_cash:.2f}",
            )
        _paper_portfolio[inputs.asset] = _paper_portfolio.get(inputs.asset, Decimal("0")) + amount
        _paper_cash -= trade_value
    else:  # SELL
        held = _paper_portfolio.get(inputs.asset, Decimal("0"))
        if held < amount:
            return ExecutionStatus(
                order_id=order_id,
                portfolio_id=inputs.portfolio_id,
                asset=inputs.asset,
                side=inputs.side,
                order_type=inputs.order_type,
                requested_quantity=amount,
                status=OrderStatus.REJECTED,
                submitted_at=submitted_at,
                rejection_reason=f"Insufficient position: hold {held}, selling {amount}",
            )
        _paper_portfolio[inputs.asset] = held - amount
        _paper_cash += trade_value

    filled_at = datetime.now(timezone.utc).isoformat()
    logger.info(
        "Paper trade filled | %s %s %s @ %.4f | cash_remaining=%.2f",
        inputs.side.value, inputs.amount, inputs.asset, fill_price, float(_paper_cash)
    )

    return ExecutionStatus(
        order_id=order_id,
        portfolio_id=inputs.portfolio_id,
        asset=inputs.asset,
        side=inputs.side,
        order_type=inputs.order_type,
        requested_quantity=amount,
        filled_quantity=amount,
        fill_price=fill_price_dec,
        status=OrderStatus.FILLED,
        submitted_at=submitted_at,
        filled_at=filled_at,
        slippage_bps=_SLIPPAGE_BPS,
    )
