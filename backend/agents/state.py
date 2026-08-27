"""
backend/agents/state.py
========================
TypedDict state definitions for the LangGraph agent graph.

The AgentState flows through all graph nodes as an immutable snapshot.
Each node returns a partial dict which LangGraph merges using the
annotated reducer functions (operator.add for list fields).
"""

from __future__ import annotations

import operator
import uuid
from typing import Annotated, Any, Optional

from langgraph.graph import MessagesState
from pydantic import BaseModel

from backend.gateway.schemas.portfolio import IntentClass


class AgentState(MessagesState):
    """
    Full agent execution state — flows through all LangGraph nodes.

    Fields annotated with `Annotated[list, operator.add]` are appended
    across state updates (LangGraph reducer pattern).
    """

    # --- Session context ---
    session_id: str
    user_id: str
    user_roles: list[str]

    # --- Input ---
    user_message: str
    ip_address: Optional[str]
    current_ticker: Optional[str]

    # --- Intent classification ---
    intent_class: Optional[IntentClass]
    is_transactional: bool

    # --- RAG ---
    rag_context: Annotated[list[str], operator.add]     # Retrieved document chunks
    rag_citations: Annotated[list[str], operator.add]   # Source references

    # --- Tool execution ---
    tool_name: Optional[str]
    tool_input: Optional[dict[str, Any]]
    tool_output: Optional[Any]
    tool_error: Optional[str]

    # --- HITL (Human-in-the-Loop) ---
    hitl_required: bool
    hitl_action_id: Optional[uuid.UUID]
    hitl_confirmed: bool
    confirmation_token: Optional[str]

    # --- Final output ---
    final_response: Optional[str]
    compliance_metadata: Optional[dict]

    # --- Tracing ---
    execution_steps: Annotated[list[str], operator.add]
    error_count: int


def initial_state(
    user_message: str,
    session_id: str,
    user_id: str,
    user_roles: list[str],
    ip_address: Optional[str] = None,
    current_ticker: Optional[str] = "AAPL",
) -> dict:
    """
    Build the initial AgentState dict for a new conversation turn.
    All mutable list fields are initialized to empty to prevent cross-turn leakage.
    """
    return {
        "session_id": session_id,
        "user_id": user_id,
        "user_roles": user_roles,
        "user_message": user_message,
        "ip_address": ip_address,
        "current_ticker": current_ticker or "AAPL",
        "messages": [],
        "intent_class": None,
        "is_transactional": False,
        "rag_context": [],
        "rag_citations": [],
        "tool_name": None,
        "tool_input": None,
        "tool_output": None,
        "tool_error": None,
        "hitl_required": False,
        "hitl_action_id": None,
        "hitl_confirmed": False,
        "confirmation_token": None,
        "final_response": None,
        "compliance_metadata": None,
        "execution_steps": [],
        "error_count": 0,
    }
