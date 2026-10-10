# PRD: IVY

> Amended Oct 10, 2026: companions are visible, first-class apps (see Overview). Bucket names use the ivy-* prefix.

Oct 6, 2026 · @shanmukh

## Overview

IVY is a personal memory and search dashboard on Bunny's Mac, fed by visible, first-class companion apps on his Windows machine and his rooted Android phone. Nothing runs hidden on any device: each companion is an app Bunny opens and uses, showing collector status, a live capture-activity feed, per-collector toggles, pause controls, import progress, and queue state as it works. The companions capture everything they can reach — conversations, notifications, screenshots, photos, files, call logs, app usage — encrypt it on the device, and drop it in Cloudflare R2. The Mac pulls from R2, decrypts, indexes, and keeps the archive locally. Search, timelines, and AI follow-up questions all run against the Mac's copy; the companions never read the archive back.

The problem: Bunny's life is spread across three devices and a dozen apps. The robotics collaboration offer is a screenshot somewhere on the phone, a chat in LINE, a PDF on Windows, and a deadline in a notification he dismissed a week ago. Remembering anything means knowing which device, which folder, which app, which filename — and doing it manually, every time.

The outcome: one search bar on the Mac that finds the message, screenshot, file, notification, or photo by description; one timeline that reconstructs any day across all three devices; and a coverage dashboard that shows honestly what is captured and what is not. Windows and Android stay capture-and-serve companions. The Mac is the only place the archive is read.

Session Sync and Activity Vault stay separate products. The dashboard imports Activity Vault's browsing archive read-only as one more source. Session Sync is untouched; login and session availability are tracked nowhere in this product.

Conversation priority is fixed: LINE first, Telegram second, WhatsApp third. It is also the build order — LINE's store is the least documented of the three and drifts most between app versions, so it lands first where the risk is; WhatsApp's store is the best-documented encrypted database in existence, so it goes last.

## How this document is organised

| Part | Covers |
| --- | --- |
| Part 1 | Windows app: the visible companion |
| Part 2 | Mac dashboard: the vault, the index, the features |
| Part 3 | Android app: the rooted companion |
| Part 4 | Testing all of them together: gates and the roadmap |

## Requirements shared across the product

- Mac-centred dashboard: one interface for search, timelines, records, device status, and AI questions.
- Local-first archive: routine search uses already-synced, indexed content on the Mac. R2 is transit, not storage.
- Initial import plus ongoing updates: historical capture establishes the archive; incremental sync keeps it current; daily reconciliation finds what was missed.
- Evidence-backed AI: summaries and answers link to supporting records and distinguish facts, inferences, and missing information.
- OpenAI API integration for summarisation, interpretation, embeddings, and tool calling. Content sent for processing leaves the local devices, so cloud processing is an explicit setting that names what would be sent.
- Source-specific access: permissions and root enable individual collectors; they do not guarantee access to every app. Snapchat is notification-only and says so.
- Account clarity: every result retains its device, app, and account identity.
- Search performance: ordinary indexed searches should feel immediate; large result sets load progressively. Provisional target in Part 2; the final number is set during technical planning.

## Product principles

1. **R2 is a mailbox, not a vault.** Every object in every bucket is ciphertext, encrypted on a device to the Mac's public key and deleted after ingest. A leaked bucket yields sizes and timing, nothing readable.
2. **Devices capture, the Mac understands.** Companions do extraction, encryption, and upload. OCR, indexing, linking, and AI happen on the Mac, once, in one place.
3. **Two speeds.** Tiny records — notifications, statuses — travel on any network within minutes. Bulk — database dumps, media originals — travels on WiFi and charging, overnight. Freshness where it matters, patience where it does not.
4. **Never lie about coverage.** Every source shows last successful sync, import completeness, and known gaps. A missing afternoon of browsing is displayed, not papered over by an AI summary.
5. **Full history first, honest labels always.** Root reads complete databases the way a manual copy would, automatically. Where an app cannot be read, the record says notification-only instead of pretending.
6. **Cloud AI is a switch, not a default.** Text search and OCR work locally. Anything sent to OpenAI is an explicit setting, and with it off the product still works.

## The user and the three devices

One user: Bunny. A Windows 11 desktop holding personal accounts and files, usually on. A Mac holding professional work, and now the vault. A rooted Android phone holding his actual life: chats, photos, notifications, calls. The machines can be anywhere; R2 is the rendezvous, so no LAN dependency, no Tailscale, no port forwarding.

## Shared architecture: buckets, keys, pairing

R2 tokens are bucket-scoped, so bucket separation is the access control. Four buckets:

| Bucket | Who writes | Who reads and deletes | Holds |
| --- | --- | --- | --- |
| ivy-up-windows | Windows | Mac | Encrypted captures from Windows |
| ivy-up-android | Android | Mac | Encrypted captures from Android |
| ivy-cmd-windows | Mac | Windows | Encrypted commands to Windows |
| ivy-cmd-android | Mac | Android | Encrypted commands to Android |

Each device holds exactly one write token (its up-bucket) and one read token (its cmd-bucket). The Mac holds read-and-delete on the up-buckets and write on the cmd-buckets. No lifecycle expiry on up-buckets: R2 holds encrypted captures until the Mac commits them, however long the Mac is offline. A 30-day lifecycle rule on cmd-buckets is the backstop for stale commands; the Mac deletes cmd-objects once the device's status report arrives (devices hold read-only cmd tokens). [Amended Oct 10, 2026.]

Encryption is the same hybrid scheme as Session Sync: a fresh AES-256-GCM key per object, wrapped to the recipient's X25519 public key. Device-to-Mac objects are wrapped to the Mac's key; Mac-to-device commands are wrapped to that device's key. Private keys never leave their machine: the Mac's is passphrase-encrypted at rest (Argon2id), Windows' lives in DPAPI, Android's in the Keystore.

Pairing, once per device: the Mac shows a one-time code and its service fingerprint; the device enters the code (Android can scan a QR), exchanges public keys and scoped tokens, and both screens display the same fingerprint to confirm. Re-pairing after a Mac restore works from the same passphrase, like Session Sync.

