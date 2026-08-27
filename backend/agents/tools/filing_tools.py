"""
backend/agents/tools/filing_tools.py
=======================================
SEC filing retrieval tool — wraps the RAG pipeline for agent use.
"""

from __future__ import annotations

import logging

from backend.gateway.schemas.tools import FetchFinancialFilingsInput, FilingChunk, FilingContext

logger = logging.getLogger(__name__)


async def tool_fetch_financial_filings(
    inputs: FetchFinancialFilingsInput,
) -> FilingContext:
    """
    Tool: Retrieve SEC 10-K/10-Q filing context via the RAG pipeline.

    Runs hybrid dense+BM25 retrieval followed by BGE-Reranker-Large reranking.
    Returns top-k chunks with relevance scores and metadata.
    """
    from backend.rag.reranker import retrieve_and_rerank

    query = (
        f"{inputs.ticker} {inputs.filing_type.value} {inputs.section} "
        f"fiscal year {inputs.year}"
    )

    chunks = retrieve_and_rerank(
        query=query,
        ticker=inputs.ticker,
        filing_type=inputs.filing_type.value,
        fiscal_year=inputs.year,
        section=inputs.section if inputs.section != "ALL" else None,
        retrieve_top_k=inputs.max_chunks * 4,   # Retrieve 4x for reranking
        rerank_top_k=inputs.max_chunks,
    )

    logger.info(
        "tool_fetch_financial_filings | %s %s %d | %s | chunks=%d",
        inputs.ticker, inputs.filing_type.value, inputs.year,
        inputs.section, len(chunks),
    )

    return FilingContext(
        ticker=inputs.ticker,
        filing_type=inputs.filing_type.value,
        year=inputs.year,
        section=inputs.section,
        chunks=[
            FilingChunk(
                chunk_id=c.chunk_id,
                ticker=c.ticker,
                filing_type=c.filing_type,
                year=c.fiscal_year,
                section=c.section,
                text=c.text,
                relevance_score=c.relevance_score,
            )
            for c in chunks
        ],
        retrieval_method="hybrid_dense_bm25_reranked",
        total_chunks_retrieved=len(chunks) * 4,
        total_chunks_after_rerank=len(chunks),
    )
