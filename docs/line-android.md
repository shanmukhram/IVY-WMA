# Building the LINE adapter on Android — a playbook from the Windows dig

This is a how-to for the next person (or agent) who builds and verifies the **Android** LINE adapter. It explains exactly how LINE was figured out on **Windows** — including the roadblocks, and the throwaway tool we built to get past each one — and how to apply the same method on Android. LINE is priority 1 because its store is the least documented and drifts most between versions, so the risk lands first.

## The golden rule: write down everything, in `findings.md`

Whatever you discover, **record it in `docs/findings.md` in full detail** — every file path, header, table, column name, JSON tag, content-type code, key location, media path, and deletion-residue surface, with counts and structure. Record the **dead ends too**: a documented "we tried X and it does not work, here's the proof" saves the next person days. The goal is simple — **nobody digs the same hole twice.**

Two hard rules that this playbook itself exists to prove:
1. **Do not trust stale notes — including this one.** Verify on the real device and update `findings.md`. On Windows, the repo's own notes said "LINE's thumbnail key is wiped from memory, nothing on disk." We believed it, then dug anyway and found a per-media key sitting in the store. Stale assumptions cost the most.
2. **Content-free in committed docs.** Record schema, counts, tags, key *locations* — never message bodies, contact names, or media content — in anything that gets committed. (The owner viewing their own data locally in a terminal is fine; a committed file is not.)

---

## How we did it on Windows (the worked example)

### The shape: probe first, then a map you verify every run
The LINE collector is two layers, and it never guesses a row into the vault:
- **A probe** that reads *no message content* — it walks the data folders, records each file's name/size/first-16-bytes (which tell plain SQLite from an encrypted/random header apart), and lists table/column names for any *plain* SQLite file. This is what tells you the real layout.
- **An adapter** that holds a `LineStoreMap` per LINE version, and on every run **verifies that map against a fresh snapshot** (the mapped tables/columns must exist, a sample row must parse, its timestamp must be plausible). If verification fails, the row goes **red with the reason and captures nothing**. Schema drift is expected, not a crash.