[embedded content: IVY architecture · 5 components, two directions]

What R2 sees: object sizes, timing, and prefixes. No compute, no server, no plaintext.

---

# Part 1 — Windows app

## Overview

A visible companion app for Windows 11: a full window plus a tray icon, with a worker that keeps running while the window is closed. The window shows collector status, a live capture-activity feed, per-collector toggles, pause controls, import progress, and queue state. It indexes selected drives and folders, watches the Screenshots folder, samples foreground app usage, reads Windows notification records where the database is accessible, queues everything encrypted in local SQLite, uploads to R2, and serves file-retrieval requests from the Mac. It never searches, never browses the archive, never shows content. That all happens on the Mac.

## Goals and non-goals

**Goals**

- One installed app, zero configuration beyond pairing and picking folders
- File index of selected drives and folders, metadata synced continuously; originals transferred only on request
- Screenshot originals uploaded automatically: small, high search value
- App-usage events sampled every 30 seconds; Windows notification records captured where readable
- Offline-tolerant: a local encrypted queue that survives reboots and flushes on reconnect, with resumable multipart uploads for large files
- Serves retrieval commands: the Mac asks for a path, Windows uploads the encrypted original and reports the outcome
- Zero plaintext leaves the machine, ever

**Non-goals for v1**

- No searching or browsing of the archive on Windows. The companion captures and serves; it does not read.
- No conversation capture on Windows. Chat apps live on the phone.
- No browsing-history capture. Activity Vault already does this as a separate product; the Mac dashboard imports Activity Vault's archive instead.
- No Session Sync role. Cookie sync remains its own product.
- No inbound content. The only thing Windows ever receives from the Mac is encrypted commands and collector config.
- No capture of files the account cannot read, or locked volumes that are not mounted.
- Window-title capture is a setting with an exclusion list, because titles can carry content.

## User and core use cases

| Use case | What happens |
| --- | --- |
| Pair Windows to the vault | Bunny enters the one-time code from the Mac, confirms the fingerprint, picks folders. Done; nothing else is ever typed on Windows. |
| Overnight index | First run scans the selected drives, uploads metadata and thumbnails in batches over a day or two, resumable. Progress is visible both in the Windows app and on the Mac's coverage dashboard. |
| "Bring the invoice PDF from Windows" | The Mac writes a command. Windows polls within 2 minutes, finds the file, encrypts, multipart-uploads. The Mac notifies Bunny. |
| PC off or asleep | Commands wait in the bucket; captures wait in the local queue. Both complete on next boot; nothing is lost. |
| Screenshot taken | Watcher fires, image encrypted and uploaded within minutes, OCR'd on the Mac, searchable by dinner. |

## Functional requirements

**Capture, Windows**

| ID | Requirement | Priority |
| --- | --- | --- |
| WC1 | Index selected drives and folders: path, name, size, mtime, extension, quick hash; incremental updates via USN journal with periodic full rescans | Must |
| WC2 | Generate thumbnails for images and PDF first pages | Should |
| WC3 | Watch the Screenshots folder and upload screenshot originals on change | Must |
| WC4 | Sample the foreground app every 30 seconds: executable, app name, window title (setting, default on, exclusion list); sessions are grouped on the Mac | Must |
| WC5 | Read Windows notification records from the notification database where accessible; run elevated if required; record title, app, text, timestamp | Should |
| WC6 | Capture policy: metadata always; originals per rule — screenshots always, everything else on request | Must |

**Upload and queue, Windows**

| ID | Requirement | Priority |
| --- | --- | --- |
| WU1 | Encrypt every object on-device to the Mac's public key before it touches disk or network | Must |
| WU2 | Local SQLite queue of pending ciphertext; survives reboot; resumable multipart uploads for large files | Must |
| WU3 | Write only to the Windows up-bucket; delete queue entries only after confirmed upload | Must |
| WU4 | Poll the Windows cmd-bucket every 2 minutes; execute valid commands, report outcomes | Must |
| WU5 | Bandwidth cap and a pause/resume control for uploads | Should |

**Retrieval serve, Windows**

| ID | Requirement | Priority |
| --- | --- | --- |
| WR1 | Serve file-request commands: locate by path or id, read, encrypt, multipart-upload | Must |
| WR2 | Report per-request outcome: uploaded, not found, access denied, too large | Must |
| WR3 | Execute rescan and collector-config commands pushed from the Mac | Should |

**Pairing and setup, Windows**

| ID | Requirement | Priority |
| --- | --- | --- |
| WP1 | Pair via a one-time code: receive the Mac public key and the up-bucket token; send the device public key | Must |
| WP2 | Run at login with a tray icon and an openable status window; no user interaction required after pairing | Must |
| WP3 | Store its own private key via DPAPI; store nothing that can decrypt vault content | Must |

## Data model

Local SQLite at `vault-agent.db`. The queue holds ciphertext only; the file cache is metadata used to answer rescan commands quickly.

**pending_uploads**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| object_key | text | destination key in the up-bucket |
| part_path | text | local path of the encrypted part, or the whole object |
| size | integer |  |
| attempts | integer | retry counter |
| status | text | queued, uploading, done |

**file_cache**

| Field | Type | Notes |
| --- | --- | --- |
| path | text | primary key |
| quick_hash | text | change detection without re-read |
| mtime | timestamptz |  |
| last_seen | timestamptz | drives rescan diffs |

**collector_state**

| Field | Type | Notes |
| --- | --- | --- |
| name | text | files, screenshots, usage, notifications |
| last_run_at | timestamptz |  |
| cursor | text | per-collector progress marker |

## Architecture

| Component | Role | Stack |
| --- | --- | --- |
| App window + tray + worker | Start at login, visible status window, live activity feed, tray icon, background worker | C#, .NET 8, WinUI 3 |
| Collectors | FileSystemWatcher + USN journal for files; foreground-window polling via Win32; notification database reader | C#, P/Invoke |
| Crypto + queue | Hybrid encryption to the Mac's public key, SQLite pending queue, multipart | NSec (libsodium), better-sqlite3-equivalent |
| R2 client | S3-compatible uploads and command polling, scoped tokens | AWS SDK for .NET |

