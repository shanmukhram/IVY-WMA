"""Map-driven parser stubs for LINE and Telegram.

These sources are NOT yet mapped: Android LINE is SQLCipher-encrypted with an
unknown schema, and Telegram's cache4.db stores messages as serialized TL blobs,
not plain columns. Per the task and docs/line-android.md we do NOT invent their
schemas. Instead each stub:

  1. detects whether the staged store is plain SQLite or encrypted (by header),
  2. reads its column map from a seeded map file (maps/<source>.map.json),
  3. if the map is not marked `verified`, SKIPS the source and logs
     "pending real-schema verification" — emitting zero rows.

When the owner performs the real on-device extraction (per docs/line-android.md),
they fill the map's `tables` and set `verified: true`; only then would a real
column-driven parse run. Until then these never guess a row into the archive.
"""
from __future__ import annotations

import json
import os

from unified import ParseResult

from .base import log_skip

SQLITE_MAGIC = b"SQLite format 3\x00"


def detect_encryption(path: str) -> str:
    """Return 'plain' if the file starts with the SQLite magic, else 'encrypted'."""
    try:
        with open(path, "rb") as f:
            head = f.read(16)
    except OSError:
        return "unreadable"
    return "plain" if head == SQLITE_MAGIC else "encrypted"


def load_map(map_path: str) -> dict:
    with open(map_path, encoding="utf-8") as f:
        return json.load(f)


def parse_with_map(db_path: str, map_path: str, source_path: str) -> ParseResult:
    """Run the map-driven stub for one store. Always returns a ParseResult; emits
    rows only if the map is verified AND filled (never implemented by guessing)."""
    res = ParseResult()
    if not os.path.isfile(map_path):
        log_skip(source_path, f"no map file at {map_path}")
        return res

    smap = load_map(map_path)
    source = smap.get("source", os.path.basename(map_path))
    enc = detect_encryption(db_path)
    log_skip(source_path, f"{source}: store detected as {enc}")

    if not smap.get("verified", False):
        log_skip(
            source_path,
            f"{source}: pending real-schema verification "
            f"(map verified=false; see docs/line-android.md and docs/findings.md)",
        )
        return res

    # A verified map would drive a real column parse here. We deliberately do NOT
    # implement a guessed parse: reaching this branch requires the owner to have
    # probed the real store and filled maps/<source>.map.json. Until a real schema
    # exists, emitting rows from a guessed map is forbidden (zero guessed rows).
    tables = smap.get("tables", {})
    if not tables.get("messages", {}).get("table"):
        log_skip(
            source_path,
            f"{source}: map marked verified but `tables.messages` is empty — "
            f"refusing to emit rows without a real column map",
        )
        return res

    # Intentionally unreachable until a real, verified, filled map is provided by
    # the owner after on-device probing. Left as an explicit guard, not a guess.
    log_skip(
        source_path,
        f"{source}: verified column-driven parse not implemented in this milestone "
        f"(awaiting owner's real extraction)",
    )
    return res
