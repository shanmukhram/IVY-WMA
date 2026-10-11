# IVY Windows companion: `Ivy.Core`

This is the cross-platform core of the Windows app (PRD Part 1, PLAN task 1.6). It holds the wire-protocol port (`docs/PROTOCOL.md`), the DPAPI key store, the SQLite queue, the R2 client, the uploader, the command poller, pairing and the device report. It targets plain `net8.0`, so it builds and tests on macOS. Windows-only code (DPAPI) sits behind `IDeviceKeyStore`. The WinUI shell (`Ivy.App`, `net8.0-windows`) is a separate task and is not in this solution.

## Build and test

You need the .NET SDK 8.0.4xx (pinned by the repo's `global.json`), plus Node ≥ 25 and pnpm for the integration tests. Run `pnpm install` once at the repo root.

```sh
# from the repo root, on macOS or Windows
dotnet build windows/Ivy.sln
dotnet test  windows/Ivy.sln
```

- **macOS (Apple Silicon or Intel):** everything runs. NSec ships libsodium for `osx-arm64`/`osx-x64`. `DpapiKeyStore` is compiled but never runs. On a non-Windows host its constructor throws `PlatformNotSupportedException`, and the tests use `FileKeyStore`, an insecure test double.
- **Windows:** the same commands work. `DeviceKeyStores.CreateDefault(dir)` returns `DpapiKeyStore` (CurrentUser scope). One test, `Access_denied_is_reported`, uses `chmod`, so it returns early on Windows.
- **Integration tests** (`Ivy.Core.Tests/Integration`) start the local S3 mock as a child process. The command is `pnpm --filter @ivy/s3-mock exec node windows/Ivy.Core.Tests/Integration/s3mock-harness.mjs …`, run from the repo root. The harness calls the same `startMock()` as `pnpm --filter @ivy/s3-mock start`. It also opens a loopback admin endpoint (`GET /requests`) that returns the mock's per-request access-key log, which the token-separation test reads. The fixture picks a free port, waits for the `READY` line and kills the process tree on dispose. The mock policy gives:
  - the up token write-only access on `ivy-up-windows`
  - the cmd token read-only access on `ivy-cmd-windows`
  - a simulated Mac identity read/delete access on the up bucket and write access on the cmd bucket
- To run only the fast unit tests: `dotnet test windows/Ivy.sln --filter "FullyQualifiedName!~Integration"`.

## Layout

```
windows/
  Ivy.sln
  Directory.Build.props          nullable, warnings-as-errors, LangVersion 12
  Ivy.Core/
    Protocol/                    PROTOCOL.md port (no I/O)
      Bytes.cs                   hex, base64(url), big-endian ints, Crockford base32 (reference bit order)
      AesGcm256.cs X25519.cs     AES-256-GCM (16-byte tag appended), X25519 via NSec, HKDF-SHA256, Fingerprint
      Envelope.cs                single-shot envelope §2.1
      Chunked.cs                 ChunkedEncryptor (streaming) + manifest + receiver verification §2.2
      Kinds.cs Oids.cs ObjectKeys.cs   §5 kind ids/prefixes, §4.1 oids, §4 key builders/parser
      PairingCodec.cs            §7 pairing string, bootstrap seal/open
      IvyJson.cs                 shared System.Text.Json options, ISO-8601 time format
    Records/Records.cs           C# records for every §6 schema (TS field names), validation, command-params union
    KeyStore/KeyStore.cs         IDeviceKeyStore, DpapiKeyStore (Windows), FileKeyStore (test double), PairingState
    Storage/                     vault-agent.db (VaultDb), UploadQueue, ActivityLog, collector_state/file_cache/executed_commands stores
    R2/R2Clients.cs              IUpBucketClient (write-only) / ICmdBucketClient (read-only), AWSSDK.S3 implementations
    Upload/                      Uploader (ordered drain, pause, resumable multipart, progress), TokenBucket bandwidth cap
    Sink/RecordSink.cs           IRecordSink: serialize → encrypt → write part → enqueue → activity_log
    Commands/                    CommandPoller, FileRequestHandler, handler interfaces
    Agent/                       PairingService, DeviceReporter, VaultAgent (composition root)
  Ivy.Core.Tests/                xunit: vectors, crypto tamper, queue/crash, uploader, sink, zero-plaintext, commands,
                                 pairing, key store, and Integration/ (s3-mock end to end)
  Ivy.Collectors/                net8.0 + net8.0-windows10.0.19041.0 (task 1.7)
    Abstractions/                IFileSystemSource, IFileChangeSource, IUsnJournal, IForegroundWindowProbe, INotificationDbReader
    Common/                      CollectorBase, settings store, glob exclusions, status, collector-owned tables
    Files/ Thumbnails/           FileIndexCollector (scan/resume/watcher/USN/tombstones), QuickHash, ThumbnailGenerator
    Screenshots/ Usage/ Notifications/   the other three collectors
    Host/                        CollectorHost (lifecycle, settings, rescan/collector_config handlers), PlatformServices
    Windows/                     Win32 P/Invoke: USN journal, foreground window probe (#if WINDOWS)
  Ivy.Collectors.Tests/          xunit on macOS: temp-tree scans, resume, thumbnails, debounce, usage, wpndatabase fixture, host
```

## What the collectors (task 1.7) implement and consume

(Implemented in `Ivy.Collectors`; see the Collectors section below.)

- **Emit captures** through `IRecordSink` (`VaultAgent.Sink`):
  - `Enqueue(kind, "up/<prefix>", recordJson, collector)`: the JSON must be a v1 record whose `kind` matches.
  - `Enqueue<T>(record, collector)`: typed, validated.
  - `EnqueueBlob(stream, payloadKind, collector, length, commandId?, oid?, bulk?)`: returns `EnqueuedBlob.Oid`. Put that oid in `screenshot.blobOid`, `file_meta.thumbBlobOid` or `file_meta.originalBlobOid`. `PlaintextSha256` is the original's SHA-256. `oid` enqueues under an oid chosen earlier (a record already names it; never reuse one that may have been enqueued). `bulk: true` puts the blob in the queue's bulk lane, which uploads after every normal item.

  Pass `collector` as `files`, `screenshots`, `usage` or `notifications` so the queue depth is counted per collector. Keep `eventTime` (the source's time) separate from `captureTime` (now). Format both with `IvyTime.Format`.
- **Coverage state**: `CollectorStateStore` (`VaultAgent.Collectors`) has `Register`, `SetEnabled`, and `RecordRun(name, at, cursor)`. The device report reads these rows.
- **File index**: `FileCacheStore` (`VaultAgent.FileCache`) stores `path`, `quick_hash`, `mtime`, `last_seen` and an optional `file_id`. The `file_id` is what `file_request.fileId` resolves through, via `FileCacheLocator`.
- **Commands**: implement `IRescanHandler` and `ICollectorConfigHandler`, then assign them to `VaultAgent.RescanHandler` / `CollectorConfigHandler`; a running poller picks them up. Return a `CommandOutcome`. Use `CommandOutcome.Done(detail)` for success, which is sent as `"uploaded"` (see the protocol notes). Until a handler is set, those commands report `error` with detail "no handler".

## What the WinUI app (task 1.8) consumes

- `new VaultAgent(options, DeviceKeyStores.CreateDefault(dir))`, then `StartAsync()`. This reconciles the queue and starts the workers if the device is already paired. Call `DisposeAsync()` on exit.
- **Pairing screen**:
  - `PairAsync(pairingString)` returns `PairingResult` (`DeviceFingerprint`, `MacFingerprint`).
  - `Pairing.DeviceFingerprintAvailable` fires with the device fingerprint as soon as the keypair exists.
  - `PairingException` carries a user-readable reason: expired, fingerprint mismatch, wrong role, bootstrap missing or tampered.
- **Live activity feed**: the `Activity.Appended` event, and `Activity.Recent(limit, afterId)` for history (the `activity_log` table).
- **Queue view**: `Queue.Depth()`, `Queue.DepthByCollector()`, `Queue.All()` (attempts, last error, next attempt).
- **Upload controls**:
  - `Uploader.Paused` and `Uploader.BandwidthBytesPerSecond` (both persisted).
  - `Uploader.Progress` gives per-object `Started/Progress/Completed/Failed` events.
  - `SyncNowAsync()` is the "Sync now" button: poll, report, drain.
- **Footer**:
  - `PairingState.DeviceFingerprint`
  - bucket reachability from `Poller.LastPollAt` / `LastPollError` and the uploader's `Failed` events
- **Collector rows**: `Collectors.All()` and `Collectors.SetEnabled`.

**Window privacy lock.** Once paired, the app window opens locked on every launch: the sidebar shows one plain "IVY" entry and the main area is a neutral cover, with no backup details. About 20 presses on that entry opens the passphrase prompt (the first use sets the passphrase). The passphrase is stored only as a salted hash under DPAPI, and unlock lasts for the session. Capture keeps running while the window is locked, and the tray is a bare icon with Open and Quit. This is a screen-glance privacy layer, not encryption.

## Collectors: `Ivy.Collectors` (task 1.7)

`Ivy.Collectors` targets `net8.0;net8.0-windows10.0.19041.0`. The platform-independent logic builds and is tested on macOS: diffing, hashing, record building, cursors, coalescing, debounce, exclusion matching, toast parsing and the notification-db snapshot. The Win32 code lives in `Ivy.Collectors/Windows/`, under `#if WINDOWS` and `[SupportedOSPlatform("windows")]`, and is compiled only into the Windows target: the USN journal and the foreground window probe. `EnableWindowsTargeting` lets macOS compile that target. `Ivy.Collectors.Tests` (xunit, `net8.0`) covers the rest.

**Wiring:** call `CollectorHost.CreateFor(agent)`, then `StartAsync()`. This builds the four collectors with the platform services and registers the host as `agent.RescanHandler` / `agent.CollectorConfigHandler`. Until pairing completes, collectors read `agent.Sink` as null and show `WaitingForPairing`; they capture nothing in that state. Every capture is logged in `activity_log`: the collector logs `captured <kind> <oid>`, and the sink logs `encrypted` and `queued`. The details hold kinds, oids and sizes, never content or paths.

**Host:** `CollectorHost` owns all four collectors.
- It can start, stop, `PauseAsync` or `Resume` each one, or all of them. `SetEnabledAsync` persists the toggle in `collector_state.enabled`.
- `UpdateSettingsAsync(name, enabled?, settings?)` merges a settings patch and validates it. Unknown keys and out-of-range values return `error` with a reason. It persists the result in `agent_settings` as `collector.<name>.settings` and restarts a running collector. `collector_config` commands use this same path.
- `rescan` accepts `files` (optional `scope` = a folder under a root), `screenshots` or `all`. For `usage` and `notifications` it returns `error`.
- `Statuses()` / `StatusChanged` give the UI: name, enabled, running, paused, state, lastRunAt, lastCaptureAt, cursor, queueDepth, lastError, detail.
- The host writes `collector_state.last_run_at`/`cursor` when the cursor moves, at least once a minute, and on stop. The device report reads those rows.

| Collector | Captures | Key settings (camelCase in `collector_config.settings`) |
| --- | --- | --- |
| `files` (WC1/WC2, media policy) | `file_meta` for every admitted file under the roots: path, name, size, ext (lower-case, no dot), mtime, quickHash, `thumbBlobOid` for images and PDFs, and `originalBlobOid` when the media policy uploads the original (below). Other originals are sent on request. `eventTime` = mtime. | `roots` (empty until folders are picked), `exclusions` (globs), `includeHidden`/`includeSystem` (false), `fullRescanHours` (24), `scanBatchSize` (500 files per 1 s tick), `thumbnails` (true), `thumbnailMaxBytes` (64 MiB), `useUsnJournal` (true), `usnPollSeconds` (30), `changeDebounceSeconds` (2), `autoUploadImages` (true), `imageCapMB` (25), `autoUploadDocuments` (true), `documentCapMB` (10), `imageExtensions`, `documentExtensions`, `originalsBytesPerTick` (64 MiB), `maxQueuedOriginalBytes` (1 GiB) |
| `screenshots` (WC3) | The original image as a chunked blob (payload kind `screenshot`) plus a `screenshot` record: sha256, width/height, `blobOid`, `takenAt` (EXIF DateTimeOriginal, else file creation time), `savedAt` (mtime) | `roots` (`%USERPROFILE%\Pictures\Screenshots`; several allowed), `extensions`, `debounceSeconds` (2), `uploadExisting` (true), `sweepSeconds` (60), `maxBytes` (256 MiB) |
| `usage` (WC4) | `usage_event` (app = FileDescription, exe = file name, title, startedAt, endedAt) | `sampleSeconds` (30), `captureTitles` (true), `titleExclusions` (substring, or glob with `*`/`?`, matched against title or exe; a match omits the title), `idleMinutes` (5), `maxEventMinutes` (10) |
| `notifications` (WC5) | `windows_notification` (app = `NotificationHandler.PrimaryId`, title = first toast text, text = the rest joined by newlines, sender = attribution text, postedAt = ArrivalTime) | `databasePath` (default `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`), `pollSeconds` (60), `batchSize` (500), `excludedApps` |

**Files:**
- **Quick hash:** SHA-256 over (first 64 KiB) ‖ (last 64 KiB) ‖ (size as little-endian int64), truncated to 16 bytes and hex-encoded. Files of 128 KiB or less are hashed whole. A change in the middle of a large file is not seen by design, but the file's mtime still changes, so a new `file_meta` is emitted anyway.
- **Full scan:** a deterministic, sorted pre-order walk. After each batch the scan state is persisted in `agent_settings` as `collector.files.scan`, holding the last completed directory, so a restart resumes there. Unchanged files are not re-read: a file is unchanged when its mtime equals the one in `file_cache`. When a root finishes, cached files the scan did not see are re-checked, then recorded as deleted (or excluded). If a root is missing, nothing under it is marked deleted and the collector shows an error.
- **Incremental updates:** FileSystemWatcher runs on all platforms; on Windows the USN journal runs as well. Events are debounced and re-stat'ed.
  - The cursor is `{"C:\\":{"journalId":…,"nextUsn":…}}` in `collector_state.cursor`.
  - If the journal is recreated, or wraps past the cursor, a full rescan is scheduled.
  - A watcher buffer overflow also schedules one.
- **Settings changes:** changing the roots, exclusions or the hidden/system toggles restarts the scan.
- **Exclusions:**
  - Defaults: `node_modules`, `.git`, `$Recycle.Bin`, `System Volume Information`, `?:/Windows`, `?:/Program Files`, `?:/Program Files (x86)`, `**/AppData/Local/Temp`.
  - Pattern rules: a pattern without `/` matches one path segment at any depth. Other patterns match the whole path. Matching is case-insensitive, and excluding a directory excludes its subtree.
  - Reparse points (junctions, symlinks) are never followed. The agent's own data directory is always excluded.
- **Thumbnails** (`Thumbnails/`): images are decoded with SkiaSharp, with EXIF orientation applied. PDF first pages are rendered with PDFtoImage (PDFium). The long edge is 256 px; the output is JPEG with transparent areas on white. Each thumbnail goes up as a chunked blob and is reused while the quick hash is unchanged.
- **`file_cache.file_id`** is set to the oid of the latest `file_meta` for that path, so a `file_request.fileId` naming that oid resolves.
- **Import progress** (`device_report.collectors[]` `importTotal` / `importDone` / `phase`, PROTOCOL.md §6): every scan first runs a metadata-only counting walk (same walker and exclusions, no file reads, budgeted per tick), then reports files scanned of that total. `phase` is `initial` while no full scan has completed, `rescan` for later full or scoped scans, and `incremental` afterwards (with the last full scan's count as both numbers). The total is absent until counted and is persisted with the scan state. `CollectorBase.Import` carries it; the host stores it in `collector_state` (`import_total`, `import_done`, `import_phase`, added by schema v2) and `DeviceReporter` sends it.
- **Media policy (PLAN decision 8; supersedes PRD WC6's "screenshots always, everything else on request"):**
  - **What uploads.** In every indexed root, an image (`imageExtensions`, default png, jpg, jpeg, heic, heif, webp, gif, bmp, tiff) of at most `imageCapMB` (25 MB) goes up as payload kind `photo`, so the Mac OCRs it. A document (`documentExtensions`, default pdf, docx, doc, xlsx, xls, pptx, ppt, txt, md, rtf, csv) of at most `documentCapMB` (10 MB) goes up as payload kind `document`, so the Mac indexes its text. Empty files, larger files and every other type stay metadata + thumbnail, with the original on request. Extensions compare case-insensitively and without the dot. `autoUploadImages` / `autoUploadDocuments` switch each half off. All of these are settings in the window and in `collector_config`.
  - **Link.** The `file_meta` names the original by `originalBlobOid` (PROTOCOL.md §6). The oid is chosen when that record is emitted. The blob is enqueued later under the same oid, so one record per file is enough.
  - **Metadata first.** The scan and the watcher/USN path emit records as before. Originals are read and encrypted afterwards, in the same tick, up to `originalsBytesPerTick` (at least one file). They go into the upload queue's **bulk lane** (`pending_uploads.lane = 1`, schema v3), which uploads only when no normal item (records, thumbnails, screenshots, requested originals) is due. That keeps the index fresh while bulk is slow. While `maxQueuedOriginalBytes` of originals still wait in the queue (bandwidth cap, upload pause, offline), no more are encrypted. Pausing the collector stops the stage with everything else.
  - **Dedupe.** `file_originals` holds one row per content (quick hash + size) with its oid and status (`pending`, `enqueuing`, `failed`, `uploaded`). A moved or copied file names the existing oid and is not uploaded again, even if the first copy is still waiting. A modified file has a new quick hash, so it uploads again. `file_original_links` records which oid the newest record of each path named.
  - **Before the upload** the source is re-stat'ed and re-hashed. If it changed or vanished, another indexed path with the same content is used. If there is none, the original is forgotten, and the change event or the next scan indexes the new content.
  - **Unreadable files.** If the original cannot be opened (locked, access denied), the metadata stays. An `original_failed` activity line is written, with the oid and the reason but no path. The detail line counts "N unreadable". The upload is retried when the next full scan starts (periodic, `rescan` command, or a settings change).
  - **Crash safety.** If the process dies between `enqueuing` and `uploaded`, the next start checks the queue for the manifest. If the manifest is absent, the blob may already have been uploaded, so its oid is never reused. A new oid is chosen and the linked paths get a `file_meta` naming it.
  - **Backfill.** Files indexed before the policy, or before a cap or type change, are unchanged, so they are not re-hashed. The policy settings are part of the scan fingerprint. Changing them, or upgrading, runs one rescan, and that rescan emits one linking `file_meta` per covered file. The counting pass never reads file contents.
  - **Screenshots folder.** An image directly in a screenshots root (the `screenshots` collector's `roots` and `extensions`, non-recursive like that collector) is never uploaded by `files`. It keeps its `file_meta`, and the screenshot collector uploads it as `screenshot`. Images in subfolders of that root, and documents in it, follow the policy.
- **Originals for a `file_request`** are uploaded with the command's id in the manifest (`commandId`, PROTOCOL.md §2.2), so the Mac shows the command as transferring with part progress before the `uploaded` status arrives.

**Screenshots:**
- **Debounce:** a file is uploaded only after it is seen twice, at least `debounceSeconds` apart, with the same size and mtime. It must also be non-empty and open with `FileShare.Read`, which fails on Windows while a writer still holds it.
- **Dedupe:** by SHA-256 in `screenshot_seen`. Files already examined (path + size + mtime) are kept in `screenshot_files`, so sweeps never re-hash them.

**Usage:**
- **Coalescing:** consecutive samples with the same exe and recorded title extend one event.
- **When an event closes:** when the foreground changes (ended at the new sample), when there is no foreground window, after `idleMinutes` without input (ended at the last input, from GetLastInputInfo), or every `maxEventMinutes` for long sessions (the session continues as a new event).
- **Crash recovery:** the open interval is saved every sample. After a crash it is emitted ending at its last sample.
- **Title read (stability):** titles are read with `SendMessageTimeout(WM_GETTEXT, SMTO_ABORTIFHUNG, 500 ms)`, never `GetWindowTextW`, so a hung foreground window cannot stall the collector. IVY's own windows are never asked; they are recorded with the app's title (`ForegroundTitleReader.OwnProcessTitle`, `IVY`). See `Ivy.App/README.md`, "Hang diagnostics", for the app-side watchdog, heartbeat lines and hang dumps.

**Notifications:**
- **Snapshot read:** each poll copies `wpndatabase.db`, `-wal` and `-shm` to a private temp directory using shared-read streams. It retries until the three files' sizes and mtimes match before and after the copy, then queries the copy (the WAL is applied) and deletes it.
- **Cursor:** the highest `Notification.Id` read, persisted after every row. Only `Type = 'toast'` rows are emitted. The toast XML is parsed with DTDs prohibited.
- **Access:** on current Windows 11 builds (verified on 24H2) `wpndatabase.db` is usually readable by a standard user via the snapshot copy; the collector reports red with a reason only when the copy fails.
- **Unreadable database:** the collector goes to the `Error` state with the reason, for example "access denied reading …\wpndatabase.db (run elevated?)", "not found" or "could not be queried". It emits nothing and keeps retrying each poll. It never reports a healthy state it does not have.

**Collector-owned tables** (created additively in `vault-agent.db`; metadata only): `file_tombstones`, `file_thumbs`, `file_originals`, `file_original_links`, `screenshot_seen`, `screenshot_files`.

**Schema gap:** `file_meta` has no `deleted` field (PROTOCOL.md §6 and `schemas.ts`). Deletions therefore stay local: the path goes to `file_tombstones` (reason `deleted` or `excluded`), the `file_cache` row is removed, and a `deleted` activity entry is logged. Nothing reaches the Mac until the protocol adds a field or kind for deletions.

**Libraries:**
- **SkiaSharp (MIT):** used for images instead of SixLabors.ImageSharp. ImageSharp 3.1.x has open high-severity advisories, which fail the build under warnings-as-errors. ImageSharp 4.x needs a Six Labors license key for Release builds.
- **MetadataExtractor (Apache-2.0):** reads EXIF.
- **PDFtoImage (MIT, PDFium):** renders PDF first pages. It ships natives for win-x64/arm64 and macOS, so the PDF thumbnail is tested here too.

**Not verified on macOS:**
- **Compiled for the Windows target but never run:**
  - `WindowsUsnJournal`: DeviceIoControl `FSCTL_QUERY_USN_JOURNAL` / `FSCTL_READ_USN_JOURNAL` with USN_RECORD_V2 parsing. If GENERIC_READ on `\\.\C:` is denied, it falls back to `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL`. Parent paths come from `OpenFileById` + `GetFinalPathNameByHandle`.
  - `WindowsForegroundWindowProbe`: GetForegroundWindow, GetWindowThreadProcessId, QueryFullProcessImageName, FileDescription, the UWP ApplicationFrameHost child lookup, and GetLastInputInfo.
- **Tested here only through fakes:** USN cursor handling and the foreground probe's consumers (`FakeUsnJournal`, `FakeProbe`).
- **Windows behaviour not exercised:**
  - FileSystemWatcher on NTFS: buffer overflows on whole-drive roots.
  - Hidden/System attributes on real Windows folders, such as AppData being Hidden.
  - The real lock behaviour of `wpndatabase.db` and of a screenshot still being written.
  - The media policy on a real drive: exclusive locks (Outlook `.pst`, files open in Office), access-denied folders, OneDrive placeholders (cloud-only files are read in full to upload them, which downloads them), and how long a first upload of a large photo library takes under the bandwidth cap.
  - Whether the current build's toast payloads match the fixture XML.
  - PDFium on win-arm64.

## Conversation capture: LINE (`Ivy.Collectors/Line/`)

The LINE page in the app shows one row: status (ok partial, probe needed, unverified map, store not found, LINE not installed, or needs attention with a reason), chats and messages captured, last capture, last upload. Coverage from Windows is always labeled partial; the phone supplies the complete history later.

PC steps: open the LINE page, press **Run probe**, wait for "Probe complete", press **Open report**. Commit the report JSON under `docs/reports/` after confirming it holds only file names, sizes, and table and column names. Design and internals: `docs/internals/line-collector.md` (not needed to build or run).

## Conversation capture: Telegram (`Ivy.Collectors/Telegram/`)

The Telegram page shows one row: status (ok, not configured, needs input, needs attention with a reason, or waiting until a time), per-chat progress (chats done / total, messages so far), include-channels toggle, last capture, last upload. Chats that exist only on the phone are listed as phone-only and come from the Android collector.

PC steps: start the app, open the Telegram page, confirm the row reaches ok and progress climbs. If the row says it needs input, enter it in the field shown and press Apply. Toggle include-channels and confirm the chat count changes. Design and internals: `docs/internals/telegram-collector.md` (not needed to build or run).

## Defaults

| Setting | Default |
| --- | --- |
| Command poll | every 2 min (WU4) |
| Device report | every 5 min, plus on demand |
| Blob chunk | 32 MiB of plaintext; chunk objects above 16 MiB go up with resumable S3 multipart in 8 MiB parts |
| `file_request` size limit | 2 GiB (`FileRequestOptions.MaxBytes`); optional `AllowedRoots` |
| Retry backoff | 5 s · 2^(n−1), capped at 30 min; there is no attempt limit, so nothing is dropped |

## Invariants worth knowing

- **Plaintext never touches disk.** Records are encrypted in memory. Blobs stream one chunk at a time, and the buffer is zeroed after use. The queue directory and `vault-agent.db` hold only ciphertext and metadata. `ZeroPlaintextTests` and the integration test scan every file byte for a marker. `file_cache` holds file paths by PRD design.
- **The queue is crash-safe.**
  - A part file is written (temp → fsync → rename) before its row is inserted.
  - After a confirmed upload, the row goes to `done`, then the file is deleted, then the row is deleted.
  - `UploadQueue.Reconcile()` runs at startup. It resets `uploading` rows, finalizes `done` rows, drops rows whose file is missing (logged as `lost`) and deletes temp files. It re-enqueues complete orphan files, and blobs only as manifest plus all parts, manifest first. Incomplete orphan blobs are deleted.
- **Upload ordering.** The normal lane drains before the bulk lane (media-policy originals). Items in one `group_key` upload strictly in sequence, and a group never spans lanes. A blob's manifest goes first, then its parts, then the `command_status` that reports it. Unrelated items are not blocked by a failing group.
- **Token separation is structural.** `IUpBucketClient` has only write members and is built with the up write token. `ICmdBucketClient` has only list and get, and is built with the cmd read token. The device never deletes commands (PLAN decision 4). Executed commands are recorded in `executed_commands` by object key and by command id.

## Protocol notes for the other ports

- **Token string format.** PROTOCOL.md §7 carries `cmdReadToken` and `upWriteToken` as opaque strings. S3 SigV4 needs an access key id and a secret, so Ivy.Core parses each token as `<accessKeyId>:<secretAccessKey>`. The Mac must emit tokens in this form.
- **oid text encoding.** This follows the reference `toCrockford`, which zero-pads the last 3 bits on the right. Canonical ULID libraries left-pad, so do not use one; the vectors verify the reference behaviour.
- **Chunked `objectId`.** The device uses the oid's 16 bytes. The spec does not require this, and the vector uses unrelated values, so the Mac should take `objectId` from the manifest rather than derive it from the key.
- **Reserved header byte.** Byte 7 is not covered by any AAD, so Ivy.Core rejects non-zero values. It also checks that a chunk header's kind byte is `blob_chunk`. Both checks are stricter than the reference and accept every conforming object.
