# IVY build plan

Source of truth: `docs/PRD.md` (Product principles and Shared architecture are binding).
Orchestration: Fable 5.1 plans, deploys subagents, reviews, and tests. It writes no app code.
Routing: complex work (crypto, pairing, ingest ledger, multipart/resume, root adapters, FTS/OCR/AI) → Opus-class; routine UI, collectors, tooling → standard model; mechanical chores → fast model.

## Repo layout

```
docs/            PRD, this plan, PROTOCOL.md, test-vectors/
packages/protocol   TypeScript reference implementation of the wire protocol (envelope crypto, record schemas, key layout). Used by the Mac service; C# and Kotlin ports validate against its test vectors.
packages/s3-mock    In-process S3-compatible server for tests (list/get/put/delete/multipart, prefix lifecycle). No R2 credentials needed to run the pipeline locally.
mac/             Electron + TypeScript dashboard and the local Node service (Fastify, better-sqlite3, FTS5).
windows/         Ivy.Core (net8.0, cross-platform, tested on this Mac), Ivy.App (WinUI 3, builds only on Windows), Ivy.Core.Tests.
android/         Kotlin app: foreground service, listener, root adapters, queue.
tools/           zero-plaintext audit, honesty/kill tests, gate scripts.
```

## Decisions made during planning (flagged to Bunny)

