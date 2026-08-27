"""
backend/gateway/middleware/encryption.py
==========================================
AES-256-GCM field-level encryption/decryption utilities.

Uses authenticated encryption to protect sensitive financial data at rest
(portfolio holdings, PII) stored in TimescaleDB. Each encrypted value carries
its own nonce to prevent nonce reuse.

Key derivation:
  - Master key loaded from FIELD_ENCRYPTION_KEY environment variable (base64, 32 bytes).
  - Nonce: 96-bit random, unique per encryption call (stored prepended to ciphertext).

Format: base64( nonce[12] || ciphertext || tag[16] )
"""

from __future__ import annotations

import base64
import json
import os
import secrets
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


# ---------------------------------------------------------------------------
# Key loading — fail fast at import time if misconfigured
# ---------------------------------------------------------------------------

def _load_master_key() -> bytes:
    """Load and validate the AES-256-GCM master encryption key from environment."""
    raw = os.environ.get("FIELD_ENCRYPTION_KEY", "")
    if not raw:
        raise EnvironmentError(
            "FIELD_ENCRYPTION_KEY environment variable is not set. "
            "Generate a 32-byte key: python -c \"import secrets,base64; "
            "print(base64.b64encode(secrets.token_bytes(32)).decode())\""
        )
    try:
        key = base64.b64decode(raw)
    except Exception as exc:
        raise ValueError("FIELD_ENCRYPTION_KEY must be valid base64") from exc

    if len(key) != 32:
        raise ValueError(
            f"FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes (got {len(key)})"
        )
    return key


# Module-level key — loaded once at startup
_MASTER_KEY: bytes = _load_master_key()
_AESGCM: AESGCM = AESGCM(_MASTER_KEY)

# NONCE_SIZE: 96-bit (12 bytes) — GCM recommended nonce length
_NONCE_SIZE: int = 12


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def encrypt_field(plaintext: str) -> str:
    """
    Encrypt a string field with AES-256-GCM.

    Args:
        plaintext: Raw string value to encrypt.

    Returns:
        Base64-encoded string: base64(nonce || ciphertext+tag)
    """
    if not isinstance(plaintext, str):
        raise TypeError(f"plaintext must be str, got {type(plaintext).__name__}")

    nonce = secrets.token_bytes(_NONCE_SIZE)
    ciphertext = _AESGCM.encrypt(nonce, plaintext.encode("utf-8"), associated_data=None)
    # Concatenate: nonce (12 bytes) + ciphertext+tag
    return base64.b64encode(nonce + ciphertext).decode("ascii")


def decrypt_field(encrypted: str) -> str:
    """
    Decrypt an AES-256-GCM encrypted field.

    Args:
        encrypted: Base64-encoded string produced by encrypt_field().

    Returns:
        Decrypted plaintext string.

    Raises:
        ValueError: If the ciphertext is corrupted or the tag fails authentication.
    """
    if not isinstance(encrypted, str):
        raise TypeError(f"encrypted must be str, got {type(encrypted).__name__}")

    try:
        raw = base64.b64decode(encrypted)
    except Exception as exc:
        raise ValueError("Encrypted field is not valid base64") from exc

    if len(raw) < _NONCE_SIZE + 16:  # 16 = GCM tag size minimum
        raise ValueError("Encrypted field is too short to be valid")

    nonce = raw[:_NONCE_SIZE]
    ciphertext = raw[_NONCE_SIZE:]

    try:
        plaintext = _AESGCM.decrypt(nonce, ciphertext, associated_data=None)
    except Exception as exc:
        raise ValueError("Decryption failed — data may be corrupted or key mismatch") from exc

    return plaintext.decode("utf-8")


def encrypt_json(data: Any) -> str:
    """
    Serialize a Python object to JSON and encrypt it.

    Convenience wrapper for encrypting structured data (e.g., portfolio holdings).
    """
    json_str = json.dumps(data, ensure_ascii=True, default=str)
    return encrypt_field(json_str)


def decrypt_json(encrypted: str) -> Any:
    """
    Decrypt an encrypted JSON blob and deserialize it.
    """
    json_str = decrypt_field(encrypted)
    return json.loads(json_str)
