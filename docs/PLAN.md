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
3. **Build order follows the PRD roadmap.** Phase 1 (Windows → Mac over R2, gate G1) first. Nothing sensitive ships until G1 passes.

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
