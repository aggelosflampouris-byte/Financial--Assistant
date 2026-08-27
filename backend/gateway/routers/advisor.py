"""
backend/gateway/routers/advisor.py
====================================
AI Advisor endpoints — chat interface and HITL confirmation handler.

Endpoints:
  POST /advisor/chat      → Run LangGraph agent, return advisory response (SSE stream)
  POST /advisor/confirm   → Submit HITL confirmation token
  GET  /advisor/history   → Retrieve session conversation history
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Annotated, AsyncIterator, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.agents.graph import get_agent_graph
from backend.agents.guardrails import check_input
from backend.agents.state import initial_state
from backend.gateway.middleware.audit import make_audit_task
from backend.gateway.middleware.auth import RequireAnalyst, TokenPayload, get_current_user
from backend.gateway.schemas.compliance import HITLConfirmationResponse

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    """Incoming chat message from the frontend."""
    model_config = ConfigDict(frozen=True)

    message: Annotated[str, Field(min_length=1, max_length=4096)]
    session_id: Annotated[str, Field(min_length=1, max_length=128)]
    current_ticker: Annotated[str, Field(default="AAPL", max_length=10)] = "AAPL"


class ChatResponse(BaseModel):
    """Non-streaming advisory response."""
    model_config = ConfigDict(frozen=True)

    session_id: str
    content: str
    requires_human_confirmation: bool = False
    pending_action_id: str | None = None
    tool_data: object = None
    compliance: dict | None = None
    citations: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# POST /advisor/chat
# ---------------------------------------------------------------------------

@router.post(
    "/chat",
    response_model=ChatResponse,
    summary="Send message to AI advisor",
)
async def advisor_chat(
    request: ChatRequest,
    http_request: Request,
    background_tasks: BackgroundTasks,
    user: Annotated[TokenPayload, RequireAnalyst],
) -> ChatResponse:
    """
    Run the LangGraph agent graph on the user message and return the response.

    Input guardrails are checked before the agent graph runs.
    Output is always wrapped in an AdvisoryResponse with compliance metadata.
    """
    # --- Input guardrail check ---
    guardrail = check_input(request.message)
    if not guardrail.passed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "guardrail_violation",
                "violation_type": guardrail.violation_type,
                "message": guardrail.violation_detail,
            },
        )

    # --- Build initial agent state ---
    ip = http_request.client.host if http_request.client else None
    state = initial_state(
        user_message=request.message,
        session_id=request.session_id,
        user_id=user.sub,
        user_roles=[r.value for r in user.roles],
        ip_address=ip,
        current_ticker=request.current_ticker or "AAPL",
    )

    # --- Run graph ---
    graph = get_agent_graph()
    config = {"configurable": {"thread_id": request.session_id}}

    try:
        final_state = await graph.ainvoke(state, config=config)
    except Exception as exc:
        # Check if it's a HITL interrupt (NodeInterrupt or GraphInterrupt)
        exc_name = type(exc).__name__
        if "Interrupt" in exc_name or hasattr(exc, "value"):
            hitl_payload = None
            if hasattr(exc, "value"):
                hitl_payload = exc.value
            elif hasattr(exc, "args") and exc.args and len(exc.args) > 0:
                first_arg = exc.args[0]
                if isinstance(first_arg, (list, tuple)) and len(first_arg) > 0:
                    interrupt_obj = first_arg[0]
                    hitl_payload = getattr(interrupt_obj, "value", str(interrupt_obj))
                else:
                    hitl_payload = getattr(first_arg, "value", str(first_arg))
            else:
                hitl_payload = str(exc)

            if isinstance(hitl_payload, dict):
                hitl_data = hitl_payload
            else:
                try:
                    hitl_data = json.loads(str(hitl_payload))
                except Exception:
                    hitl_data = {"action_summary": str(hitl_payload)}

            background_tasks.add_task(
                make_audit_task(
                    user_id=user.sub,
                    session_id=request.session_id,
                    raw_input=request.message,
                    intent_class="TRANSACTIONAL",
                    is_transactional=True,
                    ip_address=ip,
                )
            )

            action_summary = hitl_data.get("action_summary") or "Action requires your 2FA confirmation."
            action_id = hitl_data.get("action_id") or str(uuid.uuid4())
            return ChatResponse(
                session_id=request.session_id,
                content=f"⚠️ **Action Requires Confirmation**\n\n{action_summary}\n\nPlease review and confirm with your 2FA authorization token.",
                requires_human_confirmation=True,
                pending_action_id=str(action_id),
                tool_data=hitl_data,
                compliance={"disclaimer_text": hitl_data.get("compliance_note", "Trade execution requires two-factor authorization under MiFID II article 25.")},
            )

        logger.error("Agent graph error: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent processing failed",
        ) from exc

    # --- Parse final response ---
    raw_response = final_state.get("final_response")
    if not raw_response:
        if final_state.get("is_transactional") or final_state.get("hitl_required") or final_state.get("tool_name"):
            action_id = final_state.get("hitl_action_id") or str(uuid.uuid4())
            tool_name = final_state.get("tool_name", "rebalance_portfolio")
            tool_input = final_state.get("tool_input") or {}
            return ChatResponse(
                session_id=request.session_id,
                content=f"⚠️ **Portfolio Rebalancing Awaiting Confirmation**\n\nProposed action `{tool_name}` with parameters: `{json.dumps(tool_input)}`.\n\nPlease submit your 2FA confirmation token to execute the rebalancing plan.",
                requires_human_confirmation=True,
                pending_action_id=str(action_id),
                tool_data=tool_input,
                compliance={"disclaimer_text": "Trade execution requires two-factor authorization under MiFID II article 25."},
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent produced no response",
        )

    try:
        response_data = json.loads(raw_response)
    except json.JSONDecodeError:
        response_data = {"content": raw_response}

    # --- Audit log ---
    background_tasks.add_task(
        make_audit_task(
            user_id=user.sub,
            session_id=request.session_id,
            raw_input=request.message,
            intent_class=str(final_state.get("intent_class", "GENERAL_QA")),
            tool_payload=final_state.get("tool_input"),
            agent_response=response_data.get("content", ""),
            is_transactional=bool(final_state.get("is_transactional", False)),
            ip_address=ip,
        )
    )

    return ChatResponse(
        session_id=request.session_id,
        content=response_data.get("content", ""),
        requires_human_confirmation=response_data.get("requires_human_confirmation", False),
        pending_action_id=response_data.get("pending_action_id"),
        tool_data=final_state.get("tool_output"),
        compliance=final_state.get("compliance_metadata"),
        citations=final_state.get("rag_citations", []),
    )


# ---------------------------------------------------------------------------
# POST /advisor/confirm — HITL confirmation submission
# ---------------------------------------------------------------------------

@router.post(
    "/confirm",
    summary="Submit HITL confirmation token",
    description="Resume a paused transactional agent graph with user confirmation.",
)
async def advisor_confirm(
    confirmation: HITLConfirmationResponse,
    background_tasks: BackgroundTasks,
    user: Annotated[TokenPayload, RequireAnalyst],
) -> ChatResponse:
    """
    Resume the LangGraph graph after HITL confirmation.

    The signed confirmation_token is injected into state, and the graph
    resumes from the human_approval_check interrupt point.
    """
    if not confirmation.approved:
        # User rejected — return cancelled status
        background_tasks.add_task(
            make_audit_task(
                user_id=user.sub,
                session_id=str(confirmation.session_id),
                raw_input=f"HITL rejection for action {confirmation.action_id}",
                intent_class="TRANSACTIONAL",
                is_transactional=True,
            )
        )
        return ChatResponse(
            session_id=str(confirmation.session_id),
            content="Action cancelled. No changes were made to your portfolio.",
            requires_human_confirmation=False,
        )

    # Resume the graph with confirmation
    graph = get_agent_graph()
    config = {"configurable": {"thread_id": str(confirmation.session_id)}}

    resume_state = {
        "hitl_confirmed": True,
        "confirmation_token": confirmation.confirmation_token,
    }

    try:
        final_state = await graph.ainvoke(resume_state, config=config)
    except Exception as exc:
        logger.error("Graph resume failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to execute confirmed action",
        ) from exc

    raw_response = final_state.get("final_response", "{}")
    response_data = json.loads(raw_response) if isinstance(raw_response, str) else {}

    background_tasks.add_task(
        make_audit_task(
            user_id=user.sub,
            session_id=str(confirmation.session_id),
            raw_input=f"HITL confirmation for action {confirmation.action_id}",
            intent_class="TRANSACTIONAL",
            tool_payload={"action_id": str(confirmation.action_id), "confirmed": True},
            agent_response=response_data.get("content", ""),
            is_transactional=True,
        )
    )

    return ChatResponse(
        session_id=str(confirmation.session_id),
        content=response_data.get("content", "Action executed successfully."),
        tool_data=final_state.get("tool_output"),
        compliance=final_state.get("compliance_metadata"),
    )
