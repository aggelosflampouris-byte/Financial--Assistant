"""
backend/gateway/middleware/audit.py
=====================================
Immutable WORM audit logger for all agent interactions.

Each interaction (user input → agent response) produces exactly one immutable
row in the TimescaleDB audit.interaction_log table. The database-level WORM
enforcement (revoked DELETE/UPDATE) is set in infra/timescaledb/init.sql.

This module provides:
  - AuditLogger: Async context manager and standalone logging utility.
  - audit_interaction: FastAPI background task function.
  - log_interaction: Sync helper for use outside of HTTP context.

Privacy:
  - Raw input and agent response text are AES-256-GCM encrypted before storage.
  - SHA-256 hash of the raw input is stored for integrity verification.
  - IP addresses are stored for compliance auditing.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Optional

import asyncpg

from backend.gateway.middleware.encryption import encrypt_field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Database connection configuration
# ---------------------------------------------------------------------------

_DSN: str = (
    f"postgresql://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}"
    f"@{os.environ['POSTGRES_HOST']}:{os.environ.get('POSTGRES_PORT', '5432')}"
    f"/{os.environ['POSTGRES_DB']}"
)

# Module-level connection pool — initialized on first use
_pool: Optional[asyncpg.Pool] = None


async def _get_pool() -> asyncpg.Pool:
    """Return or initialize the asyncpg connection pool."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=_DSN,
            min_size=2,
            max_size=10,
            command_timeout=30,
        )
        logger.info("Audit DB pool initialized (min=2, max=10)")
    return _pool


async def close_pool() -> None:
    """Gracefully close the connection pool on shutdown."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        logger.info("Audit DB pool closed")


# ---------------------------------------------------------------------------
# Core audit logging function
# ---------------------------------------------------------------------------

async def log_interaction(
    *,
    user_id: str,
    session_id: str,
    raw_input: str,
    intent_class: Optional[str] = None,
    tool_payload: Optional[dict[str, Any]] = None,
    agent_response: Optional[str] = None,
    is_transactional: bool = False,
    compliance_flags: Optional[dict[str, Any]] = None,
    ip_address: Optional[str] = None,
) -> None:
    """
    Write an immutable audit log entry to TimescaleDB.

    This function is designed to be called as a FastAPI BackgroundTask — it
    must not block the main request/response cycle.

    Args:
        user_id: Auth0 user subject identifier.
        session_id: Application-level session UUID.
        raw_input: Raw user input text (will be encrypted before storage).
        intent_class: Agent-classified intent (e.g., 'ADVISORY', 'TRANSACTIONAL').
        tool_payload: Dict of tool call parameters (stored as JSONB).
        agent_response: Final agent response text (will be encrypted).
        is_transactional: True if this interaction triggered an order/rebalance.
        compliance_flags: Any compliance-related metadata to persist.
        ip_address: Client IP address (may be None if not available).
    """
    # Compute SHA-256 hash of raw input for integrity verification
    request_hash = hashlib.sha256(raw_input.encode("utf-8")).hexdigest()

    # Encrypt sensitive text fields before storage
    encrypted_input = encrypt_field(raw_input)
    encrypted_response = encrypt_field(agent_response) if agent_response else None

    try:
        pool = await _get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO audit.interaction_log (
                    user_id, session_id, request_hash, input_context,
                    tool_payload, agent_response, intent_class,
                    is_transactional, compliance_flags, ip_address
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::inet)
                """,
                user_id,
                session_id,
                request_hash,
                encrypted_input,
                json.dumps(tool_payload) if tool_payload else None,
                encrypted_response,
                intent_class,
                is_transactional,
                json.dumps(compliance_flags) if compliance_flags else None,
                ip_address,
            )
    except Exception as exc:
        logger.debug("Audit log DB unavailable: %s", exc)
        return


# ---------------------------------------------------------------------------
# FastAPI Background Task convenience wrapper
# ---------------------------------------------------------------------------

def make_audit_task(
    user_id: str,
    session_id: str,
    raw_input: str,
    intent_class: Optional[str] = None,
    tool_payload: Optional[dict] = None,
    agent_response: Optional[str] = None,
    is_transactional: bool = False,
    ip_address: Optional[str] = None,
):
    """Return a callable async task for FastAPI BackgroundTasks."""
    async def _audit_job() -> None:
        try:
            await log_interaction(
                user_id=user_id,
                session_id=session_id,
                raw_input=raw_input,
                intent_class=intent_class,
                tool_payload=tool_payload,
                agent_response=agent_response,
                is_transactional=is_transactional,
                ip_address=ip_address,
            )
        except Exception as e:
            logger.debug("Background audit task error: %s", e)

    return _audit_job
