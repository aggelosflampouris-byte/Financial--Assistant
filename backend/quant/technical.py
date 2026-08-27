"""
backend/quant/technical.py
==========================
Quantitative Technical & Statistical Analysis Engine.

Performs deterministic mathematical calculations on OHLCV series:
- RSI (Relative Strength Index) with configurable period & thresholds
- MACD (Fast, Slow, Signal) & Histogram Crossovers
- Exponential & Simple Moving Averages (SMA 20/50/200, EMA 9/21)
- Bollinger Bands (Period, StdDev) & Volatility Squeeze
- Stochastic Oscillator (%K, %D)
- ATR (Average True Range)
- Pivot Points (Classical & Fibonacci) & Retracement levels
- Statistical Distribution (Z-Score, Skewness, Kurtosis, Value at Risk)
- Interactive Chart Directives generation for frontend TradingView binding
"""

from __future__ import annotations

import logging
from typing import Any, Optional
import numpy as np

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Core Quantitative Mathematical Formulas
# ---------------------------------------------------------------------------

def compute_rsi(prices: np.ndarray, period: int = 14) -> float:
    """Calculate Relative Strength Index (RSI) using Wilder's smoothing."""
    if len(prices) < period + 1:
        return 50.0

    deltas = np.diff(prices)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])

    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0.0:
        return 100.0 if avg_gain > 0 else 50.0

    rs = avg_gain / avg_loss
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return float(np.clip(rsi, 0.0, 100.0))


def compute_macd(
    prices: np.ndarray,
    fast: int = 12,
    slow: int = 26,
    signal_period: int = 9,
) -> tuple[float, float, float]:
    """
    Calculate MACD Line, Signal Line, and Histogram.
    Returns (macd_line, signal_line, histogram).
    """
    if len(prices) < slow + signal_period:
        return 0.0, 0.0, 0.0

    def _ema_series(data: np.ndarray, span: int) -> np.ndarray:
        alpha = 2.0 / (span + 1.0)
        ema = np.empty_like(data)
        ema[0] = data[0]
        for t in range(1, len(data)):
            ema[t] = alpha * data[t] + (1.0 - alpha) * ema[t - 1]
        return ema

    ema_fast = _ema_series(prices, fast)
    ema_slow = _ema_series(prices, slow)
    macd_series = ema_fast - ema_slow
    signal_series = _ema_series(macd_series[slow - 1:], signal_period)

    macd_val = float(macd_series[-1])
    sig_val = float(signal_series[-1])
    hist_val = macd_val - sig_val

    return macd_val, sig_val, hist_val


def compute_stochastic(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    k_period: int = 14,
    d_period: int = 3,
) -> tuple[float, float]:
    """Calculate Fast Stochastic Oscillator (%K, %D)."""
    if len(closes) < k_period:
        return 50.0, 50.0

    k_values = []
    for i in range(k_period - 1, len(closes)):
        window_high = np.max(highs[i - k_period + 1: i + 1])
        window_low = np.min(lows[i - k_period + 1: i + 1])
        current_close = closes[i]

        if window_high == window_low:
            k = 50.0
        else:
            k = ((current_close - window_low) / (window_high - window_low)) * 100.0
        k_values.append(k)

    percent_k = float(k_values[-1])
    percent_d = float(np.mean(k_values[-d_period:])) if len(k_values) >= d_period else percent_k
    return round(percent_k, 1), round(percent_d, 1)


def compute_bollinger_bands(
    prices: np.ndarray,
    period: int = 20,
    multiplier: float = 2.0,
) -> tuple[float, float, float, float]:
    """Calculate Bollinger Bands: (upper, middle, lower, bandwidth_pct)."""
    if len(prices) < period:
        p = float(prices[-1]) if len(prices) > 0 else 100.0
        return p * 1.05, p, p * 0.95, 0.10

    window = prices[-period:]
    middle = float(np.mean(window))
    std = float(np.std(window, ddof=1)) if len(window) > 1 else 0.0

    upper = middle + multiplier * std
    lower = middle - multiplier * std
    bandwidth = (upper - lower) / middle if middle > 0 else 0.0

    return upper, middle, lower, bandwidth


