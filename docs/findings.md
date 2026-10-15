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

---

## Telegram

### Telegram — Windows (collector built; see repo)
- `tdata` (local key + auth key + DC) read via `windows/Ivy.Collectors/Telegram/`; MTProto client over that session; full cloud-chat history. Not an on-disk SQLite dig like LINE. Fill schema/notes here if deeper mapping is done.

### Telegram — Android (not probed)
- Starting points: `/data/data/org.telegram.messenger/files/` — one SQLite DB per account (`dbN`), plus `cacheN.db`. **Plain SQLite** with no passcode; **encrypted** (passcode-derived key, params in shared_prefs) if a passcode is set. Media in `/storage/emulated/0/Telegram/`.
- **TODO — probe and fill.**

---

## WhatsApp & WhatsApp Business

### WhatsApp — Android (not probed)
- Package: `com.whatsapp`. Live store `/data/data/com.whatsapp/databases/msgstore.db` (+`-wal`/`-shm`) — **plaintext SQLite under root**; contacts in `wa.db`. Encrypted backups `.crypt14`/`.crypt15` under `/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Databases/`; backup keys `/data/data/com.whatsapp/files/key` and `/files/encrypted_backup.key`. Media under `/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/`. Prefer the live store over the backup (backup lags).
- **TODO — probe and fill.** (Best-documented store; "This message was deleted" tombstone is the deletion surface to check.)

### WhatsApp Business — Android (not probed)
- Package: `com.whatsapp.w4b` — a **separate second account**. Mirrors the same layout under its own package (`/data/data/com.whatsapp.w4b/databases/msgstore.db`, `/storage/emulated/0/Android/media/com.whatsapp.w4b/…`). Capture as a distinct account.
- **TODO — probe and fill.**

---

## Instagram — Android (not probed)
- DMs via the root database **where the schema is stable**; otherwise notification-only. Package `com.instagram.android`. **TODO — locate the DM store and assess schema stability, then fill.**

---

## SMS / MMS — Android (not probed)
- `/data/data/com.android.providers.telephony/databases/mmssms.db`; MMS parts under `app_parts/`. Plain SQLite under root; stable AOSP contract. **TODO — probe and fill.**

---

## Contacts & Calls — Android (not probed)
- `/data/data/com.android.providers.contacts/databases/contacts2.db` — contacts plus the `calls` table; also the **identity spine** to resolve the same person across apps (AC2d). Stable AOSP contract. **TODO — probe and fill.**

---

## Snapchat — Android
- Notification-only by decision (no readable history). Coverage says so. Nothing to probe.
