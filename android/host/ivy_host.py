#!/usr/bin/env python3
"""IVY host-side pipeline (PC-pull processing).

Turns a pulled `out/` staging dir (from android/scripts/stack.sh) into a
searchable, encrypted archive:

    ivingest : parse the staging DBs -> unified model -> encrypted archive
    search   : full-text search the unified messages inside the archive

Run with `py -3` on this PC. No network anywhere. Read-only on the staging inputs.
The unified database is held in memory and only its AES-256-GCM-encrypted image is
written to the archive (nothing plaintext at rest).

Usage:
    py -3 ivy_host.py ingest <out_dir> [--archive <dir>]
    py -3 ivy_host.py search <query> [--archive <dir>] [--limit N]

Passphrase: taken from the IVY_PASSPHRASE environment variable, else prompted.

This is the reference for the on-device Kotlin mirror; the logic is kept clean and
documented so it can be ported.
"""
from __future__ import annotations

import argparse
import getpass
import os
import sys
from datetime import datetime, timezone

# Allow running as a script from anywhere: make this dir importable.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from archive import Archive  # noqa: E402
from staging import Staging  # noqa: E402
from unified import UnifiedDB  # noqa: E402
from parsers import contacts as p_contacts  # noqa: E402
from parsers import sms as p_sms  # noqa: E402
from parsers import stub as p_stub  # noqa: E402
from parsers import whatsapp as p_wa  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MAPS_DIR = os.path.join(HERE, "maps")
UNIFIED_REF = "unified.db"

# (source-path suffix in the manifest, account label) for the two WhatsApp accounts.
WA_ACCOUNTS = [
    ("com.whatsapp", "whatsapp"),
    ("com.whatsapp.w4b", "whatsapp_business"),
]


def get_passphrase() -> str:
    pw = os.environ.get("IVY_PASSPHRASE")
    if pw:
        return pw
    return getpass.getpass("archive passphrase: ")


def default_archive_dir(out_dir: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(out_dir)), "archive")


def cmd_ingest(args: argparse.Namespace) -> int:
    out_dir = os.path.abspath(args.out_dir)
    staging = Staging(out_dir)
    archive_dir = os.path.abspath(args.archive or default_archive_dir(out_dir))
    pw = get_passphrase()

    arc = Archive.open_or_create(archive_dir, pw)
    if arc.uses_fallback_kdf():
        sys.stderr.write(
            "\n*** WARNING: archive uses the PBKDF2-HMAC-SHA256 FALLBACK KDF, not\n"
            "*** Argon2id. This DEVIATES from docs/PROTOCOL.md and is not\n"
            "*** interoperable with an Argon2id key. Install argon2-cffi to use the\n"
            "*** PROTOCOL scheme.\n\n"
        )

    # Re-ingest: start from the existing unified image if the archive has one, so
    # merges are idempotent across runs. Otherwise start fresh in memory.
    existing = arc.get_ref_bytes(UNIFIED_REF)
    udb = UnifiedDB.from_bytes(existing) if existing else UnifiedDB.in_memory()

    # --- WhatsApp + WhatsApp Business ---
    for pkg, account in WA_ACCOUNTS:
        ms = staging.find_one(f"{pkg}/databases/msgstore.db")
        if ms:
            r = p_wa.parse_msgstore(ms.abspath(out_dir), account, ms.source)
            udb.ingest(r)
            _report(account + " msgstore", r)
        wa = staging.find_one(f"{pkg}/databases/wa.db")
        if wa:
            r = p_wa.parse_wa_contacts(wa.abspath(out_dir), account, wa.source)
            udb.ingest(r)
            _report(account + " wa.db", r)

    # --- SMS ---
    sms = staging.find_one("mmssms.db")
    if sms:
        r = p_sms.parse_mmssms(sms.abspath(out_dir), sms.source)
        udb.ingest(r)
        _report("sms", r)

    # --- Contacts + calls ---
    c2 = staging.find_one("contacts2.db")
    if c2:
        r = p_contacts.parse_contacts2(c2.abspath(out_dir), c2.source)
        udb.ingest(r)
        _report("contacts2", r)

    # --- LINE / Telegram stubs (skip until the owner's real extraction) ---
    for base, mapfile in (("naver_line", "line.map.json"), ("cache4.db", "telegram.map.json")):
        for e in staging.find_by_basename(base):
            r = p_stub.parse_with_map(
                e.abspath(out_dir), os.path.join(MAPS_DIR, mapfile), e.source
            )
            udb.ingest(r)

    # Store the encrypted unified image; drop the in-memory db.
    image = udb.serialize()
    counts = udb.counts()
    udb.close()
    arc.put_ref_bytes(UNIFIED_REF, image)

    print(f"\n=== ingest complete: {archive_dir} ===")
    print(f"kdf: {arc.kdf.algo}")
    print(
        "unified totals: "
        + ", ".join(f"{k}={v}" for k, v in counts.items())
    )
    return 0


def _report(label: str, r) -> None:
    print(
        f"  [{label}] messages={len(r.messages)} chats={len(r.chats)} "
        f"contacts={len(r.contacts)} calls={len(r.calls)}"
    )


def cmd_search(args: argparse.Namespace) -> int:
    archive_dir = os.path.abspath(args.archive)
    pw = get_passphrase()
    arc = Archive.open(archive_dir, pw)
    image = arc.get_ref_bytes(UNIFIED_REF)
    if image is None:
        sys.exit("archive has no unified.db yet; run `ingest` first")
    udb = UnifiedDB.from_bytes(image)
    try:
        rows = udb.search(args.query, limit=args.limit)
    finally:
        udb.close()

    if not rows:
        print("no matches")
        return 0
    print(f"{len(rows)} match(es):\n")
    for r in rows:
        when = _fmt_ts(r["ts_utc"])
        who = r["sender_name"] or r["sender_id"] or ("me" if r["from_me"] else "?")
        chat = r["chat_title"] or r["chat_id"] or ""
        flag = "  [deleted-at-source]" if r["deleted_at_source"] else ""
        body = (r["body"] or "").replace("\n", " ")
        print(f"[{when}] {r['platform']}/{r['account']} | {chat} | {who}: {body}{flag}")
    return 0


def _fmt_ts(ms) -> str:
    if not ms:
        return "?"
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%SZ"
        )
    except (OverflowError, OSError, ValueError):
        return str(ms)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="ivy_host", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    ing = sub.add_parser("ingest", help="build unified.db + encrypted archive from a staging dir")
    ing.add_argument("out_dir", help="pulled staging dir (contains manifest.tsv)")
    ing.add_argument("--archive", help="archive dir (default: <out_dir>/../archive)")
    ing.set_defaults(func=cmd_ingest)

    se = sub.add_parser("search", help="full-text search the archive's unified messages")
    se.add_argument("query", help="FTS5 query over body/sender_name/chat_title")
    se.add_argument("--archive", required=True, help="archive dir")
    se.add_argument("--limit", type=int, default=50)
    se.set_defaults(func=cmd_search)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
