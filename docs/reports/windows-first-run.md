# Windows first run: build, pair, capture

Date: 2026-10-10. Branch: `windows-first-run`. This is the first time `windows/Ivy.App` was compiled or executed anywhere. Everything below was done on one PC against the fake Mac (`tools/fake-mac`), not a real Mac.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 11 Pro 10.0.26200 (build 26200.9457), x64, 64 GB RAM, 1920x1080 at 100 % scale |
| User | standard (non-elevated) account, medium integrity |
| .NET SDK | 8.0.425 (installed with `winget install Microsoft.DotNet.SDK.8`; 10.0.302 was already present and is not used because of `global.json`) |
| Node / pnpm | Node v24.11.1, pnpm 10.28.2 (the pinned version, resolved by the installed pnpm 12.9.1 shim) |
| Git | 2.52.0.windows.1 |
| Checkout path | `C:\Users\admin\Desktop\ivy test\IVY-WMA` (note the space; it exposed one test bug) |
| Visual Studio | not installed; the Windows App SDK's own XAML/PRI tooling was enough |

`pnpm install` prints `Unsupported engine: wanted node >=25` for `packages/s3-mock` and `tools/audit-plaintext`. Both work on Node 24; the engine field is stricter than the code.

## What built first try, what was fixed

**Built first try, unchanged:** `dotnet build windows/Ivy.Windows.sln -c Release` succeeded on the first attempt with 0 warnings and 0 errors (about 1 minute). None of the three XAML problems predicted in `windows/Ivy.App/README.md` (the `x:Bind` static function, the positional-record `x:DataType`, `UpdateSourceTrigger`) occurred. The exe landed at the documented path next to `resources.pri`, the `Microsoft.WindowsAppRuntime*.dll` files and `Assets\ivy.ico`, and it started without a "Windows App Runtime required" prompt.

**Fixed, commit `4f8baf9` (tests only; no product code):**

- `Ivy.Collectors.Tests`: 8 failures. 6 of them had one cause: the test trees were created under `%TEMP%`, which on Windows is `%LOCALAPPDATA%\Temp`, and the files collector excludes `**/AppData/Local/Temp` by default, so watcher, USN, rescan and missing-root scenarios saw nothing. `TempDir` now uses `%LOCALAPPDATA%\ivy-tests` on Windows. The other two: dot files are not hidden on Windows (the helper now sets the Hidden attribute, so the tests mean the same thing on both platforms), and the host test asserted that only the test root was watched, while on a PC where `Pictures\Screenshots` exists the screenshots collector watches that folder through the same fake change source (assertion relaxed to Contains).
- `Ivy.Core.Tests` integration fixture: `Process.Start("pnpm")` fails on Windows because the shim is `pnpm.cmd` and CreateProcess does not resolve `.cmd`. The fixture now starts `pnpm.cmd` on Windows. All 5 integration tests then passed unchanged.
- `tools/audit-plaintext` test: `new URL(...).pathname` produced `C:\C:\...\ivy%20test\...`; replaced with `fileURLToPath`. Separately, the "header allowance" test was flaky on every platform because the random padding next to the 24-byte printable run is itself sometimes printable (observed runs of 25 and 26); the sample is now padded with zero bytes on both sides.

