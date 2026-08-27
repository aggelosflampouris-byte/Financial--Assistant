"""
backend/streaming/producer.py
================================
Market data Kafka producer — polls yfinance for live prices and publishes
tick events to the configured Kafka topic.

Topics produced:
  - market.ticks: Individual price ticks per ticker symbol.
  - portfolio.events: Aggregated portfolio value changes.

Kafka message schema (JSON):
{
  "ticker": "AAPL",
  "price": 192.35,
  "change_pct": 0.0042,
  "volume": 12345678,
  "timestamp": "2024-01-15T14:30:00.000Z",
  "source": "yfinance"
}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import time
from datetime import datetime, timezone
from typing import Any

import yfinance as yf
from aiokafka import AIOKafkaProducer

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_BOOTSTRAP_SERVERS: str = os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
_TICK_TOPIC: str = os.environ.get("KAFKA_TOPIC_MARKET_TICKS", "market.ticks")
_POLL_INTERVAL: float = float(os.environ.get("MARKET_TICK_INTERVAL_SECONDS", "5"))

_DEFAULT_TICKERS: list[str] = [
    t.strip()
    for t in os.environ.get(
        "MARKET_DEFAULT_TICKERS",
        "AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA,SPY,QQQ,BRK-B"
    ).split(",")
    if t.strip()
]

# ---------------------------------------------------------------------------
# Previous price cache for change calculation
# ---------------------------------------------------------------------------

_prev_prices: dict[str, float] = {}


async def _produce_ticks(producer: AIOKafkaProducer, tickers: list[str]) -> None:
    """Fetch latest prices from yfinance and publish to Kafka."""
    try:
        data = yf.download(
            tickers,
            period="1d",
            interval="1m",
            progress=False,
            auto_adjust=True,
        )

        if data.empty:
            logger.warning("yfinance returned empty data for tickers: %s", tickers)
            return

        close_col = "Close"
        volume_col = "Volume"

        for ticker in tickers:
            try:
                if len(tickers) > 1:
                    latest_close = float(data[close_col][ticker].dropna().iloc[-1])
                    latest_volume = int(data[volume_col][ticker].dropna().iloc[-1])
                else:
                    latest_close = float(data[close_col].dropna().iloc[-1])
                    latest_volume = int(data[volume_col].dropna().iloc[-1])

                prev_price = _prev_prices.get(ticker, latest_close)
                change_pct = (latest_close - prev_price) / prev_price if prev_price != 0 else 0.0
                _prev_prices[ticker] = latest_close

                tick: dict[str, Any] = {
                    "ticker": ticker,
                    "price": round(latest_close, 4),
                    "change_pct": round(change_pct, 6),
                    "volume": latest_volume,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "source": "yfinance",
                }

                await producer.send_and_wait(
                    topic=_TICK_TOPIC,
                    key=ticker.encode("utf-8"),
                    value=json.dumps(tick).encode("utf-8"),
                )
                logger.debug("Published tick: %s @ %.2f", ticker, latest_close)

            except (KeyError, IndexError) as exc:
                logger.warning("Failed to get price for %s: %s", ticker, exc)

    except Exception as exc:
        logger.error("Tick production error: %s", exc, exc_info=True)


async def run_producer(tickers: list[str] | None = None) -> None:
    """
    Main producer loop — continuously polls yfinance and publishes to Kafka.
    Handles graceful shutdown on SIGTERM/SIGINT.
    """
    active_tickers = tickers or _DEFAULT_TICKERS
    logger.info(
        "Starting market data producer | tickers=%s | interval=%.1fs",
        active_tickers,
        _POLL_INTERVAL,
    )

    shutdown_event = asyncio.Event()

    def _handle_signal(signum, frame) -> None:
        logger.info("Received signal %s — initiating graceful shutdown", signum)
        shutdown_event.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    producer = AIOKafkaProducer(
        bootstrap_servers=_BOOTSTRAP_SERVERS,
        acks="all",           # Strongest durability guarantee
        compression_type="gzip",
        enable_idempotence=True,
    )

    await producer.start()
    logger.info("Kafka producer started → %s", _BOOTSTRAP_SERVERS)

    try:
        while not shutdown_event.is_set():
            start = time.monotonic()
            await _produce_ticks(producer, active_tickers)
            elapsed = time.monotonic() - start
            sleep_duration = max(0.0, _POLL_INTERVAL - elapsed)
            await asyncio.sleep(sleep_duration)
    finally:
        await producer.stop()
        logger.info("Kafka producer stopped")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_producer())
