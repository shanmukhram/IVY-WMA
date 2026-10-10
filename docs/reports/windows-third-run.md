# Windows third run: chat collectors, stability, gate items (c) and (d)

Date: 2026-10-10. Branch: `windows-third-run`. It started from `main` at `a99e766` and merged `main` at `dc7cec7` part-way through (the Fluent Design window and the client constants landed on main while the run was in progress), so the second half ran on the new window. Same PC as the earlier runs: Windows 11 Pro 26200 x64, standard user, Controlled Folder Access on, 100 % scale, .NET SDK 8.0.425, Node 24.11.1, pnpm 10.28.2. The app stayed paired to the real Mac from the second run, so everything it captured went to real R2 and the Mac.

## Part 1

### 1. Tests

| Suite | Before the merge (`a99e766`) | After the merge (`dc7cec7`) | Expected (commit `efdb0aa`) |
| --- | --- | --- | --- |
| Ivy.App.Core.Tests | 87 passed | 142 passed | 142 |
| Ivy.Core.Tests | 108 passed, 1 skipped | 108 passed, 1 skipped | 108 + 1 skipped |
| Ivy.Collectors.Tests | 118 passed | 117 passed, 1 failed | 118 |
| @ivy/protocol | 60 passed | | green |
| @ivy/s3-mock | 13 passed | | green |
| @ivy/audit | 13 passed | | green |
| @ivy/fake-mac | 12 passed | | green |
| @ivy/mac-ui | 49 passed | | green |
| @ivy/gate-g1 | 14 passed, 1 failed | | see below |
| @ivy/mac-service | 190 passed, 4 skipped, 2 failed | | see below |
| @ivy/mac-ocr | suite error (requires macOS) | | see below |

**The one .NET failure is environmental.** `Ivy.Collectors.Tests.Telegram.TelegramCollectorTests.Missing_tdata_reports_not_found` expects the state `TdataNotFound` and gets `SessionInvalid`. It passed on the same code at the start of the session and started failing after Telegram Desktop was installed on this PC during the run, so the collector under test is evidently reading the real `%APPDATA%\Telegram Desktop\tdata` instead of the missing test path. Not patched (it is a collector behaviour, not a test typo); worth fixing on the Mac so the test's "missing" path is honoured on a PC that has Telegram installed.

`pnpm install` still needs `--ignore-scripts` on this PC (`better-sqlite3` has no Node 24 prebuilt, no C++ toolchain), as in the second run. The three JS failures are the same Windows-only assumptions in Mac-side packages as before and were not patched: `@ivy/gate-g1` expects exit code 130 after SIGINT (Windows gives `null`); `@ivy/mac-service` checks a `0o600` file mode and a `/thumbs/` forward-slash path; `@ivy/mac-ocr` needs Apple Vision.

### 2. Build

`dotnet build windows/Ivy.Windows.sln -c Release` succeeded first try with 0 warnings both before and after the merge. The new Fluent window (NavigationView, pages per collector, Telegram and LINE pages, Transfers, Settings, Activity) compiled without any XAML change; none of the problems the fourth-run checklist anticipates occurred.

### 3. Telegram and LINE rows

Telegram Desktop was not installed on this PC at the start of the session. It was installed and signed in by the operator during the run (`tdata` appeared at 08:51Z), so both states were observed.

