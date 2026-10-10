# Prompt for the Windows Claude Code session, second run

Paste everything below the line into Claude Code on the Windows 11 desktop, inside the existing clone of the repo.

---

I'm building IVY, a personal backup and search app for my own files, screenshots, and app usage. The Windows companion (C#, .NET 8, WinUI 3) in this repo uploads my own records to my own storage so my Mac can index them. You built and tested it on this PC earlier (see docs/reports/windows-first-run.md). Since then the main branch gained a wider media policy and a few protocol additions, and the Mac side now exists for real. This session has three jobs: rebuild and verify the new Windows changes, prepare this PC for the gate G1 run, and help me through the PC-side steps of that run.

Setup:

git checkout main
git pull
pnpm install

Read: docs/PLAN.md (decisions 6 and 8), windows/README.md (the media policy section), windows/Ivy.App/README.md (the checklist has new items), and docs/GATE-G1.md (the whole runbook; the Mac side runs on my Mac, you do the PC side).

Ground rules, same as before: work on a branch named windows-second-run, commit as you go, push the branch, never force-push or change main. Keep fixes small and conservative; don't restyle the UI. Don't change the protocol, queue, or storage code in windows/Ivy.Core to make a test pass; report instead.

Part 1, rebuild and verify:
1. dotnet test windows/Ivy.sln and pnpm -r test. Expected: 72 + 73 + 103 passed with 1 skipped on the .NET side; all JS packages green. Investigate any failure.
2. dotnet build windows/Ivy.Windows.sln -c Release. Fix compile errors in the new settings panel if any.
3. Start the fake Mac (tools/fake-mac/README.md) and the app, pair against it, and verify the new media policy items in the Ivy.App README checklist: an image and a PDF placed in an indexed folder upload automatically as photo and document; a file over the cap does not; a screenshot in the Screenshots folder uploads once only; the two toggles and two caps in the settings panel work and persist; a settings change triggers one rescan; the fake Mac's audit shows zero hits. Also re-check the two things left unverified last time if they are quick: a bad or expired pairing string is refused with a clear message, and the app behaves at 150% display scaling if this PC can switch to it.
4. Commit and push, and write docs/reports/windows-second-run.md with results item by item.

Part 2, prepare for gate G1 (docs/GATE-G1.md section 1, "PC"):
1. Quit IVY from the tray, delete %LOCALAPPDATA%\IVY, delete the IVY value under HKCU\Software\Microsoft\Windows\CurrentVersion\Run, so the PC is unpaired and fresh.
2. Create %USERPROFILE%\Documents\IVY-G1 with a PDF of at least 50 MB in it, using the PowerShell snippet in the runbook, and print its SHA-256 with Get-FileHash. Keep the document upload cap at its default 10 MB so this file stays on the PC until the Mac requests it.
3. Build the Release app again and leave it ready to start, but do not pair yet. Tell me the full path of the PDF and its hash.

Part 3, during the gate run: I'll run the gate on my Mac and relay each prompt to you. For each one, do the PC-side action the runbook describes (start the app, confirm what the window shows, add the indexed folder, run the PowerShell line that creates the marker files, and so on) and tell me what you see. The only things you can't do are switch the PC to my phone's hotspot and restart the PC; tell me when to do those. After the run, add a section to docs/reports/windows-second-run.md with what happened on the PC side, commit, and push.
