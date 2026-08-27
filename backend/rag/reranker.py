"""
backend/rag/reranker.py
========================
Cross-encoder reranking using BAAI/bge-reranker-large.

BGE-Reranker-Large is a cross-encoder that takes (query, passage) pairs
and produces a relevance score — significantly more accurate than bi-encoder
cosine similarity for final-stage ranking.

Typical pipeline:
  1. retrieve_context → 20 candidates (hybrid_retrieve)
  2. rerank → top 5 (rerank_chunks)
  3. synthesize_response → LLM uses top-5 chunks as context
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

from backend.rag.retrieval import RetrievedChunk

logger = logging.getLogger(__name__)

_RERANKER_MODEL: str = os.environ.get("RERANKER_MODEL", "BAAI/bge-reranker-large")
_DEFAULT_TOP_K: int = 5


# ---------------------------------------------------------------------------
# Reranked result type
# ---------------------------------------------------------------------------

@dataclass
class RerankedChunk:
    """A document chunk after cross-encoder reranking."""
    chunk_id: str
    ticker: str
    filing_type: str
    fiscal_year: int
    section: str
    text: str
    relevance_score: float      # Cross-encoder output score (higher = more relevant)
    rrf_score: float            # Original RRF score (for reference)
    source_url: Optional[str] = None


# ---------------------------------------------------------------------------
# Model loader
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_reranker():
    """
    Load and cache the BGE-Reranker-Large cross-encoder model.
    Uses lru_cache to ensure single load per process.
    """
    try:
        from FlagEmbedding import FlagReranker
        logger.info("Loading reranker model: %s", _RERANKER_MODEL)
        reranker = FlagReranker(_RERANKER_MODEL, use_fp16=_is_gpu_available())
        logger.info("Reranker model loaded")
        return reranker
    except ImportError:
        logger.warning(
            "FlagEmbedding not available — falling back to score pass-through reranker. "
            "Install with: pip install FlagEmbedding"
        )
        return None


def _is_gpu_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


# ---------------------------------------------------------------------------
# Core reranking function
# ---------------------------------------------------------------------------

def rerank_chunks(
    query: str,
    chunks: list[RetrievedChunk],
    top_k: int = _DEFAULT_TOP_K,
) -> list[RerankedChunk]:
    """
    Rerank retrieved chunks using BGE-Reranker-Large cross-encoder.

    Args:
        query: The original user query.
        chunks: Candidate chunks from hybrid_retrieve().
        top_k: Number of top chunks to return after reranking.

    Returns:
        Top-k RerankedChunk objects sorted by relevance_score (descending).
    """
    if not chunks:
        return []

    reranker = _get_reranker()

    if reranker is None:
        # Fallback: use RRF score as-is
        logger.warning("Reranker unavailable — using RRF scores as relevance scores")
        sorted_chunks = sorted(chunks, key=lambda c: c.rrf_score, reverse=True)
        return [
            RerankedChunk(
                chunk_id=c.chunk_id,
                ticker=c.ticker,
                filing_type=c.filing_type,
                fiscal_year=c.fiscal_year,
                section=c.section,
                text=c.text,
                relevance_score=c.rrf_score,
                rrf_score=c.rrf_score,
            )
            for c in sorted_chunks[:top_k]
        ]

    # Build (query, passage) pairs for cross-encoder
    pairs = [[query, chunk.text] for chunk in chunks]

    try:
        scores: list[float] = reranker.compute_score(pairs, normalize=True)
    except Exception as exc:
        logger.error("Reranker scoring failed: %s — falling back to RRF", exc)
        return rerank_chunks.__wrapped__(query, chunks, top_k) if hasattr(rerank_chunks, '__wrapped__') \
            else [RerankedChunk(
                chunk_id=c.chunk_id, ticker=c.ticker, filing_type=c.filing_type,
                fiscal_year=c.fiscal_year, section=c.section, text=c.text,
                relevance_score=c.rrf_score, rrf_score=c.rrf_score,
            ) for c in sorted(chunks, key=lambda x: x.rrf_score, reverse=True)[:top_k]]

    # Pair scores with chunks and sort
    scored = sorted(
        zip(chunks, scores),
        key=lambda pair: pair[1],
        reverse=True,
    )

    result = [
        RerankedChunk(
            chunk_id=chunk.chunk_id,
            ticker=chunk.ticker,
            filing_type=chunk.filing_type,
            fiscal_year=chunk.fiscal_year,
            section=chunk.section,
            text=chunk.text,
            relevance_score=float(score),
            rrf_score=chunk.rrf_score,
        )
        for chunk, score in scored[:top_k]
    ]

    logger.info(
        "Reranker | input=%d chunks | output=%d | top_score=%.4f",
        len(chunks),
        len(result),
        result[0].relevance_score if result else 0.0,
    )
    return result


def retrieve_and_rerank(
    query: str,
    ticker: Optional[str] = None,
    filing_type: Optional[str] = None,
    fiscal_year: Optional[int] = None,
    section: Optional[str] = None,
    retrieve_top_k: int = 20,
    rerank_top_k: int = 5,
) -> list[RerankedChunk]:
    """
    Combined retrieval + reranking pipeline entry point.

    This is the primary function called from the retrieve_context agent node.
    """
    from backend.rag.retrieval import hybrid_retrieve

    candidates = hybrid_retrieve(
        query=query,
        ticker=ticker,
        filing_type=filing_type,
        fiscal_year=fiscal_year,
        section=section,
        top_k=retrieve_top_k,
    )

    return rerank_chunks(query=query, chunks=candidates, top_k=rerank_top_k)
