# Prompt for the Windows Claude Code session

Paste everything below the line into Claude Code on the Windows 11 desktop, started inside a fresh clone of https://github.com/shanmukhram/IVY-WMA.git.

---

You are doing the first real build and run of the IVY Windows companion app. Everything in this repo was written and unit-tested on a Mac; the WinUI 3 app itself (windows/Ivy.App) has never been compiled or executed. Your job is to get it building, running, paired, and capturing on this PC, fix what breaks, and report honestly.

Read first: docs/PRD.md Part 1, docs/PLAN.md, windows/README.md, windows/Ivy.App/README.md (build steps and the first-run checklist), and tools/fake-mac/README.md (a stand-in for the Mac so you can test pairing and retrieval locally).

Rules:
- Work on a branch `windows-first-run`. Commit as you go with clear messages and push the branch. Do not force-push or rewrite main.
- Fix compile and runtime errors conservatively: keep the existing design, view models, and interfaces; do not redesign or restyle anything. The UI is meant to be minimal and functional. If a fix needs an interface change, do the smallest one and say so in the report.
- Never weaken anything in windows/Ivy.Core/Protocol, the key store, the queue, or the token separation to make something pass. If a test there fails on Windows, report it rather than editing the test.
- No plaintext may ever be written to disk or the bucket by the app. If you see any, stop and report.

Steps:
1. Toolchain: install the .NET 8 SDK (8.0.4xx) and Node 22+ with pnpm (`npm i -g pnpm`) if missing. `dotnet --list-sdks`, `node -v`, `pnpm -v`. Then `pnpm install` at the repo root.
2. Cross-platform tests on Windows: `dotnet test windows/Ivy.sln` and `pnpm -r test`. Record the counts (expected: 69 + 61 + 99 passed with 1 skipped; 13 + 54 + 13 + 12). Investigate any failure; Windows-specific path or file-locking differences are the likely causes.
3. Build the app: `dotnet build windows/Ivy.Windows.sln -c Release` (add `-p:Platform=ARM64` on an ARM PC). Fix XAML and compile errors until it builds. The Ivy.App README lists the three most likely XAML problems and their fixes.
4. Smoke test with the fake Mac, two terminals, following tools/fake-mac/README.md: terminal A runs `serve`, which prints a pairing string; terminal B is for `request-file`, `rescan`, `config`, `status`, and `audit`. Launch `Ivy.App.exe`, paste the pairing string, pair, compare fingerprints with what `serve` printed, continue.
5. Walk the whole first-run checklist in windows/Ivy.App/README.md. For capture: add a small test folder with a few files, a PDF and an image as an indexed root; take a screenshot with Win+Shift+S or Win+PrtScn; switch between a few apps for a couple of minutes; trigger a Windows notification. Confirm each appears in the app's activity feed and, decrypted, in the fake Mac's output. Then `request-file` one of the test files and confirm the fake Mac writes it to `received/` with the correct SHA-256. Run `audit` and confirm zero plaintext hits. Quit the app mid-upload with a large file queued, relaunch, and confirm the upload resumes.
6. Verify the Windows-only code paths that could not run on the Mac and record the result for each: DPAPI key storage (keys folder contents are not readable plaintext), USN journal (does it open with and without admin, and does the collector fall back to FileSystemWatcher honestly), foreground-window probe including a Store app, the notification database reader (is wpndatabase.db readable, does the toast XML match the parser), tray icon behaviour after an Explorer restart, run-at-login entry, single-instance.
7. Write docs/reports/windows-first-run.md: environment, what built first try vs. what you fixed (with commit hashes), checklist results item by item, everything that failed or could not be verified, and plaintext audit result. Commit and push the branch, then tell me the branch name and a summary.
