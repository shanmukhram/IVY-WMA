# IVY Windows app: `Ivy.App`

The visible Windows companion (PRD Part 1 "App UI", WP1 to WP3, WU5; PLAN task 1.8). It is one process with a window and a tray icon. That process hosts the `VaultAgent` (queue, uploader, command poller, device reporter) and the `CollectorHost` (files, screenshots, usage, notifications) directly. There is no Windows service. Closing the window hides it to the tray, and the workers keep running until you choose **Quit** from the tray.

The shell is WinUI 3 on the Windows App SDK 1.6. It is unpackaged (no MSIX) and self-contained, so the Windows App SDK runtime does not need a separate install. Most of the logic lives in `windows/Ivy.App.Core`, a plain `net8.0` library with xunit tests that also run on macOS: view models, formatting, the activity-feed buffer, status-dot rules, settings binding and the run-at-login rules. This project is the thin Windows-only part: XAML, the tray icon, the registry, the folder dialog and single-instance handling.

> **Nothing in this project has been compiled or run yet.** It was written on macOS, where the XAML compiler cannot run. Here is what was checked there:
> - every C# file here was type-checked against the real Windows App SDK 1.6 reference assemblies, with warnings as errors, using stand-ins for the XAML-generated partials;
> - `dotnet restore` of this project succeeds;
> - `CollectorHostAdapter.cs` is linked into `Ivy.App.Core.Tests` and tested against the real `CollectorHost`.
>
> The XAML was reviewed by hand only. Use the checklist at the end on the first Windows build.

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
    ViewModels/                   MainViewModel, PairingViewModel, CollectorRowViewModel, SettingsViewModel, StringListViewModel, commands
  Ivy.App.Core.Tests/             xunit (includes CollectorHostAdapter.cs from Ivy.App, linked, against the real CollectorHost)
  Ivy.App/                        net8.0-windows10.0.19041.0, WinUI 3, Windows only
    Program.cs                    Main: single instance via AppInstance (second launch redirects and exits)
    App.xaml(.cs)                 composition root: VaultAgent + CollectorHost + window + tray; hide-to-tray; Quit
    MainWindow.xaml(.cs)          pairing panel and status window
    Ui.cs                         x:Bind helper (status colour to brush)
    Hosting/CollectorHostAdapter.cs   the only file that knows Ivy.Collectors' API
    Platform/TrayIcon.cs          Shell_NotifyIcon tray icon and native popup menu (Open / Pause / Sync now / Quit)
    Platform/StartupRegistration.cs   HKCU Run key
    Platform/UiServices.cs        DispatcherQueue dispatcher, FolderPicker, AppPaths
    Platform/Win32.cs             P/Invoke declarations
    Assets/ivy.ico                app and tray icon
```

The tray icon is native `Shell_NotifyIcon` rather than H.NotifyIcon. That removes a third-party dependency, keeps the menu working while the window is hidden, and let the code be type-checked on macOS.

## What the window shows

The design is deliberately plain (PLAN decision 5): dark background, 1px borders, one green accent, and Consolas for timestamps, keys and fingerprints.

- **Header**
  - **Running/Paused** switch. It pauses both capture (every collector) and uploads. The uploader persists the pause, and capture is re-synced to it on start.
  - Error lines from the collector host or from settings, if any.
- **Collectors**: one row each for files, screenshots, app usage, notifications, LINE and Telegram. Each row has:
  - an on/off switch;
  - last capture: the newer of the collector's own time and the last `queued` entry in the activity log;
  - last upload: the last `uploaded` entry for that collector;
  - queue depth and bytes;
  - a status dot and text, plus the collector's detail line (scan progress, fallbacks).
- **Conversation capture** (Telegram and LINE): each shows the collector's own status/detail line (per-chat progress, honest states). Telegram: an **Include channels** toggle (groups and DMs are always captured), and — only when the row reports **needs passcode** — a passcode box and **Apply** that stores the Telegram Desktop local passcode via DPAPI and reconnects. LINE: **Run probe** (one-shot) and **Open report** (opens the probe JSON in the default app via ShellExecute), with the report path shown.
- **Initial file index**: files scanned / estimated, and bytes queued by the files collector.
- **Upload queue**
  - pending objects and bytes, and the retrying count;
  - the current upload with per-object progress;
  - the bandwidth cap (KB/s, 0 = unlimited) with **Apply**;
  - **Sync now**: poll commands, send a device report, drain the queue.
- **Folder lists**: indexed folders and drives (folder dialog, add/remove) and screenshot folders.
- **Originals uploaded from indexed folders** (PLAN decision 8): **Upload images** and **Upload documents** switches, the two size caps (MB) with **Apply**, and the image and document extension lists (add/remove, entered without the dot).
- **App usage**: the window-title capture switch and the title exclusion list.
- **Startup**: the run-at-login switch.
- **Activity feed** (right-hand side)
  - every `activity_log` entry plus "upload_started" from the uploader, newest first, last 500;
  - **Pause scroll** freezes the list and counts what arrived meanwhile.
- **Footer**
  - **up bucket**: the last successful put, and the last failure if it is newer;
  - **cmd bucket**: the last successful list and the last error;
  - the device and Mac fingerprints;
  - the app version.

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

**Quit**

- [ ] Tray, Quit: the window and icon disappear, and the process exits within 15 s.
- [ ] Start again: the feed shows a `reconciled` line, and pending uploads continue.

**Privacy**

- [ ] `%LOCALAPPDATA%\IVY\logs\*.log` contains object keys, sizes and errors only, with no file contents or window titles.