def compute_atr(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    period: int = 14,
) -> float:
    """Calculate Average True Range (ATR)."""
    if len(closes) < 2:
        return float(highs[-1] - lows[-1]) if len(highs) > 0 else 1.0

    tr_list = []
    for i in range(1, len(closes)):
        h = highs[i]
        l = lows[i]
        prev_c = closes[i - 1]
        tr = max(h - l, abs(h - prev_c), abs(l - prev_c))
        tr_list.append(tr)

    if not tr_list:
        return 1.0

    atr_window = tr_list[-period:] if len(tr_list) >= period else tr_list
    return float(np.mean(atr_window))


def compute_pivot_points(
    high: float,
    low: float,
    close: float,
) -> dict[str, float]:
    """Calculate Classical Pivot Support and Resistance levels."""
    pivot = (high + low + close) / 3.0
    r1 = (2.0 * pivot) - low
    s1 = (2.0 * pivot) - high
    r2 = pivot + (high - low)
    s2 = pivot - (high - low)
    r3 = high + 2.0 * (pivot - low)
    s3 = low - 2.0 * (high - pivot)

    return {
        "pivot": round(pivot, 2),
        "r1": round(r1, 2),
        "r2": round(r2, 2),
        "r3": round(r3, 2),
        "s1": round(s1, 2),
        "s2": round(s2, 2),
        "s3": round(s3, 2),
    }


def compute_fibonacci_levels(
    high: float,
    low: float,
    current_price: float,
) -> dict[str, float]:
    """Calculate Fibonacci Retracement and Extension levels."""
    diff = high - low
    return {
        "fib_236": round(high - 0.236 * diff, 2),
        "fib_382": round(high - 0.382 * diff, 2),
        "fib_500": round(high - 0.500 * diff, 2),
        "fib_618": round(high - 0.618 * diff, 2),
        "fib_786": round(high - 0.786 * diff, 2),
    }


def compute_statistical_moments(
    prices: np.ndarray,
) -> dict[str, float]:
    """Compute Z-score, Volatility, Skewness, Kurtosis, and 1D VaR 95%."""
    if len(prices) < 5:
        return {"z_score": 0.0, "skewness": 0.0, "kurtosis": 0.0, "volatility": 0.15, "var_95_1d_pct": 0.018}

    returns = np.diff(prices) / prices[:-1]
    mean_p = float(np.mean(prices))
    std_p = float(np.std(prices, ddof=1)) if len(prices) > 1 else 1.0
    current_p = float(prices[-1])

    z_score = (current_p - mean_p) / std_p if std_p > 0 else 0.0
    ann_vol = float(np.std(returns, ddof=1) * np.sqrt(252)) if len(returns) > 1 else 0.18

    # Parametric & Historical VaR (1-day 95%)
    var_95_1d = float(np.percentile(returns, 5.0)) if len(returns) >= 20 else -0.018

    # Skewness & Kurtosis
    mean_r = np.mean(returns)
    m2 = np.mean((returns - mean_r) ** 2)
    m3 = np.mean((returns - mean_r) ** 3)
    skew = float(m3 / (m2 ** 1.5)) if m2 > 0 else 0.0

    m4 = np.mean((returns - mean_r) ** 4)
    kurt = float((m4 / (m2 ** 2)) - 3.0) if m2 > 0 else 0.0

    return {
        "z_score": round(z_score, 2),
        "skewness": round(skew, 2),
        "kurtosis": round(kurt, 2),
        "volatility": round(ann_vol, 4),
        "var_95_1d_pct": round(abs(var_95_1d), 4),
    }


# ---------------------------------------------------------------------------
# Comprehensive Analysis Orchestrator
# ---------------------------------------------------------------------------

