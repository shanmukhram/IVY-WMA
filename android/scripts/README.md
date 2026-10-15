# Android scripts (milestone 1)

Read-only extraction and verification. This is the shell side of the split: it assumes a
**working root shell already exists** on the device (a `su` binary — however the owner
provides it). These scripts never obtain root, never call any system or vendor service,
and never write to third-party app data. They only copy **from** app data **into** a
staging dir and hash what they copied.

## Files
- `stack.sh` — runs **on the device as root**. Stages read-only copies of the target app
  databases + keys (with `-wal`/`-shm`), logs each package's version from `packages.xml`,
  writes `manifest.tsv` (source, staged path, size, sha256, plain-vs-encrypted type), and
  inventories `/data/media/0` (tars it only if `WITH_MEDIA=1`).
- `stack.py` — runs **on the host** after pulling the staging dir. Re-checks every sha256,
  and for each plain SQLite db lists tables + row counts via Python's stdlib `sqlite3`
  (no external tools). Encrypted stores are reported as "needs key" for the parser layer.
- `stack.bat` — Windows one-click runner: push → run on device → pull → check, writing all
  output to `service.txt`. Put it next to `adb.exe` and run it.

## Run (rooted phone connected over adb)
Easiest: put `stack.sh`, `stack.py`, `stack.bat` next to `adb.exe` and run `stack.bat`.

Manual:
```sh
adb push stack.sh /data/local/tmp/
adb shell "su -c 'sh /data/local/tmp/stack.sh'"
adb pull /data/local/tmp/out ./out
python3 stack.py ./out
```
Add the media tar (large — can be 100+ GB): prefix the device step with `WITH_MEDIA=1`.

## What it stages
| Source | Paths |
| --- | --- |
| WhatsApp / WA Business | `files/key`, `files/encrypted_backup.key`, `databases/msgstore.db`, `databases/wa.db` |
| Telegram | `cache4.db` (located under the data dir; type tells plain vs SQLCipher) |
| LINE | `databases/naver_line` + full `shared_prefs/` (key material); version logged |
| SMS/MMS | `com.android.providers.telephony/databases/mmssms.db` |
| Contacts + calls | `com.android.providers.contacts/databases/contacts2.db` |
| Media | `/data/media/0` (inventory by default; tar with `WITH_MEDIA=1`) |

## Expected after milestone 1
WhatsApp `msgstore.db`/`wa.db`, SMS, and contacts read as **plain SQLite** — the checker
prints their tables and row counts. LINE `naver_line` reads as **encrypted** (SQLCipher,
key from `shared_prefs`, decrypted by the parser layer). Telegram `cache4.db` is plain
unless a local passcode is set.

## Hard rules (kept by these scripts)
- Read-only on all third-party app data; writes only to the staging dir.
- No privilege escalation, no system/vendor service calls, no binder calls — assumes `su`.
- No network; the sync path is a PC pull over adb.
- The staging dir is plaintext until the archive layer encrypts it — treat it as sensitive
  and delete it after pulling (`adb shell "su -c 'rm -rf /data/local/tmp/out'"`).
