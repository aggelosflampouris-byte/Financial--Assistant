"""
backend/rag/retrieval.py
=========================
Hybrid retrieval pipeline: Dense (bge-m3) + Sparse (BM25) search over Qdrant,
with metadata filtering by ticker, filing_type, and section.

The hybrid approach combines:
  - Dense semantic search (cosine similarity on bge-m3 embeddings)
  - BM25 sparse lexical search (keyword matching)
  - Score fusion via Reciprocal Rank Fusion (RRF)
  - BGE-Reranker-Large cross-encoder reranking (see reranker.py)
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

from qdrant_client import QdrantClient, models

from backend.rag.embeddings import embed_query

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_COLLECTION: str = os.environ.get("QDRANT_COLLECTION_FILINGS", "financial_filings")
_DEFAULT_TOP_K: int = 20        # Candidates before reranking
_RRF_K: int = 60                # RRF smoothing constant


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class RetrievedChunk:
    """A document chunk retrieved from Qdrant with metadata and score."""
    chunk_id: str
    ticker: str
    filing_type: str
    fiscal_year: int
    section: str
    text: str
    dense_score: float
    sparse_score: float
    rrf_score: float
    source_url: Optional[str] = None


# ---------------------------------------------------------------------------
# Qdrant client singleton
# ---------------------------------------------------------------------------

_client: Optional[QdrantClient] = None


def _get_client() -> QdrantClient:
    global _client
    if _client is None:
        _client = QdrantClient(
            host=os.environ.get("QDRANT_HOST", "localhost"),
            port=int(os.environ.get("QDRANT_PORT", "6333")),
            api_key=os.environ.get("QDRANT_API_KEY") or None,
        )
    return _client


# ---------------------------------------------------------------------------
# BM25 sparse vector generation (lightweight tokenizer)
# ---------------------------------------------------------------------------

def _build_sparse_vector(query: str) -> models.SparseVector:
    """
    Build a BM25-style sparse vector for the query.

    Uses simple TF-IDF approximation via token hashing — a full BM25
    implementation requires the SPLADE or BM42 model from FastEmbed.
    For production, replace with:
        from fastembed import SparseTextEmbedding
        model = SparseTextEmbedding("prithivida/Splade_PP_en_v1")
    """
    import hashlib
    import math
    from collections import Counter

    tokens = query.lower().split()
    tf = Counter(tokens)
    total = len(tokens) or 1

    indices: list[int] = []
    values: list[float] = []

    for token, count in tf.items():
        # Hash token to a stable int index (mod 2^17 to stay within Qdrant's sparse range)
        token_idx = int(hashlib.sha256(token.encode()).hexdigest(), 16) % 131072
        tf_score = count / total
        # IDF approximation: log(1 + 1/tf)
        idf_approx = math.log(1.0 + 1.0 / tf_score)
        indices.append(token_idx)
        values.append(float(tf_score * idf_approx))

    return models.SparseVector(indices=indices, values=values)


# ---------------------------------------------------------------------------
# Core retrieval function
# ---------------------------------------------------------------------------

def hybrid_retrieve(
    query: str,
    ticker: Optional[str] = None,
    filing_type: Optional[str] = None,
    fiscal_year: Optional[int] = None,
    section: Optional[str] = None,
    top_k: int = _DEFAULT_TOP_K,
) -> list[RetrievedChunk]:
    """
    Hybrid dense + sparse retrieval with optional metadata filtering.

    Args:
        query: User query or question string.
        ticker: Filter by ticker symbol (e.g. "AAPL").
        filing_type: Filter by "10-K" or "10-Q".
        fiscal_year: Filter by fiscal year.
        section: Filter by SEC section label (e.g. "Item 1A").
        top_k: Number of candidates to retrieve before reranking.

    Returns:
        List of RetrievedChunk, sorted by RRF score (descending).
    """
    client = _get_client()

    # Build metadata filter
    filter_conditions: list[models.FieldCondition] = []
    if ticker:
        filter_conditions.append(
            models.FieldCondition(key="ticker", match=models.MatchValue(value=ticker.upper()))
        )
    if filing_type:
        filter_conditions.append(
            models.FieldCondition(key="filing_type", match=models.MatchValue(value=filing_type))
        )
    if fiscal_year:
        filter_conditions.append(
            models.FieldCondition(key="fiscal_year", match=models.MatchValue(value=fiscal_year))
        )
    if section and section != "ALL":
        filter_conditions.append(
            models.FieldCondition(key="section", match=models.MatchText(text=section))
        )

    qdrant_filter = (
        models.Filter(must=filter_conditions) if filter_conditions else None
    )

    # --- Dense retrieval ---
    query_embedding = embed_query(query)
    dense_results = client.query_points(
        collection_name=_COLLECTION,
        query=query_embedding.tolist(),
        using="dense",
        query_filter=qdrant_filter,
        limit=top_k,
        with_payload=True,
        with_vectors=False,
    ).points

    # --- Sparse retrieval ---
    sparse_vec = _build_sparse_vector(query)
    sparse_results = client.query_points(
        collection_name=_COLLECTION,
        query=models.SparseVector(
            indices=sparse_vec.indices,
            values=sparse_vec.values,
        ),
        using="bm25",
        query_filter=qdrant_filter,
        limit=top_k,
        with_payload=True,
        with_vectors=False,
    ).points

    # --- Reciprocal Rank Fusion ---
    rrf_scores: dict[str, float] = {}
    dense_scores: dict[str, float] = {}
    sparse_scores: dict[str, float] = {}

    for rank, point in enumerate(dense_results):
        pid = str(point.id)
        rrf_scores[pid] = rrf_scores.get(pid, 0.0) + 1.0 / (_RRF_K + rank + 1)
        dense_scores[pid] = float(point.score or 0.0)

    for rank, point in enumerate(sparse_results):
        pid = str(point.id)
        rrf_scores[pid] = rrf_scores.get(pid, 0.0) + 1.0 / (_RRF_K + rank + 1)
        sparse_scores[pid] = float(point.score or 0.0)

    # Merge unique results
    all_points: dict[str, object] = {}
    for p in dense_results + sparse_results:
        all_points[str(p.id)] = p

    # Sort by RRF score
    sorted_ids = sorted(rrf_scores, key=lambda pid: rrf_scores[pid], reverse=True)

    chunks: list[RetrievedChunk] = []
    for pid in sorted_ids[:top_k]:
        point = all_points[pid]
        payload = point.payload or {}  # type: ignore
        chunks.append(RetrievedChunk(
            chunk_id=pid,
            ticker=payload.get("ticker", ""),
            filing_type=payload.get("filing_type", ""),
            fiscal_year=int(payload.get("fiscal_year", 0)),
            section=payload.get("section", ""),
            text=payload.get("text", ""),
            dense_score=dense_scores.get(pid, 0.0),
            sparse_score=sparse_scores.get(pid, 0.0),
            rrf_score=rrf_scores[pid],
        ))

    logger.info(
        "Hybrid retrieval | query_preview='%s...' | dense=%d | sparse=%d | merged=%d",
        query[:60],
        len(dense_results),
        len(sparse_results),
        len(chunks),
    )
    return chunks
