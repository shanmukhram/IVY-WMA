# IVY Windows app: `Ivy.App`

The visible Windows companion (PRD Part 1 "App UI", WP1 to WP3, WU5; PLAN task 1.8). It is one process with a window and a tray icon. That process hosts the `VaultAgent` (queue, uploader, command poller, device reporter) and the `CollectorHost` (files, screenshots, usage, notifications) directly. There is no Windows service. Closing the window hides it to the tray, and the workers keep running until you choose **Quit** from the tray.

The shell is WinUI 3 on the Windows App SDK 1.6. It is unpackaged (no MSIX) and self-contained, so the Windows App SDK runtime does not need a separate install. Most of the logic lives in `windows/Ivy.App.Core`, a plain `net8.0` library with xunit tests that also run on macOS: view models, formatting, the activity-feed buffer, status-dot rules, settings binding and the run-at-login rules. This project is the thin Windows-only part: XAML, the tray icon, the registry, the folder dialog and single-instance handling.

> **The fourth-run UI (Fluent redesign) has not been compiled or run yet.** It was written on macOS, where the XAML compiler cannot run. Here is what was checked there:
> - every C# file here was type-checked against the real Windows App SDK 1.6 reference assemblies, with warnings as errors, using stand-ins for the XAML-generated partials (`InitializeComponent`, `x:Name` fields);
> - every XAML file parses as XML, and every `{x:Bind}` path, function binding (`local:Ui.*`), TwoWay target and event handler was turned into C# by a script and compiled in that same type-check, so a misspelt path, a missing setter, a wrong target type or a handler with the wrong signature fails there;
> - every `StaticResource`/`ThemeResource` key is either defined in `App.xaml` or a WinUI built-in (listed by the script and checked by hand);
> - `CollectorHostAdapter.cs` is linked into `Ivy.App.Core.Tests` and tested against the real `CollectorHost`.
>
> What only the XAML compiler and a real run can find is in "Fourth run: UI" at the end.

## Build and run on Windows 11

1. **Install the .NET 8 SDK, 8.0.4xx band.** The repo's `global.json` pins `8.0.425` with `rollForward: latestPatch`.
   ```powershell
   winget install Microsoft.DotNet.SDK.8
   dotnet --list-sdks        # expect 8.0.4xx with patch >= 25
   ```
   - You do not need Visual Studio. `EnableMsixTooling=true` makes the Windows App SDK package supply its own PRI and MSIX build tasks.
   - The XAML compiler runs on .NET Framework 4.7.2, which ships with Windows 11.
   - Git and Node/pnpm are only needed for the `Ivy.Core` integration tests, not for this app.

2. **Build** from the repo root:
   ```powershell
   dotnet build windows/Ivy.Windows.sln -c Release
   ```
   - `Ivy.Windows.sln` contains `Ivy.Core`, `Ivy.Collectors`, `Ivy.App.Core` and `Ivy.App`. Its platforms are `x64` (the default) and `ARM64`.
   - On an ARM64 PC, add `-p:Platform=ARM64`.
   - `windows/Ivy.sln` does not contain this project, by design. It must keep building on macOS.

