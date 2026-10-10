# Windows fourth run: the Fluent window

Date: 2026-10-10. Branch: `windows-fourth-run`, from `main` at `06cc2b1`. Same PC as the earlier runs: Windows 11 Pro 26200 x64, standard user, one 1920x1080 monitor at 100 % scale, .NET SDK 8.0.425. The app stayed paired to the real Mac. Screenshots are in `docs/ui/windows-screenshots/` (one per page, light and dark).

## 1. Tests

| Suite | Result | Expected |
| --- | --- | --- |
| Ivy.App.Core.Tests | 142 passed | 142 |
| Ivy.Core.Tests | 108 passed, 1 skipped | 108 + 1 skipped |
| Ivy.Collectors.Tests | 128 passed, 1 failed | 129 |

The one failure is `TelegramCollectorTests.Missing_tdata_reports_not_found` (expects `TdataNotFound`, gets `SessionInvalid`). It is the same test that started failing in the third run the moment Telegram Desktop was installed on this PC, and it still fails on `06cc2b1`: on a PC with a real Telegram profile the test does not get the "not found" path. Not patched here; it needs the test (or the collector's path handling) made independent of the PC's own profile.

## 2. Build

`dotnet build windows/Ivy.Windows.sln -c Release`: succeeded first try, 0 warnings, 0 errors. None of the XAML problems the checklist anticipates occurred (the record-typed `x:DataType`s, the `BrandBadge` function binding, the tooltip binding on the tiles, `UpdateSourceTrigger`, the list style). No fix from the earlier verification branches needed carrying over; the merge of main in the third run already took the rewrite.

## 3. Checklist: Fourth run, UI

Legend: PASS verified here; PARTIAL verified with a caveat; NOT VERIFIED could not be exercised on this PC.

**Every page renders**

| Item | Result |
| --- | --- |
| Unpaired start, pairing card, Tab order, access keys | NOT VERIFIED. The app stayed paired (unpairing would need a fresh string from the Mac). The pairing card itself was verified in the third run on the previous window. |
| Bad, expired, used and random strings; network error line | NOT VERIFIED here for the same reason (the refusals were verified in the second and third runs). |
| Pair for real, fingerprints, Continue opens Overview | NOT VERIFIED here (paired state kept). |
| Overview, Files, Screenshots, App usage, Notifications, Telegram, LINE, Transfers, Settings and Activity open from the pane with a title, no clipped text, no horizontal scroll bar | PASS at 1186 x 833 (the window's default size on this PC) in both themes: each page opened from the pane with its title and description, and no horizontal scroll bar was present on any page (checked through UI Automation). 150 % scaling NOT VERIFIED (needs a sign-out on this PC). |
| Overview tiles show dot, name, status, last capture; clicking a tile opens the page and selects it in the pane | PASS. Tiles: Files, Screenshots, App usage, Notifications (green, Working, last capture), LINE and Telegram (red, Error, never). Clicking the Telegram tile opened the Telegram page and selected it in the pane. |
| Telegram and LINE brand marks in the pane and as the page badge | PASS at 100 % (blue plane, green LINE bubble, crisp). 150 % NOT VERIFIED. |

**Mica and theme**

| Item | Result |
| --- | --- |
| Mica background, raised content layer with the rounded corner | PASS. The wallpaper tints the window edge and pane; the content area is the raised layer with the rounded top-left corner (see `overview-light.png`). |
| Windows light/dark switch is followed live, caption buttons too | PASS. With App theme on "Use system setting", switching Windows to dark (Personalization, Colors) re-themed the window within a second, caption buttons included; switching back re-themed it light. The Windows setting was put back to light afterwards. |
| App theme Light / Dark apply at once and survive a restart; "Use system setting" follows Windows again | PASS. Dark applied at once (all ten dark screenshots were taken this way); after tray Quit and a restart the window came up dark with the combo box still on Dark; "Use system setting" put it back to following Windows. |
| Accent colour used by switches, buttons, progress bars and the feed's event column; no old green | PASS with the current accent (teal): switches, Sync now, Apply, the feed's event column and the pane's selection marker use it. No green from the old palette; the only greens are the status dots and the LINE brand mark. Changing the accent colour itself was not tried. |

**NavigationView groups**

| Item | Result |
| --- | --- |
| Collectors and Conversations expand and collapse by click and keyboard; the header does not change the page | PASS by click and through the group's expand/collapse pattern; the page did not change. Keyboard (arrow keys, Enter) NOT VERIFIED. |
| Collapse Conversations, select Files, Quit, start again: opens on Files with Conversations collapsed | PASS. After the restart the Files page was showing and the Telegram and LINE items were not in the pane until the group was expanded. |
| Selecting a page in a collapsed group expands it | PASS via the Overview Telegram tile. |

**All actions still work**

| Item | Result |
| --- | --- |
| Overview Running/Paused switch; bucket InfoBar with Retry now | PASS for the switch (tiles say Paused, tray tooltip says Paused, Resume restores). The InfoBar needs the network unplugged: NOT VERIFIED. |
| Files: Add folder, Remove, exclusions add (also with Enter) and remove, Upload switches, size caps with Apply, extension lists | PASS. Typing `*.iso` in the exclusion box and pressing Enter added it (removed again afterwards); `abc` in the image cap with Apply shows "enter sizes in MB, more than 0 and at most 4096"; both upload switches and both caps are on the page; the extension lists sit in the Expander. Add folder and Remove were verified on the previous window in the earlier runs and the buttons are present here. |
| Screenshots add/remove folders; App usage title switch and exclusions; Notifications database line | PASS for presence and the Notifications line ("Last notification id 2704"). The Screenshots and App usage controls are present with the expected names; their behaviour was verified in earlier runs. |
| Each collector page's switch turns the collector off (grey, Off, "Turned off") and on; an error shows an InfoBar | PASS on Notifications (Off, then Working again). The InfoBar with a reason is shown on the Telegram and LINE pages. |
| Telegram: needs-input field appears and clears after Apply | NOT APPLICABLE. The row never entered that state (see section 4). |
| LINE: Run probe updates the summary and path; Open report opens the JSON | PASS, on this window (verified in the third run the same day; the committed report is `docs/reports/line-probe-26.5-windows.json`). |
| Transfers: pending numbers, progress bar, bandwidth "current: 256.0 KB/s", "last sync now ... ok", recent commands | PASS for bandwidth (`256` + Apply shows "current: 256.0 KB/s", put back to 0) and Sync now ("last sync now: 20:27:29 ok"). Pending numbers and the progress bar moved during the earlier transfers today on the previous window. Recent commands: the list was empty in this session; the Mac sent no command while this window was open, so the "File request / Uploaded to the Mac" entry is NOT VERIFIED. |
| Settings: Run at login toggles the Run key; folder Open buttons; version | PASS. Off removed `HKCU\...\Run\IVY`, on restored it; Open (log folder) opened File Explorer; the page reads "IVY for Windows 0.1.0". |
| Settings, Unpair: dialog, return to the pairing card, tray greys out, re-pair resumes queued work | NOT VERIFIED. Deliberately skipped: re-pairing needs a fresh string from the Mac, and the PC is in use for the gate. |
| Activity: full-height feed; Pause scroll in step with Overview | PASS. Ticking Pause scroll on Activity showed it ticked on Overview; unticking on Overview showed it unticked on Activity. |

**Keyboard and accessibility**

| Item | Result |
| --- | --- |
| Tab order, focus rectangle, access keys | NOT VERIFIED (not exercised through automation). |
| Narrator names | PARTIAL. The UI Automation names are in place: "Add folder", "Remove selected folder", "New exclusion", "Add", "Remove selected exclusion", "Pause scroll", "Capture and upload", "Files collector", "Notifications collector", "Apply size caps", "Apply bandwidth cap", "Open data folder", "Open log folder", "Unpair this PC", "App theme". Narrator itself was not run. |
| Accessibility Insights FastPass | NOT VERIFIED (not installed on this PC). |

**Tray still works**

| Item | Result |
| --- | --- |
| Left-click opens the window on the last page; right-click shows Open / Pause / Sync now / Quit; tooltip "IVY: Running, N queued"; closing hides to the tray; Quit within 15 s | PASS. With Transfers open, closing hid the window (`window: close requested; hiding to the tray`); left-click on the tray icon brought it back on Transfers; the menu shows Open, Pause, Sync now, Quit; Pause from the menu paused (tooltip "IVY: Paused, 0 queued", header "Paused"), the menu then offered Resume, and Resume restored "IVY: Running, 0 queued"; Quit exited in under a second; the next start opened on Transfers again. The icon sits in the hidden-icons flyout on this PC. |

## 4. Telegram and LINE rows, from the pages

| Row | What the page shows |
| --- | --- |
| Telegram | "Telegram has a problem", status "No usable accounts in tdata (no MTProto authorization found)", last capture never, History "No progress reported yet". The row did not reach ok at any point during this run, so there was nothing to check on the Mac. (The third run's message on the same PC was "Bad descriptor length 67174400"; this build gives the new message above.) Telegram Desktop is installed and was signed in by the operator during the third run. |
| LINE | "LINE has a problem", status "LINE 26.5 store is encrypted and no key is available on this PC, so Windows captures no LINE messages. Complete LINE history comes from the phone." with the "Partial coverage" card. This is the named state the checklist expects, and it now names the installed version (26.5). |

## 5. Screenshots

`docs/ui/windows-screenshots/<page>-<light|dark>.png`, ten pages in each theme, 1186 x 833, taken from the window's own bounds (DWM extended frame) with a desktop capture rather than the Snipping Tool, which does not save a file when driven by synthetic input on this PC (first run). Content is the same as a Snipping Tool window capture.

## Not verified in this run

Unpaired start and pairing card on the new window; network-unplugged InfoBar; keyboard navigation of the groups; Tab order and access keys; Narrator and FastPass; 150 % scaling; accent colour change; Unpair; a Mac command under Recent commands.

## Changes

No code change. Commits: the screenshots and this report.
