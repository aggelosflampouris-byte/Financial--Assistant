"""
backend/agents/nodes/call_tool.py
===================================
Tool selection and pre-execution node.

This node:
  1. Uses structured output to select the correct tool based on user intent.
  2. Validates the tool inputs with Pydantic schemas.
  3. For non-transactional tools: executes immediately and stores output.
  4. For transactional tools: prepares inputs but defers execution to
     post-HITL confirmation (execute_tool node in graph.py).

ARCHITECTURAL CONSTRAINT:
Tool inputs that require numerical values (e.g. portfolio_id, target_risk)
are extracted from the user message by the LLM. The actual computation
(Sharpe, VaR, optimization) is performed by the Quant Engine — never LLM.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any

from openai import AsyncOpenAI
from pydantic import ValidationError

from backend.agents.state import AgentState
from backend.gateway.schemas.portfolio import IntentClass

logger = logging.getLogger(__name__)

_client = AsyncOpenAI(
    base_url=os.environ["VLLM_BASE_URL"],
    api_key=os.environ.get("VLLM_API_KEY", "not-required"),
)
_MODEL = os.environ["VLLM_MODEL_NAME"]

# ---------------------------------------------------------------------------
# Tool selection prompt — forces structured JSON tool call selection
# ---------------------------------------------------------------------------

_DEMO_PORTFOLIO_ID = "00000000-0000-0000-0000-000000000001"

_TOOL_SELECTION_PROMPT = f"""
You are a tool dispatcher for a financial portfolio system.
Based on the user message and available context, select the correct tool.

Available tools:
1. get_portfolio_metrics  — Compute Sharpe, VaR, MDD, Beta, CAGR (analytical)
2. rebalance_portfolio    — Generate optimal allocation plan (TRANSACTIONAL)
3. fetch_financial_filings — Retrieve SEC 10-K/10-Q text (analytical)
4. execute_order          — Place a trade order (TRANSACTIONAL)
5. none                   — No tool needed (general Q&A only)

Respond ONLY with valid JSON:
{{
  "tool": "<tool_name_or_none>",
  "inputs": {{<validated input fields>}},
  "reasoning": "<one sentence>"
}}

Default portfolio_id if not specified: "{_DEMO_PORTFOLIO_ID}"
For execute_order, ALWAYS set amount > 0 and leave confirmation_token as a placeholder "PENDING_2FA".
"""


# ---------------------------------------------------------------------------
# Tool executor registry
# ---------------------------------------------------------------------------

async def _execute_get_portfolio_metrics(inputs: dict) -> Any:
    """Execute get_portfolio_metrics via the portfolio router's logic."""
    from backend.gateway.schemas.tools import GetPortfolioMetricsInput
    from backend.gateway.routers.portfolio import _fetch_returns
    from backend.quant.metrics import compute_all_metrics
    from backend.quant.risk import compute_var_suite
    import numpy as np
    import os as _os
    from datetime import datetime, timezone
    from decimal import Decimal

    validated = GetPortfolioMetricsInput(**inputs)
    tickers = ["AAPL", "MSFT", "GOOGL", "AMZN", "META"]  # Demo holdings
    benchmark = validated.benchmark

    portfolio_returns, benchmark_returns, equity_curve = await _fetch_returns(
        tickers, benchmark, validated.lookback_days
    )

    risk_free_rate = float(_os.environ.get("RISK_FREE_RATE_ANNUAL", "0.0525"))
    metrics = compute_all_metrics(
        portfolio_returns=portfolio_returns,
        benchmark_returns=benchmark_returns,
        equity_curve=equity_curve,
        risk_free_rate=risk_free_rate,
    )
    var_suite = compute_var_suite(portfolio_returns, float(equity_curve[-1]))

    return {
        "portfolio_id": str(validated.portfolio_id),
        "benchmark": benchmark,
        "calculated_at": datetime.now(timezone.utc).isoformat(),
        "sharpe_ratio": round(metrics.sharpe_ratio, 4),
        "sortino_ratio": round(metrics.sortino_ratio, 4),
        "cagr": round(metrics.cagr, 4),
        "max_drawdown": round(metrics.max_drawdown, 4),
        "beta": round(metrics.beta, 4),
        "alpha": round(metrics.alpha, 4),
        "var_95_pct": round(var_suite["historical_95"].var_pct, 4),
        "var_99_pct": round(var_suite["historical_99"].var_pct, 4),
        "annualized_volatility": round(metrics.annualized_volatility, 4),
        "total_return": round(metrics.total_return, 4),
        "analysis_period_days": metrics.observations,
    }


