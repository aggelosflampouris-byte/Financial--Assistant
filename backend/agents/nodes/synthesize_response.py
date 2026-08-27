"""
backend/agents/nodes/synthesize_response.py
=============================================
Final response synthesis node — generates user-facing advisory text
and wraps it in the MiFID II / SEC compliance envelope.

ARCHITECTURAL CONSTRAINT:
The LLM synthesizes narrative text ONLY from:
  1. Retrieved RAG context (document chunks)
  2. Structured tool_output (already computed by the Quant Engine)

The LLM is explicitly instructed NEVER to generate numerical values.
All numbers in the response must be cited from tool_output or RAG context.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from openai import AsyncOpenAI

from backend.agents.state import AgentState
from backend.gateway.schemas.compliance import (
    AdvisoryResponse,
    ComplianceFramework,
    RiskWarningLevel,
)
from backend.gateway.schemas.portfolio import IntentClass

logger = logging.getLogger(__name__)

_client = AsyncOpenAI(
    base_url=os.environ["VLLM_BASE_URL"],
    api_key=os.environ.get("VLLM_API_KEY", "not-required"),
)
_MODEL = os.environ["VLLM_MODEL_NAME"]

_SYNTHESIS_SYSTEM_PROMPT = """
You are a professional financial advisor assistant operating under MiFID II regulations.

STRICT RULES:
1. NEVER generate or invent numerical values (prices, ratios, percentages, returns).
2. ONLY use numbers that appear in the provided TOOL_DATA or DOCUMENT_CONTEXT sections.
3. Always attribute claims to their source (tool result or document section).
4. Write in clear, professional financial language.
5. Keep responses concise — 3-5 paragraphs maximum.
6. Do NOT provide specific buy/sell recommendations for individual securities without tool validation.

