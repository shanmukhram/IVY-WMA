# IVY Android — build brief

The Android companion for IVY (personal backup of the owner's own data on the owner's own
OnePlus 11R / OxygenOS 14, single user). Product spec: `docs/android.md`. Framing:
`docs/CONTEXT.md`. Decisions: `docs/PLAN.md` (24, 25). This file is the build brief and the
labor split.

## Scope and the split
- **Root is the owner's side.** A working root shell (a `su`, or functionally equivalent)
  is provided by a mechanism the owner maintains themselves. **This codebase assumes root
  already exists.** It never obtains root, never escalates privileges, and never calls or
  reverse-engineers any system or vendor service. If a task seems to need that, stop and
  flag it.
- **Everything once a root shell exists is the build.** Extraction, parsers/decryptors,
  the encrypted archive, search, the app, the no-root track, and maintenance.
- The boundary is a single check: `adb shell "su -c id"` → `uid=0(root)`. Below it, the
  owner's mechanism brings root up; above it, everything here runs.

## Hard rules (kept everywhere in this codebase)
- Read-only on all third-party app data; writes only to IVY's own dirs.
- No privilege-escalation logic, no service/interface reverse engineering, no binder calls.
- No network sync, no telemetry — the sync path is a PC pull over adb.
- Everything encrypted at rest (the archive layer).
- Script/file names are generic (e.g. `stack.*`), not descriptive of the contents.

## Components
1. **Privileged task runner** — at runtime check for a working root shell; if present run
   extraction via `su -c`, if absent record what was unreachable and defer to next boot.
2. **Extraction (read-only staging, then off-device)** — WhatsApp / WA Business
   (`files/key`, `files/encrypted_backup.key`, `databases/msgstore.db`, `databases/wa.db`),
   Telegram (`cache4.db`; log whether SQLCipher), LINE (`databases/naver_line` + full
   `shared_prefs/`; log version), telephony (`mmssms.db`), contacts (`contacts2.db` + calls),
   tar of `/data/media/0`.
3. **Parsers / decryptors** — msgstore schema, cache4 reader, naver_line SQLCipher
   (key supplied by the owner), into one unified message model (platform, chat, sender,
   body, timestamp).
4. **Archive layer** — content-addressed storage, AES-256-GCM at rest (passphrase →
   Argon2id key), manifest with hashes, PC export over adb.
5. **Search** — FTS5 over the unified model, minimal query UI.
6. **No-root degraded track (same app)** — All-Files-Access media/docs,
   READ_SMS / READ_CALL_LOG / READ_CONTACTS via providers, NotificationListenerService
   archiving incoming message notifications, Shizuku-assisted copy of
   `/sdcard/Android/{data,obb}`.
7. **Maintenance** — silent self-update via `pm install -r` when root is available; single
   signing keystore, key file kept by the owner offline, never in the repo.

## Boot behavior
`BOOT_COMPLETED` → start the worker → if root available, run pending extraction; if not,
log and exit. No binder calls to any system or vendor service.

## Two tracks, run both
- **Root track** — full history, Telegram secret chats, deep LINE. Needs `uid=0`.
- **No-root track** — media, files, SMS/calls/contacts, and a notifications message feed,
  plus WhatsApp's crypt15 backup and LINE's own backup. Needs no root, secures most of the
  value, and is built in parallel so the root trigger never stalls the project.

## Milestones and status
1. **Read-only extraction + manifest, verified by tables + row counts.** DONE on the build
   side: `android/scripts/stack.{sh,py,bat}` (see `android/scripts/README.md`). Runs the
   moment the owner's root shell is live; produces `service.txt` + an `out/` staging dir.
   **Blocked on `uid=0` (owner's side).**
2. Parsers/decryptors against the real schemas the milestone-1 run reveals; findings into
   `docs/findings.md`.
3. Encrypted content-addressed archive (AES-256-GCM, Argon2id).
4. FTS5 search.
5. The Kotlin app (privileged task runner on `BOOT_COMPLETED`) + the no-root track.
6. Maintenance (silent self-update).

## First root discipline
Given a working root shell, produce the staging copies + manifest and verify via tables and
row counts before anything else. The staging dir is plaintext until the archive layer
encrypts it — treat it as sensitive and delete it after pulling.
