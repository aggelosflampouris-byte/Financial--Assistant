"""
backend/streaming/consumer.py
================================
Kafka consumer — aggregates market ticks into 1-minute OHLCV bars,
persists to TimescaleDB, and publishes aggregated events to Redis pub-sub.

Processing pipeline:
  Kafka (market.ticks) → Consumer → OHLCV aggregation → TimescaleDB + Redis

Uses asyncpg for non-blocking DB writes and aiokafka for async consumption.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import asyncpg
import redis.asyncio as redis
from aiokafka import AIOKafkaConsumer

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_BOOTSTRAP_SERVERS: str = os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
_TICK_TOPIC: str = os.environ.get("KAFKA_TOPIC_MARKET_TICKS", "market.ticks")
_CONSUMER_GROUP: str = os.environ.get("KAFKA_CONSUMER_GROUP", "financial_assistant_cg")
_REDIS_HOST: str = os.environ.get("REDIS_HOST", "localhost")
_REDIS_PORT: int = int(os.environ.get("REDIS_PORT", "6379"))
_REDIS_PASSWORD: str | None = os.environ.get("REDIS_PASSWORD") or None
_REDIS_CHANNEL_PREFIX: str = os.environ.get("REDIS_MARKET_CHANNEL", "market_ticks")

_PG_DSN: str = (
    f"postgresql://{os.environ.get('POSTGRES_USER', 'fa_user')}:"
    f"{os.environ.get('POSTGRES_PASSWORD', '')}@"
    f"{os.environ.get('POSTGRES_HOST', 'localhost')}:"
    f"{os.environ.get('POSTGRES_PORT', '5432')}/"
    f"{os.environ.get('POSTGRES_DB', 'financial_assistant')}"
)

# ---------------------------------------------------------------------------
# In-memory OHLCV bar state
# ---------------------------------------------------------------------------

@dataclass_like := type("OHLCVBar", (), {})  # using dict for simplicity
_bars: dict[str, dict[str, Any]] = defaultdict(lambda: {
    "open": None, "high": None, "low": None, "close": None,
    "volume": 0, "bar_time": None
})


def _update_bar(ticker: str, price: float, volume: int, bar_time: str) -> None:
    """Update the current 1-minute OHLCV bar for a ticker."""
    bar = _bars[ticker]
    if bar["bar_time"] != bar_time:
        # New bar — reset
        bar.update({"open": price, "high": price, "low": price, "close": price,
                    "volume": volume, "bar_time": bar_time})
    else:
        bar["high"] = max(bar["high"], price)
        bar["low"] = min(bar["low"], price)
        bar["close"] = price
        bar["volume"] += volume


async def _persist_bar(conn: asyncpg.Connection, ticker: str, bar: dict) -> None:
    """Write a completed OHLCV bar to TimescaleDB."""
    if not bar["bar_time"]:
        return
    await conn.execute(
        """
        INSERT INTO ohlcv (time, ticker, open, high, low, close, volume, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'kafka_consumer')
        ON CONFLICT (time, ticker) DO UPDATE
        SET high = GREATEST(ohlcv.high, EXCLUDED.high),
            low  = LEAST(ohlcv.low, EXCLUDED.low),
            close = EXCLUDED.close,
            volume = ohlcv.volume + EXCLUDED.volume
        """,
        datetime.fromisoformat(bar["bar_time"]),
        ticker,
        Decimal(str(bar["open"])),
        Decimal(str(bar["high"])),
        Decimal(str(bar["low"])),
        Decimal(str(bar["close"])),
        bar["volume"],
    )


# ---------------------------------------------------------------------------
# Main consumer loop
# ---------------------------------------------------------------------------

async def run_consumer() -> None:
    """
    Main Kafka consumer loop.

    Consumes market ticks, aggregates into OHLCV bars, persists to
    TimescaleDB every 60 seconds, and fans out to Redis pub-sub.
    """
    shutdown_event = asyncio.Event()

    def _handle_signal(signum, _) -> None:
        logger.info("Signal %s received — shutting down consumer", signum)
        shutdown_event.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    # Connect to Redis
    redis_client = redis.Redis(
        host=_REDIS_HOST, port=_REDIS_PORT,
        password=_REDIS_PASSWORD, decode_responses=True,
    )

    # Connect to TimescaleDB
    db_pool = await asyncpg.create_pool(dsn=_PG_DSN, min_size=2, max_size=5)

    consumer = AIOKafkaConsumer(
        _TICK_TOPIC,
        bootstrap_servers=_BOOTSTRAP_SERVERS,
        group_id=_CONSUMER_GROUP,
        auto_offset_reset="latest",
        enable_auto_commit=True,
    )
    await consumer.start()
    logger.info("Kafka consumer started | topic=%s", _TICK_TOPIC)

    last_persist_time = asyncio.get_event_loop().time()
    _PERSIST_INTERVAL = 60.0  # Persist bars every 60 seconds

    try:
        async for message in consumer:
            if shutdown_event.is_set():
                break

            try:
                tick = json.loads(message.value.decode("utf-8"))
                ticker = tick["ticker"]
                price = float(tick["price"])
                volume = int(tick.get("volume", 0))
                ts = tick.get("timestamp", datetime.now(timezone.utc).isoformat())

                # Determine 1-minute bar timestamp
                bar_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                bar_time = bar_dt.replace(second=0, microsecond=0).isoformat()

                _update_bar(ticker, price, volume, bar_time)

                # Publish raw tick to Redis channel for WebSocket fanout
                await redis_client.publish(
                    f"{_REDIS_CHANNEL_PREFIX}.{ticker}",
                    json.dumps(tick),
                )

            except (json.JSONDecodeError, KeyError, ValueError) as exc:
                logger.warning("Malformed tick message: %s", exc)
                continue

            # Periodic bar persistence
            now = asyncio.get_event_loop().time()
            if now - last_persist_time >= _PERSIST_INTERVAL:
                async with db_pool.acquire() as conn:
                    for ticker, bar in list(_bars.items()):
                        try:
                            await _persist_bar(conn, ticker, bar)
                        except asyncpg.PostgresError as exc:
                            logger.error("DB persist failed for %s: %s", ticker, exc)
                last_persist_time = now
                logger.info("OHLCV bars persisted | tickers=%d", len(_bars))

    finally:
        await consumer.stop()
        await db_pool.close()
        await redis_client.aclose()
        logger.info("Consumer shutdown complete")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_consumer())
