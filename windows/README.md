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
```

## What the collectors (task 1.7) implement and consume

- **Emit captures** through `IRecordSink` (`VaultAgent.Sink`):
  - `Enqueue(kind, "up/<prefix>", recordJson, collector)`: the JSON must be a v1 record whose `kind` matches.
  - `Enqueue<T>(record, collector)`: typed, validated.
  - `EnqueueBlob(stream, payloadKind, collector, length)`: returns `EnqueuedBlob.Oid`. Put that oid in `screenshot.blobOid` or `file_meta.thumbBlobOid`. `PlaintextSha256` is the original's SHA-256.

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
- **Upload ordering.** Items in one `group_key` upload strictly in sequence. A blob's manifest goes first, then its parts, then the `command_status` that reports it. Unrelated items are not blocked by a failing group.
- **Token separation is structural.** `IUpBucketClient` has only write members and is built with the up write token. `ICmdBucketClient` has only list and get, and is built with the cmd read token. The device never deletes commands (PLAN decision 4). Executed commands are recorded in `executed_commands` by object key and by command id.

## Protocol notes for the other ports

- **Token string format.** PROTOCOL.md §7 carries `cmdReadToken` and `upWriteToken` as opaque strings. S3 SigV4 needs an access key id and a secret, so Ivy.Core parses each token as `<accessKeyId>:<secretAccessKey>`. The Mac must emit tokens in this form.
- **oid text encoding.** This follows the reference `toCrockford`, which zero-pads the last 3 bits on the right. Canonical ULID libraries left-pad, so do not use one; the vectors verify the reference behaviour.
- **Chunked `objectId`.** The device uses the oid's 16 bytes. The spec does not require this, and the vector uses unrelated values, so the Mac should take `objectId` from the manifest rather than derive it from the key.
- **Reserved header byte.** Byte 7 is not covered by any AAD, so Ivy.Core rejects non-zero values. It also checks that a chunk header's kind byte is `blob_chunk`. Both checks are stricter than the reference and accept every conforming object.
