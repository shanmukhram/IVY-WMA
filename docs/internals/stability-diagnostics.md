# Stability diagnostics (moved from windows/Ivy.App/README.md)

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


# Third-run checklist, original wording

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

