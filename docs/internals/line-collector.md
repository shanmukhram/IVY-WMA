## Conversation capture: LINE desktop (`Ivy.Collectors/Line/`, task 1.12, WL1–WL3)

LINE for Windows keeps its chat store locally, encrypted, in a format that is
undocumented and **drifts between app versions**. So the collector is two layers,
and it never guesses a single row into the vault (WL3). Everything we *think* we
know about the layout, with sources and confidence, is in
`Ivy.Collectors/Line/NOTES.md` — it is research, not fact, and the code treats it
that way.

**Layer 1 — the probe (`LineStoreProbe`). Run this on the PC first.** It reads
**no message content**. It locates the LINE data folders (classic installer
`%LOCALAPPDATA%\LINE\Data\` and the Store build
`%LOCALAPPDATA%\Packages\NAVER.LINEwin8_*\LocalState\`), walks the tree recording
each file's name, size, mtime and **first 16 bytes** (which tell plain SQLite,
an encrypted/random header, LevelDB and JSON apart), and for any *plain* SQLite
file lists its **table and column names only**. It writes
`%LOCALAPPDATA%\IVY\line-probe-<version>.json` plus a one-line human summary
("Probe complete: N files, M databases, K readable"), surfaced in the LINE row
with a button to open the report. This report is what tells us the real layout.

**Layer 2 — the adapter (`LineDesktopCollector`).** It holds a `LineStoreMap`
per LINE version (`LineStoreMap.ShippedDefault`, the current `26.3` layout,
marked `verified: false` so it is used only after on-PC verification). On start
and after every detected version change it snapshots the db + `-wal` + `-shm`
atomically (the notification collector's approach, `LineSnapshot`), opens the
snapshot and **verifies the map against it**: the mapped tables and columns must
be present, a sample row must parse, and its timestamp must be plausible. If
verification fails the row goes **red with the reason and nothing is captured**
(WL3). If it passes it walks messages with a **per-chat cursor** and emits
`message_batch` records with `sourceSession = "windows:line-desktop"` and
`coverage = partial` **always** (WL2 — a mirror of what the phone synced; complete
LINE history comes from the Android adapter), carrying `chatMeta` and attachments
as references (with hashes/originals per the Windows media policy when the file is
present under the LINE data folder).

**Encrypted stores.** A db file whose header is not the SQLite magic is treated
as encrypted and handed to `ILineStoreUnlocker`. The shipped default,
`NotImplementedUnlocker`, does **not** guess a key: it reports
"store is encrypted; key derivation for this LINE version is not implemented".
So the first real PC run yields either data (a plain store) or an honest red
state plus the probe report we need to implement the unlocker — keeping any key
in memory/DPAPI on the PC, never uploaded (WX2).

**Honest states (the LINE row).** `ok partial` (verified, capturing — always
partial from Windows), `probe needed` (run the probe on the PC first),
`unverified map` (schema/column drift or an implausible timestamp — red),
`encrypted store` (no unlocker for this version — red), `store not found` (a data
folder exists but holds no db matching the pattern — red), `LINE not installed`
(no data folder — informational, not an error).

**Controls (`collector_config`, WR3).** `enabled` toggles the row; `runProbe`
(one-shot, cleared after it runs) runs the probe; `dataPath` overrides the data
folder; `version` reports the installed LINE version (drives map selection and
re-verification); `account`, `batchSize`, `pollSeconds` tune capture. Registered
in `CollectorHost` and in the device report like every other collector.

**What to do on the PC, in order.** (1) Run the probe and send me
`line-probe-<version>.json`. (2) I line it up against `NOTES.md`, fix any column
drift and set the real data folder / db file name in the shipped map. (3) If the
store is encrypted, I implement `ILineStoreUnlocker` for that exact version. (4)
Only after on-PC verification passes do we flip the map's `verified` to true.

**Tested here (Mac, fixture-based):** the probe over a synthetic tree (plain
SQLite, random-header `.edb`, JSON); the adapter against a generated plain-SQLite
fixture matching the shipped map (walk, per-chat cursors, resume across restart,
the `partial` label, `chatMeta`, attachments); and the verification-failure paths
(missing table, renamed column, implausible timestamp, encrypted header) each
producing red-with-reason and **zero** records, plus a version change triggering
re-verification against the new map. We cannot test a real encrypted LINE store,
the real data-folder layout, or memory-based key derivation without a PC and a
LINE install — hence the probe-first workflow.


---

## Verified scheme (Oct 10 2026): wxSQLite3 AES-128-CBC

Source: Kang, Kim, Hur, Kim, "Forensic Analysis of wxSQLite3-Encrypted Databases and Its Application", Electronics 13(7):1325, MDPI, 2024 (LINE for Windows v7.x), cross-checked against the wxSQLite3 / SQLite3 Multiple Ciphers source (cipher_wxaes128.c, codec_algos.c). This replaces the earlier hypotheses; confidence high.

Corrections to earlier notes: the data lives under `%LocalAppData%\LINE` (Local, not Roaming), and the format is a documented wxSQLite3 database, not an opaque app-internal one. LINE for Windows is a Qt app and ships the QtCipherSQLite plugin.

Layout (matches the probe report exactly):
- `%LocalAppData%\LINE\Data\db\` holds three `.edb` files per account: `qw<15-byte-hex>.edb` (the chat store — contacts, chats, all history), `keep_<hex>.edb`, `chatStats_<hex>.edb`. The chat store is the one with a `-wal` sidecar (the `-wal` exists only while LINE is running; LINE folds it into the main file and removes it on quit); the collector already selects it that way.
- Thumbnails are `.eimg` files under `Cache`, AES-128-ECB, a per-file key deleted from memory after use (out of scope).

Cipher (implemented in `windows/Ivy.Collectors/Line/LineWxCipher.cs`):
- wxSQLite3 AES-128-CBC, page-based, new (non-legacy) mode. Page 1 keeps bytes 16..23 in the clear (the identification signature); its first 16 bytes decrypt to the SQLite magic.
- Passphrase: a 32-character hex string LINE receives from its server at login. Account-specific and stable across PCs for the same account. NOT on disk; it is in LINE's process memory while logged in (bounded by `encryption_key=`/`encryptionkey=` and `mse`, or found by the regex `[0-9a-f]{32}`).
- Base key: pad the passphrase, derive an owner key (MD5 x50 then RC4 x20), then the encryption key (MD5 x50). Per-page key = MD5(baseKey + page[LE4] + "sAlT"). Per-page IV = MD5 of a MODMULT sequence seeded by the page number. All implemented and round-trip tested.

Schema: `_contact(_mid, display name)`, `_chats(_from, _to, content, created time)`.

What remains: obtaining the passphrase, which is the one step that is not on disk. The decryptor is ready for it. See the collector integration plan: a key the user supplies once is stored in DPAPI and never uploaded (WX2); the collector decrypts to a temporary plaintext copy, reads it read-only, and deletes the copy.

Poll cadence: LINE is polled every 5 seconds (`pollSeconds`, default 5) so a new message shows up almost at once; each tick snapshots and reads the small store.

## Side file (write-ahead log), verified Oct 11 2026

LINE keeps the chat store in SQLite WAL mode, so recent writes sit in a side file until they are folded into the main file. Before this change the decrypt step read only the main file, which meant new messages stayed invisible until LINE quit.

The unlocker (KeyedLineUnlocker in LineKeyStore.cs) now overlays the committed frames of the snapshot's -wal copy, using LineWal.cs and SQLite's own recovery rules. Salts must match the WAL header. The running checksum, computed over the stored, still-encrypted bytes, must hold. Reading stops at the first bad frame. Only frames up to the last commit frame count, and for a page that appears more than once the later frame wins. Each kept page is decrypted with the same per-page cipher, with page 1 following its special header rule. The plaintext copy is then marked as a rollback-journal database with the real page count, so it opens standalone. The Keep store (EmitKeep) gets the same overlay.

Nothing is guessed. An unfinished or damaged tail is dropped, and an unusable WAL leaves the main file as it was. The live -wal is never read in place; only the snapshot copy is.

Observed on the real store (headers and frame headers only, no content):

| Item | Observed |
| --- | --- |
| Main file page size | 4096 bytes |
| Header bytes 18 and 19 | 2 (WAL mode) |
| WAL magic | 0x377f0682 (little-endian checksums) |
| Format and checkpoint sequence | 3007000, sequence 1 |
| Frames in the WAL | 1003: 778 with current salts, 225 stale-salt |
| Commit frames | 64 |
| Database size after last commit | 322 pages (main file: 249) |

The WAL file is reused rather than truncated, so the 225 stale-salt frames from an earlier checkpoint cycle are still present and are skipped by the salt check. A page-1 frame is present, and bytes 16 to 23 of the main file are in the clear with standard SQLite values, which confirms the page-1 rule.

Live result: with LINE open, the main file alone yielded 366 messages across 8 chats. With the side file folded in, it yielded 821. A message sent while LINE stayed open appeared on the next snapshot (822, with the newest timestamp advanced) while the main file was unchanged.

Cadence is the pollSeconds default described above.

## Contact names in LINE 26.x, verified Oct 11 2026

In the 26.x store `_contact._displayName` is NULL on every row, so chats and senders reached the Mac as raw mids. The name is the `profileName` key of the `_targetProfileDetail` JSON column (which also holds `picturePath`, `statusMessage` and `hiddenFromList`). `LineStore` now resolves a contact's name as `_displayNameOverridden` (the user's own rename) if non-empty, else `_displayName`, else `_targetProfileDetail.profileName`; all three are declared in `LineStoreMap.Names` and read only when the column exists, and malformed JSON just means no name. The account snapshot fills display name, picture path and status message from the same JSON when the plain columns are empty, and sets `blocked` only when `_blockDetail.notBlocked` is a plain boolean. `picturePath` is a LINE object-storage path on LINE's servers, so profile pictures cannot be read from the PC's files (only the encrypted `.eimg` cache is local). A one-time `namesV2` flag re-sends every chat once on existing installs so stored messages gain names; the Mac merges by platform message id, so rows are updated, not duplicated.

Tests: LineTests.cs and LineWalFixture.cs build a real WAL-mode fixture. The cases cover rows that exist only in the WAL on the encrypted and plain paths, a trailing transaction with no commit frame, a frame with a bad checksum, and header edge cases in LineWal.ReadCommitted.

## Several LINE accounts on one PC, Oct 11 2026

LINE for Windows keeps one set of stores per account in `%LOCALAPPDATA%\LINE\Data\db\` (`qw<hex>.edb`, `keep_qw<hex>.edb`, `chatStats_qw<hex>.edb`), and only the logged-in account's chat store has a `-wal` beside it, so `LineStore.FindDb` opens that one. When the owner uses two of their own accounts in turn, the collector now keeps them apart. The account label on every message batch, Keep batch and account snapshot is the open store's own mid (`LineStore.AccountId`, read from the own-profile table), or the store's `qw<hex>` file name if the mid cannot be read; a non-default `account` setting chosen by the user still wins. Per-account state is keyed by the store's identity (the mid, else the file name): chat cursors are saved as `cursors:<id>`, the account-snapshot hash as `accountHash:<id>`, and the in-memory Keep hash resets when the account changes, so switching accounts never reuses the other account's cursors and switching back resumes where that account left off. A re-sync applies to the open account at once and to each other account the next time its store is open (a saved re-sync epoch per account). The Keep store read is the one named after the open chat store (`keep_<chat store name>.edb`); a lone Keep store is used whatever its name, and with several and none matching, no Keep is read. The stored LINE key fits one account's stores; when the store switches and the key no longer fits, the existing path reads a fitting key from the running LINE process, stores it and reopens. On upgrade, the old single `cursors` blob moves once to the account open at the time, and a one-time `accountKeyV1` flag (same pattern as `namesV2`) re-sends every chat under the account's id instead of "default". Until the Mac removes its LINE records labelled "default", it holds those chats twice.
