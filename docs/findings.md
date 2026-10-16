# IVY source findings & maps — every app, every platform

The single place where everything we learn about each app's local data goes. When you probe an app on any device, **write what you find here, in detail, immediately** — file paths, headers, encryption scheme and key location, schema (tables/columns), content-type codes, attachment/media layout, deletion-residue surfaces, coverage and version-drift notes, and the dead ends you ruled out. The point is that **nobody digs the same hole twice.**

Rules:
- **Content-free:** record schema, counts, tags, and key *locations* — never message bodies, contact names, or media content — in this committed file.
- **Record negatives too:** "tried X, doesn't work, here's why" is as valuable as a win.
- **Don't trust stale entries:** verify on the real device/version and update the entry (note the version you verified against). Store schemas and key locations move between app versions.
- Method and worked example for conversation stores: `docs/line-android.md`. Architecture context: `docs/android.md`, `docs/CONTEXT.md`.

Status legend: **not probed** → **probed** (files/headers known) → **mapped** (schema + key understood) → **verified** (map checked against a live store, reading cleanly).

---

## Template — copy this block for each app × platform

```
### <App> — <Platform> (<status>, verified against <app version / OS>, <date>)
- Package / app:
- Store files & locations:
- Encryption & key: (scheme; key location; how obtained; KDF/params)
- Snapshot notes: (what to copy together; live-read hazards)
- Schema: (tables, key columns) — or pointer to a detailed map file
- Content-type codes:
- Attachments & media: (how referenced in the row; where the files live on disk)
- Deleted / residue surfaces: (FTS index, tombstone flags, freelist/WAL slack — what survives)
- Coverage & drift notes: (what's complete vs partial; what breaks on app update)
- Tool used: (path to the probe/inspector)
- Dead ends ruled out:
```

---

## LINE

### LINE — Windows (mapped & verified, LINE for Windows 26.x, Oct 2026)
- Package / app: LINE for Windows (classic installer; data under `%LocalAppData%\LINE`).
- Store files: `…\LINE\Data\db\qw<hex>.edb` — one chat store per account; the logged-in account's store is the one with a `-wal` sidecar. Also `keep_<hex>.edb`, `chatStats_<hex>.edb`, `album_<hex>.edb` per account.
- Encryption & key: **wxSQLite3 AES-128-CBC** (page cipher). Key = a 32-hex passphrase from LINE's server, held in LINE's process memory while logged in; captured once and kept in DPAPI at `%LocalAppData%\IVY\keys\line-key.bin`; never uploaded. Per-page key/IV derived (MD5/RC4 chain); implemented in `windows/Ivy.Collectors/Line/LineWxCipher.cs`.
- Snapshot notes: copy `.edb` + `-wal` + `-shm`; fold the WAL in; read the copy, never the live file.
- Schema: **34 tables.** IVY reads `_message`, `_chat`, `_chatOption`, `_contact`, `_profile`, `_groupChat`, `_room`, `_squareChat`, `_setting`. **Full per-table/column/tag dump → `windows/tools/disposable/line.md` §7.**
- Content-type codes (`_message._contentType`): 0 text, 1 image, 2 video, 6 call, 7 sticker, 17 + 22 rich/flex (unmapped→"other"); call metadata in `_contentMetadata` (`TYPE/RESULT/CAUSE/DURATION/SESSION_ID`).
- Attachments & media: referenced by `_contentMetadata` (`OID`/`SID`/`DOWNLOAD_URL`/`PREVIEW_URL`) and `_contentInfo` (`keyMaterial` = 32-byte AES key for the **server/obs** copy, `thumbPath` = local `.eimg` path). On Windows the **originals are server-side**; the local `/m/` cache is `.eimg` (encrypted, separate key — not recoverable locally); a second `/e/` cache holds some **plaintext** JPEG previews. Details: `line.md` §8–§9.
- Deleted / residue: **Unsend clears `_message._text` but NOT the `_message_fts` full-text index** — wiped text recovered via `_message_fts_content.c0_text` by docid. Details: `line.md` §10.
- Coverage & drift: Windows holds only a **recent rolling window** (partial by design, WL2); complete history comes from Android. Map pinned per version, re-verified every run; red-with-reason on drift.
- Tool used: `windows/tools/disposable/LineDiag/` (read-only, reuses the collector crypto).
- Dead ends ruled out: `keyMaterial` does **not** decrypt the local `.eimg` under any key-derivation × IV × mode (CTR/OFB/CFB/CBC/ECB/GCM) — exhaustively tested, 0 hits; the `.eimg` uses a separate local key not in the store.

