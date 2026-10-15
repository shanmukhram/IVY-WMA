#!/usr/bin/env python3
"""Staging check. Runs on the host after `adb pull <out> ./out`.

Reads the manifest, re-checks each file's sha256, and for every plain SQLite database
lists its tables with row counts using Python's stdlib sqlite3 (no external tools).
Encrypted stores are reported as "needs key" - decrypting them is the parser layer.

Usage:  python3 stack.py [./out]
"""
import os, sys, hashlib, sqlite3

stage = sys.argv[1] if len(sys.argv) > 1 else "./out"
manifest = os.path.join(stage, "manifest.tsv")

if not os.path.isfile(manifest):
    sys.exit(f"no manifest at {manifest} (did you pull the staging dir?)")

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def tables_and_counts(path):
    # immutable=1: read the main file without touching -wal/-shm or locks. Recent,
    # not-yet-checkpointed rows may be undercounted here; the real parser folds the WAL.
    uri = f"file:{os.path.abspath(path)}?immutable=1"
    con = sqlite3.connect(uri, uri=True)
    try:
        cur = con.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        tables = [r[0] for r in cur.fetchall()]
        out = []
        for t in tables:
            try:
                cur.execute(f'SELECT count(*) FROM "{t.replace(chr(34), chr(34)*2)}"')
                out.append((t, cur.fetchone()[0]))
            except sqlite3.Error as e:
                out.append((t, f"err:{e}"))
        return out
    finally:
        con.close()

rows, verified, sha_ok, sha_bad, missing = [], 0, 0, 0, 0
with open(manifest, encoding="utf-8") as f:
    f.readline()
    for line in f:
        parts = line.rstrip("\n").split("\t")
        if len(parts) == 5:
            rows.append(parts)

print(f"=== check: {stage} ===\n{len(rows)} manifest rows\n")

for src, staged, b, want_sha, typ in rows:
    if typ == "inventory-only":
        print(f"[media] {src}  {b}  {staged}")
        continue
    p = os.path.join(stage, staged)
    if not os.path.isfile(p):
        print(f"[MISSING] {staged}")
        missing += 1
        continue
    got = sha256(p)
    ok = (got == want_sha)
    sha_ok += ok
    sha_bad += (not ok)
    tag = "sha OK" if ok else f"sha MISMATCH (manifest {want_sha[:12]}.. got {got[:12]}..)"
    print(f"[{typ}] {staged}  {b}B  {tag}")
    if typ == "sqlite-plain" and staged.endswith(".db"):
        try:
            tc = tables_and_counts(p)
            verified += 1
            total = sum(c for _, c in tc if isinstance(c, int))
            print(f"    {len(tc)} tables, {total} rows total")
            for t, c in tc:
                print(f"      {t}: {c}")
        except sqlite3.Error as e:
            print(f"    sqlite open failed: {e}")
    elif typ == "encrypted-or-other" and staged.endswith(".db"):
        print("    encrypted (SQLCipher or non-sqlite) - needs key; handled by the parser layer")

print(f"\nsummary: {verified} plain DBs read, sha OK {sha_ok}, sha bad {sha_bad}, missing {missing}")
if sha_bad or missing:
    sys.exit(1)
