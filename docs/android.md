# The Android companion

The Android app is IVY's rooted capture-and-serve companion. Its one job is to get **everything** off the owner's own phone — every message, every photo and video, every notification, call, and app-usage event — encrypt it on the phone, and hand it to the Mac through the owner's own Cloudflare R2 storage. The phone never reads the archive back; it only captures and serves. The Mac is the only place anything is searched or read.

This is the same kind of thing as a manual rooted-phone backup, made automatic and complete, so the owner never has to open 5–6 apps or export a chat by hand. It is the owner's own data, own accounts, own hardware. Everything here is one person backing up their own phone.

The phone matters most of the three devices because it holds the complete history: Windows and the desktop apps only ever keep a recent window, but the phone keeps the real thing. So the Android companion is where "complete" comes from.

---

## What it captures, and in what order

### Priority 1 — conversations, every messaging app, in one place
The whole point is that the owner stops opening app after app. IVY pulls every messaging app into one searchable place on the Mac:

- **LINE** — first, because its store is the least documented and drifts most between app versions (so the risk lands first).
- **Telegram** — second.
- **WhatsApp and WhatsApp Business** — third. These are **two separate accounts** (`com.whatsapp` and `com.whatsapp.w4b`), each with its own store, keys, and media; both are captured as distinct accounts.
- **Instagram** — DMs via the root database where the schema is stable, otherwise notification-only.
- **SMS / MMS** — alongside, from the system provider.
- **Anything else** — any other messaging app IVY can't read at the database level is still captured through its **notifications**, so nothing the owner receives is invisible.

For each readable app: every conversation, every contact, every message, with attachments — complete history, not a recent slice — plus incremental updates afterward.

### Priority 2 — all media on the phone
Every image and video in storage, not just chat media: `DCIM`, `Screenshots`, `Downloads`, `Android/media`, app media folders, and ordinary hidden albums. Documents too. Originals upload under the two-speed policy; metadata and thumbnails come first so the Mac can index and OCR.

### Always on — the realtime and system layer
- **Notifications** — every notification captured the moment it arrives: app, title, displayed sender, preview text, timestamp; segregated per app; retained even after the owner dismisses it. This is the freshness layer and the safety net that catches content before it can be deleted or expire (see "Deleted and view-once content" below).
- **Call log** — incoming, outgoing, missed, with contact, number, time, and duration.
- **App usage** — per-app sessions and times, for the timeline.

---

## How it is built

### A root daemon that stays out of the notification bar
The heavy work — reading app databases with root and uploading to R2 — runs as a **privileged background daemon**, started at boot (via Magisk) and surviving the app being killed. It is deliberately **not** an Android foreground service, because Android forces every foreground service to show a permanent notification, and the owner wants **nothing** in the status bar. A root daemon has no such requirement, so there is no notification at all. It is also what makes a multi-day initial upload reliable: it does not depend on the app's process staying alive.

### The notification listener
Realtime notification capture uses a `NotificationListenerService`. This is a *bound* service, not a foreground service, so it also needs no notification. It writes each notification to the local log within seconds.

### Root database adapters
Each messaging app has an adapter that reads its database directly with root:
- **Snapshot first, never read live.** Copy the database together with its `-wal` and `-shm` sidecars (or checkpoint through SQLite) before reading, so a mid-write app never yields torn or missing recent rows. Read the copy, then delete it.
- **Keys in memory only.** Where a store is encrypted, extract the per-app key in place with root and hold it only in memory for the read — LINE's store key, Telegram's passcode-derived key when a passcode is set, WhatsApp's keys. Nothing persists a decrypted copy to disk.
- **Per-app cursors.** Track the last-seen rowid or hash per conversation, so incremental scans only read what's new.
- **Schema-drift discipline.** Every app's store layout is a moving target, not a public contract. The adapter pins a source map per installed app version and **re-verifies it against the real store at pairing and after every app update**. When the map and reality disagree, coverage drops to *partial* and a rescan surfaces on the Mac's coverage dashboard. **Nothing is ever guessed into the vault.**