| Checklist item | Result |
| --- | --- |
| Telegram page shows the row with a status; reaches ok and progress climbs | NOT REACHED. Before the install the row read `not configured` (build without the constants) and then `tdata folder not found`. After the install, on both the old and the new window, the page shows "Telegram has a problem" with status `Bad descriptor length 67174400.`, last capture never, "No progress reported yet". The log has the matching `WRN telegram:` line once per start. The row did not reach ok during the run, so the Mac could not be checked. This needs a look on the Mac side with the real profile; nothing on the PC side was changed for it. |
| If the row says it needs input, the field accepts it and Apply clears it | NOT APPLICABLE. The page showed no input field; the state above is not the needs-input state. |
| Include-channels toggle changes the chat count and persists | PARTIAL. The toggle flips and is logged as a settings change; with no chats captured the count could not change. Persistence across the restart: on (unchanged). |
| Phone-only chats listed | NOT REACHED. |
| Image and PDF attachments as uploads, videos as records | NOT REACHED. |
| Mac dashboard shows "Telegram · Windows" | NOT REACHED. |
| LINE: Run probe | PASS, on both windows. Old window: `Probe complete: 258 files, 6 databases, 1 readable`. New window after the rebuild: `Probe complete: 260 files, 6 databases, 1 readable` (LINE was running and had written two more files), report path shown, `%LOCALAPPDATA%\IVY\line-probe-unknown.json` written. `unknown` because the probe could not read the LINE version; the installed app is LINE 26.5.0.0 (Store package), data under `%LOCALAPPDATA%\LINE\Data`. |
| LINE: Open report | PASS: the JSON opened in the default app (VS Code). |
| LINE: a named state with a reason; coverage partial | PASS: "LINE has a problem", status `Store is encrypted (EncryptedWxSqlite3Aes128Cbc); key derivation for LINE version 26.3 is not implemented. Run the probe on the PC and send the report so the unlocker can be written.`, and the "Partial coverage" card. Nothing captured. The message names 26.3 while the installed version is 26.5. |
| Probe report committed | `docs/reports/line-probe-26.5-windows.json` (commit `0f536e6`). Checked before committing: per file `relativePath`, `size`, `mtime`, `head16Hex`, `kind`, `looksEncrypted`, `tables` (table and column names only, for the one plain SQLite file, a sticker-metadata db) and `note`; one location; a summary. No message content. `head16Hex` is the first 16 bytes of each file, which for the 16 `Text`/`Json` files (ini files, a connection id) is file content, so those values were removed from the committed copy and marked in `note`; they remain for binary, SQLite and LevelDB files, where they only identify the format. The six databases are five `.edb` files with random headers (`looksEncrypted`), including the 516 KB main store with a 4 MB `-wal`, plus the plain SQLite file. |

### 4. Stability

**Old window, 08:31Z to 09:06Z (35 minutes).** The feed was driven by an indexed folder, `ivy-stress-test`: 600 small text files in 12 subfolders indexed at 08:32Z with Upload documents off (so only `file_meta` records went to the Mac), then 20 new files written every two minutes through the watcher path. 34 heartbeat lines, one a minute, all `ui=alive feed=500 window=visible` with `last_tick` 1 s old. No `UI unresponsive`, no diagnostics file, no `slow` lines. Pause/Resume, a collector switch, a capture setting, the bandwidth cap and run-at-login were each flipped once: no `UI thread: VaultDb write` warning from any of them. Closing the window logged `window: close requested; hiding to the tray` and `window: hidden`; Open from the tray logged `window: shown`. The one UI-thread write warning of the session came from Run probe on the unfixed build (see commits).

**New window, from 09:06Z.** See the result line at the end of this section.

Not done: Win+L lock/unlock (it would end this session's control of the PC; no second monitor exists).

**Result, new window, 09:06Z to 09:22Z (stopped early at the operator's request):** 16 heartbeat lines, one a minute, every one `ui=alive feed=500 window=visible` with `last_tick` 1 s old (last: `2026-10-10T09:22:13.548Z INF Watchdog: heartbeat: ui=alive feed=500 window=visible last_tick=2026-10-10T09:22:11.980Z (1 s ago)`). 0 warnings of the `UI unresponsive`, diagnostics-file, `slow` or `UI thread: VaultDb write` kinds. No freeze on either window. Combined, the app ran with the window open and the feed active for about 60 minutes across the two builds without incident.

## Commits (Part 1)

| Commit | Change |
| --- | --- |
| `a8f6e27` | `TelegramApiCredentials.DesktopDefault` set to Telegram Desktop's public constants (superseded by the same change on main; the merge took main's version). |
| `d5845e8` | Conversation panel: Run probe, Apply passcode and Include channels go through `BackgroundWork` like the main view model's host calls. Found by the checklist: pressing Run probe on the unfixed build logged `UiThreadGuard: UI thread: VaultDb write VaultDb.SetSetting from CollectorSettingsStore.SaveJson` and `... ActivityLog.Append from CollectorHost.UpdateSettingsAsync`. Smallest interface change: `ConversationViewModel.LastWork` (a `Task`) so the tests can await the queued work; the three tests use `ExecuteAsync`. After the rebuild, Run probe logs nothing, on both windows. |
| `0f536e6` | LINE probe report. |
| `94c7fda` | Merge of `main` (`dc7cec7`). |

No change to `windows/Ivy.Core`, and no XAML change.

## Part 2: gate items (c) and (d)

Filled in after the run.
