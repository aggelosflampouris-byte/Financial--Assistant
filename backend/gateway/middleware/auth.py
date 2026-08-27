"""
backend/gateway/middleware/auth.py
====================================
JWT authentication middleware and RBAC decorators for the FastAPI gateway.

Auth flow:
  1. Client authenticates with Auth0 (OAuth2/OIDC).
  2. Auth0 returns a signed RS256 JWT access token.
  3. FastAPI endpoints validate the token via JWKS endpoint.
  4. User roles are extracted from custom claims for RBAC.

JWKS caching: Public keys are cached with a TTL to avoid rate-limiting Auth0.
"""

from __future__ import annotations

import logging
import os
import time
from enum import Enum
from functools import lru_cache
from typing import Annotated, Optional

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_AUTH0_DOMAIN: str = os.environ["AUTH0_DOMAIN"]
_AUDIENCE: str = os.environ["AUTH0_AUDIENCE"]
_ALGORITHMS: list[str] = os.environ.get("AUTH0_ALGORITHMS", "RS256").split(",")
_JWKS_URL: str = f"https://{_AUTH0_DOMAIN}/.well-known/jwks.json"
_JWKS_CACHE_TTL_SECONDS: int = 3600  # 1 hour


# ---------------------------------------------------------------------------
# Role definitions
# ---------------------------------------------------------------------------

class UserRole(str, Enum):
    """Application roles assigned via Auth0 custom claims."""
    VIEWER = "viewer"        # Read-only portfolio access
    ANALYST = "analyst"      # Full analytics access, no trading
    TRADER = "trader"        # Full access including order execution
    ADMIN = "admin"          # Administrative access

    @classmethod
    def from_string(cls, value: str) -> "UserRole":
        try:
            return cls(value.lower())
        except ValueError:
            return cls.VIEWER  # Fallback to minimal permissions


# ---------------------------------------------------------------------------
# Token payload model
# ---------------------------------------------------------------------------

class TokenPayload(BaseModel):
    """Parsed and validated JWT token payload."""

    model_config = ConfigDict(frozen=True)

    sub: str                          # Auth0 user ID (subject)
    aud: str | list[str]              # Audience claim
    iss: str                          # Issuer claim
    exp: int                          # Expiry (Unix timestamp)
    iat: int                          # Issued at (Unix timestamp)
    email: Optional[str] = None
    roles: list[UserRole] = Field(default_factory=list)

    @classmethod
    def from_claims(cls, claims: dict) -> "TokenPayload":
        """Parse JWT claims dict into a TokenPayload, handling custom Auth0 claims."""
        # Auth0 custom claim namespace for roles
        roles_claim_key = f"https://{_AUTH0_DOMAIN}/roles"
        raw_roles = claims.get(roles_claim_key, [])
        roles = [UserRole.from_string(r) for r in raw_roles]
        return cls(
            sub=claims["sub"],
            aud=claims["aud"],
            iss=claims["iss"],
            exp=claims["exp"],
            iat=claims["iat"],
            email=claims.get("email"),
            roles=roles,
        )


# ---------------------------------------------------------------------------
# JWKS cache
# ---------------------------------------------------------------------------

_jwks_cache: dict[str, object] = {}
_jwks_last_fetched: float = 0.0


def _get_jwks() -> dict:
    """Fetch and cache JWKS public keys from Auth0."""
    global _jwks_last_fetched, _jwks_cache

    now = time.monotonic()
    if _jwks_cache and (now - _jwks_last_fetched) < _JWKS_CACHE_TTL_SECONDS:
        return _jwks_cache  # type: ignore

    try:
        response = httpx.get(_JWKS_URL, timeout=5.0)
        response.raise_for_status()
        _jwks_cache = response.json()
        _jwks_last_fetched = now
        logger.info("JWKS refreshed from Auth0")
        return _jwks_cache  # type: ignore
    except httpx.HTTPError as exc:
        logger.error("Failed to fetch JWKS: %s", exc)
        if _jwks_cache:
            logger.warning("Using stale JWKS cache")
            return _jwks_cache  # type: ignore
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service temporarily unavailable",
        ) from exc


# ---------------------------------------------------------------------------
# Token verification
# ---------------------------------------------------------------------------

_bearer_scheme = HTTPBearer(auto_error=False)


def _dev_user_payload() -> TokenPayload:
    """Return a mock admin user for local development and testing."""
    return TokenPayload(
        sub="auth0|dev-analyst-001",
        aud="https://api.financialassistant.internal",
        iss="https://financial-assistant-dev.auth0.com/",
        exp=int(time.time()) + 86400,
        iat=int(time.time()),
        email="analyst@enterprise.local",
        roles=[UserRole.ADMIN, UserRole.TRADER, UserRole.ANALYST, UserRole.VIEWER],
    )


def _verify_token(token: str) -> TokenPayload:
    """Validate JWT signature and claims using Auth0 JWKS."""
    if os.environ.get("APP_ENV") != "production" and (not token or token.startswith("dev-")):
        return _dev_user_payload()

    jwks = _get_jwks()
    try:
        unverified_header = jwt.get_unverified_header(token)
        rsa_key = _find_rsa_key(jwks, unverified_header.get("kid", ""))
        if not rsa_key:
            if os.environ.get("APP_ENV") != "production":
                return _dev_user_payload()
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token: matching public key not found",
            )

        payload = jwt.decode(
            token,
            rsa_key,
            algorithms=_ALGORITHMS,
            audience=_AUDIENCE,
            issuer=f"https://{_AUTH0_DOMAIN}/",
        )
        return TokenPayload.from_claims(payload)

    except (JWTError, Exception) as exc:
        if os.environ.get("APP_ENV") != "production":
            return _dev_user_payload()
        logger.warning("JWT validation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


# ---------------------------------------------------------------------------
# FastAPI dependency functions
# ---------------------------------------------------------------------------

async def get_current_user(
    credentials: Annotated[Optional[HTTPAuthorizationCredentials], Depends(_bearer_scheme)],
) -> TokenPayload:
    """
    FastAPI dependency: extract and validate JWT from Authorization header.
    In development, falls back to dev user if token is omitted.
    """
    if credentials is None or not credentials.credentials:
        if os.environ.get("APP_ENV") != "production":
            return _dev_user_payload()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return _verify_token(credentials.credentials)


def require_role(*required_roles: UserRole):
    """
    FastAPI dependency factory: enforce minimum role requirement.

    Usage:
        @router.post("/orders/execute")
        async def execute_order(
            user: Annotated[TokenPayload, Depends(require_role(UserRole.TRADER))]
        ):
            ...
    """
    async def role_checker(
        user: Annotated[TokenPayload, Depends(get_current_user)]
    ) -> TokenPayload:
        if not any(r in user.roles for r in required_roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Insufficient permissions. Required: "
                    f"{[r.value for r in required_roles]}"
                ),
            )
        return user

    return role_checker


# Convenience pre-built dependencies
RequireViewer = Depends(require_role(UserRole.VIEWER, UserRole.ANALYST, UserRole.TRADER, UserRole.ADMIN))
RequireAnalyst = Depends(require_role(UserRole.ANALYST, UserRole.TRADER, UserRole.ADMIN))
RequireTrader = Depends(require_role(UserRole.TRADER, UserRole.ADMIN))
RequireAdmin = Depends(require_role(UserRole.ADMIN))