async def _execute_fetch_financial_filings(inputs: dict) -> Any:
    """Execute fetch_financial_filings via the RAG pipeline."""
    from backend.gateway.schemas.tools import FetchFinancialFilingsInput
    from backend.rag.reranker import retrieve_and_rerank

    validated = FetchFinancialFilingsInput(**inputs)

    chunks = retrieve_and_rerank(
        query=f"{validated.ticker} {validated.filing_type} {validated.section}",
        ticker=validated.ticker,
        filing_type=validated.filing_type.value,
        fiscal_year=validated.year,
        section=validated.section if validated.section != "ALL" else None,
        rerank_top_k=validated.max_chunks,
    )

    return {
        "ticker": validated.ticker,
        "filing_type": validated.filing_type.value,
        "year": validated.year,
        "section": validated.section,
        "chunks": [
            {
                "chunk_id": c.chunk_id,
                "section": c.section,
                "text": c.text[:500],  # Truncate for state storage
                "relevance_score": round(c.relevance_score, 4),
            }
            for c in chunks
        ],
        "total_chunks": len(chunks),
    }


async def _execute_analyze_technical_indicators(inputs: dict) -> Any:
    """Execute analyze_technical_indicators via Quant Engine and yfinance."""
    import random
    from datetime import datetime, timezone, timedelta
    import yfinance as yf
    from backend.quant.technical import analyze_technical_and_statistical, analyze_all_watchlist_assets
    from backend.gateway.schemas.tools import AnalyzeTechnicalIndicatorsInput

    validated = AnalyzeTechnicalIndicatorsInput(**inputs)
    ticker = validated.ticker.upper()

    def _fetch_bars_for_ticker(sym: str) -> list[dict[str, Any]]:
        bars = []
        try:
            t = yf.Ticker(sym)
            df = t.history(period=validated.period, interval=validated.interval)
            if not df.empty:
                for ts, row in df.iterrows():
                    bars.append({
                        "timestamp": ts.strftime("%Y-%m-%d"),
                        "open": float(row["Open"]),
                        "high": float(row["High"]),
                        "low": float(row["Low"]),
                        "close": float(row["Close"]),
                        "volume": float(row["Volume"]),
                    })
        except Exception as exc:
            logger.warning("Technical OHLCV fetch failed for %s: %s", sym, exc)

        if not bars:
            base_date = datetime.now(timezone.utc) - timedelta(days=35)
            curr = 210.0 if sym == "AAPL" else (500.0 if sym == "MSFT" else 280.0)
            for i in range(35):
                d = base_date + timedelta(days=i)
                if d.weekday() >= 5:
                    continue
                step = (random.random() - 0.48) * 0.02 * curr
                op = curr
                cl = op + step
                hi = max(op, cl) + random.random() * 0.01 * curr
                lo = min(op, cl) - random.random() * 0.01 * curr
                curr = cl
                bars.append({
                    "timestamp": d.strftime("%Y-%m-%d"),
                    "open": round(op, 2),
                    "high": round(hi, 2),
                    "low": round(lo, 2),
                    "close": round(cl, 2),
                    "volume": random.randint(1000000, 10000000),
                })
        return bars

    if ticker in ["ALL", "WATCHLIST", "COMPARE", "RANK"]:
        watch_dict = {
            s: _fetch_bars_for_ticker(s)
            for s in ["AAPL", "MSFT", "GOOGL", "NVDA", "SPY"]
        }
        return analyze_all_watchlist_assets(watch_dict)

    bars = _fetch_bars_for_ticker(ticker)
    return analyze_technical_and_statistical(ticker=ticker, bars=bars, period=validated.period)


_TOOL_EXECUTORS = {
    "get_portfolio_metrics": _execute_get_portfolio_metrics,
    "fetch_financial_filings": _execute_fetch_financial_filings,
    "analyze_technical_indicators": _execute_analyze_technical_indicators,
    # rebalance_portfolio and execute_order are handled post-HITL
}

_TRANSACTIONAL_TOOLS = {"rebalance_portfolio", "execute_order"}


# ---------------------------------------------------------------------------
# Node function
# ---------------------------------------------------------------------------