The compliance disclaimer will be appended automatically — do NOT write it yourself.
"""


async def synthesize_response_node(state: AgentState) -> dict[str, Any]:
    """
    LangGraph node: synthesize the final user-facing response.

    Combines RAG context, tool outputs, and conversation history
    into a coherent, compliance-wrapped response.
    """
    tool_data = state.get("tool_output")
    rag_context = state.get("rag_context", [])
    citations = state.get("rag_citations", [])
    intent = state.get("intent_class", IntentClass.GENERAL_QA)
    session_id = state["session_id"]
    user_message = state["user_message"]
    error = state.get("tool_error")

    # Build context sections for the LLM
    sections: list[str] = []

    if tool_data is not None:
        tool_str = (
            json.dumps(tool_data, default=str, indent=2)
            if not isinstance(tool_data, str)
            else tool_data
        )
        sections.append(f"<TOOL_DATA>\n{tool_str}\n</TOOL_DATA>")

    if rag_context:
        context_str = "\n---\n".join(rag_context[:5])  # Top 5 chunks
        sections.append(f"<DOCUMENT_CONTEXT>\n{context_str}\n</DOCUMENT_CONTEXT>")

    if error:
        sections.append(f"<ERROR_NOTE>Tool execution encountered an error: {error}</ERROR_NOTE>")

    user_content = (
        f"User question: {user_message}\n\n"
        + "\n\n".join(sections)
    ) if sections else user_message

    # Determine risk level from intent
    risk_level = {
        IntentClass.TRANSACTIONAL: RiskWarningLevel.HIGH,
        IntentClass.ADVISORY: RiskWarningLevel.MEDIUM,
        IntentClass.ANALYTICAL: RiskWarningLevel.MEDIUM,
        IntentClass.GENERAL_QA: RiskWarningLevel.LOW,
    }.get(intent, RiskWarningLevel.MEDIUM)

    try:
        response = await _client.chat.completions.create(
            model=_MODEL,
            messages=[
                {"role": "system", "content": _SYNTHESIS_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.1,
            max_tokens=int(os.environ.get("VLLM_MAX_TOKENS", "4096")),
            stream=False,
            timeout=1.0,
        )
        narrative = response.choices[0].message.content or "Unable to generate response."

    except Exception as exc:
        logger.warning("LLM response synthesis unavailable (%s) — generating direct quant report", exc)
        if isinstance(tool_data, dict) and "sharpe_ratio" in tool_data:
            sharpe = tool_data.get("sharpe_ratio", 0)
            sortino = tool_data.get("sortino_ratio", 0)
            mdd = tool_data.get("max_drawdown", 0)
            cagr = tool_data.get("cagr", 0)
            beta = tool_data.get("beta", 0)
            var95 = tool_data.get("var_95_pct", 0)
            bench = tool_data.get("benchmark", "SPY")
            narrative = (
                f"### 📊 Portfolio Risk & Performance Analysis\n\n"
                f"Based on quantitative analysis over the trailing {tool_data.get('analysis_period_days', 252)} trading days vs **{bench}**:\n\n"
                f"- **Sharpe Ratio:** `{sharpe:.2f}` ({'Strong' if sharpe > 1.5 else 'Moderate'} risk-adjusted return)\n"
                f"- **Sortino Ratio:** `{sortino:.2f}` (Downside risk-adjusted performance)\n"
                f"- **Max Drawdown:** `{mdd*100:.2f}%` (Peak-to-trough historical decline)\n"
                f"- **CAGR:** `{cagr*100:+.2f}%` (Compound annual growth rate)\n"
                f"- **Beta (vs {bench}):** `{beta:.2f}` ({'Aggressive' if beta > 1.0 else 'Defensive'})\n"
                f"- **Value at Risk (95% 1-day):** `{var95*100:.2f}%` of portfolio value\n\n"
                f"All metrics were computed deterministically by the Quantitative Analytics Engine."
            )
        elif isinstance(tool_data, dict) and tool_data.get("multi_asset"):
            rankings = tool_data.get("rankings", [])
            lines = [
                "### 🏆 Multi-Asset Technical & Statistical Rankings\n\n",
                "Sorted by quantitative momentum and signal strength:\n\n",
            ]
            for idx, item in enumerate(rankings, 1):
                sym = item["ticker"]
                sig = item["signal"]
                score = item["score"]
                rsi = item["rsi"]
                price = item["price"]
                trend = item["ma_trend"]
                s1 = item["support_1"]
                r1 = item["resistance_1"]
                lines.append(
                    f"{idx}. **{sym}** (${price:.2f}) — **Signal:** `{sig}` (`{score:+.2f}`) · "
                    f"RSI: `{rsi}` · Trend: `{trend}` · S1: `${s1}` · R1: `${r1}`\n"
                )
            lines.append("\n💡 *Click any ticker tab above the chart to view its live candlestick breakdown.*")
            narrative = "".join(lines)
        elif isinstance(tool_data, dict) and "overall_signal" in tool_data:
            t = tool_data.get("ticker", "AAPL")
            sig = tool_data.get("overall_signal", "NEUTRAL")
            score = tool_data.get("signal_score", 0.0)
            rsi = tool_data.get("rsi_14", 50.0)
            rsi_sig = tool_data.get("rsi_signal", "NEUTRAL")
            stoch_k = tool_data.get("stoch_k", 50.0)
            stoch_d = tool_data.get("stoch_d", 50.0)
            macd_trend = tool_data.get("macd_trend", "NEUTRAL")
            sma20 = tool_data.get("sma_20", 0.0)
            sma50 = tool_data.get("sma_50", 0.0)
            pivots = tool_data.get("pivot_levels", {})
            fibs = tool_data.get("fibonacci_levels", {})
            stats = tool_data.get("statistical_moments", {})
            params = tool_data.get("parameters", {})

            narrative = (
                f"### 📈 Technical & Statistical Analysis: **{t}**\n\n"
                f"**Technical Rating:** `{sig}` (Composite Signal Score: `{score:+.2f}`)\n"
                f"**Engine Parameters:** `RSI({params.get('rsi_period', 14)})` · `SMA({params.get('sma_fast', 20)}, {params.get('sma_slow', 50)})` · `BB({params.get('bb_period', 20)}, {params.get('bb_std', 2.0)}σ)` · `MACD(12,26,9)`\n\n"
                f"**1. Momentum & Oscillators:**\n"
                f"- **RSI (14):** `{rsi}` ({rsi_sig} territory)\n"
                f"- **Stochastic Oscillator (14, 3):** `%K: {stoch_k}` · `%D: {stoch_d}`\n"
                f"- **MACD (12, 26, 9):** `{macd_trend}` (Histogram: `{tool_data.get('macd_histogram', 0.0):+.2f}`)\n\n"
                f"**2. Trend & Volatility:**\n"
                f"- **Moving Averages:** `{tool_data.get('ma_trend', 'NEUTRAL')}` (SMA 20: `${sma20}`, SMA 50: `${sma50}`)\n"
                f"- **Price vs SMA 20 / 50:** `{tool_data.get('price_vs_sma20_pct', 0.0):+.2f}%` / `{tool_data.get('price_vs_sma50_pct', 0.0):+.2f}%`\n"
                f"- **Bollinger Bandwidth:** `{tool_data.get('bollinger_bandwidth_pct', 0.0):.1f}%` (ATR: `${tool_data.get('atr_14', 0.0)}`)\n\n"
                f"**3. Statistical Support, Resistance & Fibonacci:**\n"
                f"- **Resistance (R1 / R2):** `${pivots.get('r1', 0.0)}` · `${pivots.get('r2', 0.0)}`\n"
                f"- **Pivot Level:** `${pivots.get('pivot', 0.0)}`\n"
                f"- **Support (S1 / S2):** `${pivots.get('s1', 0.0)}` · `${pivots.get('s2', 0.0)}`\n"
                f"- **Fibonacci 61.8% Level:** `${fibs.get('fib_618', 0.0)}` · **50.0%:** `${fibs.get('fib_500', 0.0)}`\n\n"
                f"**4. Statistical Risk & Distribution:**\n"
                f"- **Price Z-Score:** `{stats.get('z_score', 0.0)}` (Normalized price deviation)\n"
                f"- **Annualized Volatility:** `{stats.get('volatility', 0.0)*100:.1f}%`\n"
                f"- **1-Day Historical VaR (95%):** `{stats.get('var_95_1d_pct', 0.0)*100:.2f}%`\n\n"
                f"✨ *Indicators and statistical price levels have been automatically plotted onto your interactive chart.*"
            )
        elif isinstance(tool_data, dict) and "allocations" in tool_data:
            narrative = (
                f"### ⚖️ Portfolio Rebalancing Plan\n\n"
                f"Optimization generated using the **{tool_data.get('optimization_model', 'MPT')}** model with target volatility `{tool_data.get('target_risk', 0.15)*100:.1f}%`.\n\n"
                f"Please review the pending action details and submit confirmation to proceed."
            )
        else:
            narrative = (
                f"Hello! I am your **AI Financial Advisor and Portfolio Manager**.\n\n"
                f"Here is what I can help you with:\n"
                f"- **Portfolio Metrics**: Ask *'Show me my Sharpe ratio and risk metrics'* to calculate Sharpe, Sortino, VaR, MDD, and Beta via the Quant Engine.\n"
                f"- **Optimization**: Ask *'Rebalance portfolio with 15% target risk'* for Mean-Variance or Black-Litterman allocation.\n"
                f"- **SEC Filings**: Ask *'What are Apple's risk factors in 10-K?'* to search SEC EDGAR reports via the RAG pipeline.\n"
                f"- **Live Market Data**: Select any ticker (AAPL, MSFT, GOOGL, NVDA, SPY) on the dashboard for real-time charting."
            )

    advisory = AdvisoryResponse.wrap(
        content=narrative,
        session_id=session_id,
        intent_class=intent.value if intent else "GENERAL_QA",
        risk_level=risk_level,
        tool_validated=(tool_data is not None and error is None),
        tool_data=tool_data,
        citations=citations,
        model_identifier=_MODEL,
        requires_human_confirmation=state.get("hitl_required", False),
        pending_action_id=state.get("hitl_action_id"),
        framework=ComplianceFramework.BOTH,
    )

    return {
        "final_response": advisory.model_dump_json(),
        "compliance_metadata": advisory.compliance.model_dump(),
        "execution_steps": ["synthesize_response:done"],
    }