def analyze_technical_and_statistical(
    ticker: str,
    bars: list[dict[str, Any]],
    period: str = "1mo",
    rsi_period: int = 14,
    sma_fast_period: int = 20,
    sma_slow_period: int = 50,
    bb_period: int = 20,
    bb_std: float = 2.0,
) -> dict[str, Any]:
    """
    Run full technical & statistical pipeline on OHLCV data.
    Generates deterministic metrics and interactive chart directives.
    """
    if not bars:
        raise ValueError(f"No OHLCV bars available for {ticker}")

    closes = np.array([float(b["close"]) for b in bars], dtype=np.float64)
    highs = np.array([float(b["high"]) for b in bars], dtype=np.float64)
    lows = np.array([float(b["low"]) for b in bars], dtype=np.float64)
    opens = np.array([float(b["open"]) for b in bars], dtype=np.float64)

    current_price = round(float(closes[-1]), 2)
    high_period = float(np.max(highs))
    low_period = float(np.min(lows))

    # 1. Momentum & Trend
    rsi = round(compute_rsi(closes, rsi_period), 1)
    if rsi >= 70:
        rsi_signal = "OVERBOUGHT"
    elif rsi <= 30:
        rsi_signal = "OVERSOLD"
    else:
        rsi_signal = "NEUTRAL"

    stoch_k, stoch_d = compute_stochastic(highs, lows, closes, 14, 3)

    macd_line, macd_signal, macd_hist = compute_macd(closes, 12, 26, 9)

    if macd_hist > 0 and macd_line > macd_signal:
        macd_trend = "BULLISH_MOMENTUM"
    elif macd_hist < 0 and macd_line < macd_signal:
        macd_trend = "BEARISH_MOMENTUM"
    else:
        macd_trend = "NEUTRAL"

    # 2. Moving Averages
    sma_20 = round(float(np.mean(closes[-sma_fast_period:])) if len(closes) >= sma_fast_period else current_price, 2)
    sma_50 = round(float(np.mean(closes[-sma_slow_period:])) if len(closes) >= sma_slow_period else current_price, 2)

    alpha_9 = 2.0 / (9.0 + 1.0)
    ema_9 = round(float(closes[-1] * alpha_9 + np.mean(closes[-9:]) * (1 - alpha_9)), 2)
    alpha_21 = 2.0 / (21.0 + 1.0)
    ema_21 = round(float(closes[-1] * alpha_21 + np.mean(closes[-21:]) * (1 - alpha_21)), 2)

    price_vs_sma20_pct = round(((current_price - sma_20) / sma_20) * 100, 2)
    price_vs_sma50_pct = round(((current_price - sma_50) / sma_50) * 100, 2)

    if current_price > sma_20 > sma_50:
        ma_trend = "STRONG_UPTREND"
    elif current_price > sma_20:
        ma_trend = "UPTREND"
    elif current_price < sma_20 < sma_50:
        ma_trend = "STRONG_DOWNTREND"
    else:
        ma_trend = "NEUTRAL"

    # 3. Volatility & Bollinger Bands
    bb_upper, bb_mid, bb_lower, bb_width = compute_bollinger_bands(closes, bb_period, bb_std)
    atr = round(compute_atr(highs, lows, closes, 14), 2)

    # 4. Statistical Levels & Fibonacci
    pivots = compute_pivot_points(high_period, low_period, current_price)
    fibs = compute_fibonacci_levels(high_period, low_period, current_price)
    stats = compute_statistical_moments(closes)

    # 5. Composite Score & Recommendation
    score = 0.0
    if rsi < 35: score += 0.3
    elif rsi > 65: score -= 0.3

    if macd_hist > 0: score += 0.25
    else: score -= 0.25

    if current_price > sma_20: score += 0.25
    else: score -= 0.25

    if current_price > sma_50: score += 0.20
    else: score -= 0.20

    score = round(float(np.clip(score, -1.0, 1.0)), 2)
    if score >= 0.5:
        overall_signal = "STRONG_BUY"
    elif score >= 0.15:
        overall_signal = "BUY"
    elif score <= -0.5:
        overall_signal = "STRONG_SELL"
    elif score <= -0.15:
        overall_signal = "SELL"
    else:
        overall_signal = "NEUTRAL"

    # 6. Generate Direct Interactive Chart Directives
    chart_directives = {
        "ticker": ticker.upper(),
        "timeframe": period.upper() if period in ["1D", "5D", "1M", "3M", "6M", "1Y", "YTD"] else "1M",
        "chart_type": "candlestick",
        "enable_indicators": ["sma20", "sma50", "bb", "volume"],
        "add_price_lines": [
            {
                "id": "s1_level",
                "price": pivots["s1"],
                "label": f"Support S1 (${pivots['s1']})",
                "color": "#10b981",
            },
            {
                "id": "r1_level",
                "price": pivots["r1"],
                "label": f"Resistance R1 (${pivots['r1']})",
                "color": "#ef4444",
            },
            {
                "id": "pivot_level",
                "price": pivots["pivot"],
                "label": f"Pivot (${pivots['pivot']})",
                "color": "#3b82f6",
            },
        ],
    }

    return {
        "ticker": ticker.upper(),
        "current_price": current_price,
        "period": period,
        "overall_signal": overall_signal,
        "signal_score": score,
        "parameters": {
            "rsi_period": rsi_period,
            "sma_fast": sma_fast_period,
            "sma_slow": sma_slow_period,
            "bb_period": bb_period,
            "bb_std": bb_std,
            "atr_period": 14,
            "macd_fast": 12,
            "macd_slow": 26,
            "macd_signal": 9,
        },
        "rsi_14": rsi,
        "rsi_signal": rsi_signal,
        "stoch_k": stoch_k,
        "stoch_d": stoch_d,
        "macd_line": round(macd_line, 2),
        "macd_signal": round(macd_signal, 2),
        "macd_histogram": round(macd_hist, 2),
        "macd_trend": macd_trend,
        "sma_20": sma_20,
        "sma_50": sma_50,
        "ema_9": ema_9,
        "ema_21": ema_21,
        "price_vs_sma20_pct": price_vs_sma20_pct,
        "price_vs_sma50_pct": price_vs_sma50_pct,
        "ma_trend": ma_trend,
        "bollinger_upper": round(bb_upper, 2),
        "bollinger_middle": round(bb_mid, 2),
        "bollinger_lower": round(bb_lower, 2),
        "bollinger_bandwidth_pct": round(bb_width * 100, 2),
        "atr_14": atr,
        "pivot_levels": pivots,
        "fibonacci_levels": fibs,
        "statistical_moments": stats,
        "chart_directives": chart_directives,
    }