1. **Pairing bootstrap.** A device has no R2 credentials before pairing, so the "one-time code" must carry a bootstrap. The Mac shows a QR and the same payload as a copyable pairing string. The payload holds: R2 endpoint, the device's cmd-bucket read token, the Mac's public key, the Mac's fingerprint, a pairing id, and a one-time secret. The Mac has already written `pair/<id>` into the device's cmd-bucket, encrypted with a key derived from the secret, containing the up-bucket write token. The device decrypts it, then writes `pair/<id>/device` to its up-bucket encrypted to the Mac's key, carrying its own public key. The Mac ingests it, stores the device, and both screens show the fingerprint. On Windows "entering the code" is pasting that string. Re-pairing after a Mac restore derives the same Mac key from the passphrase, as in Session Sync.
2. **Testing on this Mac.** No Windows or Android hardware is attached. Windows core logic lives in a cross-platform net8.0 library tested with xunit here; the WinUI shell compiles only on Windows and is reviewed, not run. Android unit tests run on the JVM; instrumentation and root paths are reviewed and gated on the device later. The R2 pipeline is tested end to end against the local S3 mock, and against real R2 once Bunny supplies tokens.
3. **Build order (Bunny, Oct 10 2026): Windows app first, then the Mac dashboard, then Android.** The shared protocol package and the local S3 mock come first because the Windows app is written and tested against them. Gate G1 is run once the Mac side exists. Nothing sensitive ships until G1 passes.
4. **Command deletion.** The PRD gives devices a read-only token on their cmd-bucket but also says devices delete commands on execution. R2 has no read-plus-delete scope, so the device token stays read-only (least privilege), the device records executed command ids locally and ignores repeats, and the Mac deletes `cmd/<oid>` when it ingests the matching `command_status`. The 30-day lifecycle rule remains the backstop.
5. **UI direction, revised (Bunny, Oct 10 2026).** The first Mac dashboard was too cluttered to use. Every UI is now built to Apple Human Interface Guidelines: clean, easy to navigate, sidebar navigation (no top bar) with expandable per-device sections, proper layout and alignment, rounded controls, light and dark mode. Rich views where the data calls for it: a real visual timeline, a photo gallery with a picker, a chat-style AI interface, and app-like conversation views (Telegram-style and LINE-style, per source). Still no decoration for its own sake; the core and background workers keep the engineering priority.
6. **No expiry on up-buckets (Bunny, Oct 10 2026).** R2 holds encrypted captures for as long as the Mac is offline; nothing is lost if the Mac is away for weeks. Up-objects are deleted only after the Mac commits them. The 7-day lifecycle rule in the PRD is dropped; the 30-day rule on cmd-buckets stays.
7. **Device-record authentication deferred (Bunny, Oct 10 2026).** Records are accepted when they decrypt and name a paired device; a leaked up-write token could forge records. Accepted for now; a per-object authentication tag derived from the device and Mac keys can be added later as a protocol version bump.
8. **Windows media policy widened (Bunny, Oct 10 2026).** The point is never having to go back to the PC. In every indexed root: images (png, jpg, jpeg, heic, webp, gif, bmp) upload automatically under a size cap (default 25 MB) so the Mac OCRs them; documents (pdf, docx, xlsx, pptx, txt, md) upload automatically under a cap (default 10 MB) so the Mac indexes their text; everything else is metadata + thumbnail with the original on request. All caps and types are settings in the Windows app. Supersedes PRD WC6's "screenshots always, everything else on request".
9. **Windows conversation capture from existing logins (Bunny, Oct 10 2026).** PRD Part 1 gained WT1–WT4 (Telegram via the Telegram Desktop session key: complete cloud history, no new login), WL1–WL3 (LINE for Windows local store, always labeled partial), WX1–WX2 (merge by platform message id; session keys never leave the PC). No app ever asks Bunny to log in again. Further desktop apps follow the same pattern only when Bunny names them.
10. **Model routing confirmed by Bunny:** Fable 5.1 orchestrates and verifies; Opus 5.5 for complex tasks; Sonnet 5.5 for standard tasks; Haiku 5.5 for mechanical chores.
11. **Media originals kept in R2 (Bunny, Oct 11 2026).** A committed media original (payloadKind photo, document, attachment, media) stays in its up-bucket after the Mac commits it, instead of being deleted. The Mac records it in `media_archive` and can re-fetch it at full quality on demand (`POST /api/media/:id/fetch`) without the capturing device online; thumbnails and avatars still cache small and are deleted from R2 as before. `ingest.keepMediaInR2` (default true) toggles it; eviction frees the local copy while keeping the R2 object. This narrows decision 6: media originals now persist in R2 indefinitely (accepted storage cost), everything else still deletes after commit.
12. **LINE Windows inline chat media is not capturable from disk, by design (research, Oct 11 2026).** LINE for Windows does not persist inline chat-media originals anywhere on disk. `...\LINE\Cache\*.eimg` are encrypted *thumbnails* only (AES-128-ECB, a different key per file received from the server and wiped from memory right after decryption), confirmed by the Kang et al. 2024 forensic study and consistent with our own probe (LINE\Data holds no media). There is no key to extract and no original to recover. So the Windows LINE media spec is: (a) user-saved chat files already land in Downloads and are captured by the file index (WC1) with no new code; (b) inline media originals come from the phone — the rooted Android agent reads LINE's browsable `/sdcard/Android/data/jp.naver.line.android/storage/` media, keeping the phone canonical for media as the PRD intends; (c) coverage is labelled honestly ("media: user-saved files only; inline media original lives on the phone") and, optionally, `.eimg` thumbnail metadata (count, dates) is recorded as evidence that media existed in a chat, without implying the bytes are recoverable. This is the rare case where the finding is "do not build it".
13. **Near-real-time sync (Bunny, Oct 11 2026).** Windows polls LINE and Telegram every 5 s and uploads at once; the Mac pulls R2 every 5 s by default (`IVY_POLL_INTERVAL_MS`). This supersedes the 2-minute cadence in PRD S1. Cost: 86400 / 5 = 17,280 list calls per up-bucket per day, about 518,400 a month, so about 1,036,800 a month with both up-buckets. That is just over R2's free 1 million Class A operations a month, so a few cents a month at most beyond the free tier. `IVY_POLL_INTERVAL_MS` raises or lowers it without a code change. An idle poll lists all of `up/` in pages of 1,000, so the cost grows as archived media accumulates. This was narrowed with StartAfter in decision 14, so an idle poll no longer grows with the archive.
14. **Ingest cost and LINE account ids (Bunny, Oct 11 2026).** The ingester checks the ledger before it downloads a listed object. An object already committed or quarantined is settled from the listing alone when the listing shows the same copy the ledger recorded: same size, and either a copy this process already read or one R2 wrote more than 60 seconds before the Mac ingested it. Otherwise the object is fetched and compared as before, so an overwrite is still caught. Before this change, 15 kept or stuck manifests were re-downloaded on every 5-second pass, and a pass took 10 to 23 seconds.

    The poll timer runs on a fixed cadence counted from the start of each pass (default 5 s, `IVY_POLL_INTERVAL_MS`). A fast pass waits out the rest of the interval; a slow pass is followed at once; passes never overlap. Previously the 5 s wait began only after a pass ended, which stretched the real cadence to pass time plus 5 s. Measured delivery of a LINE message from the PC to the vault before the fix was about 17 s; the Windows side captured the message within 1 to 4 s of sending it.

    LINE records from Windows are labelled with the LINE account's own id (a string starting with "u") instead of the placeholder "default" (Windows commits 8dc4eab and 987cceb). The Mac keys a conversation on platform, account and chat key, so the one-time re-send under the real id created every LINE chat a second time. Bunny chose to delete the "default" LINE rows rather than merge them: 9 conversations, 850 messages and their sources, 2 edits, 22 attachments, and the "default" account snapshot rows were removed in one transaction on Oct 11 2026. A copy of the vault was kept beforehand at `data/vault.before-line-default-delete.db`. Seven messages that existed only under "default" went with them. A second LINE account appears under its own id when the owner logs into it on the PC.

    The incremental listing is now narrowed (Oct 11 2026). The ingester keeps a saved position per record prefix and lists only after it. Because `up/anotif/` is the only prefix that sorts before `up/blob/`, an idle poll is two one-page list calls per bucket, however large the archive: `up/anotif/` from its position, and `up/` from just after the blob position, which returns new blobs plus every other prefix. The blob position moves only past settled blobs, so a large upload still arriving is never skipped because a newer avatar committed first; a blob unsettled for more than one hour stops holding it back, since the hourly full listing sees it anyway. The `up/` call is capped, and if the cap lands inside a flood (the file catalogue) one small call per later prefix follows, so a heartbeat or message behind the flood lands on the same pass. A device reporting again after a 10-minute gap triggers one full listing of its bucket (`deviceReturnFullMs`). Cost at the 5-second cadence: about 2 list calls per bucket per poll, roughly 2 million Class A operations a month with both buckets, about $5 a month beyond R2's free million, flat as the archive grows.