### The media indexer
A whole-storage scan over the filesystem (with root, so scoped-storage limits don't apply), enriched by MediaStore. It enumerates app media folders and associates attachments with their messages by hash.

### Crypto, queue, and upload
- Everything is encrypted on the phone to the Mac's public key **before it touches disk or network** — a fresh AES-256-GCM key per object, wrapped to the Mac's X25519 key. The cloud only ever holds ciphertext.
- A local SQLite queue holds ciphertext only and survives reboots.
- Large objects go up as **resumable chunked multipart** with manifests, so a dropped connection or a reboot resumes at the last committed part, never from zero.
- **Two-speed policy:** small records (notifications, statuses, message rows) on any network; bulk (history dumps, media originals) on WiFi and charging. Both thresholds are owner-configurable.

### The app is pure UI
The installed app is only a window onto the daemon. It reads the daemon's live state over a local channel and shows everything in-app: per-collector rows (notifications, LINE, Telegram, WhatsApp, WhatsApp Business, Instagram, SMS, media, calls, usage) with on/off toggle, last capture, last upload, queue depth, and a status dot; a live capture-activity feed; per-app import progress for the history manifests; the two-speed settings; the pairing screen; and a footer with bucket reachability and the fingerprint. **No status-bar notification, ever.** If the owner wants to know what's happening, they open the app. There is no search, timeline, or archive browser on the phone — that all lives on the Mac.

---

## Transport: R2 only
Everything goes up as **regular resumable R2 uploads** to the phone's own buckets (`ivy-up-android` for captures, `ivy-cmd-android` for commands from the Mac). There is **no seed, no LAN transfer, no USB fast-path, and no relay server** — R2 is dumb ciphertext storage and there is no server-side compute anywhere. The initial backlog is large (on the order of 100 GB, mostly media); a **2–3 day initial upload is accepted** as the cost of not depending on being near the Mac. R2 is the right backend here because the Mac re-reads the archive repeatedly and R2 charges nothing for egress, and because it needs no LAN, no Tailscale, and no port forwarding — the phone can be anywhere.

---

## Over-the-air updates, no reinstall
New features and fixes reach the phone **without the owner reinstalling anything**, even while travelling, in two layers:
1. **Config over the cmd-bucket.** Source maps (the per-version LINE/Telegram/WhatsApp schema mappings), collector toggles, policies, new app package names, and media rules are pushed from the Mac and applied live — no new app at all. This handles the most common change: an app updates and drifts, the Mac pushes a new map, capture resumes.
2. **Silent signed-APK self-update.** For actual code changes, the daemon pulls a new APK — **signed by the owner's key** — from R2, verifies the signature, and installs it silently with root (`pm install`), no tap required, on any network including cellular. The daemon updates itself the same way. Auto-installing code is deliberate and tightly scoped: only an owner-signed APK from the owner's own bucket is ever installed.

---

## Deleted and view-once content: captured once, kept forever
Once IVY has captured a message, the Mac keeps it permanently. Anything the *source* does afterward — unsend, delete-for-everyone, delete a chat, disappearing-message expiry, or view-once — **never** removes it from the vault; it only sets a marker (deleted-at-source, with the time observed). The vault is append-and-flag, never retract.

This reverses IVY's earlier "exclude view-once and disappearing content" stance (PLAN decision 24): it is the owner's own received data, so once seen it is kept. Two capture nets make this reliable:
1. The **notification listener** records the message content the moment it arrives, before any later wipe.
2. The **database adapters recover from residue** when an app clears the body — for example LINE's unsend clears the message text but leaves the words in the full-text search index (proven on the Windows side; see `windows/tools/disposable/line.md`); WhatsApp leaves a "deleted" tombstone; Telegram leaves gaps. A message is safe if either net caught it.

This is only about messages IVY already reads. There is still no screen recording, microphone, or camera capture.

---

## Reliability: it must never clog or go silently stop
The Windows companion once went silently quiet mid-backlog (process alive, nothing uploading). On a phone — with OEM battery killers, Doze, and bursty cellular — that failure mode is the default condition, so the daemon is built to resist it from day one:
- **Bounded queue with real backpressure:** producers (the collectors) wait when the drain is behind, instead of buffering without limit. The queue can't overflow and can't clog.
- **Large multipart parts, not thousands of tiny objects,** so throughput is bandwidth-bound, not latency-bound.
- **Resumable manifests,** so a multi-day upload survives interruption and reboot.
- **Per-call timeouts, connection recycling, and a liveness watchdog** that rebuilds a stalled connection and nudges the drain.
- **A heartbeat that does not ride the upload path,** so the Mac always sees the phone's true liveness and shows it honestly as stale when it isn't reporting.

---

## The LINE head start (from the Windows dig)
LINE is first and hardest, but the Windows LINE work gives Android a running start.

**Transfers directly:**
- The map discipline — pin a schema map per version, verify tables and columns against a live snapshot, go red-with-reason on drift.
- The concepts — content-type codes, attachment-metadata tags, the per-media key stored in the message, and the deleted-message-from-full-text-index recovery trick.
- Snapshot-then-read (db + wal + shm), never in place.

**Differs, do not assume:**
- Android LINE uses a **SQLCipher-family** store, not the Windows wxSQLite3 scheme — a different key derivation and a key location that has moved across versions. File names and schema likely differ from the Windows store too.
- **Media is actually solvable on the phone.** On Windows the chat-media originals live on LINE's servers and the local cache is separately encrypted, so originals weren't recoverable. On the rooted phone the originals are real files in the app's folders and in `/storage/.../LINE/`. This is the whole reason complete history and real media come from the phone.

The first real step for LINE (and every app) is a **probe on the actual rooted phone** — a read-only inventory of each app's database files (plain vs encrypted by header), schema, and key locations — before writing any adapter, exactly as the Windows side did.

---

## Per-app source map (where each app keeps its data)
Starting points, not guarantees. Verified against the installed version at pairing and after every app update; on mismatch, coverage drops to partial and a rescan surfaces.

- **LINE (`jp.naver.line.android`)** — priority 1. Stores in `/data/data/jp.naver.line.android/databases/` (`chat.db` with `-wal`/`-shm`, plus `square_history.db` for group/Square history and `contacts.db`; older builds used a single `naver_line`). Modern builds encrypt the stores (SQLCipher-family); the key lives in the app's private data and its exact location moves between versions. Chat media is largely app-private under `/data/data/jp.naver.line.android/`; user-visible saves land in `/storage/emulated/0/Pictures/LINE/` and Keep. Lowest confidence — drifts most.
- **Telegram (`org.telegram.messenger`)** — priority 2. Stores in `/data/data/org.telegram.messenger/files/` — one SQLite database per signed-in account (`dbN`), alongside `cacheN.db` media caches. Plain SQLite with no passcode; encrypted with a passcode-derived key when a passcode is set (derivation params in shared_prefs). Media in `/storage/emulated/0/Telegram/`.
- **WhatsApp (`com.whatsapp`) and WhatsApp Business (`com.whatsapp.w4b`)** — priority 3, two accounts. Live store `/data/data/<pkg>/databases/msgstore.db` with `-wal`/`-shm` (plaintext SQLite under root; contacts in `wa.db`). Encrypted backups (`.crypt14`/`.crypt15`) under `/storage/emulated/0/Android/media/<pkg>/WhatsApp*/Databases/`; backup keys at `/data/data/<pkg>/files/key` and `/data/data/<pkg>/files/encrypted_backup.key`. Media under `/storage/emulated/0/Android/media/<pkg>/WhatsApp*/Media/`. Business mirrors the same layout under its own `com.whatsapp.w4b` package. Highest confidence; prefer the live store over the backup (the backup can lag).
- **Instagram** — DMs via the root database where the schema is stable, else notification-only.
- **SMS/MMS** — `/data/data/com.android.providers.telephony/databases/mmssms.db`; MMS parts under `app_parts/`.
- **Contacts and calls** — `/data/data/com.android.providers.contacts/databases/contacts2.db` — contacts plus the `calls` table; also the identity spine so the same person is one entity across apps. Stable AOSP contract, least drift.

Reading discipline for all apps: snapshot db + wal + shm first; hold any extracted key only in memory; prefer the live store over an encrypted backup when both exist.

---

## Pairing and keys
Pair once: scan the Mac's QR (or type the one-time code), exchange public keys, receive scoped tokens, and confirm the same fingerprint on both screens. The phone's private key lives in the Android Keystore; it is used to receive commands from the Mac and for pairing, never to decrypt vault content — nothing on the phone reads the archive. Re-pairing after a Mac restore works from the same passphrase.

---

## Honest coverage
Coverage is labelled truthfully everywhere, never hidden. A stopped collector shows as a gap on the Mac's coverage dashboard within its sync interval. Snapchat is notification-only and says so. Anything read only from notifications is labelled as such. Schema drift drops an app to partial with a rescan, rather than silently importing guesses.

---

## What the Android companion does not do
- No archive browsing or search on the phone — it is a companion, not a reader.
- No status-bar notification — all status is in the app only.
- No keystroke logging, no screen recording, no microphone, no camera.
- No location scraping — locations come from photo EXIF where present.
- No cloud other than R2, and only ciphertext there; no server-side compute.
- No support for non-rooted devices in v1 — root is required for the history adapters, the no-notification daemon, and silent self-update.
- No iPhone.

---

## Build and toolchain
Kotlin app, min SDK 26. The protocol (X25519 wrap, AES-256-GCM envelope, chunked upload, pairing, bootstrap unseal) is ported and validated **byte-for-byte against the shared test vectors** — this is the one part that must match Windows and the Mac exactly. Built on the Mac (JDK, Android SDK command-line tools, Gradle). Real verification happens on the actual rooted phone, probe-first, before any adapter is trusted.

---

## How this maps to the rest of the docs
- The product requirements are PRD Part 3 (collectors AC1–AC9, upload AU1–AU6, retrieval AR1–AR2, pairing AP1–AP2) and the gates G2/G3 in Part 4.
- The decisions that shaped this file are PLAN **decision 24** (captured messages persist; deletion/view-once only marks) and **decision 25** (this architecture: R2-only, root daemon with no notification, OTA updates, scope and priority).
- The overall framing is `docs/CONTEXT.md`. This file is the Android-specific companion to it.
