# @ivy/mac-service

The local service at the heart of the IVY Mac dashboard (PRD Part 2). It holds the Mac identity key, pulls ciphertext from both R2 up-buckets, decrypts and validates it with `@ivy/protocol`, commits it into `./data/vault.db` (SQLite + FTS5) under an ingest ledger, deletes it from R2, and serves search, timeline, coverage, commands and the recovery bin to a browser UI over HTTP and a WebSocket event stream. The Electron window is a thin wrapper around that UI.

## Run

Node 25 runs the TypeScript directly (type stripping), so there is no build step for this package. `@ivy/protocol` and `@ivy/mac-ocr` are consumed through their built `dist/`, which `prestart`/`pretest` rebuild. The OCR tests use real Apple Vision on this Mac (the Swift helper is built on first use, see `mac/ocr/README.md`).

```sh
pnpm install
pnpm --filter @ivy/mac-service start            # builds @ivy/protocol, then node src/main.ts
# or, with options:
cd mac/service && node src/main.ts --data ./data --port 4777 --static ../ui/dist
pnpm --filter @ivy/mac-service test             # vitest (S3 mock, no R2 credentials needed)
```

First run, from the UI or with curl:

```sh
T=$(cat data/session.token)
curl -s -H "Authorization: Bearer $T" -X POST localhost:4777/api/keystore/initialize -H 'content-type: application/json' -d '{"passphrase":"..."}'
curl -s -H "Authorization: Bearer $T" -X PUT  localhost:4777/api/r2 -H 'content-type: application/json' -d @r2.json
curl -s -H "Authorization: Bearer $T" -X POST localhost:4777/api/r2/check
curl -s -H "Authorization: Bearer $T" -X POST localhost:4777/api/pairings -H 'content-type: application/json' -d '{"role":"windows"}'
```

`r2.json`:

```json
{
  "accountId": "<cloudflare account id>",
  "macTokens": {
    "up":  { "windows": "<id>:<secret>", "android": "<id>:<secret>" },
    "cmd": { "windows": "<id>:<secret>", "android": "<id>:<secret>" }
  },
  "deviceTokens": {
    "windows": { "upWrite": "<id>:<secret>", "cmdRead": "<id>:<secret>" },
    "android": { "upWrite": "<id>:<secret>", "cmdRead": "<id>:<secret>" }
  }
}
```

