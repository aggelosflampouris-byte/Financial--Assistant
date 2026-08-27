"""
backend/gateway/schemas/portfolio.py
=====================================
Pydantic v2 models for portfolio data, metrics responses, allocation plans,
and financial views. All monetary values use Decimal for precision.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from enum import Enum
from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------

class OptimizationModel(str, Enum):
    """Portfolio optimization model selection."""
    MPT = "MPT"
    BLACK_LITTERMAN = "BLACK_LITTERMAN"


class OrderSide(str, Enum):
    """Direction of a trade order."""
    BUY = "BUY"
    SELL = "SELL"


class OrderType(str, Enum):
    """Execution type for a trade order."""
    MARKET = "MARKET"
    LIMIT = "LIMIT"


class FilingType(str, Enum):
    """SEC filing document type."""
    TEN_K = "10-K"
    TEN_Q = "10-Q"


class OrderStatus(str, Enum):
    """Current state of an order lifecycle."""
    PENDING = "PENDING"
    FILLED = "FILLED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class IntentClass(str, Enum):
    """Classification of user request intent."""
    ADVISORY = "ADVISORY"
    ANALYTICAL = "ANALYTICAL"
    TRANSACTIONAL = "TRANSACTIONAL"
    GENERAL_QA = "GENERAL_QA"


# ---------------------------------------------------------------------------
# Portfolio primitives
# ---------------------------------------------------------------------------

class PortfolioHolding(BaseModel):
    """A single position within a portfolio."""

    model_config = ConfigDict(frozen=True)

    asset: Annotated[str, Field(
        min_length=1,
        max_length=20,
        description="Ticker symbol (e.g. AAPL, BTC-USD)"
    )]
    quantity: Annotated[Decimal, Field(
        gt=Decimal("0"),
        description="Number of units held (fractional shares supported)"
    )]
    avg_cost_basis: Annotated[Decimal, Field(
        ge=Decimal("0"),
        description="Average cost basis per unit in account currency"
    )]
    current_price: Annotated[Optional[Decimal], Field(
        default=None,
        ge=Decimal("0"),
        description="Latest market price per unit (populated at query time)"
    )]
    currency: Annotated[str, Field(
        default="USD",
        min_length=3,
        max_length=3,
        description="ISO 4217 currency code"
    )]

    @property
    def market_value(self) -> Optional[Decimal]:
        """Compute market value if current price is available."""
        if self.current_price is None:
            return None
        return self.quantity * self.current_price

    @property
    def unrealized_pnl(self) -> Optional[Decimal]:
        """Compute unrealized P&L if current price is available."""
        if self.current_price is None:
            return None
        return (self.current_price - self.avg_cost_basis) * self.quantity


class View(BaseModel):
    """
    A Black-Litterman investor view on a specific asset.

    Encodes the belief that `asset` will achieve `expected_return`
    with `confidence` certainty over the investment horizon.
    """

    model_config = ConfigDict(frozen=True)

    asset: Annotated[str, Field(min_length=1, max_length=20)]
    expected_return: Annotated[float, Field(
        ge=-1.0,
        le=10.0,
        description="Annualized expected return as a decimal (e.g. 0.12 = 12%)"
    )]
    confidence: Annotated[float, Field(
        gt=0.0,
        le=1.0,
        description="Confidence interval [0,1]. 1.0 = absolute certainty."
    )]

    @field_validator("confidence")
    @classmethod
    def validate_confidence_not_zero(cls, v: float) -> float:
        """Confidence of exactly 0 is invalid — use a small epsilon instead."""
        if v <= 0.0:
            raise ValueError("confidence must be strictly positive")
        return v


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class VaRResult(BaseModel):
    """Value at Risk calculation result at a specific confidence level."""

    model_config = ConfigDict(frozen=True)

    confidence: Annotated[float, Field(description="Confidence level (e.g. 0.95, 0.99)")]
    var_amount: Annotated[Decimal, Field(description="Maximum expected loss in portfolio currency")]
    var_pct: Annotated[float, Field(description="VaR as percentage of portfolio value")]
    method: Annotated[str, Field(description="'parametric' or 'historical'")]


class MetricsResponse(BaseModel):
    """
    Complete portfolio risk & performance metrics response.
    All numerical calculations are performed exclusively by the Quant Engine.
    """

    model_config = ConfigDict(frozen=True)

    portfolio_id: uuid.UUID
    benchmark: str
    calculated_at: str  # ISO 8601 timestamp string

    # --- Performance metrics ---
    sharpe_ratio: Annotated[float, Field(description="Risk-adjusted return vs risk-free rate")]
    sortino_ratio: Annotated[float, Field(description="Risk-adjusted return vs downside deviation")]
    cagr: Annotated[float, Field(description="Compound Annual Growth Rate as decimal")]
    max_drawdown: Annotated[float, Field(
        le=0.0,
        description="Maximum peak-to-trough loss as negative decimal (e.g. -0.25 = -25%)"
    )]
    beta: Annotated[float, Field(description="Portfolio beta relative to benchmark")]
    alpha: Annotated[float, Field(description="Portfolio alpha (annualized, decimal)")]

    # --- Risk metrics ---
    var_95: VaRResult
    var_99: VaRResult
    annualized_volatility: Annotated[float, Field(description="Portfolio standard deviation (annualized)")]

    # --- Return metrics ---
    total_return: Annotated[float, Field(description="Total return over analysis period as decimal")]
    benchmark_return: Annotated[float, Field(description="Benchmark total return over same period")]

    # --- Metadata ---
    risk_free_rate: Annotated[float, Field(description="Risk-free rate used in calculations")]
    analysis_period_days: int


class AllocationTarget(BaseModel):
    """A single asset's target allocation weight in an optimized portfolio."""

    model_config = ConfigDict(frozen=True)

    asset: str
    target_weight: Annotated[float, Field(ge=0.0, le=1.0)]
    current_weight: Annotated[float, Field(ge=0.0, le=1.0)]
    delta_weight: float  # positive = buy more, negative = sell
    expected_return: float
    expected_volatility: float


class AllocationPlan(BaseModel):
    """
    Result of portfolio optimization — a rebalancing plan.
    Must be confirmed by user (HITL) before execution.
    """

    model_config = ConfigDict(frozen=True)

    portfolio_id: uuid.UUID
    optimization_model: OptimizationModel
    target_risk: float
    allocations: list[AllocationTarget]
    expected_portfolio_return: float
    expected_portfolio_volatility: float
    expected_sharpe: float

    # Computed convenience fields
    requires_trades: int  # Number of assets requiring rebalancing trades
    estimated_transaction_cost_bps: float

    @model_validator(mode="after")
    def validate_weights_sum(self) -> "AllocationPlan":
        """Ensure target weights sum to approximately 1.0 (within floating-point tolerance)."""
        total = sum(a.target_weight for a in self.allocations)
        if abs(total - 1.0) > 1e-4:
            raise ValueError(f"Allocation weights sum to {total:.6f}, expected 1.0 ± 0.0001")
        return self


class ExecutionStatus(BaseModel):
    """Result of a paper-trade or live order execution."""

    model_config = ConfigDict(frozen=True)

    order_id: uuid.UUID
    portfolio_id: uuid.UUID
    asset: str
    side: OrderSide
    order_type: OrderType
    requested_quantity: Decimal
    filled_quantity: Optional[Decimal] = None
    fill_price: Optional[Decimal] = None
    status: OrderStatus
    submitted_at: str   # ISO 8601
    filled_at: Optional[str] = None
    commission: Decimal = Decimal("0")
    slippage_bps: Optional[float] = None
    rejection_reason: Optional[str] = None