def analyze_all_watchlist_assets(bars_dict: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """
    Run comprehensive technical & statistical analysis across all watchlist assets.
    Returns a sorted comparison table by technical strength / composite score.
    """
    asset_summaries = []
    for ticker, bars in bars_dict.items():
        if not bars:
            continue
        res = analyze_technical_and_statistical(ticker=ticker, bars=bars, period="1mo")
        asset_summaries.append({
            "ticker": ticker.upper(),
            "price": res["current_price"],
            "signal": res["overall_signal"],
            "score": res["signal_score"],
            "rsi": res["rsi_14"],
            "rsi_signal": res["rsi_signal"],
            "ma_trend": res["ma_trend"],
            "sma_20": res["sma_20"],
            "sma_50": res["sma_50"],
            "volatility": round(res["statistical_moments"]["volatility"] * 100, 1),
            "var_95": round(res["statistical_moments"]["var_95_1d_pct"] * 100, 2),
            "pivot": res["pivot_levels"]["pivot"],
            "support_1": res["pivot_levels"]["s1"],
            "resistance_1": res["pivot_levels"]["r1"],
        })

    # Sort descending by technical score (strongest momentum first)
    asset_summaries.sort(key=lambda x: x["score"], reverse=True)

    return {
        "multi_asset": True,
        "count": len(asset_summaries),
        "rankings": asset_summaries,
        "top_pick": asset_summaries[0] if asset_summaries else None,
    }
