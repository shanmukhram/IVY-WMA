# Prompt for the Windows Claude Code session, third run

Paste everything below the line into Claude Code on the Windows 11 desktop, inside the existing clone.

---

I'm building IVY, a personal backup and search app for my own files, screenshots, app usage, and chat history. The Windows companion (C#, .NET 8, WinUI 3) uploads my own records, encrypted, to my own storage so my Mac can index them. You've done two runs on this PC (docs/reports/windows-first-run.md and windows-second-run.md). Since then main gained: hang hardening and diagnostics for the app window, a Telegram collector that reuses the Telegram Desktop session I'm already signed into (no new login), and a LINE collector with a probe. This session: rebuild, verify those, and run the remaining gate items.

Setup:

git checkout main
git pull
pnpm install

Read: windows/README.md (Telegram and LINE sections, hang diagnostics), windows/Ivy.App/README.md (the third-run checklist and "Hang diagnostics"), docs/GATE-G1.md (updated: no tokens file needed, `skip` works at any prompt), docs/reports/gate-g1-2026-10-10-partial.md (items a and b already passed).

Ground rules as before: branch `windows-third-run`, commit as you go, push the branch, never force-push or change main; small conservative fixes; don't restyle; don't change windows/Ivy.Core protocol, queue, or storage code to make a test pass; report instead.

Part 1, rebuild and verify:
1. `dotnet test windows/Ivy.sln` and `pnpm -r test`. Expected .NET counts are in the latest commit message on main; all JS packages should now pass on Windows too (they were made platform-neutral). Investigate any failure.
2. `dotnet build windows/Ivy.Windows.sln -c Release`. Fix compile errors in the new "Conversation capture" panel and the tray/watchdog code if any; these were type-checked by hand on a Mac but never compiled.
3. Telegram, one PC-only step: `TelegramApiCredentials.DesktopDefault` in windows/Ivy.Collectors/Telegram must hold Telegram Desktop's public api_id and api_hash. They are published in the open-source Telegram Desktop repository (tdesktop, `Telegram/SourceFiles/config.h` or the build docs); look them up, fill them in, and note the source in the commit.
4. Start the app (it is still paired to the real Mac from the last run; keep that pairing) and walk the third-run checklist in windows/Ivy.App/README.md: Telegram row goes from "not configured" to ok with per-chat progress, passcode flow if a local passcode is set, Telegram's own Active Sessions list shows no new session, backfill climbs, a chat's messages decrypt on the Mac side (I'll check the Mac dashboard's Conversations view when you tell me to), include-channels toggle, secret chats phone-only, image/PDF attachments uploaded, video metadata-only. LINE row: Run probe produces `%LOCALAPPDATA%\IVY\line-probe-<version>.json` with the summary, Open report works. Commit the probe report's JSON into docs/reports/line-probe-<version>.json (it contains file names, sizes, and table/column names only, no message content; check that before committing).
5. Hang diagnostics: keep the window open with the feed active for 30 minutes while Telegram backfills; confirm heartbeat lines appear every minute in ivy-app.log and no hang occurs. If the UI freezes, the watchdog writes a dump to %LOCALAPPDATA%\IVY\logs; note its path and the breadcrumb line in the report.
6. Write docs/reports/windows-third-run.md with results item by item, commit, push.

Part 2, gate items c and d: the Mac side runs on my Mac; I'll relay prompts. Be ready to: run the marker-file PowerShell line the gate prints (it now uses the Desktop IVY-G1 folder), tell me when to restart the PC, and after the restart confirm IVY came back from the tray and resumed the upload. Add a Part 2 section to the report afterwards, commit, push, and tell me the branch name.
