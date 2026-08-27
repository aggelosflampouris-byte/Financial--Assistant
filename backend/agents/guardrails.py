"""
backend/agents/guardrails.py
==============================
Deterministic compliance guardrails for all agent outputs.

Implements two layers of protection:
  1. Input guardrails: reject requests that attempt to elicit unauthorized advice.
  2. Output guardrails: validate that advisory responses contain no self-generated
     numerical claims, and that all tool-validated outputs carry the compliance flag.

References:
  - NeMo Guardrails design patterns
  - Llama-Guard content safety taxonomy
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Guardrail violation types
# ---------------------------------------------------------------------------

class GuardrailViolationType(str, Enum):
    """Classification of guardrail violations."""
    UNAUTHORIZED_ADVICE    = "unauthorized_investment_advice"
    UNVALIDATED_NUMERICS   = "unvalidated_numerical_claim"
    MISSING_DISCLAIMER     = "missing_compliance_disclaimer"
    HARMFUL_CONTENT        = "harmful_financial_content"
    PROMPT_INJECTION       = "prompt_injection_attempt"


@dataclass(frozen=True)
class GuardrailResult:
    """Result of a guardrail check."""
    passed: bool
    violation_type: Optional[GuardrailViolationType] = None
    violation_detail: Optional[str] = None
    sanitized_text: Optional[str] = None


# ---------------------------------------------------------------------------
# Input guardrails
# ---------------------------------------------------------------------------

# Patterns that indicate attempts to bypass compliance guardrails
_INJECTION_PATTERNS: list[re.Pattern] = [
    re.compile(r"ignore\s+(previous|all)\s+instructions", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(?:a\s+)?(?:free|unrestricted)", re.IGNORECASE),
    re.compile(r"act\s+as\s+(?:an?\s+)?(?:uncensored|unfiltered)", re.IGNORECASE),
    re.compile(r"forget\s+(?:your\s+)?(?:rules|guidelines|constraints)", re.IGNORECASE),
    re.compile(r"pretend\s+you\s+(?:have\s+no|don'?t\s+have)\s+restrictions", re.IGNORECASE),
    re.compile(r"jailbreak", re.IGNORECASE),
]

# Patterns indicating requests for specific unauthorized investment advice
_UNAUTHORIZED_ADVICE_PATTERNS: list[re.Pattern] = [
    re.compile(r"guarantee\s+(?:me\s+)?(?:\d+%\s+)?return", re.IGNORECASE),
    re.compile(r"give\s+me\s+a\s+(?:stock\s+)?tip", re.IGNORECASE),
    re.compile(r"tell\s+me\s+(?:exactly\s+)?(?:what|which)\s+(?:stocks?\s+)?to\s+buy", re.IGNORECASE),
    re.compile(r"what\s+will\s+(?:the\s+market|stock\s+prices?)\s+(?:do|be)\s+tomorrow", re.IGNORECASE),
]


def check_input(user_message: str) -> GuardrailResult:
    """
    Validate user input before it enters the agent graph.

    Checks for:
      - Prompt injection attempts (jailbreak patterns)
      - Requests for unauthorized guaranteed investment advice

    Args:
        user_message: Raw user input string.

    Returns:
        GuardrailResult with passed=True if safe, False with violation details otherwise.
    """
    # Check prompt injection
    for pattern in _INJECTION_PATTERNS:
        if pattern.search(user_message):
            logger.warning("INPUT GUARDRAIL: prompt injection detected | pattern=%s", pattern.pattern)
            return GuardrailResult(
                passed=False,
                violation_type=GuardrailViolationType.PROMPT_INJECTION,
                violation_detail="Input contains patterns associated with prompt injection attacks.",
            )

    # Check for unauthorized advice requests
    for pattern in _UNAUTHORIZED_ADVICE_PATTERNS:
        if pattern.search(user_message):
            logger.info("INPUT GUARDRAIL: unauthorized advice pattern detected")
            return GuardrailResult(
                passed=False,
                violation_type=GuardrailViolationType.UNAUTHORIZED_ADVICE,
                violation_detail=(
                    "This system cannot guarantee returns or predict future market movements. "
                    "Please ask for portfolio analysis or historical metrics instead."
                ),
            )

    return GuardrailResult(passed=True)


# ---------------------------------------------------------------------------
# Output guardrails
# ---------------------------------------------------------------------------

# Pattern to detect self-generated numerical claims without citation
# (Numbers appearing in advisory text that aren't cited from tool data)
_UNCITED_NUMBER_PATTERN = re.compile(
    r"\b(\d+\.?\d*)\s*(%|percent|basis\s+points?|bps|x\s+return|xr)\b",
    re.IGNORECASE,
)

_REQUIRED_DISCLAIMER_KEYWORDS = [
    "not constitute financial advice",
    "past performance",
    "capital at risk",
    "consult a qualified",
]


def check_output(
    response_text: str,
    tool_validated: bool,
    compliance_disclaimer: str,
) -> GuardrailResult:
    """
    Validate agent output before it is returned to the user.

    Checks for:
      - Missing compliance disclaimer
      - Unvalidated numerical claims (when tool_validated=False)

    Args:
        response_text: The advisory narrative generated by the LLM.
        tool_validated: Whether a Quant Engine tool provided the numerical data.
        compliance_disclaimer: The compliance disclaimer that will be appended.

    Returns:
        GuardrailResult with sanitized text if minor issues detected.
    """
    issues: list[str] = []

    # Check 1: Disclaimer must be present or appended
    disclaimer_present = any(
        kw.lower() in compliance_disclaimer.lower()
        for kw in _REQUIRED_DISCLAIMER_KEYWORDS
    )
    if not disclaimer_present:
        logger.error("OUTPUT GUARDRAIL: compliance disclaimer missing or incomplete")
        return GuardrailResult(
            passed=False,
            violation_type=GuardrailViolationType.MISSING_DISCLAIMER,
            violation_detail="Compliance disclaimer does not contain required MiFID II language.",
        )

    # Check 2: If not tool-validated, flag any specific percentage claims
    if not tool_validated:
        numerical_matches = _UNCITED_NUMBER_PATTERN.findall(response_text)
        if numerical_matches:
            logger.warning(
                "OUTPUT GUARDRAIL: unvalidated numerical claims detected: %s",
                numerical_matches[:5],
            )
            # Soft violation: annotate rather than block
            issues.append(
                f"Response contains {len(numerical_matches)} numerical claim(s) "
                "without tool validation."
            )

    if issues:
        return GuardrailResult(
            passed=True,  # Soft pass — allow with annotation
            violation_type=GuardrailViolationType.UNVALIDATED_NUMERICS,
            violation_detail="; ".join(issues),
            sanitized_text=response_text,  # No sanitization needed for soft violations
        )

    return GuardrailResult(passed=True)
