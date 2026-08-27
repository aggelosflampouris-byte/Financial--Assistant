"""
backend/agents/nodes/human_approval.py
========================================
Human-in-the-Loop (HITL) gate node.

This node interrupts the agent graph when a transactional action is detected.
It returns a HITL confirmation request to the frontend without executing
the action. Execution only resumes after the frontend submits a signed
confirmation_token (2FA proof).

LangGraph interrupt pattern:
  The node raises `NodeInterrupt` to pause execution and return state
  to the caller. The graph can be resumed by calling `.invoke()` again
  with the `confirmation_token` in the state.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any

from langgraph.errors import NodeInterrupt

from backend.agents.state import AgentState
from backend.gateway.schemas.compliance import (
    HITLConfirmationRequest,
    RiskWarningLevel,
)

logger = logging.getLogger(__name__)

_CONFIRMATION_WINDOW_MINUTES: int = 5


def human_approval_node(state: AgentState) -> dict[str, Any]:
    """
    LangGraph node: gate transactional actions behind HITL confirmation.

    If `is_transactional` is True and `hitl_confirmed` is False:
      - Generate a HITLConfirmationRequest.
      - Raise NodeInterrupt with the request payload.
      - The graph is suspended; the frontend must POST a confirmation.

    If `hitl_confirmed` is True (graph resumed with confirmation):
      - Validate the confirmation_token is present.
      - Allow the graph to proceed to tool execution.
    """
    is_transactional = state.get("is_transactional", False)
    hitl_confirmed = state.get("hitl_confirmed", False)
    confirmation_token = state.get("confirmation_token")

    # Fast path: not transactional or already confirmed
    if not is_transactional:
        return {"execution_steps": ["human_approval:skipped"]}

    if hitl_confirmed:
        # Resume path — validate that a token was provided
        if not confirmation_token or len(confirmation_token) < 32:
            logger.warning(
                "HITL resume attempted without valid confirmation_token | session=%s",
                state["session_id"],
            )
            return {
                "tool_error": "Human confirmation required but no valid token provided",
                "hitl_required": True,
                "execution_steps": ["human_approval:invalid_token"],
            }
        logger.info(
            "HITL confirmed | session=%s | action_id=%s",
            state["session_id"],
            state.get("hitl_action_id"),
        )
        return {"execution_steps": ["human_approval:confirmed"]}

    # Interrupt path — require confirmation
    action_id = uuid.uuid4()
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=_CONFIRMATION_WINDOW_MINUTES)).isoformat()

    tool_name = state.get("tool_name", "unknown_action")
    tool_input = state.get("tool_input", {})

    hitl_request = HITLConfirmationRequest(
        action_id=action_id,
        session_id=state["session_id"],
        action_type=tool_name,
        action_summary=_build_action_summary(tool_name, tool_input),
        action_payload=tool_input or {},
        risk_level=RiskWarningLevel.HIGH,
        expires_at=expires_at,
    )

    logger.info(
        "HITL interrupt triggered | session=%s | action=%s | action_id=%s",
        state["session_id"],
        tool_name,
        action_id,
    )

    # Interrupt the graph — this propagates back to the API caller
    raise NodeInterrupt(hitl_request.model_dump_json())


def _build_action_summary(tool_name: str, tool_input: dict) -> str:
    """Generate a human-readable description of the pending transactional action."""
    summaries = {
        "execute_order": (
            f"Execute {tool_input.get('side', '?')} order for "
            f"{tool_input.get('amount', '?')} units of {tool_input.get('asset', '?')} "
            f"({tool_input.get('order_type', 'MARKET')} order)"
        ),
        "rebalance_portfolio": (
            f"Rebalance portfolio using {tool_input.get('model', 'MPT')} optimization "
            f"with target risk {tool_input.get('target_risk', '?')}"
        ),
    }
    return summaries.get(tool_name, f"Execute {tool_name} operation")
