"""Parser base: the map-verify-or-skip discipline from docs/line-android.md.

Every parser pins a per-source column map and VERIFIES it against the real DB
before emitting a single row:

  1. required tables exist,
  2. required columns exist on each,
  3. a sample row parses,
  4. a timestamp is plausible.

On any mismatch the parser SKIPS the source and logs the reason (red-on-drift).
Zero guessed rows ever reach the unified model. This mirrors the LINE adapter
discipline: "Nothing is ever guessed into the vault."

Opening discipline: staging DBs are opened READ-ONLY, immutable (no touching of
-wal/-shm or locks), exactly like android/scripts/stack.py. The device-side
snapshot already folded in the WAL when it copied db + -wal + -shm.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import time
from dataclasses import dataclass, field


# Plausible timestamp window for message/call rows, in epoch-milliseconds UTC.
# 2005-01-01 .. (now + ~1 day). Anything outside is treated as a bad column map.
TS_MIN_MS = 1_104_537_600_000
TS_MAX_MS = int((time.time() + 86_400) * 1000)


def log_drift(source: str, reason: str) -> None:
    """Red-on-drift: print a clearly-marked skip reason to stderr.

    ANSI red when stderr is a TTY; plain text otherwise (so logs stay clean).
    """
    msg = f"[DRIFT] skip {source}: {reason}"
    if sys.stderr.isatty():
        sys.stderr.write(f"\x1b[31m{msg}\x1b[0m\n")
    else:
        sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def log_skip(source: str, reason: str) -> None:
    """A non-drift skip (e.g. encrypted store pending verification)."""
    sys.stderr.write(f"[SKIP] {source}: {reason}\n")
    sys.stderr.flush()


class DriftError(Exception):
    """Raised internally when the pinned map does not match the real DB."""


@dataclass
class SourceMap:
    """A pinned schema map for one source DB: which tables and columns the parser
    requires. `required` maps table name -> list of required columns."""

    name: str
    required: dict[str, list[str]] = field(default_factory=dict)


def open_ro(path: str) -> sqlite3.Connection:
    """Open a staged SQLite DB read-only and immutable (no -wal/-shm, no locks)."""
    uri = f"file:{os.path.abspath(path)}?immutable=1"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


def table_columns(con: sqlite3.Connection, table: str) -> list[str]:
    try:
        return [r[1] for r in con.execute(f'PRAGMA table_info("{table}")')]
    except sqlite3.Error:
        return []


def table_exists(con: sqlite3.Connection, table: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def verify_map(con: sqlite3.Connection, smap: SourceMap) -> None:
    """Check every required table/column is present. Raise DriftError on mismatch."""
    for table, cols in smap.required.items():
        if not table_exists(con, table):
            raise DriftError(f"missing table {table!r}")
        have = set(table_columns(con, table))
        missing = [c for c in cols if c not in have]
        if missing:
            raise DriftError(f"table {table!r} missing columns {missing}")


def plausible_ms(ts: int | None) -> bool:
    return ts is not None and TS_MIN_MS <= int(ts) <= TS_MAX_MS