### Reading the store
Windows LINE uses a **wxSQLite3 AES-128-CBC** store (`qw<hex>.edb`, one per account; the logged-in account's store is the one with a `-wal` sidecar). The 32-hex passphrase is not on disk — it lives in LINE's process memory while logged in, and once captured is kept in DPAPI (`%LocalAppData%\IVY\keys\line-key.bin`), never uploaded. We **snapshot db + wal + shm, read the copy, never the live file.** The full decrypted map (34 tables, every column, every JSON tag, media layout, deletion residue) is in `windows/tools/disposable/line.md`.

### Roadblock 1 — "there's no key on disk" (there was)
The repo notes claimed the media/thumbnail key was wiped from memory with nothing recoverable. Instead of accepting it, we built a read-only inspector (**LineDiag**, `windows/tools/disposable/LineDiag/`) that decrypted the store with the key we had and dumped the schema. Dug into `_message._contentInfo` and found **`keyMaterial`** — base64 that decodes to a **32-byte AES key** stored *in the message itself* — plus `thumbPath` (the full path to the message's `.eimg` thumbnail) and the `OID`/`e2eeMark` in `_contentMetadata`. The lesson: **build the tool, verify empirically, don't take the note's word.**

### Roadblock 2 — the thumbnails wouldn't decrypt
Natural next step: decrypt the `.eimg` with that `keyMaterial`. It failed with raw AES, so we looked at the file: **fully high-entropy (7.99 bits/byte), no header, size not 16-aligned** → a stream cipher with a *derived* key. So we made LineDiag into a **systematic cracker**: every plausible key derivation (`km`, `km[0:16]`, `sha256(km)`, `md5(km)`, …) × every IV × every mode (CTR/OFB/CFB/CBC/ECB/GCM), checking for an image or a zlib header. **Zero hits.** That negative result *is* a finding: the local `.eimg` uses a separate key that is not in the store; `keyMaterial` is for the server (obs) copy. We then found LINE keeps a second cache namespace (`/e/`) with **plaintext** images — so some previews need no crypto at all. All of this is written down so nobody re-runs that crack.

### Roadblock 3 — can we recover deleted messages?
We checked what LINE does on **Unsend**: it clears `_message._text` and keeps a tombstone (`UNSENT=1`) — but it **does not purge the full-text search index** (`_message_fts`). A small probe joined the tombstone rowids to `_message_fts_content` and recovered the wiped text for 3 of 5 unsent messages. **Residue surfaces are real; look for them.**

### The tool we built — and kept
`LineDiag` (`windows/tools/disposable/LineDiag/`): a small read-only console that **reuses the collector's verified crypto** (no re-implemented ciphers), **snapshots** the store to temp and reads the copy, **auto-detects** the store (no hardcoded account id), prints **counts/schema/tags only**, and cleans up its temp + any decrypted copies. It's deliberately disposable — edit `Program.cs` per probe (schema dump, chat list, thumbnail crack, deleted-text residue were all the same tool pointed at different questions). It lives under `windows/tools/disposable/` with a README; it is **not** part of the product build.

---

## How to explore LINE on Android (apply the same method)

Android LINE is a **different store** from Windows — do not assume the Windows specifics carry over. The method does; the details don't.

### Step 0 — probe first, on the real rooted phone
Nothing is trustworthy until it's seen on the device. Build an **Android probe** that mirrors `LineProbe`/`LineDiag`: read-only, snapshots `db + -wal + -shm` via `su`, records file names/sizes/headers, classifies plain SQLite vs SQLCipher by header, and lists tables/columns for anything readable. Write the result to `findings.md`.

### Step 1 — locate and classify the stores
Starting points (verify on device, they move between versions):
- `/data/data/jp.naver.line.android/databases/` — `chat.db` (+ `-wal`/`-shm`), `square_history.db` (group/Square history), `contacts.db`; older builds used a single `naver_line`.
- Header-check each: SQLite magic (`SQLite format 3\0`) = plain; random = encrypted (**SQLCipher-family on Android**, *not* the Windows wxSQLite3 scheme).

### Step 2 — get the key (SQLCipher), in memory only
- The key material is in the app's private data, and **its exact location has moved across versions** — pin it per installed version, re-verify after every app update.
- Extract it with root, hold it **only in memory** for the read, never persist a decrypted copy. (SQLCipher needs the key + the KDF/page parameters; record both.)

### Step 3 — snapshot, then read
Copy `db + -wal + -shm` together to a temp location via `su`, open the **copy** read-only (SQLCipher-aware), delete the copy after. Never read the live database in place.

### Step 4 — map and verify the schema
Build a `LineStoreMap` for the Android schema (expect different table/column names than Windows), and verify it against the snapshot every run exactly as Windows does: tables/columns present, a sample row parses, timestamp plausible; **red-with-reason and zero rows on drift** (AC2a). Walk every conversation with a per-chat cursor.

### Step 5 — content types, attachments, and media (this is where Android wins)
- Map the content-type codes and the attachment-metadata columns (the Windows map is a *hypothesis* to test, not a given).
- **Media originals are real files on the phone** — app-private under `/data/data/jp.naver.line.android/` and user-visible under `/storage/emulated/0/Pictures/LINE/` and Keep. This is the opposite of Windows, where originals were server-side. Enumerate them and associate by hash. Record every media path.

### Step 6 — deleted-message residue
Check the Android store for the same surfaces: an FTS index that isn't purged on unsend, tombstone rows/flags, and (deeper) SQLite freelist/WAL slack. Record what survives and how to read it. Per decision 24, deleted/unsent/expired/view-once content is kept once captured and only marked.

### What transfers vs what differs

| | Windows (done) | Android (to verify) |
| --- | --- | --- |
| Store cipher | wxSQLite3 AES-128-CBC | **SQLCipher-family** |
| Store files | one `qw<hex>.edb` per account | `chat.db`, `square_history.db`, `contacts.db` |
| Key | 32-hex passphrase from LINE memory → DPAPI | key in app private data, **location moves per version**, root-extracted, memory-only |
| Schema | known (34 tables, see `line.md`) | **unknown — probe it**; concepts likely echo |
| Media originals | server-side, local cache encrypted (not recoverable) | **real files on disk — recoverable** |
| Deleted text | recovered from `_message_fts` residue | look for the same residue |
| Method | probe → map → verify → walk | **identical** |

---

## Discipline for every probe (don't skip)
- Read-only on the real store; **snapshot-then-read**; keys **in memory only**; delete temp + any decrypted copy on exit.
- **Content-free** in anything committed; counts/schema/tags/key-locations only.
- Verify empirically; **document the negative results**, not just the wins.
- Build a disposable read-only tool (an Android counterpart to `LineDiag`); keep it under a disposable-tools folder; reuse the shared/verified crypto rather than re-implementing it.
- **Write every finding into `docs/findings.md`** as you go — in detail, immediately, so the hole is never dug twice.

## Reference
- The complete Windows LINE map (every table/column/tag, media layout, deletion residue, the decryption investigation): `windows/tools/disposable/line.md`.
- The disposable inspector to copy from: `windows/tools/disposable/LineDiag/`.
- The central per-app findings registry to write into: `docs/findings.md`.
- Product requirements and the source map: PRD Part 3; decisions: PLAN 24 (persistence) and 25 (Android architecture).
