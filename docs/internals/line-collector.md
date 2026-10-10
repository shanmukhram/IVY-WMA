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