15. **Zero-touch Windows companion (Bunny, Oct 11 2026).** After the one-time pairing, nothing in the Windows app needs a click. It registers a per-user Run key that starts it at login, hidden in the tray, with a minimized flag. The entry is re-applied on every paired start, and a stale path is repointed. A second launch redirected into the running instance stays hidden when it was itself a minimized launch. The capture worker starts on launch when paired.

    Every collector is on by default and starts itself: screenshots, app usage, notifications, Telegram (using the existing Telegram Desktop session), LINE (the key is read from the running LINE during a tick and kept in DPAPI; two accounts on one PC are told apart by the account's own id), the file catalogue (scopes itself once) and, new on Oct 11, the file index (scopes itself to Documents, Pictures and Downloads on its first paired tick). "Index my standard folders" remains a convenience. LINE's "Run probe" and "Detect from LINE" buttons are conveniences, not required steps.

    Self-heal: a failing tick is logged and retried on the next tick. With LINE closed, the app shows a grey "LINE is not running; last captured …" and resumes on its own when LINE opens. A switched LINE store that the stored key does not open shows an amber "waiting for LINE to finish signing in" and retries every tick. Idle LINE ticks skip the snapshot when nothing changed. The catalogue resumes its saved pass on launch instead of re-walking the PC.

    The one unavoidable manual case is a Telegram Desktop local passcode, if the owner set one. It must be entered once in the app, because it is a secret.

    A crash between logins is not restarted by anything; the Run key fires at the next login. We keep the Run key rather than a Task Scheduler task, and will revisit if real crashes show up in the logs. The Run key points at the build output folder, so a rebuild into a different folder needs one manual launch of the new exe to repoint it.

    Verified on the PC on Oct 11 2026: launched with the exact Run-key command line, no window appeared, all seven collectors ticked within 35 seconds, the file index had scoped itself and was indexing, LINE was capturing, and uploads flowed. Closing LINE produced no error rows for six minutes, and the collector kept its account and cursors; reopening LINE resumed capture.

16. **Archived and hidden chats (Bunny, Oct 11 2026).** Every chat now carries a listing value, normal, archived or hidden, on each batch (commit 5ccac69); a change with no new message is sent as a metadata-only batch, and the Mac stores it, filters on it and shows an Archived or Hidden badge. Telegram's Archive folder is captured in full and the badge was verified live on the Mac within seconds of archiving and unarchiving. LINE is different: hiding a chat in LINE is a per-device view setting that LINE for Windows does not persist anywhere in its database (verified by comparing the chat, chat-option and setting tables before and after several hides; only a sync revision counter moved), and a chat hidden on the phone shows as normal on the PC. So Windows cannot label LINE hidden chats and sends normal for all of them; every LINE chat is captured regardless. The hidden label for LINE will come from the Android adapter, where LINE does store it, and the Mac will label by source (hidden on phone). Research the same day: LINE today has no locked or secret chats; Hidden Chat (timed secret rooms) was retired in 2016, the passcode lock is app-wide, and Letter Sealing is default end-to-end encryption that the PC client decrypts into its local store, so none of these hides any chat from capture.

## Phase 1 tasks

| # | Task | Model | Depends on |
| --- | --- | --- | --- |
| 1.1 | PROTOCOL.md + `packages/protocol` (X25519 wrap, AES-256-GCM envelope, Argon2id passphrase KDF, record schemas, key layout, pairing, test vectors) | Opus | — |
| 1.2 | `packages/s3-mock` + pnpm workspace + `tools/audit-plaintext` | standard | — |
| 1.3 | Toolchains: .NET 8 SDK, JDK 17, Android cmdline tools | fast | — |
| 1.4 | Mac service: key store (Argon2id, auto-lock), pairing, R2 client, ingest loop with ledger + quarantine, files/devices tables, retrieval commands | Opus | 1.1, 1.2 |
| 1.5 | Mac dashboard UI: lock screen, devices/pairing, files search, request original, coverage rows (Phase 1 subset) | standard | 1.4 API shape |
| 1.6 | Windows Ivy.Core: crypto port (validated against test vectors), DPAPI key store, SQLite queue, multipart upload, cmd polling, pairing | Opus | 1.1 |
| 1.7 | Windows collectors: file index (USN + rescan), screenshots watcher, usage sampler, notification db reader | standard | 1.6 |
| 1.8 | Windows Ivy.App (WinUI 3): pairing screen, collector rows with toggles, live activity feed, queue, folder picker, bandwidth cap, tray | standard | 1.6, 1.7 |
| 1.9 | Integration tests: pairing + ingest + retrieval through the mock, reboot-mid-queue, zero-plaintext audit; G1 script | Opus | all |

Phases 2–4 are broken down when Phase 1 reaches gate G1.

## Windows conversation capture tasks (PRD WT/WL/WX, after gate G1)

| # | Task | Model | Depends on |
| --- | --- | --- | --- |
| 1.10 | Protocol: `message_batch` gains `sourceSession` (e.g. `windows:telegram-desktop`), per-message `platformMsgId` is mandatory, attachments reference blobs; Mac committers merge by platform + msg id with provenance list (WX1) | Opus | G1 |
| 1.11 | Telegram collector: read Telegram Desktop `tdata` (local key, passcode if set, auth key + DC), MTProto client using that session, full history walk with per-chat cursors, incremental updates, attachment policy, coverage labels; tested on Mac with a fake tdata fixture and a mock MTProto layer; real verification on the PC | Opus | 1.10 |
| 1.12 | LINE desktop collector: locate and snapshot LINE for Windows store, per-version mapping with verification, partial coverage label, red-with-reason on mismatch; fixture-based tests; real verification on the PC | Opus | 1.10 |
| 1.13 | Windows app rows for Telegram and LINE (toggle, status, coverage, per-chat progress, passcode entry once); Mac conversations view shows per-source coverage | Opus | 1.11, 1.12 |

## Phase status

- **Windows (done, Oct 10 2026):** built, paired, captured, retrieved on the PC; see `docs/reports/windows-first-run.md`.

## Mac phase tasks

| # | Task | Model | Depends on |
| --- | --- | --- | --- |
| 2.1 | `mac/service`: vault.db + FTS5, Argon2id key store with auto-lock, R2 config, pairing issuance, ingest with ledger/quarantine/blob resume, commands, search/timeline/coverage APIs, recovery bin, event stream | Opus | — |
| 2.2 | `mac/ocr`: Vision OCR + thumbnail helper (Swift) with Node wrapper | Opus | — |
| 2.3 | Indexer wiring: OCR every ingested image, FTS over ocr_text, media origin hooks | Opus | 2.1, 2.2 |
| 2.4 | Web UI served by the service + Electron shell: lock screen, search, timeline, conversations/notifications/media/files views, coverage, devices and pairing (QR), settings, recovery bin. Minimal and functional. | Opus | 2.1 |
| 2.5 | Gate G1 script: Windows ↔ Mac over the mock and over real R2; zero-plaintext audit; reboot-mid-queue | Opus | 2.1, 2.4 |
| 2.6 | Activity Vault read-only import (S7) and AI layer (A1–A4, cloud switch) | Opus | 2.4 |

## Android phase tasks (PRD Part 3; starts after gate G1 closes)

| # | Task | Model | Depends on |
| --- | --- | --- | --- |
| 3.1 | Toolchain on the Mac: JDK 17, Android SDK command-line tools, Gradle wrapper; JVM unit tests runnable here | fast | — |
| 3.2 | `android/` app skeleton (Kotlin, min SDK 26, target current): protocol port validated against docs/test-vectors byte-for-byte (X25519, AES-GCM, chunked, pairing string decode, bootstrap unseal), Keystore-backed device key, SQLite queue with two-speed policy (small records any network; bulk WiFi + charging), resumable chunked uploads with manifests, cmd-bucket polling (5 min, connectivity change, manual), pairing by QR scan or code, foreground service with persistent notification, boot receiver, battery-optimisation helper | Opus | 3.1 |
| 3.3 | Non-root collectors: NotificationListenerService (segregated per app, retained after dismissal), call log, UsageStatsManager usage, media/document index across user storage with MediaStore enrichment, device report | Opus | 3.2 |
| 3.4 | Android app UI (minimal): pairing screen with QR scanner, collector rows with toggles and status, policy settings, live activity feed, queue state, footer | Opus | 3.2 |
| 3.5 | Root adapters in priority order, each with atomic db+wal+shm snapshot, per-version source map verification (AC2a), in-memory keys only (AC2c), per-app cursors, manifests: LINE first, then Telegram (secret chats and anything the Windows session cannot serve), then WhatsApp, then SMS/MMS; contacts spine (AC2d); Instagram where stable; Snapchat notification-only | Opus | 3.3 |
| 3.6 | Mac: Android committers exercised end to end (android_notification, call, message_batch per platform), conversation search, attachment chips, coverage per app, G2 and G3 gate scripts | Opus | 3.3, 3.5 |
| 3.7 | On-device verification prompts for the phone (first run, pairing by QR, 7-day soak, battery) | — | 3.4 |