**Capture flow, one file event**

1. Watcher or journal reports a change. Read metadata; generate a thumbnail if applicable.
2. Serialize the record, generate a random AES key, encrypt, wrap the key with the Mac's public key.
3. Queue the object. Upload to `ivy-up-windows`; delete the queue entry after confirmation.

**Retrieval flow, one command**

1. Poll finds a command object; decrypt with the device private key.
2. Locate the file, read it, encrypt in parts, multipart-upload to the up-bucket.
3. Write a status object (uploaded, not found, denied) and delete the command.

## App UI

A full app window plus a tray icon, in the family's Supabase-style dark look: near-black background, 1px borders, one green accent, monospace for timestamps and fingerprints.

- Not paired: a single field for the one-time code. That is the only input Windows ever has.
- Paused/running toggle, per-collector rows: files, screenshots, usage, notifications — each with an on/off toggle, last capture, last upload, queue depth, status dot.
- Live capture-activity feed: every capture, encrypt, and upload event as it happens, plus import progress for the initial index.
- Folder picker, bandwidth cap, pause, "Sync now."
- Footer: bucket reachability, pairing fingerprint.

No search, no timeline, no archive browser, no settings beyond capture and network. Everything else lives in the Mac dashboard.

## Success metrics

| Metric | Target | How measured |
| --- | --- | --- |
| Index coverage | At least 95% of selected folders' files searchable on the Mac within 48h of first run | Mac file records vs. a sampled directory listing |
| Freshness | New file metadata searchable within 10 minutes while online | mtime vs. ingested_at |
| Retrieval | 50 MB file Mac-bound within 5 minutes on typical broadband | Timed test |
| Zero plaintext | No readable content in the bucket or local queue | Grep of bucket listing, object samples, queue dump each release |

## Milestones

Phase 1 proves the R2 pipeline with the least sensitive data there is — Windows file metadata and one retrieved PDF. Gate G1 in Part 4. Nothing sensitive ships until G1 passes.

---

# Part 2 — Mac dashboard

## Overview

The face of the product. An Electron app over a local service: it pulls ciphertext from both up-buckets, decrypts, commits into `./data/vault.db` with FTS5, runs OCR through macOS Vision, builds the timeline, and answers questions. One search bar covers messages, notifications, screenshots, photos, files, and titles. The coverage dashboard tells the truth about every source. AI is a drawer beside the data, never a replacement for it.

## Goals and non-goals

**Goals**

- Ingest and decrypt everything from both up-buckets; delete from R2 only after commit; survive restarts and duplicates via an ingest ledger
- Unified search: exact words, phrases, typo tolerance; filters by device, app, account, person, conversation, date, content type; all matches paginated, never an AI-selected sample
- Conversation archive: complete history per app per contact from rooted extraction, incremental updates, attachments, open-at-match — LINE first, Telegram second, WhatsApp third
- Notification archive from the Android listener, segregated per app, retained after dismissal
- Screenshot and photo search: OCR text always; visual-description search when embeddings are enabled; media-origin linking to conversations
- Day reconstruction: one timeline across all sources, with coverage gaps shown on the timeline itself
- Cross-device file retrieval with offline queueing
- Coverage dashboard per device, source, and app
- AI overview and follow-ups, evidence-linked, cloud as an explicit setting
- Recovery bin with explicit permanent delete

**Non-goals for v1**

- Live search across accounts on demand (querying sources fresh when the archive is not enough) — v2
- Automatic project collections — v2
- Habit-analysis dashboards and break reminders — v2. Usage events are captured now; analysis comes later.
- Saved searches and digest alerts — v2
- No vault reading on Windows or Android; companions stay capture-only
- No recovery of anything deleted before it was captured; no view-once or disappearing content, ever
- No sending of content to OpenAI unless the setting is on; when on, only the minimum needed — the search passage or the image being described — and the setting names it
- No trusting of inferred links: every origin or context link is labeled evidenced or inferred
- No multi-user, no sharing, no cloud archive. The archive is the Mac.

## User and core use cases

| Use case | What happens |
| --- | --- |
| "Find the screenshot of that robotics collaboration offer" | One search bar; OCR text and visual description both hit; result shows the image, the OCR passage, and the LINE message it came from. |
| "Show everything that happened on September 24" | Timeline merges photos, messages, notifications, calls, files, usage, browsing (via Activity Vault import). "Expand the afternoon" zooms without losing the day. |
| "Bring the invoice PDF from Windows" | File result shows reference-only status; request queues, transfers, lands in the vault, Bunny gets a notification. |
| Search "collaboration" | Every match across LINE, Telegram, WhatsApp, notifications, screenshots, and documents, paginated; clicking a message opens the thread at that message. |
| "Who sent me this product image?" | Origin panel: source app, conversation, sender, message — with surrounding messages, and both the LINE and WhatsApp occurrences listed. |
| Coverage check | "Android notifications captured; Windows browsing missing this afternoon" — because Activity Vault import ran late, and the dashboard says so. |

## Functional requirements

**Sync and ingest**

| ID | Requirement | Priority |
| --- | --- | --- |
| S1 | Poll both up-buckets every 2 minutes and on demand; list since the last marker | Must |
| S2 | Decrypt each object with the passphrase-held key; commit idempotently; delete the R2 object only after commit | Must |
| S3 | Keep an ingest ledger (device, bucket, key, kind, status) so restarts and duplicates cannot double-import | Must |
| S4 | Quarantine corrupt or undecryptable objects and continue; never stall the queue | Must |
| S5 | Track bulk-import manifests (history, media) with resume; show per-manifest progress on the coverage dashboard | Must |
| S6 | Reconcile daily: compare device-reported cursors and hashes with the vault; issue rescan commands for missed records | Should |
| S7 | Import Activity Vault's browsing archive read-only on a schedule, without modifying it | Should |
| S8 | Hold the private key in memory after one passphrase entry; encrypted at rest with an Argon2id-derived key; auto-lock | Must |

**Search**

