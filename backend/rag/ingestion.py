"""
backend/rag/ingestion.py
=========================
SEC EDGAR filing ingestion pipeline.

Workflow:
  1. Fetch filing index from SEC EDGAR full-text search API.
  2. Download HTML document for the specified filing type.
  3. Chunk document by SEC section headers (Item 1A, Item 7, etc.).
  4. Generate BAAI/bge-m3 dense embeddings for each chunk.
  5. Upsert chunks + embeddings into Qdrant with rich metadata payload.

Uses section-aware chunking — each chunk is annotated with its SEC section
so RAG queries can be filtered by section (e.g., "only Item 1A: Risk Factors").
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Iterator

import httpx
from qdrant_client import QdrantClient, models

from backend.rag.embeddings import embed_texts

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_EDGAR_BASE_URL = "https://data.sec.gov"
_USER_AGENT = os.environ.get(
    "SEC_EDGAR_USER_AGENT",
    "FinancialAssistant/1.0 contact@example.com"
)
_CHUNK_SIZE_CHARS: int = 1500     # Target characters per chunk
_CHUNK_OVERLAP_CHARS: int = 200   # Overlap to preserve context across chunk boundaries
_COLLECTION_NAME: str = os.environ.get("QDRANT_COLLECTION_FILINGS", "financial_filings")

# SEC section header pattern
_SECTION_PATTERN = re.compile(
    r"(ITEM\s+\d+[A-Z]?\s*[\.\-]?\s*[A-Z][A-Z\s,&']+)",
    re.IGNORECASE,
)

# Mapping of canonical section names
_SECTION_MAP: dict[str, str] = {
    "1": "Item 1",
    "1A": "Item 1A",
    "1B": "Item 1B",
    "2": "Item 2",
    "3": "Item 3",
    "7": "Item 7",
    "7A": "Item 7A",
    "8": "Item 8",
    "9A": "Item 9A",
}


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class FilingChunk:
    """A single text chunk from a parsed SEC filing."""
    chunk_id: str           # Deterministic SHA-256 hash
    ticker: str
    cik: str
    filing_type: str
    fiscal_year: int
    section: str            # e.g. "Item 1A"
    text: str
    char_count: int
    chunk_index: int        # Position within section


# ---------------------------------------------------------------------------
# EDGAR API client
# ---------------------------------------------------------------------------

_headers = {
    "User-Agent": _USER_AGENT,
    "Accept-Encoding": "gzip, deflate",
}


def _get_cik(ticker: str) -> str:
    """Resolve a ticker symbol to SEC CIK number."""
    url = "https://efts.sec.gov/LATEST/search-index?q=%22{}%22&dateRange=custom&startdt=2020-01-01&forms=10-K".format(ticker)
    # Use company search API
    search_url = f"https://efts.sec.gov/LATEST/search-index?q=%22{ticker}%22&forms=10-K"

    # Use the company tickers JSON endpoint (most reliable)
    tickers_url = "https://www.sec.gov/files/company_tickers.json"
    with httpx.Client(headers=_headers, timeout=15) as client:
        r = client.get(tickers_url)
        r.raise_for_status()
        data = r.json()

    ticker_upper = ticker.upper()
    for entry in data.values():
        if entry.get("ticker", "").upper() == ticker_upper:
            return str(entry["cik_str"]).zfill(10)

    raise ValueError(f"CIK not found for ticker '{ticker}'")


def _fetch_filing_urls(cik: str, filing_type: str, year: int) -> list[str]:
    """
    Fetch filing document URLs from SEC EDGAR XBRL submissions endpoint.

    Returns a list of document URLs for the given CIK, type, and fiscal year.
    """
    url = f"{_EDGAR_BASE_URL}/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type={filing_type}&dateb=&owner=include&count=40&search_text="

    submissions_url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    with httpx.Client(headers=_headers, timeout=30) as client:
        r = client.get(submissions_url)
        r.raise_for_status()
        data = r.json()

    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    accessions = recent.get("accessionNumber", [])
    primary_docs = recent.get("primaryDocument", [])

    document_urls = []
    for form, date, accession, primary in zip(forms, dates, accessions, primary_docs):
        if form == filing_type and str(year) in date:
            accession_clean = accession.replace("-", "")
            doc_url = (
                f"https://www.sec.gov/Archives/edgar/data/"
                f"{int(cik)}/{accession_clean}/{primary}"
            )
            document_urls.append(doc_url)

    return document_urls


def _download_and_clean(url: str) -> str:
    """Download HTML filing and strip HTML tags to plain text."""
    with httpx.Client(headers=_headers, timeout=60) as client:
        r = client.get(url)
        r.raise_for_status()
        html = r.text

    # Remove HTML tags
    text = re.sub(r"<[^>]+>", " ", html)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text)
    # Remove page markers and form numbers
    text = re.sub(r"Table of Contents", "", text, flags=re.IGNORECASE)
    return text.strip()


# ---------------------------------------------------------------------------
# Section-aware chunker
# ---------------------------------------------------------------------------

def _extract_sections(text: str) -> dict[str, str]:
    """
    Parse plain text into a dict of {section_name: section_text}.
    Uses SEC section header pattern to identify boundaries.
    """
    matches = list(_SECTION_PATTERN.finditer(text))
    sections: dict[str, str] = {}

    for i, match in enumerate(matches):
        section_header = match.group(0).strip()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        section_text = text[start:end].strip()

        if len(section_text) > 100:  # Skip near-empty sections
            sections[section_header] = section_text

    return sections


def _chunk_text(text: str, section: str, size: int, overlap: int) -> list[str]:
    """
    Split section text into overlapping chunks of roughly `size` characters.
    Uses sentence boundaries where possible to avoid mid-sentence cuts.
    """
    # Split on sentence boundaries first
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    current_chunk = ""

    for sentence in sentences:
        if len(current_chunk) + len(sentence) <= size:
            current_chunk += " " + sentence
        else:
            if current_chunk.strip():
                chunks.append(current_chunk.strip())
            # Start next chunk with overlap from previous
            overlap_text = current_chunk[-overlap:] if len(current_chunk) > overlap else current_chunk
            current_chunk = overlap_text + " " + sentence

    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    return chunks


def parse_filing_into_chunks(
    text: str,
    ticker: str,
    cik: str,
    filing_type: str,
    fiscal_year: int,
) -> list[FilingChunk]:
    """
    Full pipeline: raw filing text → list of annotated FilingChunks.
    """
    sections = _extract_sections(text)
    all_chunks: list[FilingChunk] = []

    for section_header, section_text in sections.items():
        text_chunks = _chunk_text(section_text, section_header, _CHUNK_SIZE_CHARS, _CHUNK_OVERLAP_CHARS)

        for idx, chunk_text in enumerate(text_chunks):
            # Deterministic chunk ID based on content
            chunk_hash = hashlib.sha256(
                f"{ticker}-{filing_type}-{fiscal_year}-{section_header}-{idx}-{chunk_text[:100]}".encode()
            ).hexdigest()[:24]

            all_chunks.append(FilingChunk(
                chunk_id=chunk_hash,
                ticker=ticker,
                cik=cik,
                filing_type=filing_type,
                fiscal_year=fiscal_year,
                section=section_header,
                text=chunk_text,
                char_count=len(chunk_text),
                chunk_index=idx,
            ))

    logger.info("Parsed %d chunks from %s %s %d", len(all_chunks), ticker, filing_type, fiscal_year)
    return all_chunks


# ---------------------------------------------------------------------------
# Qdrant upsert
# ---------------------------------------------------------------------------

def _get_qdrant_client() -> QdrantClient:
    """Create or return a Qdrant client."""
    return QdrantClient(
        host=os.environ.get("QDRANT_HOST", "localhost"),
        port=int(os.environ.get("QDRANT_PORT", "6333")),
        api_key=os.environ.get("QDRANT_API_KEY") or None,
    )


def _ensure_collection(client: QdrantClient, vector_size: int = 1024) -> None:
    """Create the Qdrant collection if it doesn't exist."""
    existing = {c.name for c in client.get_collections().collections}
    if _COLLECTION_NAME not in existing:
        client.create_collection(
            collection_name=_COLLECTION_NAME,
            vectors_config=models.VectorsConfig(
                dense=models.VectorParams(
                    size=vector_size,
                    distance=models.Distance.COSINE,
                )
            ),
            sparse_vectors_config={
                "bm25": models.SparseVectorParams(
                    index=models.SparseIndexParams(on_disk=False)
                )
            },
        )
        logger.info("Created Qdrant collection '%s'", _COLLECTION_NAME)


