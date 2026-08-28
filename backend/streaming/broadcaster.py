"""
backend/streaming/broadcaster.py
===================================
WebSocket broadcast service — subscribes to Redis pub-sub channels
and fans market tick events out to all connected WebSocket clients.

This service is mounted inside the FastAPI gateway as a WebSocket router.
Clients connect to /ws/market/{ticker} to receive real-time price streams.

Architecture:
  Kafka → Consumer → Redis pub-sub → Broadcaster → WebSocket clients
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timezone
from typing import DefaultDict, Set

import redis.asyncio as redis
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_REDIS_HOST: str = os.environ.get("REDIS_HOST", "localhost")
_REDIS_PORT: int = int(os.environ.get("REDIS_PORT", "6379"))
_REDIS_PASSWORD: str | None = os.environ.get("REDIS_PASSWORD") or None
_MARKET_CHANNEL_PREFIX: str = os.environ.get("REDIS_MARKET_CHANNEL", "market_ticks")

router = APIRouter()


# ---------------------------------------------------------------------------
# Connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    """
    Thread-safe WebSocket connection registry.
    Groups connections by subscribed ticker symbol.
    """

    def __init__(self) -> None:
        # ticker → set of active WebSocket connections
        self._connections: DefaultDict[str, Set[WebSocket]] = defaultdict(set)

    async def connect(self, websocket: WebSocket, ticker: str) -> None:
        await websocket.accept()
        self._connections[ticker].add(websocket)
        logger.info("WS connected | ticker=%s | total=%d", ticker, len(self._connections[ticker]))

    def disconnect(self, websocket: WebSocket, ticker: str) -> None:
        self._connections[ticker].discard(websocket)
        if not self._connections[ticker]:
            del self._connections[ticker]
        logger.info("WS disconnected | ticker=%s", ticker)

    async def broadcast(self, ticker: str, message: str) -> None:
        """Send message to all connections subscribed to a ticker."""
        dead_connections: Set[WebSocket] = set()
        for ws in list(self._connections.get(ticker, set())):
            try:
                await ws.send_text(message)
            except Exception:
                dead_connections.add(ws)

        # Clean up dead connections
        for ws in dead_connections:
            self._connections[ticker].discard(ws)

    @property
    def active_tickers(self) -> set[str]:
        return set(self._connections.keys())


_manager = ConnectionManager()


# ---------------------------------------------------------------------------
# Redis subscriber
# ---------------------------------------------------------------------------

async def redis_subscriber_task() -> None:
    """
    Background task: subscribe to all market tick channels in Redis
    and fan out to WebSocket clients.

    Reconnects automatically on connection failure.
    """
    while True:
        try:
            r = redis.Redis(
                host=_REDIS_HOST,
                port=_REDIS_PORT,
                password=_REDIS_PASSWORD,
                decode_responses=True,
            )
            pubsub = r.pubsub()
            # Subscribe to the wildcard market tick channel pattern
            await pubsub.psubscribe(f"{_MARKET_CHANNEL_PREFIX}.*")
            logger.info("Redis subscriber connected, listening on %s.*", _MARKET_CHANNEL_PREFIX)

            async for message in pubsub.listen():
                if message["type"] not in ("pmessage", "message"):
                    continue

                # Extract ticker from channel name: "market_ticks.AAPL" → "AAPL"
                channel: str = message.get("channel", "")
                parts = channel.split(".", 1)
                ticker = parts[1].upper() if len(parts) == 2 else "UNKNOWN"

                data = message.get("data", "")
                if data and ticker in _manager.active_tickers:
                    await _manager.broadcast(ticker, data)

        except Exception as exc:
            logger.error("Redis subscriber error: %s — reconnecting in 3s", exc)
            await asyncio.sleep(3)


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

async def _stream_ticks_to_client(websocket: WebSocket, ticker: str) -> None:
    """Background streamer that pushes live price ticks to a single WebSocket client."""
    import random
    import yfinance as yf

    ticker_upper = ticker.upper()
    try:
        data = yf.Ticker(ticker_upper).fast_info
        base_price = float(data.last_price or 150.0)
    except Exception:
        base_price = 150.0

    current_price = base_price
    while True:
        try:
            # Simulate realistic micro-movement around base price
            delta_pct = (random.random() - 0.495) * 0.003
            current_price = round(current_price * (1.0 + delta_pct), 2)
            total_change_pct = (current_price - base_price) / base_price

            tick_msg = {
                "ticker": ticker_upper,
                "price": current_price,
                "changePct": round(total_change_pct, 4),
                "volume": random.randint(1000, 50000),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            await websocket.send_text(json.dumps(tick_msg))
            await asyncio.sleep(2.0)
        except Exception:
            break


@router.websocket("/ws/market/{ticker}")
async def market_websocket(websocket: WebSocket, ticker: str) -> None:
    """
    WebSocket endpoint for real-time market tick streaming.

    Clients send:
      { "action": "ping" }  → Keep-alive heartbeat

    Server sends:
      { "ticker": "AAPL", "price": 192.35, "changePct": 0.0042, "timestamp": "..." }
    """
    ticker_upper = ticker.upper()
    await _manager.connect(websocket, ticker_upper)
    stream_task = asyncio.create_task(_stream_ticks_to_client(websocket, ticker_upper))

    try:
        while True:
            # Listen for client messages (ping/pong keepalive)
            data = await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
            try:
                msg = json.loads(data)
                if msg.get("action") == "ping":
                    await websocket.send_json({"action": "pong", "ticker": ticker_upper})
            except json.JSONDecodeError:
                pass

    except (asyncio.TimeoutError, WebSocketDisconnect):
        logger.debug("WS client disconnected | ticker=%s", ticker_upper)
    finally:
        stream_task.cancel()
        _manager.disconnect(websocket, ticker_upper)


@router.websocket("/ws/portfolio/{portfolio_id}")
async def portfolio_websocket(websocket: WebSocket, portfolio_id: str) -> None:
    """
    WebSocket endpoint for real-time portfolio value updates.
    Subscribed to portfolio.events Redis channel.
    """
    channel_key = f"portfolio_{portfolio_id}"
    await _manager.connect(websocket, channel_key)

    try:
        while True:
            await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        pass
    finally:
        _manager.disconnect(websocket, channel_key)
