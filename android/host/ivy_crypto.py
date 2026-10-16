"""At-rest crypto for the host-side archive.

This is the PC-pull processing side of IVY. It encrypts the archive at rest with
AES-256-GCM under a key derived from the owner's passphrase.

Key derivation MATCHES docs/PROTOCOL.md's scheme (section 3.1 / 3.3):

    Argon2id, memory = 65536 KiB (64 MiB), iterations = 3, parallelism = 1,
    salt length = 16 bytes, output length = 32 bytes, Argon2 version 0x13 (19).

This module uses the preferred `cryptography` (AES-256-GCM) and `argon2-cffi`
(Argon2id) packages. Both are present on this PC and the Argon2id derivation here
reproduces docs/test-vectors/argon2id.json byte-for-byte.

FALLBACK (loudly flagged): if `argon2-cffi` cannot be imported, the KDF falls
back to stdlib PBKDF2-HMAC-SHA256. That is a DEVIATION from PROTOCOL.md: an
archive written with the PBKDF2 KDF is NOT interoperable with a PROTOCOL/Argon2id
key and will refuse to decrypt under the Argon2id path. The archive records which
KDF it used (`kdf` in archive.json) so decrypt always uses the right one, and the
deviation is printed on every ingest that uses it.

We never ship a home-grown cipher: AES-256-GCM comes only from `cryptography`. If
`cryptography` is unavailable we refuse rather than weakly encrypt the owner's
backup.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

# AES-256-GCM is required. No home-grown cipher fallback for a backup tool.
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _HAVE_AESGCM = True
except Exception:  # pragma: no cover - environment guard
    _HAVE_AESGCM = False

# Preferred KDF: Argon2id, matching docs/PROTOCOL.md.
try:
    from argon2.low_level import Type as _Argon2Type
    from argon2.low_level import hash_secret_raw as _argon2_raw
    _HAVE_ARGON2 = True
except Exception:  # pragma: no cover - environment guard
    _HAVE_ARGON2 = False

# Normative Argon2id params from PROTOCOL.md section 3.1 (ports MUST match).
ARGON2_MEMORY_KIB = 65536
ARGON2_ITERATIONS = 3
ARGON2_PARALLELISM = 1
ARGON2_SALT_LEN = 16
ARGON2_OUTPUT_LEN = 32
ARGON2_VERSION = 19  # 0x13

# PBKDF2 fallback params (deviation path only).
PBKDF2_ITERATIONS = 600_000

NONCE_LEN = 12  # AES-256-GCM nonce, per PROTOCOL.md section 0.


class CryptoUnavailable(RuntimeError):
    """Raised when AES-256-GCM is not available; we refuse to weakly encrypt."""


@dataclass(frozen=True)
class KdfSpec:
    """How a given archive derived its key, recorded in archive.json so decrypt
    reproduces it regardless of which packages are installed later."""

    algo: str  # "argon2id" (PROTOCOL) or "pbkdf2-hmac-sha256" (fallback)
    salt_hex: str
    memory_kib: int | None = None
    iterations: int | None = None
    parallelism: int | None = None
    output_len: int = ARGON2_OUTPUT_LEN
    version: int | None = None

    def to_json(self) -> dict:
        d = {"algo": self.algo, "saltHex": self.salt_hex, "outputLen": self.output_len}
        if self.algo == "argon2id":
            d.update(
                memoryKiB=self.memory_kib,
                iterations=self.iterations,
                parallelism=self.parallelism,
                version=self.version,
            )
        else:
            d.update(iterations=self.iterations)
        return d

    @staticmethod
    def from_json(d: dict) -> "KdfSpec":
        return KdfSpec(
            algo=d["algo"],
            salt_hex=d["saltHex"],
            memory_kib=d.get("memoryKiB"),
            iterations=d.get("iterations"),
            parallelism=d.get("parallelism"),
            output_len=d.get("outputLen", ARGON2_OUTPUT_LEN),
            version=d.get("version"),
        )


def new_kdf_spec(prefer_argon2: bool = True) -> KdfSpec:
    """Build a KdfSpec for a NEW archive with a fresh random salt.

    Uses Argon2id (PROTOCOL) when available; otherwise the PBKDF2 fallback.
    """
    salt = os.urandom(ARGON2_SALT_LEN)
    if prefer_argon2 and _HAVE_ARGON2:
        return KdfSpec(
            algo="argon2id",
            salt_hex=salt.hex(),
            memory_kib=ARGON2_MEMORY_KIB,
            iterations=ARGON2_ITERATIONS,
            parallelism=ARGON2_PARALLELISM,
            output_len=ARGON2_OUTPUT_LEN,
            version=ARGON2_VERSION,
        )
    # Fallback path.
    return KdfSpec(
        algo="pbkdf2-hmac-sha256",
        salt_hex=salt.hex(),
        iterations=PBKDF2_ITERATIONS,
        output_len=ARGON2_OUTPUT_LEN,
    )


def using_fallback_kdf(spec: KdfSpec) -> bool:
    return spec.algo != "argon2id"


def derive_key(passphrase: str, spec: KdfSpec) -> bytes:
    """Derive the 32-byte archive key from the passphrase and the archive's KDF spec."""
    salt = bytes.fromhex(spec.salt_hex)
    if spec.algo == "argon2id":
        if not _HAVE_ARGON2:
            raise CryptoUnavailable(
                "archive uses Argon2id (PROTOCOL) but argon2-cffi is not installed; "
                "install argon2-cffi to open it"
            )
        return _argon2_raw(
            secret=passphrase.encode("utf-8"),
            salt=salt,
            time_cost=spec.iterations or ARGON2_ITERATIONS,
            memory_cost=spec.memory_kib or ARGON2_MEMORY_KIB,
            parallelism=spec.parallelism or ARGON2_PARALLELISM,
            hash_len=spec.output_len,
            type=_Argon2Type.ID,
            version=spec.version or ARGON2_VERSION,
        )
    if spec.algo == "pbkdf2-hmac-sha256":
        return hashlib.pbkdf2_hmac(
            "sha256",
            passphrase.encode("utf-8"),
            salt,
            spec.iterations or PBKDF2_ITERATIONS,
            dklen=spec.output_len,
        )
    raise CryptoUnavailable(f"unknown KDF algo: {spec.algo!r}")


def encrypt(key: bytes, plaintext: bytes, aad: bytes = b"") -> bytes:
    """AES-256-GCM encrypt. Returns nonce(12) || ciphertext || tag(16)."""
    if not _HAVE_AESGCM:
        raise CryptoUnavailable(
            "AES-256-GCM is unavailable (the `cryptography` package is not installed); "
            "refusing to write a weakly-encrypted archive"
        )
    nonce = os.urandom(NONCE_LEN)
    ct = AESGCM(key).encrypt(nonce, plaintext, aad)
    return nonce + ct


def decrypt(key: bytes, blob: bytes, aad: bytes = b"") -> bytes:
    """AES-256-GCM decrypt of nonce(12) || ciphertext || tag(16)."""
    if not _HAVE_AESGCM:
        raise CryptoUnavailable(
            "AES-256-GCM is unavailable (the `cryptography` package is not installed)"
        )
    if len(blob) < NONCE_LEN + 16:
        raise ValueError("ciphertext too short")
    nonce, ct = blob[:NONCE_LEN], blob[NONCE_LEN:]
    return AESGCM(key).decrypt(nonce, ct, aad)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
