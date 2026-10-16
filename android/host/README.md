# IVY host-side pipeline (`android/host/`)

The PC-pull processing side (milestones 2-4). It turns a pulled `out/` staging dir
(produced read-only on the device by `android/scripts/stack.sh`) into a searchable,
**encrypted-at-rest** archive. The on-device Kotlin app will mirror this logic
later, so the code is kept clean and documented as the reference.

Runs with **`py -3`** on this PC (not `python`/`python3`).

```
py -3 android/host/ivy_host.py ingest <out_dir> [--archive <dir>]
py -3 android/host/ivy_host.py search "<query>" --archive <dir> [--limit N]
```

Passphrase comes from the `IVY_PASSPHRASE` env var, else it is prompted. No network
is used anywhere; the staging inputs are opened read-only.

## What it does

1. **Parse** the staging DBs named in `out/manifest.tsv` into one unified model.
2. **Merge** idempotently into `unified.db` (held in memory).
3. **Encrypt** the unified image into a content-addressed archive (AES-256-GCM,
   key via Argon2id).
4. **Search** the unified messages with FTS5.

## Hard rules kept here

- **Read-only** on the staging inputs; the archive is **encrypted at rest**; **no
  network** anywhere; **generic** file names.
- **Never guess a schema.** Each parser pins a per-source column map and verifies
  it against the real DB (required tables/columns present, a sample row parses, a
  timestamp is plausible). On mismatch the source is **skipped and the reason is
  logged red-on-drift** - zero guessed rows. (The discipline from
  `docs/line-android.md`.)
- A source-side delete only sets `deleted_at_source`; captured content is never
  removed (PLAN decision 24).

## Layout

| File | Role |
| --- | --- |
| `ivy_host.py` | CLI: `ingest` / `search` |
| `staging.py` | reads `out/manifest.tsv`, locates staged DBs by source path |
| `unified.py` | `unified.db` schema, idempotent merge, FTS5 search |
| `archive.py` | content-addressed, AES-256-GCM encrypted blob store |
| `ivy_crypto.py` | Argon2id key derivation + AES-256-GCM (matches `docs/PROTOCOL.md`) |
| `parsers/base.py` | `SourceMap` + `verify_map` + red-on-drift logging |
| `parsers/whatsapp.py` | `msgstore.db` -> messages/chats, `wa.db` -> contacts |
| `parsers/sms.py` | `mmssms.db` `sms` table -> messages |
| `parsers/contacts.py` | `contacts2.db` -> contacts, `calls` table -> call records |
| `parsers/stub.py` | map-driven LINE/Telegram stubs (skip until verified) |
| `maps/line.map.json`, `maps/telegram.map.json` | seeded, `verified: false` |
| `tests/make_fixtures.py` | synthetic SQLite fixtures + a staging dir |
| `tests/test_pipeline.py` | the fixture test suite |

## Unified model (`unified.db`)

- **messages** `(platform, account, chat_id, chat_title, sender_id, sender_name,
  msg_id, ts_utc, body, kind, from_me, deleted_at_source, source_path)` -
  UNIQUE `(platform, account, msg_id)`. `msg_id` is the platform's own id; re-ingest
  merges on it and never duplicates. A delete only sets `deleted_at_source` and
  never wipes a captured `body`.
- **chats** `(platform, account, chat_id, title, kind, source_path)`.
- **contacts** `(platform, account, contact_id, display_name, number, source_path)`.
- **calls** `(platform, account, call_id, number, contact_name, ts_utc, direction,
  duration_s, source_path)`.
- **messages_fts** - FTS5 over `body, sender_name, chat_title`, kept in sync by
  triggers.

`ts_utc` / `deleted_at_source` are epoch-milliseconds UTC. `from_me` is 0/1.

## Archive (encrypted at rest)

Content-addressed: each object is stored under the SHA-256 of its plaintext and
AES-256-GCM encrypted (`nonce(12) || ciphertext || tag(16)`), with the object's
hash bound into the GCM AAD. `archive.json` records the KDF spec, object hashes +
sizes, and named refs (`unified.db` -> hash).

```
<archive>/
  archive.json
  objects/<hh>/<sha256>
```

**Key derivation matches `docs/PROTOCOL.md` section 3.1/3.3:** Argon2id, memory
65536 KiB, iterations 3, parallelism 1, salt 16 B, output 32 B, version 0x13. This
derivation reproduces `docs/test-vectors/argon2id.json` byte-for-byte.

**Fallback (loudly flagged):** if `argon2-cffi` is not installed, the KDF falls
back to stdlib PBKDF2-HMAC-SHA256 - a documented DEVIATION from PROTOCOL, recorded
in `archive.json` (`kdf.algo`) and warned on every ingest. AES-256-GCM comes only
from `cryptography`; we never ship a home-grown cipher - if `cryptography` is
missing, we refuse rather than weakly encrypt. On this PC both packages are
installed, so the Argon2id path is used.

Install the preferred packages:

```
py -3 -m pip install cryptography argon2-cffi
```

## What is mapped vs pending

- **Verified & mapped now:** WhatsApp/WA Business `msgstore.db` + `wa.db`,
  SMS `mmssms.db`, `contacts2.db` (contacts + calls). Documented schemas are in
  `docs/findings.md`.
- **Pending the owner's real on-device extraction:** LINE (`naver_line`,
  SQLCipher, unknown schema) and Telegram (`cache4.db`, TL-blob payloads). The
  stubs detect encryption, read `maps/*.map.json`, and skip with
  "pending real-schema verification" while the maps are `verified: false`. They
  never guess rows. Fill the map and set `verified: true` after probing per
  `docs/line-android.md`.

## Tests

```
py -3 android/host/tests/test_pipeline.py
```

18 tests, no network, no device: parsing -> unified rows; two distinct WhatsApp
accounts; idempotent re-ingest (no dupes); decision-24 delete keeps the body;
archive encrypt/decrypt round-trip (and wrong-passphrase failure); FTS hits;
red-on-drift (renamed column -> skip, zero rows, logged); LINE/Telegram stubs skip;
and an end-to-end ingest+search over the CLI.
