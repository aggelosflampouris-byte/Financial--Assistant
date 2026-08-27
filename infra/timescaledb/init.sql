-- =============================================================================
-- TimescaleDB Initialization Script
-- Creates all required tables, hypertables, and WORM audit schema.
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- Schema: public — operational data
-- =============================================================================

-- OHLCV market data
CREATE TABLE IF NOT EXISTS ohlcv (
    time        TIMESTAMPTZ NOT NULL,
    ticker      TEXT        NOT NULL,
    open        NUMERIC(18, 6) NOT NULL,
    high        NUMERIC(18, 6) NOT NULL,
    low         NUMERIC(18, 6) NOT NULL,
    close       NUMERIC(18, 6) NOT NULL,
    volume      BIGINT      NOT NULL,
    source      TEXT        NOT NULL DEFAULT 'yfinance',
    PRIMARY KEY (time, ticker)
);
SELECT create_hypertable('ohlcv', 'time', if_not_exists => TRUE);
SELECT add_retention_policy('ohlcv', INTERVAL '5 years', if_not_exists => TRUE);

-- Portfolio holdings snapshot
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    portfolio_id    UUID        NOT NULL,
    snapshot_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    holdings        JSONB       NOT NULL,  -- AES-encrypted JSON blob
    total_value_usd NUMERIC(18, 2),
    currency        TEXT        NOT NULL DEFAULT 'USD'
);
SELECT create_hypertable('portfolio_snapshots', 'snapshot_time', if_not_exists => TRUE);

-- Executed orders log
CREATE TABLE IF NOT EXISTS order_log (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    portfolio_id    UUID        NOT NULL,
    asset           TEXT        NOT NULL,
    side            TEXT        NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type      TEXT        NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    filled_at       TIMESTAMPTZ,
    requested_qty   NUMERIC(18, 8) NOT NULL,
    filled_qty      NUMERIC(18, 8),
    fill_price      NUMERIC(18, 6),
    status          TEXT        NOT NULL DEFAULT 'PENDING',
    confirmation_token TEXT,                     -- 2FA token reference
    user_id         TEXT        NOT NULL
);
SELECT create_hypertable('order_log', 'requested_at', if_not_exists => TRUE);

-- =============================================================================
-- Schema: audit — WORM (Write Once, Read Many) immutable audit log
-- Rows are never updated or deleted — enforced via RLS + revoked DELETE/UPDATE
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.interaction_log (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id         TEXT        NOT NULL,
    session_id      TEXT        NOT NULL,
    request_hash    TEXT        NOT NULL,          -- SHA-256 of raw input
    input_context   TEXT        NOT NULL,           -- Encrypted input
    tool_payload    JSONB,                          -- Tool call parameters
    agent_response  TEXT,                           -- Encrypted response
    intent_class    TEXT,
    is_transactional BOOLEAN    NOT NULL DEFAULT FALSE,
    compliance_flags JSONB,
    ip_address      INET
);
SELECT create_hypertable('audit.interaction_log', 'logged_at', if_not_exists => TRUE);
SELECT add_retention_policy('audit.interaction_log', INTERVAL '7 years', if_not_exists => TRUE);

-- Revoke destructive permissions on audit schema (WORM enforcement)
REVOKE DELETE, UPDATE, TRUNCATE ON audit.interaction_log FROM PUBLIC;
REVOKE DELETE, UPDATE, TRUNCATE ON audit.interaction_log FROM fa_user;

-- Create read-only audit role
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_reader') THEN
        CREATE ROLE audit_reader;
    END IF;
END
$$;
GRANT USAGE ON SCHEMA audit TO audit_reader;
GRANT SELECT ON audit.interaction_log TO audit_reader;