| ID | Requirement | Priority |
| --- | --- | --- |
| Q1 | One search bar across messages, notifications, screenshots, photos, files, and captured titles and text | Must |
| Q2 | Pre-index all text in FTS5; support exact words, phrases, and typo-tolerant matching | Must |
| Q3 | Filter by device, app, account, person, conversation, date, and content type | Must |
| Q4 | Show matching passages with direct access to the record: conversation at the message, file at its entry, image preview | Must |
| Q5 | Return all matching records through pagination, never an AI-selected sample | Must |
| Q6 | When semantic search is enabled, show semantic results separately below exact matches, clearly labeled | Must |
| Q7 | Support follow-up questions while retaining the current search context | Should |

**Conversations**

| ID | Requirement | Priority |
| --- | --- | --- |
| C1 | Import complete history per app from rooted database dumps, in priority order — LINE, Telegram, WhatsApp, SMS: every conversation, every contact, every message | Must |
| C2 | Preserve platform, account, conversation identity, sender identity, original message time, and capture time on every message | Must |
| C3 | Preserve message order and reply relationships; record observable edits without creating duplicates | Must |
| C4 | Associate attachments with their messages; track download and indexing status per attachment | Must |
| C5 | Capture new messages incrementally from device cursors; find missed records in daily reconciliation | Must |
| C6 | Keep archived copies when the source deletes, per the retention setting; mark deleted-at-source distinctly | Must |
| C7 | Search a word, phrase, or sentence across all indexed conversations; highlight the match and open the archived thread directly at it, with expand before and after | Must |
| C8 | Reconcile a message captured first as a notification preview and later from the database into one record with both provenances | Must |
| C9 | Label coverage per app: complete, partial, or notification-only | Must |
| C10 | Exclude view-once and disappearing content from automatic archiving; label the exclusion in coverage | Must |

**Notifications**

| ID | Requirement | Priority |
| --- | --- | --- |
| N1 | Store every captured notification: app, title, displayed sender, preview text, source, timestamps | Must |
| N2 | Categorise per app — LINE, WhatsApp, Instagram, Telegram, and every other enabled source; search by word, phrase, app, sender, date | Must |
| N3 | Link notifications to corresponding archived messages where a match can be established; label uncertain links | Should |
| N4 | Label previews as partial records, not conversations; record capture gaps and redacted content | Must |

**Media: screenshots, photos, origin**

| ID | Requirement | Priority |
| --- | --- | --- |
| M1 | OCR every ingested image locally via Vision; index the extracted text with the image | Must |
| M2 | Preserve the original image, source device, file location, and available timestamps | Must |
| M3 | Show image previews with matching text in search results | Must |
| M4 | Visual-description search via image embeddings: local model by default, OpenAI embeddings only under the cloud setting | Should |
| M5 | Photo-to-context: connect photos to calendar entries and contemporaneous activity; label inferred context separately from embedded metadata | Should |
| M6 | Media origin: associate received media with source app, conversation, sender, and message when evidence exists; show multiple occurrences; label uncertain matches rather than inventing an origin; open the conversation at the message | Must |
| M7 | Distinguish photo capture time, message time, and file-save time | Must |

**Timeline**

| ID | Requirement | Priority |
| --- | --- | --- |
| T1 | Reconstruct a date or range as one chronological timeline from all sources | Must |
| T2 | Display photos inline, clickable links, message excerpts, and available locations on a map | Must |
| T3 | Expandable groups and pagination over all records in the period | Must |
| T4 | Keep original event times separate from capture, download, and import times | Must |
| T5 | Show missing coverage and unavailable sources on the timeline itself | Must |
| T6 | Offer an AI overview and follow-ups alongside, never replacing, the timeline | Should |

**File retrieval**

| ID | Requirement | Priority |
| --- | --- | --- |
| F1 | Search indexed file records from Windows and Android | Must |
| F2 | Request an original: write an encrypted command; show source device, file location, and transfer progress | Must |
| F3 | Queue requests when the device is offline; complete and notify on reconnect | Must |
| F4 | Distinguish an indexed reference, a cached preview, and a locally available copy in every file result | Must |

**Coverage dashboard**

| ID | Requirement | Priority |
| --- | --- | --- |
| D1 | Connection status and last successful sync for every device, account, and source | Must |
| D2 | Initial-import progress, pending work, failures, and retry status | Must |
| D3 | Identify fully imported, partially imported, and unsupported sources; show known gaps by date | Must |
| D4 | Explain what each collector captures: full messages, previews, attachments, metadata, or other records | Must |
| D5 | Surface problems that need attention, with the offending source named | Must |

**AI layer**

| ID | Requirement | Priority |
| --- | --- | --- |
| A1 | AI overview and follow-up questions over search results and timelines, via tool calls against the local index | Must |
| A2 | Every answer links to supporting records; facts, inferences, and missing information are distinguished | Must |
| A3 | OpenAI processing is an explicit setting that names the affected content; when off, nothing leaves the Mac | Must |
| A4 | With cloud AI off, search, timeline, and browsing are fully functional | Must |

**Recovery bin**

| ID | Requirement | Priority |
| --- | --- | --- |
| B1 | Retain deleted vault items for a configurable recovery period | Must |
| B2 | Restore content and its associated archive relationships where retained | Must |
| B3 | Explicit permanent delete removes stored copies, extracted text, thumbnails, and search entries | Must |
| B4 | Distinguish deletion at the original source from deletion inside the vault, everywhere | Must |

## Data model

SQLite at `./data/vault.db` with FTS5. Ciphertext never lands here; objects are decrypted in memory and committed as records. `sent_at` is the phone's truth, `captured_at` is ours; they are never merged into one column.

**devices**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| role | text | windows or android |
| public_key | text | for encrypting commands to it |
| paired_at | timestamptz |  |
| last_seen | timestamptz | last successful poll or upload |

**sync_objects**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| device_id | uuid |  |
| bucket | text | which up-bucket |
| object_key | text | ledger key; the object itself is deleted from R2 after commit |
| kind | text | notification, message_batch, media, file, usage, call, status |
| status | text | pending, committed, quarantined |
| ingested_at | timestamptz |  |

