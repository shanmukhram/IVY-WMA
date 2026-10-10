# LINE for Windows — store research notes

Everything here is **publicly reported, not verified by us**. LINE's store is
undocumented and drifts between app versions (PRD WL1, AC2a). Nothing in this
file is treated as fact in code: the collector pins a declarative map per LINE
version and re-verifies it against the real store on the PC before capturing a
single row (WL3). This file exists so that, when the first probe report comes
back from Bunny's PC, we can line it up against what the literature says and
write the `ILineStoreUnlocker` for the encrypted case.

## Where LINE for Windows keeps its data

Two shapes exist depending on how LINE was installed:

- **Classic desktop installer:** `%LOCALAPPDATA%\LINE\Data\` (confidence:
  medium). This is the folder the LINE PC client uses for its local caches and
  chat store. The chat database inside appears to use the **`.edb`** extension
  (confidence: medium — from the `line-summary` MCP tool below, which opened the
  largest `.edb` file in this folder).
- **Microsoft Store (UWP) build:** `%LOCALAPPDATA%\Packages\NAVER.LINEwin8_*\LocalState\`
  (confidence: low-medium). The package family name prefix `NAVER.LINEwin8_` is
  the long-standing identifier for the Store build; `LocalState` is the standard
  per-machine app-data folder for packaged apps. We have not confirmed the
  database lives directly under `LocalState` vs. a subfolder — the probe
  enumerates the whole tree precisely because we do not know.

The probe looks in **both** locations and reports whatever it actually finds
(file names, sizes, mtimes, first-16-byte magic, and — for any *plain* SQLite
file — table and column names only). That report is the real source of truth.

## Encryption

- The LINE Windows chat database is **encrypted with wxSQLite3** (the SQLite3
  Multiple Ciphers family), using the **AES-128-CBC** scheme (confidence:
  medium-high). Sources: Kim et al., *Forensic Analysis of wxSQLite3-Encrypted
  Databases and Its Application* (MDPI *Electronics* 13(7):1325, 2024), which
  tested LINE for Windows and identifies wxSQLite3; and the `line-summary` MCP
  tool, which decrypts with `PRAGMA cipher='aes128cbc'` + passphrase key.
- The underlying database is plain SQLite once decrypted (the paper reports
  SQLite 3.40.0 with wxSQLite3 4.9.1). A *plaintext* SQLite file begins with the
  19-byte magic `SQLite format 3\0`; an encrypted wxSQLite3 file does **not** —
  its first page looks like random bytes. This is exactly the discriminator the
  probe records (first 16 bytes) and the collector uses to decide plain vs.
  encrypted at runtime.
- **Key derivation is not something we can do blind.** The paper reports the
  key-generation element is obtained via communication with LINE's server and is
  held in the client's **process memory**; their method and the `line-summary`
  tool both recover a 32-hex-character passphrase by scanning `LINE.exe` memory
  (regions ≤128 MB, matching `[0-9a-f]{32}` in ASCII and UTF-16LE, ranked by
  frequency, each candidate tried against the database). We deliberately do
  **not** guess or ship a memory-scanner: the `ILineStoreUnlocker` default is
  `NotImplemented` and reports the honest red state until we see a real probe
  report and decide how to derive the key safely on the PC (WX2: any key stays
  in memory/DPAPI on the PC, never uploaded).

## Schema (decrypted database), as publicly reported

From the `line-summary` tool (tested against "LINE 電腦版 26.3", the current PC
numbering). **Confidence: medium-high** for table/column names, because they come
from a working tool, but **unverified by us** and version-specific — this is the
shape the shipped map encodes with `verified: false`.

- `_message`: `_id` (platform message id, PK), `_chatId`, `_from` (sender mid),
  `_createdTime` (epoch **milliseconds**, 13 digits), `_text`, `_contentType`
  (int), `_contentMetadata` (JSON string).
- `_chat`: `_id` (chat id), `_lastUpdatedTime`, `_unreadCount`.
- `_contact`: `_mid`, `_displayName`, `_displayNameOverridden`, `_type`.
- `_groupChat`: `_chatMid`, `_chatName`; `_squareChat`: `_squareChatMid`,
  `_name`; `_squareMember`: `_squareMemberMid`, `_displayName`; `_room`: `_mid`.
- `_contentType` map: 0 text, 1 image, 2 video, 3 audio, 6 location, 7 sticker,
  13 contact, 14 file, 16 link.
- Chat-id kind is inferred by resolving the id through `_groupChat` / `_squareChat`
  / `_room` (→ group) else `_contact` (→ dm/private).
- Attachment details (file name, url, title) come from the `_contentMetadata`
  JSON (keys seen: `FILE_NAME`/`fileName`, `url`/`linkUrl`, `title`, `desc`).
  Media bytes are app-private and not referenced by path in the row.

## Versions referenced

- MDPI 2024 paper: LINE for Windows (older `7.14.0` numbering), SQLite 3.40.0,
  wxSQLite3 4.9.1, AES-128-CBC.
- `line-summary` MCP tool: "LINE 電腦版 26.3" (current PC numbering),
  `PRAGMA cipher='aes128cbc'`, passphrase from `LINE.exe` memory.

## Sources

- Kim et al., *Forensic Analysis of wxSQLite3-Encrypted Databases and Its
  Application*, MDPI Electronics 13(7):1325 (2024):
  https://www.mdpi.com/2079-9292/13/7/1325 (abstract/metadata; full text was
  403 to our fetcher — confirm details against the PDF when accessible).
- `yung13yubabie/line-summary` (GitHub): read-only LINE PC chat reader for
  Windows; `db_reader.py` (schema + `PRAGMA cipher='aes128cbc'`) and
  `key_extractor.py` (`LINE.exe` memory scan). Read 2026-10-10.
- wxSQLite3 / SQLite3 Multiple Ciphers: https://en.wikipedia.org/wiki/WxSQLite3
- Windows packaged-app data layout (`LocalState` under
  `%LOCALAPPDATA%\Packages\<PFN>\`): standard platform behaviour.

## What to do with the first real probe report

1. Compare the enumerated tree against both candidate locations above; record the
   actual data folder and the real db file name/extension in the shipped map.
2. Check the db file's first 16 bytes: `SQLite format 3\0` → plain, read now with
   the shipped schema (fix any column drift the probe's `table_info` reveals);
   otherwise → encrypted, and we implement `ILineStoreUnlocker` for that exact
   LINE version, keeping the key on the PC only (WX2).
3. Flip the map's `verified` to true only after on-PC verification passes.