**Fixed, commit `fa52b96` (one Windows-only product change, `Ivy.Collectors/Windows/WindowsUsnJournal.cs`):** see USN journal below. Also added `.fake-mac/` to `.gitignore` (it holds the fake Mac's keys, tokens and ledger).

No interface, view model, XAML or `Ivy.Core` change was needed. Nothing under `windows/Ivy.Core/Protocol`, the key store, the queue or the token separation was touched.

## Test counts on Windows

| Suite | First run | After `4f8baf9` |
| --- | --- | --- |
| Ivy.App.Core.Tests | 69 passed | 69 passed |
| Ivy.Collectors.Tests | 53 passed, 8 failed | 61 passed |
| Ivy.Core.Tests | 94 passed, 5 failed, 1 skipped | 99 passed, 1 skipped |
| @ivy/s3-mock | 13 passed | 13 passed |
| @ivy/protocol | 54 passed | 54 passed |
| @ivy/audit | 10 passed, 3 failed | 13 passed (5 consecutive runs) |
| @ivy/fake-mac | 12 passed | 12 passed |

The expected counts (69 + 61 + 99 with 1 skipped; 13 + 54 + 13 + 12) are met. The skipped test is `Access_denied_is_reported` (chmod-based). The suites were rerun after `fa52b96` with the same result.

## Smoke test with the fake Mac

Fake Mac: `pnpm --filter @ivy/fake-mac run serve --root .fake-mac --keep --no-qr` with `IVY_FAKE_MAC_PASSPHRASE` set (`--keep` so the audit scans real ciphertext). The terminal panel's shell integration was broken on this PC, so `serve` ran as a background process logging to a file, and the app's UI was driven with UI Automation (Win32 UIA, the same tree a screen reader sees) plus synthetic mouse and keyboard input for the shell folder dialog and the tray menu.

1. Pairing string pasted from `.fake-mac\pairing.txt`, **Pair** pressed. The app showed "Paired. Check that both fingerprints match...", **This device** `2C05-6878-2791-5572` and **Mac** `4CC6-DF4D-743B-3157`. `serve` printed `PAIRED pair/<id>/device` with the same two fingerprints. **Continue** switched to the status window.
2. Within seconds `serve` printed the first `REPORT` (device report) and started printing decrypted `RECORD` lines.
3. Terminal-B commands used: `request-file` (twice), `rescan --collector files`, `config --collector usage --enabled false`, `status`, `audit`. All four commands show `done` or `uploaded -> <oid>` in `status`, and `serve` deleted each `cmd/<oid>` after the matching `command_status`.

Final fake Mac ledger: 209 objects, all `committed`, 0 quarantined, 0 rejected. Record kinds seen decrypted: 7 `file_meta`, 50 `screenshot`, 15 `usage_event`, 13 `windows_notification`, 4 `command_status`, plus `device_report`s, 54 blob manifests and 57 chunks.

## First-run checklist, item by item

Legend: PASS = verified here; PARTIAL = verified with a caveat; NOT VERIFIED = could not be exercised on this PC.

**Build**
- PASS: `dotnet build windows/Ivy.Windows.sln -c Release` has no errors (and no warnings). The three predicted XAML problems did not occur.
- PASS: `Ivy.App.exe` sits next to `resources.pri`, `Microsoft.WindowsAppRuntime*.dll` and `Assets\ivy.ico`.

**Launch and window**
- PASS: starts with no runtime prompt. No `ivy-app-crash.log` was ever written.
- PASS: opens on the pairing panel; near-black background, 1 px borders on the text box, green focus underline and green switches/progress bars (the accent overrides are honoured).

**Tray**
- PASS: a green square icon appears. On this PC it is in the hidden-icons overflow (not pinned). Tooltip reads `IVY: Running, 0 queued`, and `IVY: Paused, 2 queued` after pausing with a queue.
- PASS: right-click shows Open / Pause / Sync now / Quit (seen in a screenshot; the native menu's items are not exposed to UIA, so they were chosen by keyboard). The menu closed when clicking elsewhere.
- PASS: left-click/Open brings the window up (verified with Open after a `--minimized` start).
- PASS: closing the window with X hides it; the process and tray icon stay.
- PASS: after `Stop-Process explorer` and Explorer's restart the tray icon came back with its tooltip intact.
- NOT VERIFIED: crispness at 150 % scale. This display runs at 100 %.

**Single instance**
- PASS: a second `Ivy.App.exe` launch left exactly one process (the original pid), which was the foreground window; the second process exited.

**Pairing**
- PASS: fingerprints shown in monospace and matching the fake Mac; Continue switches to the status window. Run-at-login was registered by pairing.
- NOT VERIFIED: a bad, expired or used string. Not exercised.

**Run at login**
- PASS: after pairing, `HKCU\...\Run\IVY` = `"<exe path>" --minimized`.
- PASS: the **Run at login** switch off removes the value; on adds it back.
- PARTIAL: starting with `--minimized` gives no window, only the tray icon, and the collectors and uploads run. A real sign-out/sign-in was not done (it would end this session).

**Collectors**
- PASS: all four rows appear.
- PASS: usage turned green within 30 s with its last-capture time.
- PASS (unexpectedly good): notifications is green without elevation on this build. `wpndatabase.db` was readable; the collector reported `ok - last notification id 2691, 12 new` and emitted the existing toasts. The README says red-with-reason is expected without elevation; that is not the case on this Windows 11 24H2 PC.
- PASS: turning a row off (notifications) greys it and stops it (`collector_config disabled`, `collector_stopped`); after Quit and restart it was still off.

**Folders and index**
- PASS: **Add folder...** opens the system folder dialog; the chosen path appears and the files row showed the scan, then `ok - last full scan ...: 5 files`.
- PARTIAL: the initial index counter reached `complete: 5 / 5 files (100%)` (later 6 / 6 with the big file). The tree was too small to watch it count up or to see the "?" estimate.
- PASS: **Remove selected** removed the folder (row went to `ok - no folders selected`), and it was added back afterwards.
- NOT VERIFIED: behaviour of the dialog when IVY runs elevated.

**Activity feed**
- PASS: captured, encrypted, queued, upload_started and uploaded lines stream in newest first, for all four collectors, plus `commands` and `status` lines.
- PARTIAL: **Pause scroll** toggles on and off and the feed reflowed after unticking, but the "N new while paused" text was not read back through UIA, so that label is unconfirmed.
- PARTIAL: the UI stayed responsive during the first screenshot-folder sweep (50 existing screenshots, a few hundred lines in a few seconds). The 500-line cap could not be checked from outside because the list is virtualised (UIA only sees realised items; it reported 155).

**Queue**
- PASS: pending objects and bytes rose and fell (for example 5 objects / 24.0 MB during the big upload, back to 0).
- PASS: a 120 MB file request showed the current upload per 32 MiB chunk with a progress bar (`.../p/00000001 19.0 MB of 32.0 MB (59%)`).
- PASS: bandwidth cap `2048` + Apply showed `current: 2.0 MB/s` and the observed throughput matched (about 51 MB in the first 25 s). The README's example of `256` KB/s was not used because it would have made the 120 MB test take eight minutes.
- PASS: **Sync now** shows `last sync now: HH:mm:ss ok`.

**Footer**
- PASS: up bucket "last put" updated within seconds of an upload.
- PASS: cmd bucket "last list" was never older than about 2 minutes.
- PASS (simulated): with the fake Mac stopped, Sync now showed `sync failed: ... actively refused it (127.0.0.1:9000)` and the cmd-bucket line carried the error; after restarting `serve` both cleared. The network cable was not pulled.
- PASS: both fingerprints and `IVY for Windows 0.1.0` are shown.

**Pause**
- PASS: Running to Paused: every collector row shows `paused`, the tray tooltip says Paused, uploads stop (queue went to 2).
- PASS: after Quit and restart the switch was still Paused and the rows still said paused; Resume brought everything back (`resumed` feed line).

**Settings**
- PASS: turning window-title capture off and adding `keepass.exe` produced `collector_config settings: captureTitles` and `settings: titleExclusions` feed lines; the exclusion was still listed after restart.

**Quit**
- PASS: tray Quit: window and icon gone, process exited in under 1 s (log: `quit requested`).
- PASS: on restart the feed shows `reconciled reset=1 requeued=0 orphansDeleted=0 tmp=0 missing=0 done=0` and pending uploads continue.

**Privacy**
- PASS: `%LOCALAPPDATA%\IVY\logs\ivy-app.log` had 7 lines after the whole session: start lines, the pairing line (device id and fingerprint), the reconcile report, one poll failure and `quit requested`. No paths, window titles, notification text or file contents. No crash log.

## Capture scenarios (step 5)

| Scenario | App feed | Fake Mac (decrypted) |
| --- | --- | --- |
| Indexed root with `notes.txt`, `data.csv`, `sub\readme.md`, `doc.pdf`, `photo.png` | 5 `file_meta` captured/encrypted/queued/uploaded, 2 thumbnail blobs | 5 `file_meta` records with correct path, name, size, ext, mtime; thumbnails for the PDF and the PNG written to `received\*.thumb` (PDFium and SkiaSharp both worked) |
| Edit `notes.txt` later | new `file_meta` within seconds | 1 more `file_meta` |
| Screenshot | `Win+PrtScn` saved `Screenshot (1).png`; captured 2.5 s after save (debounce) | `screenshot` record with sha256, 1920x1080, and the original PNG in `received\` |
| App switching for ~2.5 min (Notepad, Settings, Chrome, IVY) | `usage_event`s every sample | 15 `usage_event`s with FileDescription, exe and title, including Settings (`SystemSettings.exe`) resolved through ApplicationFrameHost |
| Toast via `ToastNotificationManager` from PowerShell | `windows_notification` captured on the next poll (within 60 s) | record with the toast's title and body text exactly as sent, app = the PowerShell AppUserModelId, even with Do Not Disturb on |
| `request-file doc.pdf` | manifest + 1 part + `command_status` uploaded after Sync now | `STATUS ... uploaded`, `received\<oid>.pdf` with SHA-256 `be9b96d1...8dc7` = original |
| `request-file big.bin` (120 MB random), quit mid-upload, relaunch | killed at part 3 of 4, 72 %; after relaunch `reconciled reset=1` and part 3 was in progress again 9 s later (resumed, not restarted) | `received\<oid>.bin` 125 829 120 bytes, SHA-256 `cfdc2b64...5e43` = original, `parts=4` |
| `rescan files`, `config usage enabled=false` | `command_received`, `collector_config`, `scan_started/completed (command)`, `command_completed ... done` | both `done`, commands deleted from the cmd bucket |

Caveats: the `Win+Shift+S` snip overlay did not save a file when driven by synthetic keystrokes (the snipping overlay probably rejected the injected drag), so `Win+PrtScn` was used; a human pressing `Win+Shift+S` should be retried once. The "quit mid-upload" was a forced process kill rather than tray Quit, because the tray icon took longer to locate than the upload took to finish; that is the stricter test and the resume worked. Tray Quit was tested separately with a small queue.

## Windows-only components (step 6)

| Component | Result |
| --- | --- |
| DPAPI key store | PASS. `%LOCALAPPDATA%\IVY\keys\device-key.bin` (262 B) and `credentials.bin` (358 B) start with the DPAPI blob header (`01 00 00 00 D0 8C 9D DF ...`) and contain no readable text. `pairing.json` holds only ids, the endpoint, bucket names, both public keys and fingerprints; no secret. |
| USN journal, without admin | FIXED in `fa52b96`. As shipped, the standard user got `no USN journal on C:\; using FileSystemWatcher only`, which is honest about the fallback but wrong about the cause: the journal exists (`fsutil usn queryjournal C:` works as a standard user). Probing with P/Invoke showed that `\\.\C:` refuses `GENERIC_READ` and `FILE_READ_DATA` (error 5) for a standard user, opens with `FILE_READ_ATTRIBUTES`, but then both `FSCTL_QUERY_USN_JOURNAL` and `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL` return `ERROR_INVALID_FUNCTION` (1) on that handle. A handle to the root directory `C:\` opened with `FILE_READ_ATTRIBUTES` + `FILE_FLAG_BACKUP_SEMANTICS` accepts both (query OK; unprivileged read returned 33 KB of records). The fallback now opens that handle. After the rebuild the files row shows no fallback note and the device report's files cursor is `{"C:\\":{"journalId":133539027358354654,"nextUsn":...}}`, whose journal id equals fsutil's `0x01da6d09b1588cde`. Edits in the root were picked up (the watcher also covers them, so the two paths were not separated). |
| USN journal, with admin | NOT VERIFIED. Nothing was run elevated (UAC consent cannot be given from this session). The `GENERIC_READ` path is unchanged. |
| FileSystemWatcher fallback | PASS before the fix: the collector reported the fallback and file changes were still captured through the watcher. |
| Foreground app sampler | PASS. Desktop apps (`Notepad`, `chrome.exe`, `Ivy.App.exe`) and a Store app (Settings, hosted by ApplicationFrameHost, resolved to `SystemSettings.exe` / "Settings") were reported with FileDescription, exe and title. The folder dialog host `PickerHost.exe` was also sampled. Idle detection was not exercised. |
| Notification database reader | PASS. `wpndatabase.db` was readable by the standard user (snapshot copy approach worked while the platform service held it); existing toasts and a new toast were parsed with correct title, text and sender, so the current build's toast XML matches the parser. |
| Tray icon after Explorer restart | PASS. |
| Run-at-login entry | PASS (registered by pairing, toggled off and on, `--minimized` start shows no window). Sign-out not done. |
| Single instance | PASS. |

## Zero-plaintext audit

`pnpm --filter @ivy/fake-mac run audit --root .fake-mac`, run twice (mid-session and at the end, both against the running `serve` with `--keep`):

```
audit of the running serve endpoint, 186 marker(s) harvested from ledger.json and received/
Scanned 209 item(s), 21046798 bytes.
RESULT: PASS (0 hits)
```

The markers include the file names, paths, window titles, notification texts and the text runs of the received PDF and text files, so a pass means none of that appeared in any of the four buckets. Independently of the audit, the local state was inspected: `vault-agent.db` and the queue directory held only ciphertext parts and metadata, the keys folder holds DPAPI blobs, and the app log holds no content.

One thing to check in the fake Mac's audit, not the app: it reports 21 MB scanned although the buckets held the 120 MB blob's four chunk objects (about 134 MB) at that point. Either the audit scans a bounded prefix of each object or the listing is capped; either way it should say so.

## Not verified, or failed

- `Win+Shift+S` did not produce a file under synthetic input (see above); `Win+PrtScn` did.
- Elevated runs: USN with admin, and the folder dialog failure when elevated.
- Sign out and back in.
- 150 % display scale.
- The 500-line feed cap and the "N new while paused" label (both only observable inside the virtualised list).
- Bad/expired pairing string handling.
- The "quit while uploading" step used a process kill, not the tray menu.
- Everything was tested against the fake Mac on loopback, not real R2 or a real Mac.

## Observations worth a follow-up (not changed)

- `packages/s3-mock` and `tools/audit-plaintext` declare `engines.node >= 25`; the README says 22.18+ is enough and Node 24 worked.
- The notifications README text ("red with a reason ... expected without elevation") should say that on current Windows 11 builds the database is usually readable; red is the exception.
- The bandwidth cap label formats 2048 KB/s as `2.0 MB/s`; the checklist example (`current: 256.0 KB/s`) was not tried.
- The native tray menu's items are not visible to UI Automation. Cosmetic for users, but it blocks automated UI tests of the menu.
