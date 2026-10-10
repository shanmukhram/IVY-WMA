# @ivy/mac-service

The local service at the heart of the IVY Mac dashboard (PRD Part 2). It holds the Mac identity key, pulls ciphertext from both R2 up-buckets, decrypts and validates it with `@ivy/protocol`, commits it into `./data/vault.db` (SQLite + FTS5) under an ingest ledger, deletes it from R2, and serves search, timeline, coverage, commands and the recovery bin to a browser UI over HTTP and a WebSocket event stream. The Electron window is a thin wrapper around that UI.

## Run

Node 25 runs the TypeScript directly (type stripping), so there is no build step for this package. `@ivy/protocol` and `@ivy/mac-ocr` are consumed through their built `dist/`, which `prestart`/`pretest` rebuild. The OCR tests use real Apple Vision on this Mac (the Swift helper is built on first use, see `mac/ocr/README.md`).

```sh
pnpm install
pnpm --filter @ivy/mac-ui build                 # optional: builds mac/ui/dist
pnpm --filter @ivy/mac-service start            # builds @ivy/protocol, then node src/main.ts
# or, with options:
cd mac/service && node src/main.ts --data ./data --port 4777 --static ../ui/dist
pnpm --filter @ivy/mac-service test             # vitest (S3 mock, no R2 credentials needed)
```

