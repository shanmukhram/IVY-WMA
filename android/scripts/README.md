# IVY Android — scripts (milestone 1)

Read-only extraction and verification for the Android backup. This is the shell side of
the split: it assumes a **working root shell already exists** on the device (a `su`
binary — however the owner provides it). These scripts never obtain root, never call any
system or vendor service, and never write to third-party app data. They only copy **from**
app data **into** IVY's own staging dir and hash what they copied.

## Files
- `ivy-extract.sh` — runs **on the device as root**. Stages read-only copies of the target
  app databases + keys (with `-wal`/`-shm` sidecars), logs each package's version from
  `packages.xml`, writes `manifest.tsv` (source, staged path, size, sha256, plain-vs-encrypted
  type), and inventories `/data/media/0` (tars it only if `IVY_MEDIA=1`).
- `ivy-verify.py` — runs **on the host** after pulling the staging dir. Re-checks every
  sha256, and for each plain SQLite db lists tables + row counts via Python's stdlib
  `sqlite3` (no external tools). Encrypted stores are reported as "needs key" — decrypting
  them is the parser layer, not this check.

## Run (rooted phone connected over adb)
```sh
adb push ivy-extract.sh /data/local/tmp/
adb shell "su -c 'sh /data/local/tmp/ivy-extract.sh'"
adb pull /data/local/tmp/ivy_stage ./ivy_stage
python3 ivy-verify.py ./ivy_stage
```
Add the media tar (large — can be 100+ GB): prefix the shell step with `IVY_MEDIA=1`.

## What it stages
| Source | Paths |
| --- | --- |
| WhatsApp / WA Business | `files/key`, `files/encrypted_backup.key`, `databases/msgstore.db`, `databases/wa.db` |
| Telegram | `cache4.db` (located under the data dir; type tells plain vs SQLCipher) |
| LINE | `databases/naver_line` + full `shared_prefs/` (key material); version logged |
| SMS/MMS | `com.android.providers.telephony/databases/mmssms.db` |
| Contacts + calls | `com.android.providers.contacts/databases/contacts2.db` |
| Media | `/data/media/0` (inventory by default; tar with `IVY_MEDIA=1`) |

## Expected after milestone 1
WhatsApp `msgstore.db`/`wa.db`, SMS, and contacts read as **plain SQLite** — the verifier
prints their tables and row counts. LINE `naver_line` reads as **encrypted** (SQLCipher,
key comes from `shared_prefs`, decrypted by the parser layer). Telegram `cache4.db` is
plain unless a local passcode is set.

## Hard rules (kept by these scripts)
- Read-only on all third-party app data; writes only to IVY's staging dir.
- No privilege escalation, no system/vendor service calls, no binder calls — assumes `su`.
- No network; the sync path is a PC pull over adb.
- The real archive encrypts everything at rest (archive layer, next milestones). The raw
  staging dir produced here is plaintext on the device/host — treat it as sensitive and
  delete it after pulling (`adb shell su -c 'rm -rf /data/local/tmp/ivy_stage'`).

## Next milestones (not in this folder yet)
Parsers/decryptors (msgstore schema, cache4 reader, naver_line SQLCipher), the encrypted
content-addressed archive (AES-256-GCM, Argon2id), the FTS5 search, the Kotlin app that
calls this as a privileged task runner on `BOOT_COMPLETED`, and the no-root degraded mode.
