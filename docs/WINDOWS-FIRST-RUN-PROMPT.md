# Prompt for the Windows Claude Code session

Paste everything below the line into Claude Code on the Windows 11 desktop. It can be started in any folder; the prompt tells it to clone the repo.

---

I'm building IVY, a personal backup and search app for my own files, screenshots, and app usage. It has a Windows companion app written in C# (.NET 8, WinUI 3) that uploads my own records to my own storage so my Mac can index them. The repo is https://github.com/shanmukhram/IVY-WMA.git. Clone it and work inside the clone:

git clone https://github.com/shanmukhram/IVY-WMA.git
cd IVY-WMA

The code was written and unit-tested on a Mac, so the WinUI 3 app in windows/Ivy.App has never been compiled or run. Please get it building and running on this PC, fix whatever breaks, and write up what you found.

Read first: windows/README.md, windows/Ivy.App/README.md (build steps and a first-run checklist), tools/fake-mac/README.md (a local stand-in for the Mac side so the app can be paired and tested on this PC alone), and docs/PLAN.md.

Ground rules:
- Work on a branch named windows-first-run. Commit as you go and push the branch. Don't force-push or change main.
- Keep fixes small and conservative: keep the existing design, view models, and interfaces, and don't restyle the UI; it's meant to be plain and functional. If a fix needs an interface change, make the smallest one and mention it in the report.
- Don't change the protocol, queue, or storage code in windows/Ivy.Core to make a test pass. If one of those tests fails on Windows, note it in the report instead.

Steps:
1. Toolchain: install the .NET 8 SDK (8.0.4xx) and Node 22+ with pnpm (npm i -g pnpm) if missing. Check dotnet --list-sdks, node -v, pnpm -v. Then run pnpm install at the repo root.
2. Run the cross-platform tests on Windows: dotnet test windows/Ivy.sln and pnpm -r test. Record the counts (expected 69 + 61 + 99 passed with 1 skipped, and 13 + 54 + 13 + 12). Look into any failure; Windows path or file-locking differences are the likely causes.
3. Build the app: dotnet build windows/Ivy.Windows.sln -c Release (add -p:Platform=ARM64 on an ARM PC). Fix XAML and compile errors until it builds. The Ivy.App README lists the three most likely XAML issues and their fixes.
4. Pair and smoke test using the fake Mac, in two terminals, as described in tools/fake-mac/README.md: terminal A runs serve and prints a pairing string; terminal B is for request-file, rescan, config, status, and audit. Launch Ivy.App.exe, paste the pairing string, pair, confirm the fingerprints shown match the ones serve printed, and continue.
5. Walk through the first-run checklist in windows/Ivy.App/README.md. For capture: add a small test folder with a few files, a PDF, and an image as an indexed root; take a screenshot with Win+Shift+S; switch between a few apps for a couple of minutes; trigger a normal Windows notification. Confirm each shows up in the app's activity feed and in the fake Mac's output. Then use request-file on one of the test files and confirm the fake Mac saves it to received/ with a matching SHA-256. Run the audit command and note the result. Finally, quit the app while a large file is still uploading, relaunch, and confirm the upload resumes where it left off.
6. For each Windows-only component that could not run on the Mac, note whether it works here: the DPAPI-backed key store, the USN journal file watcher (with and without admin, and whether it falls back to FileSystemWatcher), the foreground app sampler (including a Store app), the Windows notification reader, the tray icon after an Explorer restart, the run-at-login entry, and single-instance launch.
7. Write docs/reports/windows-first-run.md: environment, what built on the first try versus what you fixed (with commit hashes), the checklist results item by item, anything that failed or could not be verified, and the audit result. Commit and push the branch, then tell me the branch name and a short summary.