### LINE — Android (not probed)
- Starting points (verify on device; see `docs/line-android.md` for the method):
  - Store files: `/data/data/jp.naver.line.android/databases/` — `chat.db` (+`-wal`/`-shm`), `square_history.db`, `contacts.db`; older builds used `naver_line`.
  - Encryption & key: **SQLCipher-family** (not wxSQLite3). Key in the app's private data; **location moves per version** — pin per version, extract with root, hold in memory only.
  - Media: **real files on disk** — app-private under `/data/data/jp.naver.line.android/`; user-visible under `/storage/emulated/0/Pictures/LINE/` and Keep. (Recoverable, unlike Windows.)
  - Deleted/residue: check for an FTS index not purged on unsend, tombstone flags, freelist/WAL slack.
- Everything else: **TODO — probe and fill using the template above.**
- **Host-side status:** a map-driven stub exists (`android/host/parsers/stub.py` + `android/host/maps/line.map.json`, `verified: false`). It detects encryption by header and **skips with "pending real-schema verification"**, emitting zero rows. No LINE schema is invented. After probing a real store (per `docs/line-android.md`), fill `maps/line.map.json.tables` and set `verified: true`.

### LINE — Android chat media (external export) (verified against the owner's own LINE export, Oct 2026)
- **Finding:** LINE's chat attachment media is **plaintext on disk** and the owner exported it externally, so it is **ingestible without the LINE database or its SQLCipher key.** The DB is still needed later for message text, sender/timestamps, and to resolve which attachment belongs to which message body — but the media blobs themselves need neither.
- **Chat-media export layout (`line_ext` tree):** `.../files/chats/<chatId>/messages/<file>`.
  - `<chatId>` is an **opaque id** (no personal name): prefix `u` = 1:1, `c` = group, `m` = other.
  - `<file>` is `<msgId>.<ext>` (e.g. `5012.thumb`, `1946.jpg`) or `voice_<msgId>.aac` for voice notes. **msgId = the number in the filename**, which matches LINE's own message id — so media **keys to a message by (chat_id, msg_id)** once the store is parsed.
  - **Plaintext media verified by header:** `.jpg`/`.thumb` = JPEG (`FF D8 FF`), `.png` = PNG, `.gif` = GIF, `.pdf` = `%PDF`, `.aac`/`.mp4`/`.m4a` = ISO-BMFF (`ftyp`), office `.docx/.pptx/.xlsx` = ZIP (`PK`), legacy `.doc` = OLE. `.thumb` files are plain JPEG thumbnails.
  - **Integrity sidecars:** `<msgId>-hmac` and `<msgId>-hash` are 32-byte integrity files next to the media. **Not media** - counted and skipped, never archived.
  - **App assets, not attachments:** the rest of the `line_ext` tree (`files/Effect/`, `files/old_sticon/`, `files/theme/`, `files/mp/`, `files/storage/`, `group_default_profile/`, `storage/g/`) is LINE's own UI assets (stickers, effects, themes, profile thumbnails) - ignored by the chat-media ingester.
- **Keep export layout (`line_export` tree):** the owner's LINE Keep / saved files, **flat (not chat-keyed)**: PDFs, images, documents (+ a few in one-level subdirs). Ingested as **unkeyed** media (`chat_id`/`msg_id` NULL), `source = line_keep`, kind by extension.
- **Real-export inventory (content-free, dry-run, counts only):**
  - `line_ext`: **295 chats** (u=253, c=40, m=2); **7630 ingestible media files** (thumbnail 5298, image 2017, audio 165, document 143, video 7); **769 sidecars** skipped; **2 non-media** skipped red-on-drift (one `.mp4a`, one `.thumb` whose header is not a true JPEG); 6106 non-chat app assets ignored.
  - `line_export`: **67 Keep files** (document 39, image 25, video 1, other 2), all unkeyed.
