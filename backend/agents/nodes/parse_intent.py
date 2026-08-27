"""
backend/agents/nodes/parse_intent.py
======================================
Intent classification node — classifies user requests into one of four categories:
  - ADVISORY:      "What should I do with my portfolio?"
  - ANALYTICAL:    "Show me my Sharpe ratio" / "What is the VaR?"
  - TRANSACTIONAL: "Buy 10 shares of AAPL" / "Rebalance my portfolio"
  - GENERAL_QA:    "What is the Black-Litterman model?"

Classification uses the LLM for semantic understanding but the output is
constrained to a strict enum — no numerical data is generated at this stage.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from openai import AsyncOpenAI

from backend.agents.state import AgentState
from backend.gateway.schemas.portfolio import IntentClass

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# LLM client (vLLM / OpenAI-compatible)
# ---------------------------------------------------------------------------

_client = AsyncOpenAI(
    base_url=os.environ["VLLM_BASE_URL"],
    api_key=os.environ.get("VLLM_API_KEY", "not-required"),
)

_MODEL = os.environ["VLLM_MODEL_NAME"]

# Strict classification prompt — forces the LLM to output only a JSON class label
_CLASSIFICATION_SYSTEM_PROMPT = """
You are an intent classifier for a financial advisory system.
Classify the user message into EXACTLY one of these categories:

- ADVISORY: User asks for financial advice, recommendations, or portfolio guidance.
- ANALYTICAL: User asks for specific quantitative data (metrics, ratios, risk numbers).
- TRANSACTIONAL: User wants to execute a trade, rebalance, or modify their portfolio.
- GENERAL_QA: User asks a general finance question (concepts, definitions, market info).

Respond with ONLY a JSON object in this exact format:
{"intent": "<CATEGORY>", "is_transactional": <true|false>, "reasoning": "<one sentence>"}

Do NOT include any numerical financial data, prices, or investment advice in your response.
"""


# ---------------------------------------------------------------------------
# Node function
# ---------------------------------------------------------------------------

async def parse_intent_node(state: AgentState) -> dict[str, Any]:
    """
    LangGraph node: classify user intent.

    This is the first node in the graph. It determines which subsequent
    nodes are activated via conditional edges.
    """
    user_message = state["user_message"]
    logger.info(
        "parse_intent | session=%s | message_preview=%s",
        state["session_id"],
        user_message[:100],
    )

    try:
        response = await _client.chat.completions.create(
            model=_MODEL,
            messages=[
                {"role": "system", "content": _CLASSIFICATION_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            temperature=0.0,          # Deterministic classification
            max_tokens=128,
            response_format={"type": "json_object"},
            timeout=1.0,
        )
        raw = response.choices[0].message.content or "{}"
        parsed = json.loads(raw)

        intent_str = parsed.get("intent", "GENERAL_QA").upper()
        is_transactional = bool(parsed.get("is_transactional", False))

        # Validate against enum — fallback to GENERAL_QA for unknown values
        try:
            intent = IntentClass(intent_str)
        except ValueError:
            logger.warning("Unknown intent '%s' — falling back to GENERAL_QA", intent_str)
            intent = IntentClass.GENERAL_QA
            is_transactional = False

        logger.info(
            "parse_intent | intent=%s | is_transactional=%s | reasoning=%s",
            intent,
            is_transactional,
            parsed.get("reasoning", ""),
        )

        return {
            "intent_class": intent,
            "is_transactional": is_transactional,
            "execution_steps": [f"parse_intent:{intent.value}"],
        }

    except Exception as exc:
        logger.warning("LLM intent classification unavailable (%s) — using keyword fallback", exc)
        msg_lower = user_message.lower()
        if any(w in msg_lower for w in ["rebalance", "optimize", "buy", "sell", "order", "allocation", "allocate"]):
            intent = IntentClass.TRANSACTIONAL
            is_transactional = True
        elif any(w in msg_lower for w in [
            "sharpe", "sortino", "var", "risk", "metric", "metrics", "cagr", "beta",
            "performance", "drawdown", "portfolio", "returns", "technical", "indicator",
            "indicators", "rsi", "macd", "bollinger", "support", "resistance", "sma",
            "ema", "moving average", "chart", "levels", "trend", "momentum", "volatility", "statistical"
        ]):
            intent = IntentClass.ANALYTICAL
            is_transactional = False
        elif any(w in msg_lower for w in ["filing", "10-k", "10-q", "sec", "edgar", "annual report"]):
            intent = IntentClass.ADVISORY
            is_transactional = False
        else:
            intent = IntentClass.GENERAL_QA
            is_transactional = False

        return {
            "intent_class": intent,
            "is_transactional": is_transactional,
            "execution_steps": [f"parse_intent:{intent.value}_heuristic"],
        }