**conversations**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| platform | text | line, telegram, whatsapp, sms, instagram, snapchat |
| account | text | Bunny's account on that platform |
| conv_key | text | the platform's own conversation identity |
| peer | text | contact or group name |
| kind | text | dm or group |
| coverage | text | complete, partial, notification_only |

**messages**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| conversation_id | uuid |  |
| sender | text | sender identity as recorded |
| sent_at | timestamptz | original message time |
| captured_at | timestamptz | when the vault learned of it |
| text | text | indexed in FTS5 |
| reply_to | uuid | nullable; reply relationship |
| edited_at | timestamptz | nullable; observable edits |
| source_status | text | live or deleted_at_source |

**attachments**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| message_id | uuid |  |
| kind | text | image, video, audio, doc |
| filename | text |  |
| size | integer |  |
| origin_hash | text | dedupe and media-origin matching |
| status | text | indexed, cached, on_demand |
| local_path | text | nullable; only when cached or retrieved |

**notifications**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| device_id | uuid |  |
| app | text | source app |
| title | text |  |
| sender | text | displayed sender |
| preview | text | preview text; a partial record |
| posted_at | timestamptz | when the phone showed it |
| captured_at | timestamptz |  |
| linked_message_id | uuid | nullable; labeled with confidence |

**media**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| device_id | uuid |  |
| kind | text | screenshot or photo |
| source_path | text | original file location |
| taken_at | timestamptz | capture time |
| saved_at | timestamptz | file-save time |
| imported_at | timestamptz |  |
| ocr_text | text | extracted locally |
| thumb_path | text |  |
| attachment_id | uuid | nullable; origin link when evidenced |

**files**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| device_id | uuid |  |
| path | text | on the source device |
| size | integer |  |
| mtime | timestamptz |  |
| quick_hash | text |  |
| status | text | reference, cached |

**calls**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| device_id | uuid |  |
| direction | text | incoming, outgoing, missed |
| contact | text |  |
| number | text |  |
| started_at | timestamptz |  |
| duration_s | integer |  |

**usage_events**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| device_id | uuid |  |
| app | text |  |
| title | text | nullable; Windows only, per setting |
| started_at | timestamptz |  |
| ended_at | timestamptz |  |

Deletion convention: every table carries a nullable `deleted_at` (recovery bin) and permanent delete removes the row plus derived artifacts — thumbnails, extracted text, index entries.

## Architecture

| Component | Role | Stack |
| --- | --- | --- |
| Mac app | Dashboard UI, passphrase lock, all surfaces | Electron, TypeScript |
| Ingest service | Poll up-buckets, decrypt, commit idempotently, delete after commit, quarantine failures | Node.js, Fastify, better-sqlite3 |
| Indexer | FTS5 text index, Vision OCR, embeddings (local model default, OpenAI per setting) | Node.js, FTS5, macOS Vision |
| AI layer | Overview and follow-ups via tool calls against the local index; OpenAI API when enabled | OpenAI API |
| R2 client | Scoped tokens; read-and-delete on up-buckets, write on cmd-buckets | AWS SDK |

**Ingest flow, one object**

1. Poll lists new objects since the marker. Fetch each.
2. Decrypt with the in-memory key. Parse the kind.
3. Commit as records under the ledger; delete the R2 object; advance the marker.
4. On failure: quarantine with the reason and move on. The queue never stalls on one bad object.

**Retrieval request flow, one file**

1. Bunny clicks Request original on a file result. The service writes a command object encrypted to the device's public key into its cmd-bucket.
2. The device polls, finds it, uploads the encrypted original to its up-bucket, deletes the command.
3. The next Mac poll ingests the file, marks it cached, and notifies Bunny. If the device is offline, the request sits queued and the file result shows queued.

## Dashboard UI

The family look: near-black background, 1px borders, one green accent, monospace for timestamps and fingerprints, status dots reused from Session Sync (green recent-and-working, amber stale, red failed).

- Locked state: a passphrase field and an unlock button. Nothing else is visible until unlocked.
- Search: one bar; a filter rail (device, app, account, person, date, type); results as passages with source chips; exact matches first, semantic matches below a labeled divider; footer with index stats and last sync.
- Timeline: date picker; one merged stream; photos inline; a map strip for locations; a coverage ribbon showing gaps; the AI overview in a side drawer that can be closed.
- Conversations: thread view with the match highlighted and expand-before/after; a coverage badge per app (complete, partial, notification-only); attachment chips with status.
- Media: grid with OCR text on hover; an origin panel ("received via LINE from X on …; also appears in WhatsApp").
- Files: reference vs. local-copy indicator; request button with progress; queued state when the device is offline.
- Coverage: one row per device and source — status dot, last sync, import progress bars, gaps by date; problems pinned on top.
- Devices and pairing: paired devices, fingerprints, revoke, re-pair from passphrase.
- AI settings: cloud on/off, what would be sent, model choice.
- Recovery bin: retention setting, restore, explicit permanent delete.

## Success metrics

| Metric | Target | How measured |
| --- | --- | --- |
| Freshness | Phone notification searchable within 5 minutes on WiFi, 10 on cellular | posted_at vs. ingested_at |
| Full import | Complete LINE history searchable within 24 hours of pairing | Vault row count vs. source database row count |
| Search latency | First results under 300 ms at 500k messages, provisional; final target in technical planning | Instrumented queries |
| Zero plaintext | No readable content in any bucket or local queue | Grep of dumps each release |
| Honest coverage | Every stopped collector visible within one sync interval | Kill tests |
| AI honesty | Every AI answer links at least one supporting record | Manual review of sampled answers |

## Milestones

Phases 2 through 4 build this part on top of the Phase 1 pipeline: realtime sources and coverage first, conversation history second (LINE before Telegram before WhatsApp), understanding last. Gates G2–G4 in Part 4.

---

# Part 3 — Android app

## Overview

