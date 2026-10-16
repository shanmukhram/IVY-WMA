# IVY host-side pipeline (`android/host/`)

The PC-pull processing side (milestones 2-4). It turns a pulled `out/` staging dir
(produced read-only on the device by `android/scripts/stack.sh`) into a searchable,
**encrypted-at-rest** archive. The on-device Kotlin app will mirror this logic
later, so the code is kept clean and documented as the reference.

Runs with **`py -3`** on this PC (not `python`/`python3`).

```
py -3 android/host/ivy_host.py ingest <out_dir> [--archive <dir>]
py -3 android/host/ivy_host.py search "<query>" --archive <dir> [--limit N]
py -3 android/host/ivy_host.py ingest-line-media <export-zip-or-dir> --archive <dir>
py -3 android/host/ivy_host.py ingest-line-media <export-zip-or-dir> --dry-run
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
| `ivy_host.py` | CLI: `ingest` / `search` / `ingest-line-media` |
| `staging.py` | reads `out/manifest.tsv`, locates staged DBs by source path |
| `line_media.py` | folds an exported LINE media tree (zip or dir) into the archive |
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
- **media** `(id, platform, account, chat_id, msg_id, kind, orig_name, ext, bytes,
  sha256, archive_ref, source)` - archived media blobs. Chat attachments carry
  `chat_id`/`msg_id` (the source keys) so each row links to a message once the
  store is parsed; unkeyed media (LINE Keep) has both NULL. `sha256` == `archive_ref`
  (content-addressed). Idempotent via a UNIQUE index on
  `(platform, account, COALESCE(chat_id,''), COALESCE(msg_id,''), sha256)`; an
  index on `(platform, chat_id, msg_id)` serves the message join.
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

## LINE media (externally exported, plaintext)

`line_media.py` + the `ingest-line-media` command fold the owner's externally
exported LINE app files into the archive. The media is **plaintext** (verified by
header), so it needs neither the LINE database nor its key.

Two export shapes are handled, each as a **.zip or an extracted directory**:

- **Chat attachments** (`line_ext`): `.../files/chats/<chatId>/messages/<file>`.
  The `<chatId>` segment (opaque hash; `u`=1:1, `c`=group, `m`=other) and the
  number in the filename become `chat_id`/`msg_id`, so each media row links to its
  message once the LINE store is parsed. Integrity sidecars (`<msgId>-hmac`,
  `<msgId>-hash`) are **counted and skipped**, never archived. The rest of the
  `line_ext` tree (stickers, effects, themes, profile thumbnails) is LINE app
  assets, not conversation attachments, and is ignored.
- **Keep / saved files** (`line_export`): flat, not chat-keyed. Ingested as
  **unkeyed** media (`chat_id`/`msg_id` NULL), `source = line_keep`, kind by
  extension.

Discipline (same as the DB parsers): every chat-media file's **header is verified**
to be a true media type (JPEG/PNG/GIF/PDF/ISO-BMFF/ID3/RIFF/office/...); anything
that is not plaintext media is **skipped and logged red-on-drift** - zero guessed
blobs. Each distinct blob is AES-256-GCM encrypted into the **existing**
content-addressed archive, so identical thumbnails across messages dedup to one
object automatically; `archive_ref` is the object id (== `sha256`). Re-ingest is
idempotent (dedup on `sha256` + keys).

`--dry-run` inventories **without** encrypting or needing a passphrase: it reads
only each file's header (no full-file reads) and prints **counts only** - distinct
chats, counts by kind, keyed vs unkeyed, sidecars skipped, non-media skipped - and
**never** file contents or the names of people. Run it to confirm a real export
reads correctly before folding it in. Fold it in with:

```
py -3 android/host/ivy_host.py ingest-line-media <line_ext.zip or dir> --archive <dir>
```

(passphrase via `IVY_PASSPHRASE` or the prompt, exactly like `ingest`).

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

28 tests, no network, no device: parsing -> unified rows; two distinct WhatsApp
accounts; idempotent re-ingest (no dupes); decision-24 delete keeps the body;
archive encrypt/decrypt round-trip (and wrong-passphrase failure); FTS hits;
red-on-drift (renamed column -> skip, zero rows, logged); LINE/Telegram stubs skip;
an end-to-end ingest+search over the CLI; and the LINE media ingester (chat media
keyed by chat+msg id, sidecars + bogus non-media skipped, blobs archived and
round-trip-decrypted, identical bytes dedup to one object, Keep files ingested
unkeyed, zip and dir sources agree, and a `--dry-run` CLI run needing no passphrase).