Bucket lifecycle rules (PLAN decision 6): **no** lifecycle/expiry rule on `ivy-up-windows` / `ivy-up-android`. R2 holds the encrypted captures for however long the Mac is offline; the Mac deletes each up-object only after committing it. Keep a **30-day** expiry rule on `ivy-cmd-windows` / `ivy-cmd-android` as the backstop for commands a device never answers (the Mac deletes `cmd/<oid>` when the device's status arrives and marks commands unanswered after 30 days as expired).

`endpoint` may replace `accountId` (any S3 endpoint, e.g. the local mock); `macTokens.all` is a fallback token for all four buckets; `buckets` overrides the default `ivy-up-windows` / `ivy-up-android` / `ivy-cmd-windows` / `ivy-cmd-android`; `deviceEndpoint` overrides the endpoint written into pairing strings. Mac tokens need read + delete on the up-buckets and write on the cmd-buckets (on R2 that is "Object Read & Write"); device tokens are handed out at pairing: the cmd-read token in the pairing string, the up-write token inside the sealed bootstrap. The whole R2 config is stored sealed under a key derived from the identity key (HKDF), so it is unreadable while the vault is locked.

## Back up the identity salt

`data/identity.json` holds the 16-byte identity salt (not secret), the public key and fingerprint, and the private key sealed per PROTOCOL §3.3. **Back it up.** The Mac key is Argon2id(passphrase, salt): re-pairing after a restore needs the same passphrase and the same salt. A new salt is a new Mac key, and every device must be paired again.

- Restore from the salt alone: put `{"v":1,"salt":"<base64>"}` in `data/identity.json` (or pass `salt` to `POST /api/keystore/initialize`) and initialize with the same passphrase. The fingerprint must come out identical.
- After a passphrase change the key does not change (devices stay paired), but the salt alone re-derives it only with the original passphrase. To unlock with the new one after a restore, you need the newer `identity.json`. `GET /api/keystore` reports `derivedFrom: "original-passphrase"` in that case.

## Configuration

| Setting | Env / flag | Default |
| --- | --- | --- |
| data directory | `IVY_DATA_DIR`, `--data` | `./data` |
| vault database | `IVY_DB_PATH`, `--db` | `<data>/vault.db` |
| UI directory served at `/` | `IVY_STATIC_DIR`, `--static` | `mac/service/public` (placeholder page) |
| bind address / port | `IVY_HOST` / `IVY_PORT`, `--host` / `--port` | `127.0.0.1` / `4777` |
| poll interval (S1) | `IVY_POLL_INTERVAL_MS`, `--poll-ms` | 120000 (0 = only on demand) |
| auto-lock (S8) | `IVY_AUTO_LOCK_MINUTES`, `--auto-lock-minutes`, then `PUT /api/keystore/settings` | 30 (0 = never) |
| auto-lock mode | `PUT /api/keystore/settings {autoLockMode: "ui" \| "full"}` (stored in the vault) | `ui` |
| listing window | `IVY_LIST_LOOKBACK_MS` | 8 days |
| OCR | `IVY_OCR=0` disables; `IVY_OCR_COMMAND` (`<cmd> <image>` prints text) replaces Vision | Apple Vision via `@ivy/mac-ocr` (macOS) |
| OCR concurrency | `IVY_OCR_CONCURRENCY` | 2 |
| fallback thumbnails via `sips` | `IVY_THUMBNAILS=0` disables | on (macOS) |

Fixed defaults in `src/config.ts`: pairing code lifetime 10 min (+5 min grace for the device's answer), full bucket sweep hourly, orphan parts quarantined after 7 days, 64 MiB cap per part in memory, coverage amber after 15 min and red after 60 min, timeline gaps for runs more than 15 min apart, recovery bin retention 30 days (changeable at runtime).

Files under `data/`: `vault.db` (+ WAL), `identity.json`, `session.token` (0600), `media/` (screenshot/photo originals), `thumbs/`, `files/<oid>/<name>` (retrieved originals), `attachments/`, `blobs/` (in-progress reassembly), `quarantine/` (quarantined ciphertext, still encrypted).

## API

All routes are under `/api` on 127.0.0.1 and need the token from `data/session.token` as `Authorization: Bearer <token>` (or the `ivy_session` cookie set by `POST /api/session {token}`). Only loopback `Host` headers are served and cross-site `Origin`s are refused. While the vault is locked (UI lock or full lock) every data route returns 423.

### Lock semantics (PRD S8 vs freshness)

| | content routes / event stream | private key | ingest, decryption, R2 |
| --- | --- | --- | --- |
| unlocked | served | in memory | running |
| **UI lock** (`POST /api/keystore/lock` or `{full: false}`; auto-lock by default) | 423 / only `keystore.*` events | **kept in memory** | **keeps running**, so the vault stays fresh |
| **full lock** (`{full: true}`; auto-lock with `autoLockMode: "full"`; shutdown) | 423 / only `keystore.*` events | zeroed | stopped until the next unlock |

Leaving either lock needs the passphrase (`POST /api/keystore/unlock`); from a UI lock it is verified against the sealed key and the held key is kept. After a full lock the next poll lists every bucket in full. `GET /api/keystore` (and the lock and settings responses) report `state` (`unlocked` / `locked` / `uninitialized`; a UI lock reports `locked`), `locked` (content is locked, either kind), `uiLocked` (locked but the key is held), `keyInMemory`, `ingestRunning`, `autoLockMinutes`, `autoLockMode`, `lockedAt`, `lockReason`. Argon2id (initialize, unlock, change passphrase) runs on a worker thread, so the server keeps answering while a key is derived.

| Area | Routes |
| --- | --- |
| health / session | `GET /api/health` (open), `POST /api/session {token}`, `DELETE /api/session` |
| key store (S8) | `GET /api/keystore`, `POST /api/keystore/initialize {passphrase, salt?}`, `POST /api/keystore/unlock {passphrase}`, `POST /api/keystore/lock {full?}`, `POST /api/keystore/change-passphrase {current, next}`, `PUT /api/keystore/settings {autoLockMinutes?, autoLockMode?}` |
| R2 | `GET /api/r2` (redacted), `PUT /api/r2`, `POST /api/r2/check` (lists each bucket, reports reachability) |
| pairing / devices | `POST /api/pairings {role}` -> `{pairingId, pairingString, macFingerprint, expiresAt}`, `GET /api/pairings`, `DELETE /api/pairings/:id`, `GET /api/devices`, `GET /api/devices/:id`, `DELETE /api/devices/:id` (revoke), `GET /api/fingerprints` |
| ingest | `POST /api/ingest/poll {full?}`, `GET /api/ingest/status`, `GET /api/quarantine[?all=1]`, `POST /api/quarantine/:id/retry`, `DELETE /api/quarantine/:id` |
| commands (F2/F3) | `GET /api/commands?device=&status=&file=`, `GET /api/commands/:id`, `POST /api/commands {deviceId, params}`, `DELETE /api/commands/:id`, `POST /api/files/:id/request {force?}`, `POST /api/devices/:id/rescan {collector, scope?}`, `POST /api/devices/:id/collector-config {collector, enabled?, settings?}` |
| search (Q1-Q5) | `GET /api/search?q=&type=&device=&app=&person=&conversation=&account=&from=&to=&page=&pageSize=&sort=relevance\|newest\|oldest&typo=off` |
| timeline (T1-T5) | `GET /api/timeline?date=YYYY-MM-DD&tz=<IANA or offset minutes>&device=&type=&page=&pageSize=` (or `from`+`to`) |
| coverage (D1-D5) | `GET /api/coverage`, `GET /api/stats` |
| records (Q4) | `GET /api/items/:type/:id`, `GET /api/conversations/:id/messages?around=<messageId>&before=&after=`, `GET /api/files`, `GET /api/files/:id/content`, `GET /api/files/:id/thumb`, `GET /api/media/:id/content`, `GET /api/media/:id/thumb` |
| recovery bin (B1-B4) | `DELETE /api/items/:type/:id` (to the bin), `GET /api/bin`, `POST /api/bin/:type/:id/restore`, `DELETE /api/bin/:type/:id` (permanent), `GET`/`PUT /api/bin/settings {retentionDays}`, `POST /api/bin/sweep` |
| events | `GET /api/activity?limit=&before=&type=a,b`; WebSocket `/events` (or `/api/events`) with subprotocol `bearer.<token>` (or `?token=`) |

Item types: `message`, `notification`, `screenshot`, `photo`, `file`, `usage`, `call` (bin also: `conversation`, `attachment`, `media`).

Search returns `{ total, exactTotal, fuzzyTotal, pages, counts: {type: {exact, fuzzy}}, items, groups, semantic }`; every item carries `eventTime` + `timeField` (which original column) and `capturedAt` separately, a `snippet` / `snippetHtml` (`<mark>` highlights, HTML-escaped), `match: exact|fuzzy`, and `detail` with the direct-access fields (conversation + message id, file availability `reference|preview|local|stale_local`, media URLs). Query syntax: words (substring, 3+ chars via the trigram index), `word*`, `"exact phrase"`, `-exclude`; 1-2 character terms are matched by scan. Typo tolerance: candidates from the trigram index, then edit distance 1 (4-7 chars) or 2 (8+), listed after all exact matches. Semantic search (Q6) is an extension point (`SemanticProvider` in `src/query/search.ts`, `semantic` in the response) and is off.

Commands move `queued -> sent -> transferring -> uploaded -> done` for a `file_request` (or end in `not_found`, `access_denied`, `too_large`, `error`, `expired`, `cancelled`). `transferring` starts when a `file_original` manifest carrying the command's `commandId` (PROTOCOL §2.2) is committed; the command view's `progress` (`committedParts/totalChunks`, `committedBytes/totalSize`) advances as parts commit, before the device's `command_status: uploaded` arrives. The original is placed and the command completes as soon as the last part is in; a part that fails verification turns the command into `error` ("transfer failed: ..."). A manifest is linked only to an outstanding `file_request` sent to a device of the bucket's role.

Coverage `collectors[].import` uses the device-reported `importTotal` / `importDone` / `phase` (PROTOCOL §6) when present: `{source: "device", phase, total, done, percent, state: in_progress|complete|counting|live, indexed}`. Older devices fall back to a total in a JSON cursor or to the vault's own count (`percent: null`).

Event types on the stream: `ingest.poll|committed|quarantined|replayed|error`, `blob.progress|complete`, `command.issued|sent|transferring|progress|status|completed|cancelled`, `file.cached`, `media.ocr`, `pairing.started|completed|rejected|expired|cancelled`, `device.revoked`, `keystore.*`, `r2.configured`, `coverage.changed`, `bin.deleted|restored|purged`. Events carry ids, keys, kinds and counts, not content. While locked only `keystore.*` events are sent.

## How ingest works

Per pass and up-bucket: list `pair/` and each record prefix from (marker - 8 days), plus a full listing (no marker window) on the first pass after service start, after an unlock from a full lock, whenever the bucket's last successful poll is older than that window, hourly, and with `{full: true}`. There is no expiry on the up-buckets, so a Mac that was off for weeks catches up on its first poll; per object fetch, ledger check (same bytes = replay, only deleted; different bytes under a committed key = quarantined), decrypt with the in-memory key, validate with the protocol schemas, check the device is paired for that bucket's role, then commit the records and the ledger row in one SQLite transaction, delete the object from R2, and finally advance the marker (highest committed oid). Any failure quarantines that one object (ciphertext kept under `data/quarantine/`) and the pass continues; network errors and a lock mid-pass leave objects for the next pass.

Chunked blobs: the manifest is verified and stored (as its envelope; the content key never sits in the database in clear), each part is verified alone (length, SHA-256, header, AES-GCM with the per-index AAD) and its plaintext written at its offset into `data/blobs/<bucket>-<oid>.part`, with `blobs.committed_parts` updated in the part's commit transaction. One part in memory at a time; restarts resume; the completed file is size- and hash-checked and moved to `media/`, `thumbs/`, `files/<oid>/<name>` or `attachments/`, then linked to its rows (media, file thumbnail, file_request result -> `files.status = cached`, attachment).

## OCR and thumbnails

Every screenshot or photo original that is placed in `media/` is queued for post-processing (bounded concurrency, `IVY_OCR_CONCURRENCY`, off the ingest path). With Apple Vision (`@ivy/mac-ocr`, the default on macOS) OCR and the thumbnail (`thumbs/media-<id>.jpg`, long edge 360) come from one decode in the warm Swift helper. The text goes to `media.ocr_text`, which the FTS5 index picks up, so `GET /api/search` finds screenshots by what is written in them; `ocr_status` becomes `done`, or `failed` for a file Vision cannot read. A `media.ocr` event is emitted per item.

When the helper is unavailable (no Swift toolchain, build failure, crash loop), items stay `ocr_status = 'pending'`, thumbnails are made with `sips` instead, and the helper is probed again every 5 minutes. The pending backlog is processed on startup, after unlock, and as soon as the helper becomes available.