- **Host-side tooling:** `android/host/line_media.py` + the `ingest-line-media` CLI (zip **or** dir input). Verifies each chat-media header is true plaintext media (red-on-drift on anything else - zero guessed blobs), encrypts each **distinct** blob into the existing content-addressed archive (identical thumbnails dedup to one object), and records a `media` row keyed by (platform, chat_id, msg_id). Idempotent (dedup on sha256 + keys). A `--dry-run` inventories without encrypting or needing a passphrase, counts only, never printing file contents or names.
- **Dead ends / notes:** the `-hmac`/`-hash` sidecars were **not** treated as media; the app-asset directories were **not** ingested as chat attachments; a `.mp4a` and a `.thumb` on the real device failed header verification and were skipped rather than guessed.

---

## Telegram

### Telegram — Windows (collector built; see repo)
- `tdata` (local key + auth key + DC) read via `windows/Ivy.Collectors/Telegram/`; MTProto client over that session; full cloud-chat history. Not an on-disk SQLite dig like LINE. Fill schema/notes here if deeper mapping is done.

### Telegram — Android (not probed)
- Starting points: `/data/data/org.telegram.messenger/files/` — one SQLite DB per account (`dbN`), plus `cacheN.db`. **Plain SQLite** with no passcode; **encrypted** (passcode-derived key, params in shared_prefs) if a passcode is set. Media in `/storage/emulated/0/Telegram/`.
- **Key difference from the other SQLite sources:** Telegram stores messages as **serialized MTProto/TL binary blobs** inside the DB, not as plain text columns — so there is no simple column map to pin; decoding needs a TL reader. The file being "plain SQLite" does not make the message bodies readable.
- **Host-side status:** a map-driven stub exists (`android/host/parsers/stub.py` + `android/host/maps/telegram.map.json`, `verified: false`). It detects plain-vs-encrypted and **skips with "pending real-schema verification"**, emitting zero rows. No Telegram schema is invented.
- **TODO — probe and fill** (locate `dbN`/`cache4.db`, decide TL decoding vs cache reading).

---

## WhatsApp & WhatsApp Business

### WhatsApp — Android (mapped from documentation; host parser pins + verifies; fixture-tested; real-device verification pending the milestone-1 run)
- Package: `com.whatsapp`. Live store `/data/data/com.whatsapp/databases/msgstore.db` (+`-wal`/`-shm`) — **plaintext SQLite under root**; contacts in `wa.db`. Encrypted backups `.crypt14`/`.crypt15` under `/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Databases/`; backup keys `/data/data/com.whatsapp/files/key` and `/files/encrypted_backup.key`. Media under `/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/`. Prefer the live store over the backup (backup lags).
- **Schema pinned by the host parser** (`android/host/parsers/whatsapp.py`, modern normalized schema, WhatsApp 2021+). Required tables/columns (verified every run; red-on-drift on mismatch):
  - `message`: `_id`, `chat_row_id`, `from_me` (0/1), `key_id` (the platform message id → `msg_id`), `sender_jid_row_id`, `timestamp` (epoch-ms), `message_type` (0 text, else media), `text_data` (body).
  - `chat`: `_id`, `jid_row_id`, `subject` (group title).
  - `jid`: `_id`, `user`, `server` (`s.whatsapp.net` dm / `g.us` group), `raw_string` (the conversation/sender jid → `chat_id`/`sender_id`).
  - Joins: `message.chat_row_id`→`chat._id`, `chat.jid_row_id`→`jid._id`, `message.sender_jid_row_id`→`jid._id`.