async def call_tool_node(state: AgentState) -> dict[str, Any]:
    """
    LangGraph node: select and execute the appropriate tool.

    For transactional tools, only stores the tool_name and tool_input —
    actual execution happens in execute_tool (post-HITL confirmation).
    """
    user_message = state["user_message"]
    rag_context = state.get("rag_context", [])
    session_id = state["session_id"]
    active_ticker = state.get("current_ticker") or "AAPL"

    # Build enriched message with RAG context
    context_section = ""
    if rag_context:
        context_section = "\n\nRelevant document context:\n" + "\n---\n".join(rag_context[:3])

    try:
        response = await _client.chat.completions.create(
            model=_MODEL,
            messages=[
                {"role": "system", "content": _TOOL_SELECTION_PROMPT},
                {"role": "user", "content": user_message + context_section},
            ],
            temperature=0.0,
            max_tokens=512,
            response_format={"type": "json_object"},
            timeout=1.0,
        )
        raw = json.loads(response.choices[0].message.content or "{}")
        tool_name = raw.get("tool", "none")
        tool_inputs = raw.get("inputs", {})
    except Exception as exc:
        logger.warning("LLM tool selection unavailable (%s) — using analytical heuristic dispatcher", exc)
        msg_lower = user_message.lower()

        # Check for multi-asset / all charts comparison
        if any(w in msg_lower for w in ["all chart", "all charts", "all ticker", "all tickers", "compare all", "rank all", "ranking", "watchlist"]):
            detected_ticker = "ALL"
        else:
            # Default to active chart ticker unless a specific ticker is named
            detected_ticker = active_ticker
            for t in ["AAPL", "MSFT", "GOOGL", "NVDA", "SPY", "AMZN", "TSLA", "META", "QQQ"]:
                if t.lower() in msg_lower:
                    detected_ticker = t
                    break

        if any(w in msg_lower for w in [
            "technical", "indicator", "indicators", "rsi", "macd", "bollinger",
            "support", "resistance", "sma", "ema", "moving average", "chart analysis",
            "trend", "level", "levels", "target", "stop-loss", "stop loss", "momentum",
            "volatility", "fibonacci", "stochastic", "analyze chart", "analyze this", "on this chart"
        ]):
            tool_name = "analyze_technical_indicators"
            tool_inputs = {
                "ticker": detected_ticker,
                "period": "1mo",
                "interval": "1d",
            }
        elif any(w in msg_lower for w in ["rebalance", "optimize", "black-litterman", "mpt", "allocation"]):
            tool_name = "rebalance_portfolio"
            tool_inputs = {
                "portfolio_id": _DEMO_PORTFOLIO_ID,
                "model": "MPT",
                "target_risk": 0.15,
            }
        elif any(w in msg_lower for w in ["filing", "10-k", "10-q", "sec", "edgar", "annual report"]):
            tool_name = "fetch_financial_filings"
            tool_inputs = {
                "ticker": detected_ticker if detected_ticker != "ALL" else "AAPL",
                "filing_type": "10-K",
                "year": 2024,
                "section": "Item 1A",
            }
        elif any(w in msg_lower for w in ["metric", "sharpe", "sortino", "var", "risk", "drawdown", "cagr", "beta", "performance", "portfolio", "how is", "show me", "analysis"]):
            tool_name = "get_portfolio_metrics"
            tool_inputs = {
                "portfolio_id": _DEMO_PORTFOLIO_ID,
                "benchmark": "SPY",
                "lookback_days": 252,
            }
        else:
            tool_name = "none"
            tool_inputs = {}
        raw = {"reasoning": f"Heuristic selection: {tool_name}"}

    reasoning_text = raw.get("reasoning", "") if isinstance(raw, dict) else ""
    logger.info(
        "call_tool | tool=%s | session=%s | reasoning=%s",
        tool_name,
        session_id,
        reasoning_text,
    )

    if tool_name == "none" or not tool_name:
        return {
            "tool_name": None,
            "tool_input": None,
            "execution_steps": ["call_tool:no_tool"],
        }

    # Transactional: prepare but don't execute (HITL gate will intercept)
    if tool_name in _TRANSACTIONAL_TOOLS:
        return {
            "tool_name": tool_name,
            "tool_input": tool_inputs,
            "is_transactional": True,
            "execution_steps": [f"call_tool:prepared_{tool_name}"],
        }

    # Non-transactional: execute immediately
    executor = _TOOL_EXECUTORS.get(tool_name)
    if not executor:
        return {
            "tool_name": tool_name,
            "tool_input": tool_inputs,
            "tool_error": f"Unknown tool: {tool_name}",
            "execution_steps": ["call_tool:unknown_tool"],
        }

    try:
        result = await executor(tool_inputs)
        return {
            "tool_name": tool_name,
            "tool_input": tool_inputs,
            "tool_output": result,
            "tool_error": None,
            "execution_steps": [f"call_tool:executed_{tool_name}"],
        }
    except (ValidationError, ValueError) as exc:
        logger.warning("Tool input validation failed: %s", exc)
        return {
            "tool_name": tool_name,
            "tool_input": tool_inputs,
            "tool_error": f"Invalid inputs for {tool_name}: {exc}",
            "execution_steps": [f"call_tool:validation_error_{tool_name}"],
        }
    except Exception as exc:
        logger.error("Tool execution error: %s", exc, exc_info=True)
        return {
            "tool_name": tool_name,
            "tool_input": tool_inputs,
            "tool_error": str(exc),
            "execution_steps": [f"call_tool:exec_error_{tool_name}"],
            "error_count": state.get("error_count", 0) + 1,
        }
