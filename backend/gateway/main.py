"""
backend/gateway/main.py
========================
FastAPI application factory — API Gateway entrypoint.

Registers:
  - Lifespan context (startup / shutdown hooks)
  - Middleware: CORS, trusted hosts, rate limiting, request ID injection
  - Routers: portfolio, advisor, orders, market
  - Error handlers: structured JSON error responses
  - Health check endpoint
"""

from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

load_dotenv()

from backend.gateway.middleware.audit import close_pool
from backend.gateway.routers import advisor, market, orders, portfolio
from backend.streaming import broadcaster

# ---------------------------------------------------------------------------
# Structured logging configuration
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format='{"time": "%(asctime)s", "level": "%(levelname)s", "logger": "%(name)s", "message": "%(message)s"}',
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# CORS configuration
# ---------------------------------------------------------------------------

_CORS_ORIGINS: list[str] = [
    o.strip()
    for o in os.environ.get("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if o.strip()
]


# ---------------------------------------------------------------------------
# Application lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage application lifecycle resources."""
    logger.info("Starting Financial Assistant API Gateway")
    yield
    logger.info("Shutting down — closing connection pools")
    await close_pool()
    logger.info("Shutdown complete")


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

def create_app() -> FastAPI:
    """Create and configure the FastAPI application instance."""
    app = FastAPI(
        title="Financial Assistant API",
        description=(
            "Enterprise-grade AI-powered Financial Advisor & Portfolio Manager. "
            "All quantitative computations are performed by the Quant Engine. "
            "MiFID II / SEC compliant."
        ),
        version="1.0.0",
        docs_url="/docs" if os.environ.get("APP_ENV") != "production" else None,
        redoc_url="/redoc" if os.environ.get("APP_ENV") != "production" else None,
        lifespan=lifespan,
    )

    # --- Middleware ---
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )

    # Request ID injection
    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    # --- Exception handlers ---
    @app.exception_handler(ValueError)
    async def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
        logger.warning("Validation error: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"detail": str(exc), "type": "validation_error"},
        )

    @app.exception_handler(Exception)
    async def generic_error_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.error("Unhandled exception: %s", exc, exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "Internal server error", "type": "server_error"},
        )

    # --- Routers ---
    app.include_router(portfolio.router, prefix="/portfolio", tags=["Portfolio"])
    app.include_router(advisor.router, prefix="/advisor", tags=["AI Advisor"])
    app.include_router(orders.router, prefix="/orders", tags=["Orders"])
    app.include_router(market.router, prefix="/market", tags=["Market Data"])
    app.include_router(broadcaster.router, tags=["WebSocket Streaming"])

    # --- Root & Health check ---
    @app.get("/", include_in_schema=False)
    async def root() -> JSONResponse:
        return JSONResponse(
            content={
                "service": "Financial Assistant API",
                "version": "1.0.0",
                "docs": "/docs",
                "health": "/health",
            }
        )

    @app.get("/health", include_in_schema=False)
    async def health_check() -> dict[str, str]:
        return {"status": "healthy", "service": "financial-assistant-gateway"}

    return app


# ---------------------------------------------------------------------------
# Application instance (used by uvicorn)
# ---------------------------------------------------------------------------

app = create_app()