A rooted companion with one job: get everything off the phone, encrypted, without Bunny ever exporting a chat manually. A foreground service runs a NotificationListenerService that captures every notification in real time and segregates it per app; root adapters read each messaging app's database directly — the same data a manual backup would copy, but automatically — for complete history, every contact, every chat, every app with a readable database. LINE first, Telegram second, WhatsApp third. Media and documents are indexed across the whole user storage, hidden albums included. Call log and usage stats come along. Everything is encrypted on-device and uploaded to R2: small records on any network, bulk on WiFi and charging.

## Goals and non-goals

**Goals**

- Realtime capture of every notification, segregated per app, retained after dismissal — the freshness layer for the whole vault
- Complete conversation history per app via root database adapters, in priority order — LINE first, Telegram second, WhatsApp third, SMS alongside: every conversation, every contact, every message, with attachments — no manual export/import, ever
- Incremental updates via per-app cursors; daily reconciliation from the Mac finds anything missed
- Media and document indexing across DCIM, Screenshots, Downloads, app media folders, and ordinary hidden albums
- Call log: incoming, outgoing, missed, with duration and contact
- Usage stats per app for the timeline and future habit analysis
- Two-speed upload: notifications and statuses on any network; history dumps and media originals on WiFi and charging
- Offline queue that survives reboots; resumable initial import with manifests
- Serves file and attachment retrieval requests from the Mac

**Non-goals for v1**

- No archive browsing or search on the phone. It is a companion, not a reader.
- No Snapchat history: notification-only, labeled as such. No pretending.
- No capture of view-once or disappearing content; excluded from archiving.
- No keystroke logging, no screen recording, no microphone, no camera.
- No location scraping: locations come from photo EXIF where present. System location-history import is a v2 candidate.
- No cloud other than R2, and only ciphertext there.
- No support for non-rooted devices in v1; root is a hard requirement for history collectors. A degraded notification-only mode for unrooted phones is a v2 candidate.
- No iPhone.

## User and core use cases

| Use case | What happens |
| --- | --- |
| Pair the phone | Scan the Mac's QR or type the code, confirm the fingerprint, grant the notification access, done. |
| Overnight history import | Root adapters dump LINE, Telegram, WhatsApp, and SMS databases; manifests upload over WiFi while charging; per-app progress shows on the Mac's coverage dashboard. Resumable across nights. LINE completes first. |
| New message arrives | The notification is captured within seconds and uploaded on any network; the database scan on WiFi later brings the full message and reconciles the preview into one record. |
| "Find my collaboration notes" | Wherever they live — a screenshot, a document in Downloads, a LINE message — the Mac finds them by text. |
| "Bring that video" | The Mac requests it; the phone defers bulk to WiFi per policy, then uploads; Bunny gets a notification on the Mac. |
| Phone away from home | Small records still flow over cellular; bulk waits for WiFi. Coverage shows both honestly. |

## Functional requirements

**Collectors, Android**

| ID | Requirement | Priority |
| --- | --- | --- |
| AC1 | NotificationListenerService captures every notification: app, title, displayed sender, preview text, timestamp; segregated per app; retained after dismissal | Must |
| AC2 | Root conversation adapters read each app's database and key directly, in priority order: LINE first, Telegram second, WhatsApp third, SMS/MMS alongside; every conversation, every contact, every message | Must |
| AC2a | Treat LINE schema drift as a first-class case: when an app update changes the database layout, label coverage partial and surface a rescan need, rather than guessing rows | Must |
| AC2b | Snapshot databases atomically: copy the db together with its `-wal` and `-shm` sidecars (or checkpoint through SQLite) before reading, so a mid-write app never yields torn or missing recent rows | Must |
| AC2c | Extract per-app keys in place with root where stores are encrypted — LINE's store key, Telegram's passcode-derived key when a passcode is set, WhatsApp's backup keys — and hold them only in memory for the duration of the read | Must |
| AC2d | Resolve contact identity across apps against the system contacts store, so the same person is one entity in the vault regardless of platform | Should |
| AC3 | Instagram DMs via root database adapter where the schema is stable; otherwise labeled notification-only | Should |
| AC4 | Snapchat stays notification-only, and coverage says so | Must |
| AC5 | Per-app cursors: last seen rowid or hash per conversation database; incremental scans on WiFi | Must |
| AC6 | Enumerate app media folders and associate attachments with their messages; upload originals per policy | Must |
| AC7 | Index media and documents across the whole user storage and selected app directories — DCIM, Screenshots, Downloads, Android/media, ordinary hidden albums | Must |
| AC8 | Call log: incoming, outgoing, missed; contact identity, number, timestamp, duration, source | Must |
| AC9 | Usage stats: per-app sessions and times via UsageStatsManager | Must |

**Upload and queue, Android**

| ID | Requirement | Priority |
| --- | --- | --- |
| AU1 | Encrypt everything on-device to the Mac's public key before it touches disk or network | Must |
| AU2 | Two-speed policy: small records on any network; bulk on WiFi and charging, both user-configurable | Must |
| AU3 | Resumable chunked uploads with manifests for the initial import; no re-upload of already-committed parts | Must |
| AU4 | Poll the cmd-bucket every 5 minutes, on connectivity change, and on manual sync | Must |
| AU5 | Foreground service with a persistent status notification; survives reboot; battery-optimisation exemption guided at setup | Must |

**Retrieval serve, Android**

| ID | Requirement | Priority |
| --- | --- | --- |
| AR1 | Serve file and attachment requests: locate, encrypt, upload, report outcome | Must |
| AR2 | Defer bulk transfers to WiFi per policy; small files on any network | Should |

**Pairing and setup, Android**

| ID | Requirement | Priority |
| --- | --- | --- |
| AP1 | Pair via one-time code or QR: exchange public keys, receive scoped tokens | Must |
| AP2 | Store its private key in the Android Keystore; nothing on the phone decrypts vault content | Must |

## Data model

Local SQLite at `vault-agent.db`. The notification log doubles as the offline record of realtime captures; the queue holds ciphertext only.

**pending_uploads**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| object_key | text | destination key in the up-bucket |
| part_path | text | encrypted part or whole object |
| size | integer |  |
| attempts | integer |  |
| status | text | queued, uploading, waiting_wifi, done |

**collector_state**

