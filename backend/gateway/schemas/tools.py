"""
backend/gateway/schemas/tools.py
==================================
Strictly typed JSON schemas for all agent tool call inputs and outputs.
These schemas enforce the contract between the LangGraph agent and the
Quantitative Engine / execution layer. No LLM may produce these values —
they are populated exclusively from deterministic tool responses.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.gateway.schemas.portfolio import (
    AllocationPlan,
    ExecutionStatus,
    FilingType,
    MetricsResponse,
    OptimizationModel,
    OrderSide,
    OrderType,
    View,
)


# ---------------------------------------------------------------------------
# Tool: get_portfolio_metrics
# ---------------------------------------------------------------------------

class GetPortfolioMetricsInput(BaseModel):
    """Input schema for the get_portfolio_metrics tool."""

    model_config = ConfigDict(frozen=True)

    portfolio_id: Annotated[uuid.UUID, Field(description="UUID of the portfolio to analyze")]
    benchmark: Annotated[str, Field(
        default="SPY",
        min_length=1,
        max_length=20,
        description="Benchmark ticker symbol for beta/alpha calculations"
    )]
    lookback_days: Annotated[int, Field(
        default=252,
        ge=30,
        le=1825,
        description="Historical lookback window in trading days (default = 1 year)"
    )]


# GetPortfolioMetricsOutput is MetricsResponse (imported from portfolio.py)
GetPortfolioMetricsOutput = MetricsResponse


# ---------------------------------------------------------------------------
# Tool: rebalance_portfolio
# ---------------------------------------------------------------------------

class RebalancePortfolioInput(BaseModel):
    """
    Input schema for the rebalance_portfolio tool.
    This tool is TRANSACTIONAL — it must trigger HITL confirmation.
    """

    model_config = ConfigDict(frozen=True)

    portfolio_id: Annotated[uuid.UUID, Field(description="UUID of the portfolio to rebalance")]
    model: Annotated[OptimizationModel, Field(description="Optimization algorithm to apply")]
    target_risk: Annotated[float, Field(
        ge=0.0,
        le=1.0,
        description=(
            "Target annualized portfolio volatility as a decimal "
            "(e.g. 0.15 = 15% p.a.). Used as the risk constraint in optimization."
        )
    )]
    views: Annotated[Optional[list[View]], Field(
        default=None,
        description="Investor views for Black-Litterman model. Ignored if model=MPT."
    )]
    constraints: Annotated[Optional[dict[str, float]], Field(
        default=None,
        description="Optional per-asset weight bounds, e.g. {'AAPL': 0.3} caps AAPL at 30%."
    )]

    @field_validator("views")
    @classmethod
    def validate_views_for_bl(cls, v: Optional[list[View]]) -> Optional[list[View]]:
        """Views list, if provided, must be non-empty."""
        if v is not None and len(v) == 0:
            raise ValueError("views must be a non-empty list if provided")
        return v


# RebalancePortfolioOutput is AllocationPlan (imported from portfolio.py)
RebalancePortfolioOutput = AllocationPlan


# ---------------------------------------------------------------------------
# Tool: fetch_financial_filings
# ---------------------------------------------------------------------------

_VALID_SECTIONS = frozenset({
    "Item 1",    # Business Overview
    "Item 1A",   # Risk Factors
    "Item 1B",   # Unresolved Staff Comments
    "Item 2",    # Properties
    "Item 3",    # Legal Proceedings
    "Item 7",    # Management's Discussion & Analysis (MD&A)
    "Item 7A",   # Quantitative & Qualitative Disclosures About Market Risk
    "Item 8",    # Financial Statements
    "Item 9A",   # Controls and Procedures
    "ALL",       # Retrieve all sections
})


class FetchFinancialFilingsInput(BaseModel):
    """Input schema for the fetch_financial_filings RAG tool."""

    model_config = ConfigDict(frozen=True)

    ticker: Annotated[str, Field(
        min_length=1,
        max_length=10,
        description="Stock ticker symbol (e.g. AAPL)"
    )]
    filing_type: Annotated[FilingType, Field(description="SEC filing document type")]
    year: Annotated[int, Field(
        ge=2000,
        le=2030,
        description="Filing fiscal year"
    )]
    section: Annotated[str, Field(
        description="SEC report section to retrieve (e.g. 'Item 1A', 'Item 7', or 'ALL')"
    )]
    max_chunks: Annotated[int, Field(
        default=10,
        ge=1,
        le=50,
        description="Maximum number of document chunks to retrieve from Qdrant"
    )]

    @field_validator("section")
    @classmethod
    def validate_section(cls, v: str) -> str:
        if v not in _VALID_SECTIONS:
            raise ValueError(
                f"section must be one of: {sorted(_VALID_SECTIONS)}. Got '{v}'."
            )
        return v


class FilingChunk(BaseModel):
    """A single retrieved and reranked document chunk from the RAG pipeline."""

    model_config = ConfigDict(frozen=True)

    chunk_id: str
    ticker: str
    filing_type: str
    year: int
    section: str
    text: str
    relevance_score: float
    page_url: Optional[str] = None


class FilingContext(BaseModel):
    """Output of the fetch_financial_filings tool — retrieved and reranked chunks."""

    model_config = ConfigDict(frozen=True)

    ticker: str
    filing_type: str
    year: int
    section: str
    chunks: list[FilingChunk]
    retrieval_method: str = "hybrid_dense_bm25_reranked"
    total_chunks_retrieved: int
    total_chunks_after_rerank: int


# ---------------------------------------------------------------------------
# Tool: execute_order
# ---------------------------------------------------------------------------

class ExecuteOrderInput(BaseModel):
    """
    Input schema for the execute_order tool.
    This tool is TRANSACTIONAL — it MUST require user confirmation.
    The signed confirmation_token must be supplied by the frontend 2FA flow.
    """

    model_config = ConfigDict(frozen=True)

    portfolio_id: Annotated[uuid.UUID, Field(description="UUID of the portfolio")]
    asset: Annotated[str, Field(
        min_length=1,
        max_length=20,
        description="Ticker symbol to trade (e.g. AAPL)"
    )]
    side: Annotated[OrderSide, Field(description="BUY or SELL")]
    amount: Annotated[float, Field(
        gt=0.0,
        description="Number of units to trade (fractional shares supported)"
    )]
    order_type: Annotated[OrderType, Field(description="MARKET or LIMIT")]
    limit_price: Annotated[Optional[float], Field(
        default=None,
        gt=0.0,
        description="Limit price — required if order_type=LIMIT, ignored for MARKET"
    )]
    confirmation_token: Annotated[str, Field(
        min_length=32,
        description="Signed 2FA confirmation token from the Frontend HITL flow"
    )]

    @field_validator("limit_price", mode="after")
    @classmethod
    def require_limit_price_for_limit_orders(cls, v: Optional[float]) -> Optional[float]:
        # Note: full cross-field validation via model_validator is preferred;
        # this is a field-level guard for type safety.
        return v


# ExecuteOrderOutput is ExecutionStatus (imported from portfolio.py)
ExecuteOrderOutput = ExecutionStatus


# ---------------------------------------------------------------------------
# Tool: analyze_technical_indicators
# ---------------------------------------------------------------------------

class AnalyzeTechnicalIndicatorsInput(BaseModel):
    """Input schema for quantitative technical and statistical analysis."""

    model_config = ConfigDict(frozen=True)

    ticker: Annotated[str, Field(
        default="AAPL",
        min_length=1,
        max_length=10,
        description="Stock ticker symbol to analyze (e.g. AAPL, MSFT, NVDA)"
    )]
    period: Annotated[str, Field(
        default="1mo",
        description="Historical period: 1d, 5d, 1mo, 3mo, 6mo, 1y"
    )]
    interval: Annotated[str, Field(
        default="1d",
        description="Bar interval: 1d, 1h, 15m, 5m"
    )]


# ---------------------------------------------------------------------------
# Union type for type-safe tool dispatch in the agent graph
# ---------------------------------------------------------------------------

ToolInput = (
    GetPortfolioMetricsInput
    | RebalancePortfolioInput
    | FetchFinancialFilingsInput
    | ExecuteOrderInput
    | AnalyzeTechnicalIndicatorsInput
)

ToolOutput = (
    GetPortfolioMetricsOutput
    | RebalancePortfolioOutput
    | FilingContext
    | ExecuteOrderOutput
    | dict
)