Relative `--data`, `--db` and `--static` (and `IVY_DATA_DIR`, `IVY_DB_PATH`, `IVY_STATIC_DIR`) resolve against the directory you run the command from, so the example above works as written. Without `--static`, the service serves the built dashboard `mac/ui/dist` when `mac/ui/dist/index.html` exists (located relative to this package, not the working directory), and the placeholder page in `mac/service/public` otherwise. The startup lines print the resolved data and UI directories. `pnpm --filter @ivy/mac-service start` runs with `mac/service` as its working directory, so its default data directory is `mac/service/data`.

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
| UI directory served at `/` | `IVY_STATIC_DIR`, `--static` | `mac/ui/dist` if it has an `index.html`, else `mac/service/public` (placeholder page) |
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
| R2 | `GET /api/r2` (redacted), `PUT /api/r2`, `POST /api/r2/check` (lists each bucket, reports reachability), `POST /api/r2/audit {markers?, harvest?, buckets?, prefix?}` (zero-plaintext audit of the buckets with the service's own tokens and markers harvested from the vault; returns counts and hit keys/rules, never plaintext), `GET /api/r2/objects?bucket=up-windows&prefix=` (keys and sizes) |
| pairing / devices | `POST /api/pairings {role}` -> `{pairingId, pairingString, macFingerprint, expiresAt}`, `GET /api/pairings`, `DELETE /api/pairings/:id`, `GET /api/devices`, `GET /api/devices/:id`, `DELETE /api/devices/:id` (revoke), `GET /api/fingerprints` |
| ingest | `POST /api/ingest/poll {full?}`, `POST /api/ingest/pause {minutes?}` / `POST /api/ingest/resume` (hold objects in R2 without locking the vault; the pause ends by itself, default 60 min), `GET /api/ingest/status`, `GET /api/quarantine[?all=1]`, `POST /api/quarantine/:id/retry`, `DELETE /api/quarantine/:id` |
| commands (F2/F3) | `GET /api/commands?device=&status=&file=`, `GET /api/commands/:id`, `POST /api/commands {deviceId, params}`, `DELETE /api/commands/:id`, `POST /api/files/:id/request {force?}`, `POST /api/devices/:id/rescan {collector, scope?}`, `POST /api/devices/:id/collector-config {collector, enabled?, settings?}` |
| search (Q1-Q5) | `GET /api/search?q=&type=&device=&app=&person=&conversation=&account=&from=&to=&page=&pageSize=&sort=relevance\|newest\|oldest&typo=off` |
| timeline (T1-T5) | `GET /api/timeline?date=YYYY-MM-DD&tz=<IANA or offset minutes>&device=&type=&page=&pageSize=` (or `from`+`to`) |
| coverage (D1-D5) | `GET /api/coverage`, `GET /api/stats` |
| records (Q4) | `GET /api/items/:type/:id`, `GET /api/conversations/:id/messages?around=<messageId>&before=&after=`, `GET /api/files`, `GET /api/files/:id/content`, `GET /api/files/:id/thumb`, `GET /api/media/:id/content`, `GET /api/media/:id/thumb` |
| recovery bin (B1-B4) | `DELETE /api/items/:type/:id` (to the bin), `GET /api/bin`, `POST /api/bin/:type/:id/restore`, `DELETE /api/bin/:type/:id` (permanent), `GET`/`PUT /api/bin/settings {retentionDays}`, `POST /api/bin/sweep` |
| events | `GET /api/activity?limit=&before=&type=a,b`; WebSocket `/events` (or `/api/events`) with subprotocol `bearer.<token>` (or `?token=`) |
| AI (A1-A4, T6, Q7) | `GET`/`PUT /api/ai/settings {cloudEnabled?, apiKey?, model?, embeddings?, embeddingModel?}`, `GET /api/ai/models`, `POST /api/ai/ask {question, context?: {searchQuery?, filters?, date?, timeline?, tz?}, conversationId?}`, `POST /api/ai/overview {context, conversationId?}`, `GET /api/ai/conversations`, `GET`/`DELETE /api/ai/conversations/:id`, `GET /api/ai/embeddings`, `POST /api/ai/embeddings/run {limit?}` |
| dashboard views (read-only, `src/http/view-routes.ts`) | `GET /api/views/sources` (conversation capture sources per platform), `GET /api/views/chats?source=&role=&platform=&q=` (chats with last message), `GET /api/views/chats/:id/profile` (counts, first/last message, coverage per source), `GET /api/views/records?type=a,b&device=<id\|role>&app=` (newest-first listing for per-device views and the gallery), `GET /api/views/notification-apps?device=` |
| Activity Vault import (S7) | `GET /api/imports/activity-vault`, `PUT /api/imports/activity-vault/settings {enabled?, adapter?: local\|mcp, path?, url?}`, `POST /api/imports/activity-vault/run` |

Item types: `message`, `notification`, `screenshot`, `photo`, `file`, `usage`, `call`, `browsing` (bin also: `conversation`, `attachment`, `media`, `ai_conversation`).

Search returns `{ total, exactTotal, fuzzyTotal, pages, counts: {type: {exact, fuzzy}}, items, groups, semantic }`; every item carries `eventTime` + `timeField` (which original column) and `capturedAt` separately, a `snippet` / `snippetHtml` (`<mark>` highlights, HTML-escaped), `match: exact|fuzzy`, and `detail` with the direct-access fields (conversation + message id, file availability `reference|preview|local|stale_local`, media URLs). Query syntax: words (substring, 3+ chars via the trigram index), `word*`, `"exact phrase"`, `-exclude`; 1-2 character terms are matched by scan. Typo tolerance: candidates from the trigram index, then edit distance 1 (4-7 chars) or 2 (8+), listed after all exact matches. Semantic search (Q6) fills `semantic` ("Semantic matches", never merged into the exact list) only while cloud AI and `ai.embeddings` are both on; otherwise `semantic.enabled` is false.

Commands move `queued -> sent -> transferring -> uploaded -> done` for a `file_request` (or end in `not_found`, `access_denied`, `too_large`, `error`, `expired`, `cancelled`). `transferring` starts when a `file_original` manifest carrying the command's `commandId` (PROTOCOL §2.2) is committed; the command view's `progress` (`committedParts/totalChunks`, `committedBytes/totalSize`) advances as parts commit, before the device's `command_status: uploaded` arrives. The original is placed and the command completes as soon as the last part is in; a part that fails verification turns the command into `error` ("transfer failed: ..."). A manifest is linked only to an outstanding `file_request` sent to a device of the bucket's role.

Coverage `collectors[].import` uses the device-reported `importTotal` / `importDone` / `phase` (PROTOCOL §6) when present: `{source: "device", phase, total, done, percent, state: in_progress|complete|counting|live, indexed}`. Older devices fall back to a total in a JSON cursor or to the vault's own count (`percent: null`).

Event types on the stream: `ingest.poll|committed|quarantined|replayed|error`, `blob.progress|complete`, `command.issued|sent|transferring|progress|status|completed|cancelled`, `file.cached`, `media.ocr`, `pairing.started|completed|rejected|expired|cancelled`, `device.revoked`, `keystore.*`, `r2.configured`, `coverage.changed`, `bin.deleted|restored|purged`, `ai.answered|embedded`, `import.completed|failed`. Events carry ids, keys, kinds and counts, not content. While locked only `keystore.*` events are sent.

## How ingest works

Per pass and up-bucket: one listing of `up/`, keeping for each record prefix only the keys after `up/<prefix>/<marker - 8 days>` (oids are time-ordered within a prefix but not across prefixes, so the window is applied per prefix to that one listing), and a listing of `pair/` only while a pairing for that role is open (pending, or created or consumed within the 10 + 5 minute pairing window). A full listing of the bucket (no marker window) replaces the `up/` listing on the first pass after service start, after an unlock from a full lock, whenever the bucket's last successful poll is older than that window, hourly, and with `{full: true}`; it also picks up unrecognised keys and stray `pair/` objects. There is no expiry on the up-buckets, so a Mac that was off for weeks catches up on its first poll; per object fetch, ledger check (same bytes = replay, only deleted; different bytes under a committed key = quarantined), decrypt with the in-memory key, validate with the protocol schemas, check the device is paired for that bucket's role, then commit the records and the ledger row in one SQLite transaction, delete the object from R2, and finally advance the marker (highest committed oid). Any failure quarantines that one object (ciphertext kept under `data/quarantine/`) and the pass continues; network errors and a lock mid-pass leave objects for the next pass.

Chunked blobs: the manifest is verified and stored (as its envelope; the content key never sits in the database in clear), each part is verified alone (length, SHA-256, header, AES-GCM with the per-index AAD) and its plaintext written at its offset into `data/blobs/<bucket>-<oid>.part`, with `blobs.committed_parts` updated in the part's commit transaction. One part in memory at a time; restarts resume; the completed file is size- and hash-checked and moved to `media/`, `thumbs/`, `files/<oid>/<name>` or `attachments/`, then linked to its rows (media, file thumbnail, file_request result -> `files.status = cached`, attachment).

## R2 request budget

R2 bills ListObjectsV2, PutObject, CopyObject and the multipart writes as Class A operations (1 million free per month) and GetObject/HeadObject as Class B (10 million free); DeleteObject is free. With the listing above the Mac makes about **one list call per up-bucket per poll** (2 per poll with both up-buckets configured; the default poll interval is 15s; measured against the mock in `test/request-budget.test.ts`, which asserts that bound; the previous per-prefix listing made 22).

| Who | Operation | Rate | Per month (30 days) |
| --- | --- | --- | --- |
| Mac | ListObjectsV2, `up/` (or the hourly full listing in its place), 2 up-buckets | every 15 s | about 345 600 |
| Mac | ListObjectsV2 `pair/` while a pairing is open | about 8 per pairing | negligible |
| Mac | extra list pages | +1 per 1 000 objects waiting in a bucket | only during a backlog |
| Mac | PutObject `cmd/<oid>` | per command | tens |
| Mac | `POST /api/r2/check` | 4 per press | negligible |
| **Mac Class A** | | | **about 43 000** |
| Windows | ListObjectsV2 on its cmd-bucket (command poll) | every 2 min | 21 600 |
| Windows | PutObject `device_report` | every 5 min | 8 640 |
| Windows | PutObject records and blobs (first-run workload: about 200 objects a day: file metadata, screenshots and their parts, usage, notifications) | about 200 / day | 6 000 |
| Windows | multipart for objects over 16 MiB (8 MiB parts): create + parts + complete, e.g. 6 for a 32 MiB chunk instead of 1 | per large object | a 50 MB file request costs about 13 (2 chunks as multipart, manifest, status) |
| **Total Class A** | | | **about 80 000, 8 % of the free tier** |

Class B: the Mac GETs each object once (about 15 000 a month for the workload above), far below 10 million. A slower poll (`IVY_POLL_INTERVAL_MS`) scales the Mac's line linearly.

### Media originals kept in R2

With `keepMediaInR2` on (the default), a completed media original (manifest `payloadKind` of `photo`, `document`, `attachment` or `media`) is left in its up-bucket instead of being deleted after commit, so the Mac can fetch it again at full quality on demand without the capturing device being online (PLAN decision 6; thumbnails, avatars, screenshots and `file_request` results are still deleted after commit, and their small local copies cache as before). Each archived original is recorded in `media_archive` (the `up/blob/<oid>/manifest` key, the part keys, the plaintext SHA-256, size, filename and content type) and its blob row keeps the manifest envelope, so the Mac's own key can always decrypt it again.

The cost is listing growth: archived blobs stay under `up/blob/`, so each one adds its manifest plus one key per part to every full listing of the bucket (hourly, and on start / unlock / after an absence). This does **not** add list calls — it is still about one `ListObjectsV2` per up-bucket per poll — and it does **not** add GETs: a completed archived oid is recognised by key (its ledger rows are committed and its blob row is `complete`) and skipped before any fetch, so it is never re-downloaded or re-assembled. Accepted per PLAN decision 6 (the up-buckets have no expiry; persistent media is the point). `POST /api/ingest/settings {"keepMediaInR2": false}` restores the old delete-after-commit behaviour for media too, and `GET /api/ingest/status` reports the archive's object count and byte size. `POST /api/media/:id/fetch` pulls a full original from R2 into the cache on demand; `POST /api/media/:id/evict` drops the local copy to free disk while keeping the object in R2 for the next fetch.

## OCR and thumbnails

Every screenshot or photo original that is placed in `media/` is queued for post-processing (bounded concurrency, `IVY_OCR_CONCURRENCY`, off the ingest path). With Apple Vision (`@ivy/mac-ocr`, the default on macOS) OCR and the thumbnail (`thumbs/media-<id>.jpg`, long edge 360) come from one decode in the warm Swift helper. The text goes to `media.ocr_text`, which the FTS5 index picks up, so `GET /api/search` finds screenshots by what is written in them; `ocr_status` becomes `done`, or `failed` for a file Vision cannot read. A `media.ocr` event is emitted per item.

When the helper is unavailable (no Swift toolchain, build failure, crash loop), items stay `ocr_status = 'pending'`, thumbnails are made with `sips` instead, and the helper is probed again every 5 minutes. The pending backlog is processed on startup, after unlock, and as soon as the helper becomes available.

## AI layer (PRD A1-A4, T6, Q7, M4)

Cloud AI is a switch, default **off** (`ui.ai.cloudEnabled`, the same switch as `PUT /api/ui-settings`). While it is off every route that would call OpenAI (`ask`, `overview`, `models`, `embeddings/run`) answers 409 `ai_disabled`, no OpenAI client is constructed, and search / timeline / browsing are unchanged (tested). The local AI history (`/api/ai/conversations`) stays readable; nothing is sent to read it. The OpenAI API key is sealed under the identity key like the R2 tokens (`sealed:openai`) and is never returned; `GET /api/ai/settings` reports only `apiKeySet`. `ai.model` unset means the newest plain GPT-5-class id in the account's model list (`gpt-5`, `gpt-5.1`, ...), read from `GET /v1/models`, never hardcoded.

What is sent when it is on: the question, and the passages and records the assistant's tools retrieve while answering. `POST /api/ai/ask` runs a tool-calling loop (OpenAI chat completions, the official `openai` package) with tools `search(query, filters, page)`, `timeline(date)`, `get_record(id)`, `open_conversation(messageId)` and `coverage()`, all executed against the local index (`src/ai/tools.ts`). The answer is `{ answer, facts: [{text, recordIds}], inferences: [{text, basis}], missing: [], records, toolCalls, retried, model, conversationId }`. Every fact must cite a record id a tool returned in that conversation; otherwise the answer is rejected and the model asked once more, and a second failure is 502 `ai_unlinked_facts` (no unlinked answer is shown). `conversationId` continues a conversation (transcript, retrieved records and the latest context are kept in `ai_conversations`, which is in the recovery bin like any record; permanently deleting a record also deletes AI conversations that quoted it). `POST /api/ai/overview` runs `search` or `timeline` locally first and asks for a short overview under the same rules. Answers are returned whole (no SSE streaming: the evidence check needs the complete answer before anything is shown).

Embeddings (`ai.embeddings`, off by default, needs cloud AI): a job (every 15 min while on, or `POST /api/ai/embeddings/run`) embeds message text and media OCR text into `embeddings` (float32, L2-normalised; a changed text or a purged item drops its vector), and search's `semantic` section ranks them by cosine similarity. The PRD's local-model default is a TODO: `Embedder` / `LocalEmbedder` in `src/ai/embeddings.ts` is the interface; no local model is bundled yet.

## Activity Vault import (PRD S7)

`src/imports/activity-vault.ts` copies Google activity from Activity Vault into `browsing_events` (FTS on title, subtitle, link; type `browsing` in search and on the timeline, `app` = the Google product), daily when enabled (checked hourly, only while the key is in memory) and on demand. Sources implement `ActivityVaultSource`:

- `local` (`imports.activityVault.path`): a SQLite file, a JSON / JSON Lines file, or a folder holding one, opened read-only (`readonly` + `query_only`). Minimal shape: rows with `time` (ISO or epoch s/ms/µs), `product`, `title`, optional `subtitle`, `link` (or `url`), `id`, `captured_at`; optionally a `capture_status` table / `captureStatus` object with per-day `date`, `status` (`healthy|gap|unknown`), `note`. Rows without a usable time are skipped and counted, never given an invented time.
- `mcp` (`imports.activityVault.url`): a stub. Activity Vault is reachable as an MCP server (`search`, `timeline`, `capture_status`), but the transport is not settled; the adapter fails with a clear error (TODO in the file).

Re-imports are idempotent (source id, else a hash of time/product/title/link); rows deleted in IVY are not re-imported, and a permanent delete leaves only that key in `import_tombstones`. Every run is in `import_runs`. Coverage (`GET /api/coverage` -> `imports[]`) shows the "Activity Vault import" row with last run, last success, rows, and the days of the last 14 without rows: `gap` only where the source itself reported a capture gap, otherwise `unknown`.
