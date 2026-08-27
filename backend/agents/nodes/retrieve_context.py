"""
backend/agents/nodes/retrieve_context.py
==========================================
RAG retrieval node — activated for ADVISORY and ANALYTICAL intents.

Determines if context retrieval from SEC filings is needed based on the
user message, then runs the hybrid RAG pipeline:
  1. Extract relevant query parameters (ticker, filing_type, year, section)
  2. Run retrieve_and_rerank()
  3. Attach retrieved text chunks and citations to the agent state
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from openai import AsyncOpenAI

from backend.agents.state import AgentState
from backend.gateway.schemas.portfolio import IntentClass

logger = logging.getLogger(__name__)

_client = AsyncOpenAI(
    base_url=os.environ["VLLM_BASE_URL"],
    api_key=os.environ.get("VLLM_API_KEY", "not-required"),
)
_MODEL = os.environ["VLLM_MODEL_NAME"]

_CURRENT_YEAR = 2024

_EXTRACTION_PROMPT = """
Extract retrieval parameters from the user message. Respond with ONLY a JSON object:
{
  "needs_rag": <true|false>,
  "ticker": "<TICKER or null>",
  "filing_type": "<10-K|10-Q|null>",
  "year": <integer year or null>,
  "section": "<Item 1A|Item 7|Item 7A|Item 8|ALL|null>",
  "query": "<refined retrieval query>"
}

Rules:
- needs_rag=true only if user asks about company filings, risk factors, MD&A, or financial statements
- ticker: extract uppercase stock symbol if mentioned
- section: "Item 1A" for risk factors, "Item 7" for MD&A, "Item 7A" for market risk, "Item 8" for financials
- query: rephrase the user question as an optimal retrieval query
"""


async def retrieve_context_node(state: AgentState) -> dict[str, Any]:
    """
    LangGraph node: determine if RAG retrieval is needed and fetch context.

    For ANALYTICAL or GENERAL_QA intents, RAG is skipped if no filing
    keywords are detected in the user message.
    """
    user_message = state["user_message"]
    intent = state.get("intent_class", IntentClass.GENERAL_QA)
    session_id = state["session_id"]

    # Fast path: skip RAG for purely transactional requests
    if intent == IntentClass.TRANSACTIONAL:
        logger.debug("retrieve_context | skipping RAG for TRANSACTIONAL intent")
        return {"execution_steps": ["retrieve_context:skipped_transactional"]}

    # Use LLM to determine if RAG is needed and extract parameters
    try:
        response = await _client.chat.completions.create(
            model=_MODEL,
            messages=[
                {"role": "system", "content": _EXTRACTION_PROMPT},
                {"role": "user", "content": user_message},
            ],
            temperature=0.0,
            max_tokens=256,
            response_format={"type": "json_object"},
            timeout=1.0,
        )
        params = json.loads(response.choices[0].message.content or "{}")
    except Exception as exc:
        logger.warning("RAG parameter extraction failed: %s — skipping RAG", exc)
        return {"execution_steps": ["retrieve_context:extraction_failed"]}

    if not params.get("needs_rag", False):
        logger.debug("retrieve_context | LLM determined RAG not needed")
        return {"execution_steps": ["retrieve_context:not_needed"]}

    # Run the RAG pipeline
    try:
        from backend.rag.reranker import retrieve_and_rerank

        chunks = retrieve_and_rerank(
            query=params.get("query", user_message),
            ticker=params.get("ticker"),
            filing_type=params.get("filing_type"),
            fiscal_year=params.get("year"),
            section=params.get("section"),
            retrieve_top_k=20,
            rerank_top_k=int(os.environ.get("RAG_TOP_K", "5")),
        )

        context_texts = [c.text for c in chunks]
        citations = [
            f"{c.ticker} {c.filing_type} ({c.fiscal_year}) — {c.section}"
            for c in chunks
        ]

        logger.info(
            "retrieve_context | session=%s | chunks=%d | ticker=%s",
            session_id, len(chunks), params.get("ticker"),
        )

        return {
            "rag_context": context_texts,
            "rag_citations": citations,
            "execution_steps": [f"retrieve_context:{len(chunks)}_chunks"],
        }

    except Exception as exc:
        logger.error("RAG pipeline error: %s", exc, exc_info=True)
        return {
            "execution_steps": ["retrieve_context:ERROR"],
            "error_count": state.get("error_count", 0) + 1,
        }