| Field | Type | Notes |
| --- | --- | --- |
| app_package | text | per collector or per app |
| db_path | text | the database being tracked, from the source map |
| cursor_rowid | integer | last seen row |
| last_scan_at | timestamptz |  |

**notification_log**

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key |
| app | text |  |
| title | text |  |
| sender | text |  |
| preview | text |  |
| posted_at | timestamptz |  |
| uploaded_at | timestamptz | nullable until flushed |

## Architecture

| Component | Role | Stack |
| --- | --- | --- |
| Foreground service | Persistent sync worker; queue flush; command polling | Kotlin |
| Notification listener | Realtime capture of every notification | NotificationListenerService |
| Root adapters | su-driven reads of app databases and keys per the source map; per-app schema mappings; atomic db+wal+shm snapshots | libsu, SQLite |
| Media indexer | Whole-storage scan via direct filesystem access, MediaStore enrichment | Kotlin, MediaStore |
| Crypto + queue | Hybrid encryption to the Mac's public key; SQLite queue; chunked multipart | libsodium, OkHttp S3 client |

**Notification flow, one event**

1. The listener fires; the record is written to the local log within seconds.
2. The queue flushes small records on any network — typically within 2 minutes.
3. The Mac ingests on its next poll; the preview is searchable and links forward to the message record once the database scan lands.

**History import flow, one app**

1. The adapter opens the app's database with root, per the source map. Snapshot the db, `-wal`, and `-shm` together (AC2b); read the key where the store is encrypted (AC2c); walk every conversation to the cursor.
2. Messages serialize into batches; attachments enumerate from the app's media folders with hashes.
3. A manifest object goes up first; batches follow as resumable chunks over WiFi and charging.
4. The Mac commits per batch and advances the manifest; a reconnect resumes at the last committed part, never from zero.

## Root adapter source map

Where each app actually keeps its data, as of this writing. These are the adapters' starting points, not guarantees: app-internal schemas and store locations are not public contracts and move between versions. At pairing, and after every detected app update, the adapter verifies the map against the installed version and records what it found. When the map and reality disagree, coverage drops to partial and a rescan surfaces on the coverage dashboard (AC2a). Nothing is guessed into the vault.

**LINE (jp.naver.line.android)** — priority 1

| What | Where |
| --- | --- |
| Message stores | `/data/data/jp.naver.line.android/databases/` — `chat.db` with its `-wal`/`-shm` sidecars, plus `square_history.db` for group ("Square") history and `contacts.db`; older builds kept a single store named `naver_line` |
| Keys | Modern builds encrypt their stores (SQLCipher-family); the key material lives inside the app's private data, and its exact location has moved across versions — the adapter pins it per installed LINE version and re-verifies after every app update |
| Media | Chat media is largely app-private under `/data/data/jp.naver.line.android/` (cache and files subdirs); user-visible saves land in `/storage/emulated/0/Pictures/LINE/` and Keep |
| Confidence | Lowest of the three. Schema drifts between app versions. This is why LINE takes Phase 3's first slot. |

**Telegram (org.telegram.messenger)** — priority 2

| What | Where |
| --- | --- |
| Message stores | `/data/data/org.telegram.messenger/files/` — one SQLite database per signed-in account (`dbN`), alongside `cacheN.db` media-cache stores; messages lived inside the cache store before the per-account split |
| Keys | No local passcode set: the stores are plain SQLite. Passcode set: the stores are encrypted with a key derived from the passcode, with derivation parameters in the app's shared_prefs |
| Media | `/storage/emulated/0/Telegram/` — `Telegram Images`, `Telegram Video`, `Telegram Audio`, `Telegram Documents`, `Stickers` |
| Confidence | Medium. Per-account file naming and the cache/main split get pinned at adapter build. |

**WhatsApp (com.whatsapp)** — priority 3

| What | Where |
| --- | --- |
| Message stores | `/data/data/com.whatsapp/databases/msgstore.db` with `-wal`/`-shm` — the live store, plaintext SQLite under root; contacts in `wa.db`. Encrypted backups (`msgstore.db.crypt14`/`.crypt15`) sit at `/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Databases/`, legacy `/storage/emulated/0/WhatsApp/Databases/` |
| Keys | The live store needs none under root. Backup keys: `/data/data/com.whatsapp/files/key` (crypt12–14) and `/data/data/com.whatsapp/files/encrypted_backup.key` (crypt15, itself wrapped by the 64-hex-character backup password) |
| Media | `/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/` — `WhatsApp Images`, `WhatsApp Video`, `WhatsApp Voice Notes`, `WhatsApp Audio`, `WhatsApp Documents`, `WhatsApp Stickers`; legacy root `/storage/emulated/0/WhatsApp/Media/` |
| Confidence | Highest. The best-documented store of the three. Last in Phase 3 because it is the safest to leave for last. |

**System providers** — alongside all three

| What | Where |
| --- | --- |
| SMS/MMS | `/data/data/com.android.providers.telephony/databases/mmssms.db`; MMS attachment parts under `/data/data/com.android.providers.telephony/app_parts/` |
| Contacts and calls | `/data/data/com.android.providers.contacts/databases/contacts2.db` — contacts plus the `calls` table; also the identity spine for AC2d |
| Keys | None; plain SQLite under root |
| Confidence | Stable AOSP contract; least drift of anything in this map |

Reading discipline, all apps: never read a live database in place — snapshot db, `-wal`, and `-shm` together first (AC2b); hold any extracted key only in memory (AC2c); prefer the live store over the encrypted backup when both exist, since the backup can lag the app.

## App UI

A full app plus the persistent foreground-service notification, in the family dark look. Everything the service does is visible in the app as it happens.

- Not paired: the Mac's QR code and a code field. That is the only input the phone ever has besides policies.
- Paused/running toggle; per-collector rows: notifications, LINE, Telegram, WhatsApp, SMS, media, calls, usage — each with an on/off toggle, last capture, last upload, queue depth, status dot.
- Live capture-activity feed and per-app import progress for the history manifests.
- Two-speed policy settings: what counts as small, WiFi-only for bulk, charging requirement toggle.
- Battery-optimisation exemption helper at setup.
- Footer: bucket reachability, fingerprint.

