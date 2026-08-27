"""
backend/rag/embeddings.py
==========================
Dense embedding generation using BAAI/bge-m3 via sentence-transformers.

bge-m3 is a multilingual, multi-granularity embedding model supporting:
  - Dense (vector) embeddings for semantic similarity search
  - Sparse (BM25-like) lexical embeddings for keyword matching
  - ColBERT-style late interaction (supported but not used in this implementation)

The model is loaded once at module level for efficiency.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Optional

import numpy as np
import numpy.typing as npt

logger = logging.getLogger(__name__)

_EMBEDDING_MODEL_NAME: str = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-m3")
_DEVICE: str = "cuda" if _is_gpu_available() else "cpu"


def _is_gpu_available() -> bool:
    """Check if a CUDA-capable GPU is available."""
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


@lru_cache(maxsize=1)
def _get_model():
    """
    Load and cache the bge-m3 model.
    Uses lru_cache to ensure the model is only loaded once per process.
    """
    from FlagEmbedding import BGEM3FlagModel
    logger.info("Loading embedding model: %s on %s", _EMBEDDING_MODEL_NAME, _DEVICE)
    model = BGEM3FlagModel(
        _EMBEDDING_MODEL_NAME,
        use_fp16=(_DEVICE == "cuda"),
        device=_DEVICE,
    )
    logger.info("Embedding model loaded")
    return model


def embed_texts(
    texts: list[str],
    batch_size: int = 32,
    max_length: int = 8192,
) -> npt.NDArray[np.float32]:
    """
    Generate dense embeddings for a list of texts using BAAI/bge-m3.

    Args:
        texts: List of text strings to embed.
        batch_size: Number of texts to process per GPU/CPU batch.
        max_length: Maximum token length per text.

    Returns:
        Float32 numpy array of shape (len(texts), embedding_dim).
        bge-m3 dense embedding dim = 1024.
    """
    if not texts:
        return np.empty((0, 1024), dtype=np.float32)

    model = _get_model()
    results = model.encode(
        texts,
        batch_size=batch_size,
        max_length=max_length,
        return_dense=True,
        return_sparse=False,
        return_colbert_vecs=False,
    )
    dense = results["dense_vecs"]
    return np.array(dense, dtype=np.float32)


def embed_query(query: str) -> npt.NDArray[np.float32]:
    """
    Embed a single query string.

    Uses the bge-m3 query instruction prefix for asymmetric retrieval:
    "Represent this sentence for searching relevant passages: {query}"
    """
    prefixed = f"Represent this sentence for searching relevant passages: {query}"
    embeddings = embed_texts([prefixed])
    return embeddings[0]
