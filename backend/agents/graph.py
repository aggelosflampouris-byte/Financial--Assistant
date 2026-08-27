"""
backend/agents/graph.py
========================
LangGraph StateGraph definition — the core AI agent orchestration engine.

Graph topology:
  parse_intent
      │
      ├─ ADVISORY / ANALYTICAL ──► retrieve_context ──► call_tool ──► synthesize_response
      │
      ├─ TRANSACTIONAL ──► retrieve_context ──► call_tool ──► human_approval_check
      │                                                              │
      │                                              [confirmed] ──► call_tool ──► synthesize_response
      │                                              [pending]  ──► INTERRUPT (return HITL request)
      │
      └─ GENERAL_QA ──► synthesize_response

All graph instances use MemorySaver for checkpointing, enabling graph resume
after HITL interrupts.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.errors import NodeInterrupt

from backend.agents.nodes.human_approval import human_approval_node
from backend.agents.nodes.parse_intent import parse_intent_node
from backend.agents.nodes.retrieve_context import retrieve_context_node
from backend.agents.nodes.call_tool import call_tool_node
from backend.agents.nodes.synthesize_response import synthesize_response_node
from backend.agents.state import AgentState

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Conditional routing functions
# ---------------------------------------------------------------------------

def route_after_intent(state: AgentState) -> Literal["retrieve_context", "synthesize_response"]:
    """
    After intent classification, decide whether to retrieve context/run tools
    or jump directly to synthesis (for GENERAL_QA).
    """
    from backend.gateway.schemas.portfolio import IntentClass
    intent = state.get("intent_class", IntentClass.GENERAL_QA)

    if intent == IntentClass.GENERAL_QA:
        return "synthesize_response"
    return "retrieve_context"


def route_after_tool(state: AgentState) -> Literal["human_approval_check", "synthesize_response"]:
    """
    After tool selection, route transactional actions through the HITL gate.
    """
    if state.get("is_transactional", False) and not state.get("hitl_confirmed", False):
        return "human_approval_check"
    return "synthesize_response"


def route_after_hitl(state: AgentState) -> Literal["execute_tool", "synthesize_response"]:
    """
    After the HITL gate: if confirmed, proceed to execution; otherwise synthesize error.
    """
    if state.get("hitl_confirmed", False) and not state.get("tool_error"):
        return "execute_tool"
    return "synthesize_response"


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------

def build_agent_graph() -> StateGraph:
    """
    Construct and compile the LangGraph StateGraph.

    Returns a compiled graph with MemorySaver checkpointing for HITL resume.
    """
    builder = StateGraph(AgentState)

    # --- Add nodes ---
    builder.add_node("parse_intent", parse_intent_node)
    builder.add_node("retrieve_context", retrieve_context_node)
    builder.add_node("call_tool", call_tool_node)          # Tool selection + preparation
    builder.add_node("human_approval_check", human_approval_node)  # HITL gate
    builder.add_node("execute_tool", call_tool_node)       # Actual tool execution (post-HITL)
    builder.add_node("synthesize_response", synthesize_response_node)

    # --- Edges ---
    builder.add_edge(START, "parse_intent")

    # Conditional: skip RAG for GENERAL_QA
    builder.add_conditional_edges(
        "parse_intent",
        route_after_intent,
        {
            "retrieve_context": "retrieve_context",
            "synthesize_response": "synthesize_response",
        },
    )

    builder.add_edge("retrieve_context", "call_tool")

    # Conditional: transactional → HITL gate, otherwise → synthesize
    builder.add_conditional_edges(
        "call_tool",
        route_after_tool,
        {
            "human_approval_check": "human_approval_check",
            "synthesize_response": "synthesize_response",
        },
    )

    # Conditional: HITL confirmed → execute, not confirmed → synthesize
    builder.add_conditional_edges(
        "human_approval_check",
        route_after_hitl,
        {
            "execute_tool": "execute_tool",
            "synthesize_response": "synthesize_response",
        },
    )

    builder.add_edge("execute_tool", "synthesize_response")
    builder.add_edge("synthesize_response", END)

    # Compile with MemorySaver for HITL interrupt/resume
    checkpointer = MemorySaver()
    graph = builder.compile(
        checkpointer=checkpointer,
        interrupt_before=["human_approval_check"],  # Pause before HITL node
    )

    logger.info("Agent graph compiled successfully")
    return graph


# ---------------------------------------------------------------------------
# Singleton graph instance
# ---------------------------------------------------------------------------

_agent_graph: StateGraph | None = None


def get_agent_graph() -> StateGraph:
    """Return the singleton compiled agent graph."""
    global _agent_graph
    if _agent_graph is None:
        _agent_graph = build_agent_graph()
    return _agent_graph