def upsert_chunks_to_qdrant(chunks: list[FilingChunk], batch_size: int = 32) -> int:
    """
    Generate embeddings and upsert all chunks into Qdrant.

    Returns the number of successfully upserted chunks.
    """
    if not chunks:
        return 0

    client = _get_qdrant_client()
    _ensure_collection(client)

    texts = [c.text for c in chunks]
    embeddings = embed_texts(texts, batch_size=batch_size)

    points: list[models.PointStruct] = []
    for chunk, embedding in zip(chunks, embeddings):
        points.append(
            models.PointStruct(
                id=chunk.chunk_id,
                vector={"dense": embedding.tolist()},
                payload={
                    "ticker": chunk.ticker,
                    "cik": chunk.cik,
                    "filing_type": chunk.filing_type,
                    "fiscal_year": chunk.fiscal_year,
                    "section": chunk.section,
                    "text": chunk.text,
                    "char_count": chunk.char_count,
                    "chunk_index": chunk.chunk_index,
                },
            )
        )

    client.upsert(collection_name=_COLLECTION_NAME, points=points)
    logger.info("Upserted %d chunks into Qdrant", len(points))
    return len(points)


# ---------------------------------------------------------------------------
# Full ingestion pipeline
# ---------------------------------------------------------------------------

def ingest_filing(ticker: str, filing_type: str, year: int) -> int:
    """
    End-to-end ingestion: SEC EDGAR → chunks → embeddings → Qdrant.

    Args:
        ticker: Stock ticker symbol (e.g. "AAPL").
        filing_type: "10-K" or "10-Q".
        year: Fiscal year.

    Returns:
        Number of chunks ingested.
    """
    logger.info("Starting ingestion: %s %s %d", ticker, filing_type, year)

    cik = _get_cik(ticker)
    time.sleep(0.1)  # SEC EDGAR rate-limit: 10 requests/second

    urls = _fetch_filing_urls(cik, filing_type, year)
    if not urls:
        raise ValueError(f"No {filing_type} filings found for {ticker} in {year}")

    # Use the first (most recent) matching filing
    raw_text = _download_and_clean(urls[0])
    time.sleep(0.1)

    chunks = parse_filing_into_chunks(
        text=raw_text,
        ticker=ticker,
        cik=cik,
        filing_type=filing_type,
        fiscal_year=year,
    )

    return upsert_chunks_to_qdrant(chunks)