The persistent notification is the always-visible status: syncing, waiting for WiFi, or paused. No search, no timeline, no archive browser. Everything else lives in the Mac dashboard.

## Success metrics

| Metric | Target | How measured |
| --- | --- | --- |
| Notification end-to-end | Phone notification searchable on the Mac within 5 minutes on WiFi | posted_at vs. ingested_at |
| Import completeness | At least 99% of LINE's message rows in the vault within 24 hours of pairing, on WiFi | Row count comparison |
| Battery | At most 2% average daily drain in steady state | Battery stats over a 7-day soak |
| Zero plaintext | No readable content in the bucket or local queue | Grep of dumps each release |

## Milestones

Phase 2 ships the non-root realtime layer (notifications, calls, usage, media metadata). Phase 3 ships the root history adapters in priority order — LINE first, then Telegram, then WhatsApp; hardest and least documented first, so the risk lands early. Gates G2 and G3 in Part 4.

---

# Part 4 — Testing all of them together

## Overview

Each phase ends with a gate that must pass with all three devices in the room. Between gates, three continuous checks run on every release: the zero-plaintext audit, the honesty test, and the soak test. A gate is not a demo; it is a scripted pass/fail run Bunny can repeat himself.

## The gates

| ID | Gate | Passes when |
| --- | --- | --- |
| G1 | Pairing and pipeline, end of Phase 1 | Windows and Mac pair over R2 from different networks; a 50 MB PDF requested on the Mac arrives encrypted and intact; the bucket dump shows zero plaintext; a PC reboot mid-queue loses nothing |
| G2 | Realtime layer, end of Phase 2 | A notification on the phone is searchable on the Mac within 5 minutes on WiFi; call log and usage appear on the timeline; disabling the notification listener produces a visible capture gap on the coverage dashboard within one day |
| G3 | Full history, end of Phase 3 | Overnight import brings complete LINE, Telegram, WhatsApp, and SMS history in, LINE first; "collaboration" returns every match with pagination; clicking opens the thread at the message; an attachment downloads on demand; deleting a LINE chat on the phone leaves the archived copy, marked deleted-at-source |
| G4 | The whole picture, end of Phase 4 | "Show everything that happened on September 24" merges at least six source types with gaps labeled; the robotics-offer screenshot is found by description; an AI answer cites its records; turning cloud AI off leaves search and timeline untouched |

## Continuous checks

- **Zero-plaintext audit, every release.** List all buckets, sample objects, dump both device queues, grep for known plaintext strings from test data. Target: zero hits.
- **Honesty test.** Kill a collector on any device; the coverage dashboard must show the gap within that collector's sync interval, and the timeline must show the missing period. Anything hidden is a failure.
- **Soak test, 7 days.** All three devices left running normally: no queue stalls, no duplicate messages, no unbounded growth, coverage stays truthful, battery within target.
- **Source-map drift check, after every app update.** LINE, Telegram, or WhatsApp updates on the phone: the adapter re-verifies the source map, and either reads normally or drops that app's coverage to partial with a rescan surfaced. Silently stale imports are a failure.

## End-to-end scenarios

| Scenario | Chain |
| --- | --- |
| Freshness | Notification on phone → local log → R2 within 2 min → Mac ingest within 2 min → searchable, linked forward to the message record later |
| Retrieval online | File request on Mac → cmd-bucket → Windows polls within 2 min → encrypted multipart upload → Mac ingest → notification |
| Retrieval offline | Same request while the PC is off → queued state on the file result → boot → completes within 5 minutes of reconnect |
| Origin | Photo received in LINE → attachment hash matches media record → origin panel shows sender, message, surrounding context, and the WhatsApp occurrence too |
| Recovery | Delete a screenshot from the vault → appears in the recovery bin → restore returns it with its links → permanent delete removes copies, OCR text, thumbnail, and index entries |

## Success metrics

| Metric | Target | How measured |
| --- | --- | --- |
| Freshness | Notification searchable within 5 minutes on WiFi, 10 on cellular | posted_at vs. ingested_at |
| Full import | Complete LINE, Telegram, WhatsApp, and SMS history within 24 hours of pairing, LINE first | Row counts |
| Zero plaintext | Nothing readable in any bucket or device queue, ever | Release audit |
| Search latency | Under 300 ms first page at 500k messages, provisional | Instrumented queries; final target in technical planning |
| Honest coverage | Every stopped collector visible within one sync interval | Kill tests |
| Retrieval | 50 MB file Mac-bound within 5 minutes on broadband; offline queue completes within 5 minutes of reconnect | Timed tests |
| AI honesty | Every AI answer links at least one record; facts, inferences, and missing data distinguished | Sampled review |

## Milestones

[embedded content: IVY roadmap · 4 phases, 4 gates]

Phase 1 proves the R2 pipeline with the least sensitive data there is — Windows file metadata and one retrieved PDF — which is where this kind of project usually stalls. Crypto and bucket discipline come before any conversation byte leaves any device.

- **Phase 1 — Windows to Mac over R2.** Pairing, the four buckets, hybrid encryption, the ingest ledger, file index, retrieval. Gate G1.
- **Phase 2 — Android realtime.** Notification listener, call log, usage, media metadata; the coverage dashboard and unified text search go live on the Mac. Gate G2.
- **Phase 3 — History.** Root conversation adapters in priority order — LINE, then Telegram, then WhatsApp — plus full import with manifests, conversation search, attachments, the recovery bin. Gate G3.
- **Phase 4 — Understanding.** OCR, media origin, day reconstruction, the AI layer. Gate G4.

**v2 candidates, after Phase 4**

- Live search across accounts on demand, merging fresh results with the archive
- Automatic project collections with suggested memberships
- Habit-analysis dashboards and break reminders — the usage events are already being captured
- Saved searches with new-match alerts and daily digests
- System location-history import for the timeline map
- A degraded notification-only mode for unrooted phones
- Absorbing Session Sync and Activity Vault into this product, so browsing capture and cookie sync become collectors like any other
- A second paired phone through the same pairing flow
