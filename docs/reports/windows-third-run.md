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

- (detail moved to docs/internals/windows-third-run-details.md)

`pnpm install` still needs `--ignore-scripts` on this PC (`better-sqlite3` has no Node 24 prebuilt, no C++ toolchain), as in the second run. The three JS failures are the same Windows-only assumptions in Mac-side packages as before and were not patched: `@ivy/gate-g1` expects exit code 130 after SIGINT (Windows gives `null`); `@ivy/mac-service` checks a `0o600` file mode and a `/thumbs/` forward-slash path; `@ivy/mac-ocr` needs Apple Vision.

### 2. Build

`dotnet build windows/Ivy.Windows.sln -c Release` succeeded first try with 0 warnings both before and after the merge. The new Fluent window (NavigationView, pages per collector, Telegram and LINE pages, Transfers, Settings, Activity) compiled without any XAML change; none of the problems the fourth-run checklist anticipates occurred.

### 3. Telegram and LINE rows

- (detail moved to docs/internals/windows-third-run-details.md)

| Checklist item | Result |
| --- | --- |
| Telegram page shows the row with a status; reaches ok and progress climbs | NOT REACHED. Before the install the row read `not configured` (build without the constants) and then `tdata folder not found`. After the install, on both the old and the new window, the page shows "Telegram has a problem" with status `Bad descriptor length 67174400.`, last capture never, "No progress reported yet". The log has the matching `WRN telegram:` line once per start. The row did not reach ok during the run, so the Mac could not be checked. This needs a look on the Mac side with the real profile; nothing on the PC side was changed for it. |
| If the row says it needs input, the field accepts it and Apply clears it | NOT APPLICABLE. The page showed no input field; the state above is not the needs-input state. |
| Include-channels toggle changes the chat count and persists | PARTIAL. The toggle flips and is logged as a settings change; with no chats captured the count could not change. Persistence across the restart: on (unchanged). |
| Phone-only chats listed | NOT REACHED. |
| Image and PDF attachments as uploads, videos as records | NOT REACHED. |
| Mac dashboard shows "Telegram · Windows" | NOT REACHED. |
- (detail moved to docs/internals/windows-third-run-details.md)
| LINE: Open report | PASS: the JSON opened in the default app (VS Code). |
- (detail moved to docs/internals/windows-third-run-details.md)
- (detail moved to docs/internals/windows-third-run-details.md)

### 4. Stability

- (detail moved to docs/internals/windows-third-run-details.md)

**New window, from 09:06Z.** See the result line at the end of this section.

- (detail moved to docs/internals/windows-third-run-details.md)

**Result, new window, 09:06Z to 09:22Z (stopped early at the operator's request):** 16 heartbeat lines, one a minute, every one `ui=alive feed=500 window=visible` with `last_tick` 1 s old (last: `2026-10-10T09:22:13.548Z INF Watchdog: heartbeat: ui=alive feed=500 window=visible last_tick=2026-10-10T09:22:11.980Z (1 s ago)`). 0 warnings of the `UI unresponsive`, diagnostics-file, `slow` or `UI thread: VaultDb write` kinds. No freeze on either window. Combined, the app ran with the window open and the feed active for about 60 minutes across the two builds without incident.

## Commits (Part 1)

| Commit | Change |
| --- | --- |
| `a8f6e27` | `TelegramApiCredentials.DesktopDefault` set to Telegram Desktop's public constants (superseded by the same change on main; the merge took main's version). |
- (detail moved to docs/internals/windows-third-run-details.md)
- (detail moved to docs/internals/windows-third-run-details.md)
| `94c7fda` | Merge of `main` (`dc7cec7`). |

No change to `windows/Ivy.Core`, and no XAML change.

## Part 2: gate items (c) and (d)

Filled in after the run.