- `message_type` → kind map (parser): 0 text, 1 image, 2 audio, 3 video, 4 contact, 5 location, 9 document, 13 gif, 20 sticker, 7/15 system; unmapped → `other`.
- **Deletion surface:** `message_revoked.message_row_id` lists revoked rows ("This message was deleted"). msgstore records no separate deletion time, so the parser marks `deleted_at_source` using the message's own `timestamp` (decision 24: the row + captured body are kept, only the flag is set). `message_revoked` is optional (not required for verification).
- **Old schema (drift):** pre-2021 builds used a single `messages` table (`key_remote_jid`, `key_from_me`, `data`, `media_wa_type`, …). The pinned modern map does **not** match it, so such a store is skipped red-on-drift — map it separately if a device is on an old build.
- `wa.db` contacts: `wa_contacts` with `jid` (→ `contact_id`), `display_name`, `number` (all required).

### WhatsApp Business — Android (mapped from documentation; same schema as WhatsApp; fixture-tested; real-device verification pending)
- Package: `com.whatsapp.w4b` — a **separate second account**. Mirrors the same layout under its own package (`/data/data/com.whatsapp.w4b/databases/msgstore.db`, `/storage/emulated/0/Android/media/com.whatsapp.w4b/…`). Capture as a distinct account.
- The host parser reads it with the **same pinned msgstore/wa.db map** as WhatsApp but tags rows `account = whatsapp_business` (`platform = whatsapp`), so the two accounts never merge. Distinct-account handling is fixture-tested.

---

## Instagram — Android (not probed)
- DMs via the root database **where the schema is stable**; otherwise notification-only. Package `com.instagram.android`. **TODO — locate the DM store and assess schema stability, then fill.**

---

## SMS / MMS — Android (SMS mapped from the AOSP contract; host parser pins + verifies; fixture-tested; real-device verification pending)
- `/data/data/com.android.providers.telephony/databases/mmssms.db`; MMS parts under `app_parts/`. Plain SQLite under root; stable AOSP contract.
- **`sms` table pinned by the host parser** (`android/host/parsers/sms.py`). Required columns: `_id` (→ `msg_id`), `thread_id` (→ `chat_id`), `address` (other party's number; sender for inbox, recipient for sent), `date` (epoch-ms), `body`, `type`. `type`: 1 inbox (received), 2 sent, 3 draft, 4 outbox, 5 failed, 6 queued; the parser sets `from_me = 1` for types {2,4,5,6}.
- **MMS not yet mapped:** image/group MMS lives in separate `pdu`/`part` tables — out of scope for the current parser (only `sms` is read). TODO when a real device shows the MMS layout.

---

## Contacts & Calls — Android (mapped from the AOSP contract; host parser pins + verifies; fixture-tested; real-device verification pending)
- `/data/data/com.android.providers.contacts/databases/contacts2.db` — contacts plus the `calls` table; also the **identity spine** to resolve the same person across apps (AC2d). Stable AOSP contract.
- **Pinned by the host parser** (`android/host/parsers/contacts.py`), two independent maps so a drift in one does not suppress the other:
  - Contacts: `raw_contacts` (`_id` → `contact_id`, `display_name`), `data` (`raw_contact_id`, `mimetype_id`, `data1`), `mimetypes` (`_id`, `mimetype`). Numbers are the `data1` of rows whose `mimetype_id` is the id of `vnd.android.cursor.item/phone_v2` in `mimetypes`.
  - Calls (AOSP CallLog `calls` table): `_id` (→ `call_id`), `number`, `date` (epoch-ms), `duration` (seconds), `type`, optional `name`. `type` → direction: 1 incoming, 2 outgoing, 3 missed, 4 voicemail, 5 rejected, 6 blocked; unknown → `unknown`.
- **Drift note:** on some Android builds the call log moved to a separate `calllog.db`; if `contacts2.db` has no `calls` table the calls map skips red-on-drift while contacts still parse. Map `calllog.db` separately if a device shows it there.

---

## Snapchat — Android
- Notification-only by decision (no readable history). Coverage says so. Nothing to probe.