3. **Find the exe.** It lands here:
   ```
   windows\Ivy.App\bin\x64\Release\net8.0-windows10.0.19041.0\win-x64\Ivy.App.exe
   ```
   (`bin\ARM64\Release\...\win-arm64\` on ARM64.) If the path differs, run `dir /s /b windows\Ivy.App\bin\Ivy.App.exe`.
   - Run it from that folder, or copy the whole folder somewhere stable such as `%LOCALAPPDATA%\Programs\IVY\` first. The folder holds the Windows App SDK runtime DLLs, `resources.pri` and `Assets\ivy.ico`.
   - The run-at-login entry stores the exe path. If you move the folder later, start the exe once from its new place and the entry is re-pointed automatically.

4. **First run: pairing.**
   1. On the Mac dashboard, add a Windows device. The Mac shows a QR code and a copyable pairing string that starts with `IVYPAIR1.`.
   2. Start `Ivy.App.exe`. The window opens on the pairing panel.
   3. Paste the string into the box. Line breaks picked up while copying are ignored. Press **Pair**.
   4. The app fetches the bootstrap from the cmd bucket, generates the device key (stored with DPAPI) and writes the device's public key to the up bucket.
   5. Both fingerprints then appear in monospace: **This device** and **Mac**. Check that each matches the Mac's screen, then press **Continue**. If either differs, do not continue. Unpair on the Mac and start again.
   6. Pairing also registers run at login. You can turn it off under **Startup**.

5. **Pick what to capture.** Under **Indexed folders and drives**, press **Add folder...** and choose folders or whole drives. The files collector starts its initial index straight away. Screenshot folders default to `%USERPROFILE%\Pictures\Screenshots`.

### Where things live

| What | Where |
| --- | --- |
| Queue, `vault-agent.db` (ciphertext and metadata only) | `%LOCALAPPDATA%\IVY\` |
| Device key and R2 tokens (DPAPI, CurrentUser) | `%LOCALAPPDATA%\IVY\keys\` |
| App log (object keys, sizes and errors, never content) | `%LOCALAPPDATA%\IVY\logs\ivy-app.log` (rolls at 5 MB) |
| Crash log | `%LOCALAPPDATA%\IVY\logs\ivy-app-crash.log` |
| Run at login | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `IVY` = `"<exe>" --minimized` |

To reset completely: quit from the tray, delete `%LOCALAPPDATA%\IVY`, delete the `IVY` Run value, and unpair on the Mac.

## Layout

```
windows/
  Ivy.Windows.sln                 Windows-only solution: Ivy.Core, Ivy.Collectors, Ivy.App.Core, Ivy.App
  Ivy.App.Core/                   net8.0, in Ivy.sln, tested on macOS
    Format.cs                     bytes / ages / timestamps / bandwidth parsing
    CollectorStatus.cs            status dot rules (green ok, amber stale > 2 intervals or not running, red error, grey off/paused)
    ActivityFeed.cs               newest-first feed bounded to 500, pause-scroll hold, de-dup by activity id, batch add
    Startup.cs                    Run-key command line rules (IStartupRegistration)
    FileLogger.cs                 tiny ILoggerFactory writing the app log
    Hosting/IAgentView.cs         what the window needs from VaultAgent (+ AgentSnapshot: queue totals, bucket reachability)
    Hosting/VaultAgentView.cs     the real IAgentView over VaultAgent (aggregate SQL, re-attaches to the uploader after pairing)
    Hosting/ICollectorHostView.cs what the window needs from the collector host (CollectorInfo, CollectorSettings, FileImportProgress)
    Hosting/StoredCollectorHostView.cs  fallback host view without live collectors (rows from collector_state, settings in agent_settings)
    BrandIcons.cs                 Telegram/LINE marks from simple-icons (CC0), embedded as Resources/brand-icons.json; initials-tile fallback
    CommandHistory.cs             recent commands from the Mac and their outcomes (Transfers page), from the poller's activity lines
    ConversationProgress.cs       Telegram per-chat progress and the LINE probe summary, parsed from the collectors' detail lines
    PairingErrors.cs              pairing failures as an inline message plus a fix hint
    ViewModels/                   MainViewModel, PairingViewModel, CollectorRowViewModel, SettingsViewModel, StringListViewModel, commands,
                                  NavigationViewModel (NavPages tags, selected page, expanded groups, theme override; persisted),
                                  OverviewViewModel (status card, bucket reachability, InfoBars)
  Ivy.App.Core.Tests/             xunit (includes CollectorHostAdapter.cs from Ivy.App, linked, against the real CollectorHost)
  Ivy.App/                        net8.0-windows10.0.19041.0, WinUI 3, Windows only
    Program.cs                    Main: single instance via AppInstance (second launch redirects and exits)
    App.xaml(.cs)                 composition root: VaultAgent + CollectorHost + window + tray; hide-to-tray; Quit
    MainWindow.xaml(.cs)          Mica window, custom title bar, pairing page, NavigationView shell (keeps it in step with NavigationViewModel)
    Pages/                        one Page per navigation item: Overview, Files, Screenshots, Usage, Notifications, Telegram, LINE,
                                  Transfers, Settings, Activity (cached; the MainViewModel is the navigation parameter)
    Ui.cs                         x:Bind helpers (brushes, InfoBar severity, visibility) and the brand PathIcon/initials-tile builders
    Hosting/CollectorHostAdapter.cs   the only file that knows Ivy.Collectors' API
    Platform/TrayIcon.cs          Shell_NotifyIcon tray icon and native popup menu (Open / Pause / Sync now / Quit)
    Platform/StartupRegistration.cs   HKCU Run key
    Platform/UiServices.cs        DispatcherQueue dispatcher, FolderPicker, AppPaths
    Platform/Win32.cs             P/Invoke declarations
    Assets/ivy.ico                app and tray icon
```

The tray icon is native `Shell_NotifyIcon` rather than H.NotifyIcon. That removes a third-party dependency, keeps the menu working while the window is hidden, and let the code be type-checked on macOS.

## What the window shows

Fourth run (PLAN decision 5, revised): a native Windows 11 app in the style of Microsoft's own inbox apps. One window on **Mica**, light and dark following Windows with a manual override, the system accent colour, Segoe UI Variable through the WinUI type ramp, rounded WinUI controls, 4/8-point spacing, no gradients. Problems show as **InfoBars** at the top of the page they concern; the only dialog is the Unpair confirmation. Cascadia Mono (Consolas fallback) for fingerprints, object keys and timestamps.

- **Title bar**: custom (48 px, drag region) with the app icon and "IVY"; caption buttons are system-drawn and recoloured for the theme. The window title stays `IVY` (the usage collector recognises its own window by it).
- **Pairing page** (full window until paired): a centred card with the pairing-string box and **Pair**. Errors appear inline under the box with a fix hint (expired, already used, wrong device type, not an IVY string, version mismatch, bucket unreachable). After pairing, both fingerprints in monospace and **Continue**.
- **Navigation** (NavigationView, left pane): Overview; Collectors (Files, Screenshots, App usage, Notifications); Conversations (Telegram, LINE, with their brand marks); Transfers; Settings; and Activity in the footer. The pane footer shows "Running · N queued". The selected page and the expanded groups are remembered (`agent_settings` key `app.ui.navigation`).
- **Overview**
  - InfoBars: bucket unreachable or command poll failing (with **Retry now**), collectors that need attention, collector-host and settings errors.
  - Status card: paired-to-Mac fingerprint, this device's fingerprint, last successful upload, last command poll, bucket state (dot and words), queue size, and the **Running/Paused** switch with a sentence saying what it means.
  - Collector tiles (dot, name, status, last capture); each opens its page.
  - Live activity feed (newest first, last 500, **Pause scroll**).
- **Collector pages** (Files, Screenshots, App usage, Notifications): a status card with the on/off switch in its header, the status with its reason, last capture, last upload and the collector's share of the queue; an InfoBar when it is in error or stale. Then that collector's settings:
  - Files: initial index progress, indexed folders and drives (**Add folder...**, **Remove**), exclusions (globs, add/remove; `files.exclusions`), the media policy switches and size caps, and the extension lists in an Expander.
  - Screenshots: the watched folders.
  - App usage: the window-title switch and the title exclusion list.
  - Notifications: the database state line and what it means.
- **Telegram**: status with reason; the passcode box only when Telegram Desktop is locked (stored with DPAPI); per-chat progress (chats complete of total, messages so far) with a progress bar; **Include channels**; the secret-chats-are-phone-only note with the count.
- **LINE**: status with reason; the "always partial from Windows" note; **Run probe** and **Open report** with the probe summary and report path.
- **Transfers**: objects waiting, encrypted size, retrying; **Sync now**; the current upload with per-object progress; the bandwidth cap with **Apply**; recent commands from the Mac (file requests, rescans, collector settings, rejected commands) with their outcome.
- **Settings**: Startup (run at login), Appearance (System / Light / Dark), Network (bandwidth cap), Advanced (data folder and log folder with **Open**, version, **Unpair...** with confirmation). Unpair forgets the device key, tokens and pairing state, stops the uploader, poller and reporter, and returns to the pairing page; the encrypted queue is kept for the next pairing and collectors idle until then.
- **Activity**: the full live feed at window height.
- **Keyboard and accessibility**: everything is reachable with Tab in visual order, WinUI's focus rectangles are unchanged, access keys (press Alt) on navigation items and primary actions (O, L, V, T, S, A in the pane; R run/pause, Y sync now, D add folder, B apply bandwidth, K apply caps, U unpair/unlock, P pair or pause scroll, C continue), and every icon-only or composite button has an `AutomationProperties.Name`. Decorative brand badges are hidden from UI Automation.

## Hang diagnostics

The second Windows run ended with Windows event 1002 (`AppHangB1`) for `Ivy.App.exe` 16 minutes into a session, with nothing in the log. The app now avoids the likely causes and records enough to explain the next one.

What changed (the likely causes):

- **Tray icon on its own thread.** The hidden tray window, its message loop, every `Shell_NotifyIconW` call and the popup menu run on an "IVY tray" thread. Menu commands and left-click go back to the UI thread through its `DispatcherQueue`. The tooltip is pushed to the shell only when its text changes, not every second.
- **No SQLite writes on the UI thread.** Pause/Resume, the collector switches, capture settings, bandwidth and run at login do their work on the thread pool, one at a time and in order. Only the resulting state is set on the UI thread. As a guard, any `VaultDb` write that still runs on the UI thread logs a warning with the write, the caller and the duration.
- **The paired state is cached.** `VaultAgentView` reads it once at startup and again after each pairing attempt. The tray menu, **Sync now** and the window read the cached value, not the DPAPI-protected key files.
- **The usage collector never waits on a window.** The foreground title is read with `SendMessageTimeout(WM_GETTEXT, SMTO_ABORTIFHUNG, 500 ms)`. IVY's own windows are never asked; the app's title (`IVY`) is used for them.
- **The feed cannot stop silently.** If the dispatcher refuses a feed flush, the flag is cleared and a warning is logged. The next event schedules a new flush.

What is recorded (all in `%LOCALAPPDATA%\IVY\logs\ivy-app.log`; timings, counts and identifiers only, never paths, titles or text):

- **Heartbeat, once a minute** (from the watchdog thread, with the last sample the UI thread gave it):
  ```
  2026-10-10T12:01:00.012Z INF Watchdog: heartbeat: ui=alive feed=500 window=visible last_tick=2026-10-10T12:00:59.981Z (0 s ago)
  ```
  `ui=unresponsive` means the line was written during an incident. `window=hidden` means the window is closed to the tray. A `last_tick` that falls behind means the 1 s timer stopped.
- **Hang incident.** The watchdog posts a heartbeat to the UI thread every second. If one is not answered for 5 s, it logs one warning with the UI thread's breadcrumb, which is the entry point it was in and for how long:
  ```
  WRN Watchdog: UI unresponsive since 2026-10-10T12:05:00.004Z (5001 ms); ui: FlushFeed batch=12 (running 5003 ms)
  WRN Watchdog: watchdog: hang dump written (ivy-app-hang-20261010T120505Z.dmp, 48213504 bytes)
  INF Watchdog: UI recovered after 7342 ms
  ```
  `ui: idle` means the UI thread was not in any of the instrumented entry points: `OnTick`, `Apply`, `FlushFeed`, `Settings.Apply`, `ApplyRunning`, `SetCollectorEnabled`, `RunAtLogin`, `ShowWindow`, `Pairing submit`/`result`. Other threads with a breadcrumb (`tray WndProc msg=0x8001`, `tray ShowMenu`) are listed after it.
- **Dump.** One per incident, written by the app about itself with `MiniDumpWriteDump` (thread info and memory-region info, plus thread stacks), to `%LOCALAPPDATA%\IVY\logs\ivy-app-hang-<UTC yyyyMMddTHHmmssZ>.dmp`. Open it in Visual Studio or WinDbg (`!clrstack` and `~*e !clrstack` with SOS) to see the UI thread's stack. The dump holds stack memory, so it stays on this PC. Do not commit it. If the window hangs and no dump appears, use Task Manager, right-click `Ivy.App.exe`, **Create dump file** before closing it.
- **Slow work:** `slow Shell_NotifyIconW modify: 340 ms` (over 100 ms), `slow refresh Snapshot|Statuses|FileImport: N ms` (over 250 ms, thread pool), `slow Apply rows=6|FlushFeed batch=N: N ms` (over 50 ms, UI thread), and `UI thread: VaultDb write VaultDb.SetSetting from <Type.Method> took 3 ms (move it to the thread pool)` (any write on the UI thread; category `UiThreadGuard`).
- **Window and session events:** `window: close requested; hiding to the tray`, `window: shown|hidden`, `window: activation CodeActivated|PointerActivated|Deactivated`, `window: WM_DISPLAYCHANGE 32 bpp 2560x1440`, `window: WM_DPICHANGED dpi 144`, `session: session_lock|session_unlock|remote_connect|... (session N)`.

## First-run checklist (nothing here has been executed)

**Build**

- [ ] `dotnet build windows/Ivy.Windows.sln -c Release` has no errors. The likeliest XAML compile problems, all in `MainWindow.xaml`, are:
  - the static function binding `{x:Bind local:Ui.Brush(StatusColor), Mode=OneWay}` in the collector-row template;
  - `x:DataType="core:FeedEntry"`, a positional record from `Ivy.App.Core`;
  - `UpdateSourceTrigger=PropertyChanged` on the three TwoWay TextBox bindings.

  The fixes are simple: a `Brush`-typed property on the row view model, a plain class, and dropping the trigger.
- [ ] `Ivy.App.exe` is in the folder from step 3, next to `resources.pri`, `Microsoft.WindowsAppRuntime*.dll` and `Assets\ivy.ico`.

**Launch and window**

- [ ] Double-click starts it with no "Windows App Runtime required" prompt (self-contained works). If it fails silently, check `ivy-app-crash.log`.
- [ ] The window opens on the pairing panel:
  - the background is near-black, with 1px borders on the text box and fingerprint box;
  - switches, progress bars and buttons use green. If the system accent still shows, the `SystemAccentColor*` overrides in `App.xaml` are being ignored. That is cosmetic.

**Tray**

- [ ] A green square icon is in the notification area. It may first appear in the overflow; pin it.
  - Left-click opens the window.
  - Right-click shows Open / Pause / Sync now / Quit. Pause and Sync now are greyed out before pairing.
  - The menu closes when you click elsewhere.
  - The tooltip reads "IVY: Running, N queued".
- [ ] Clicking the window's X hides it. `Ivy.App.exe` is still in Task Manager and the tray icon stays.
- [ ] Restarting Explorer (Task Manager, Windows Explorer, Restart) brings the tray icon back.
- [ ] The tray icon is crisp at 150% display scale.

**Single instance**

- [ ] Launch `Ivy.App.exe` again while it runs. The existing window comes to the front, no second tray icon appears, and the second process exits.

**Pairing**

- [ ] Paste the Mac's string and press Pair. The status line shows progress, then both fingerprints in Consolas. They match the Mac's screen. Continue switches to the status window.
- [ ] A bad, expired or used string shows "Pairing failed: <reason>", and the box stays editable.

**Run at login**

- [ ] After pairing, `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v IVY` shows `"<exe path>" --minimized`.
- [ ] Turning **Run at login** off removes the value, and turning it on adds it back.
- [ ] Sign out and back in. IVY starts in the tray with no window, and the collectors and uploads run (the tray tooltip count moves). An unpaired app always shows its window.

**Collectors**

- [ ] All six rows appear (files, screenshots, app usage, notifications, LINE, Telegram).
- [ ] Usage turns green within about 30 s, showing the time of its last capture.
- [ ] Notifications turns green: on current Windows 11 builds the notification database is readable by a standard user. Red with a reason means the snapshot copy failed.
- [ ] Turning a row off makes it grey and stops it. Restart the app and it is still off.

**Folders and index**

- [ ] **Add folder...** opens the system folder dialog. The chosen path appears, and the files row detail shows "scanning ...".
- [ ] **Initial file index** counts up and **bytes queued** grows. The estimate is "?" on the very first scan, because the files collector does not pre-count.
- [ ] Removing a folder works.
- [ ] If IVY runs elevated, the folder dialog fails. You see an error line instead of a crash.

**Activity feed**

- [ ] Captured, encrypted, queued, upload_started and uploaded lines stream in, newest first.
- [ ] **Pause scroll** freezes the list and shows "N new while paused". Unticking it inserts them.
- [ ] The list never exceeds 500 lines. The UI stays responsive during the initial index, when thousands of lines a minute arrive.

**Queue**

- [ ] Pending objects and bytes rise and fall.
- [ ] A file larger than 16 MiB shows the current upload with a progress bar.
- [ ] Setting a bandwidth cap of `256` and pressing Apply shows "current: 256.0 KB/s" and visibly slows large uploads.
- [ ] **Sync now** shows "last sync now: HH:mm:ss ok".

**Footer**

- [ ] **up bucket: last put** updates within seconds of an upload.
- [ ] **cmd bucket: last list** is never older than about 2 minutes.
- [ ] Unplugging the network shows the failure line on the up bucket and an error on the cmd bucket. Both clear after reconnecting.
- [ ] The fingerprints and "IVY for Windows 0.1.0" are shown.

**Pause**

- [ ] Running to Paused stops uploads (the queue grows), every collector row shows "paused", and the tray menu says Resume.
- [ ] Quit and restart: it is still Paused.

**Settings**

- [ ] Turning window-title capture off, or adding an exclusion such as `keepass.exe`, adds a `config` line to the feed. The setting survives a restart.

**Media policy (PLAN decision 8)**

- [ ] The new panel shows both switches on, caps 25 and 10, and the default extension lists. `0`, `abc` or `5000` in a cap with **Apply** shows the validation line and changes nothing.
- [ ] Index a folder with a few photos (jpg, png, HEIC from a phone), a PDF, a .docx, a .txt, a .zip and a photo over 25 MB. The feed shows `file_meta` captures first, then `blob … photo` / `blob … document` lines for the eligible files only. The zip and the large photo get no blob. On the Mac each eligible file becomes "cached", the photos appear under Photos with OCR text, and the PDF and .txt are found by words inside them.
- [ ] The files row detail shows "originals: N to upload" during the first upload, and the line goes away when it finishes. Pending records (new files) still upload while a big photo library is in the bulk lane. A newly saved .txt reaches the Mac before the remaining photos.
- [ ] Copy a photo to another indexed folder, and move another. No new `photo` blob appears. Edit the .txt and save it: a new `document` blob appears.
- [ ] A screenshot (Win+PrtScn) uploads once, as `screenshot`, not also as `photo`. A photo in a subfolder of Screenshots uploads as `photo`.
- [ ] A document open in Word, or an Outlook `.pst` if it is under a root and in the list, is not uploaded while locked. An `original_failed` line appears with no path in it, and the detail shows "1 unreadable". After closing the file, **Sync now** does not retry it, but a rescan does: change a setting or send a `rescan` from the Mac, and a `document` blob follows.
- [ ] Turning **Upload images** off stops new photo blobs, and photos already counted wait. Turning it back on resumes them. Raising the image cap to 100 and pressing Apply starts a rescan ("scanning (settings_changed)"), and the large photo then uploads without re-hashing the folder. The rescan finishes much faster than the first index.
- [ ] A cap of `256` KB/s with a few hundred MB of photos: queue bytes stop growing at about 1 GB of originals waiting ("originals waiting for the uploader" in the detail), and the disk does not fill. Pause, then quit and restart: the counts are the same afterwards, and uploads resume where they stopped.
- [ ] A `collector_config` from the Mac with `{"documentCapMB": 2, "documentExtensions": ["pdf","txt"]}` takes effect at once: a `config` line appears and the rescan starts. The panel shows the new values after the app restarts (it loads settings at start), and they survive the restart.
- [ ] If files in a OneDrive folder are cloud-only, check whether uploading their originals downloads them. If it does, decide whether to exclude OneDrive or accept it.

**Conversation capture (Telegram and LINE) — third run**

This is the first run with the real Telegram adapter wired (`WTelegramClientAdapter` over the WTelegramClient package) and with `TelegramApiCredentials.DesktopDefault` set to Telegram Desktop's own public `api_id`/`api_hash`. Telegram Desktop must already be signed in on this PC. See `windows/README.md` (Telegram section) for what each state means.

Telegram:

- [ ] The Telegram row and the **Conversation capture → Telegram** panel show a status line. With the credentials unset it reads **not configured**; once set it moves to connecting, then **ok** with per-chat progress ("chats done/total, N messages").
- [ ] If Telegram Desktop has a **local passcode**: the row reads **needs passcode** and the passcode box appears. Type it and press **Apply**. The feed shows a `config`/reconnect line, `telegram-passcode.bin` exists under `%LOCALAPPDATA%\IVY\keys\`, and the row clears to **ok** on the next tick. The passcode is never in the logs or the queue.
- [ ] In Telegram (phone or desktop): **Settings → Devices / Active sessions** shows **no new session** for IVY — it rides the existing Telegram Desktop session. A new/unknown session means the api_id/api_hash or device string is wrong; stop and fix before capturing.
- [ ] Backfill progress climbs across ticks (chats done/total and message count rise); the import bar reflects it. Edits and deletions picked up live show as updated/`deleted_at_source` entries.
- [ ] Toggle **Include channels** off: broadcast channels drop out of capture; groups and DMs keep going. Toggle it back on and they return. The setting survives a restart.
- [ ] A secret chat is reported **phone-only** in the detail and produces **no** records.
- [ ] Attachments: an image and a PDF under the caps upload as `photo`/`document` blobs; a video stays metadata-only until a `file_request` from the (fake) Mac fetches it as `attachment`.
- [ ] On the fake Mac (`tools/fake-mac`), pick one Telegram chat and confirm its `message_batch` records decrypt and the messages read correctly, with `sourceSession = windows:telegram-desktop` and `coverage = complete`.
- [ ] `FLOOD_WAIT` (if hit during the first big backfill) shows "flood-wait until T" and the row resumes on its own after that time.

LINE:

- [ ] Press **Run probe** in the LINE panel. The detail shows "Probe complete: N files, M databases, K readable" and the report path appears. `%LOCALAPPDATA%\IVY\line-probe-<version>.json` exists.
- [ ] Press **Open report**: the JSON opens in the default app. Its summary matches the detail line, and it lists the LINE data locations with per-file kinds (no message content).
- [ ] The row's state is one of the honest states (`ok partial`, `probe needed`, `store not found`, `unverified map`, `encrypted store`, `LINE not installed`) with its reason — nothing is captured unless the map verifies, and Windows coverage is always `partial`.

**Hang diagnostics — third run**

- [ ] Run for 30 minutes with the window open and the feed active (Telegram backfill or an indexed folder being scanned). No hang. Heartbeat lines are present in `ivy-app.log`, one a minute, with `ui=alive`, a growing `feed=` count up to 500, `window=visible` and a current `last_tick`.
- [ ] No `UI thread: VaultDb write` warnings during the run. Toggle Pause/Resume, a collector switch, a capture setting, the bandwidth cap and run at login once each, then check again.
- [ ] Hover the tray icon: the tooltip shows the current state and queue count. Right-click: the menu opens immediately even while the feed is busy, and Pause, Sync now and Open work.
- [ ] Lock and unlock the PC (Win+L) and move the window to another monitor or change scaling: `session: session_lock`/`session_unlock`, `window: WM_DPICHANGED` or `WM_DISPLAYCHANGE` lines appear. Close the window to the tray and reopen it: `window: hidden`/`shown` lines appear.
- [ ] If the UI does freeze: wait 10 s, then check that `UI unresponsive since … ui: <breadcrumb>` and `hang dump written (ivy-app-hang-….dmp)` are in the log and the .dmp is in `%LOCALAPPDATA%\IVY\logs`. Note the breadcrumb line and the dump path in the report, and keep the dump on the PC.

**Quit**

- [ ] Tray, Quit: the window and icon disappear, and the process exits within 15 s.
- [ ] Start again: the feed shows a `reconciled` line, and pending uploads continue.

**Privacy**

- [ ] `%LOCALAPPDATA%\IVY\logs\*.log` contains object keys, sizes and errors only, with no file contents or window titles.

## Fourth run: UI (Fluent redesign; nothing here has been executed)

The earlier checklists still apply to behaviour; this one covers the new window. Build with `dotnet build windows/Ivy.Windows.sln -c Release` first.

**Build**

- [ ] No XAML compile errors. The likeliest, if any, and their fixes:
  - `x:DataType="core:FeedEntry"` and `core:CommandItem` in DataTemplates (`FeedEntry` is a positional record): make it a plain class if the compiler objects.
  - `ContentControl Content="{x:Bind local:Ui.BrandBadge(ViewModel.TelegramBrand, 40)}"` on the Telegram and LINE pages: if a function binding returning an element is refused, set the badge in the page's code-behind after `InitializeComponent()` instead.
  - `ToolTipService.ToolTip="{x:Bind StatusReason, Mode=OneWay}"` on the Overview tiles: drop the tooltip if attached-property x:Bind is refused there.
  - `UpdateSourceTrigger=PropertyChanged` on TwoWay TextBox bindings: drop the trigger (Apply buttons still read the text).
  - `ListBoxStyle` in `App.xaml` has no `BasedOn`; if the folder/extension lists lose their Fluent look, add `BasedOn="{StaticResource DefaultListViewStyle}"`.
- [ ] The concurrent Windows verification branch's compile fixes in `MainWindow.xaml(.cs)` are superseded by this rewrite; carry over any fix that still applies (for example to `App.xaml.cs` or the tray).

**Every page renders**

- [ ] Unpaired start: only the pairing card shows, centred, on Mica. Tab reaches the box, **Pair**, then (after pairing) **Continue**; Alt shows the P and C access keys.
- [ ] Paste a bad string, press Pair: a red line under the box says what is wrong and a grey line says how to fix it; no dialog. Try an expired string, a used string and random text: each gives its own message. Pull the network cable and pair: "Could not reach the IVY bucket."
- [ ] Pair for real: both fingerprints appear in Cascadia Mono; Continue opens the navigation shell on Overview.
- [ ] Overview, Files, Screenshots, App usage, Notifications, Telegram, LINE, Transfers, Settings and Activity each open from the pane, with a title, no clipped text at 1200 x 840 and at 150% scaling, and no horizontal scroll bar.
- [ ] Collector tiles on Overview show a dot, the name, status and last capture; clicking a tile opens that collector's page and selects it in the pane.
- [ ] Telegram and LINE show their brand marks (blue plane, green LINE bubble) in the pane and as the page badge, crisp at 100% and 150%.

**Mica and theme**

- [ ] The window background is Mica (the desktop wallpaper tints it); the content area is the slightly raised layer with a rounded top-left corner, like Windows Settings.
- [ ] Windows Settings > Personalization > Colors, switch Light/Dark: IVY follows live, including the caption buttons.
- [ ] Settings > Appearance > Light and > Dark override it at once (caption buttons too) and survive a restart; "Use system setting" follows Windows again.
- [ ] Change the Windows accent colour: switches, the Pair/Sync/Run probe buttons, the progress bars and the feed's event column use it. No green from the old palette anywhere.

**NavigationView groups**

- [ ] Collectors and Conversations expand and collapse by click and by keyboard (arrow keys, Enter); clicking a group header does not change the page.
- [ ] Collapse Conversations, select Files, quit from the tray and start again: IVY opens on Files with Conversations still collapsed (`agent_settings` key `app.ui.navigation`).
- [ ] Selecting a page inside a collapsed group (for example from an Overview tile) expands that group.

**All actions still work** (same behaviour as before, new places)

- [ ] Overview: Running/Paused switch pauses capture and uploads (tray says Resume; tiles say Paused); the bucket InfoBar appears with the network unplugged and **Retry now** runs Sync now; it disappears after reconnecting.
- [ ] Files: Add folder (folder dialog), Remove, exclusions add (also with Enter) and remove (`*.iso` added there stops new ISOs being indexed), Upload images/documents switches, size caps with Apply (bad value shows the hint), extension lists in the Expander.
- [ ] Screenshots: add/remove folders. App usage: title switch and exclusions. Notifications: the database line shows "last notification id N".
- [ ] Each collector page's switch turns the collector off (grey dot, "Off", reason "Turned off") and on again; an error shows an InfoBar with the reason.
- [ ] Telegram: with a local passcode set in Telegram Desktop the warning InfoBar shows the passcode box; Unlock (or Enter) applies it and the box clears. Progress shows "N of M chats complete" with a bar and "messages so far". Include channels toggles.
- [ ] LINE: Run probe updates the summary and report path; Open report opens the JSON.
- [ ] Transfers: pending numbers move; a large upload shows the progress bar; bandwidth Apply shows "current: 256.0 KB/s"; Sync now shows "last sync now: ... ok"; a file request from the (fake) Mac appears under recent commands as "File request" with "Uploaded to the Mac" (or "File not found").
- [ ] Settings: Run at login toggles the Run key; data and log folder **Open** buttons open Explorer there; the version reads "IVY for Windows 0.1.0".
- [ ] Settings > **Unpair...**: the dialog defaults to Cancel; Unpair returns to the pairing card, the tray menu greys out Pause and Sync now, `reg`/files: `%LOCALAPPDATA%\IVY\keys` no longer holds the pairing, the feed shows `unpaired`. Pair again with a fresh string: capture and uploads resume, including what was queued before.
- [ ] Activity: the full-height feed; Pause scroll here and on Overview stay in step.

**Keyboard and accessibility**

- [ ] Tab order follows the visual order on every page; the focus rectangle is always visible; Alt shows access keys on the pane items and primary buttons.
- [ ] Narrator reads every icon button and switch by name (Add folder, Remove selected folder, Pause scroll, Capture and upload, Files collector...), and skips the decorative brand badges.
- [ ] Accessibility Insights FastPass on Overview, Files and Settings: no failures.

**Tray still works**

- [ ] Left-click opens the window on the last page; right-click shows Open / Pause / Sync now / Quit; the tooltip reads "IVY: Running, N queued"; closing the window hides it to the tray; Quit exits within 15 s.
