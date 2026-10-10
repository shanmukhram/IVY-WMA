# Phase-wise prompts for IVY

Ready-to-paste prompts for every phase of docs/PRD.md, written to the rules in docs/PROMPTSKILL.md (point at repo files, keep sensitive mechanics out of the prompt). Two kinds:

- **Device prompts**: paste into the Claude Code session on the PC or the phone. These are the ones the safety classifier reads cold, so they are deliberately plain.
- **Mac prompts**: what to tell the orchestrator session on the Mac to start or continue a phase.

Status as of Oct 10, 2026: Phase 1 Windows runs 1 and 2 done; run 3 (Telegram, LINE probe, gate c and d) in progress; Mac dashboard built and redesigned; Android not started.

---

## Phase 1 — Windows to Mac over R2 (PRD Part 1, gate G1)

### Windows run 3 (current): collectors, stability, gate c and d

```
Continuing IVY, my personal backup and search app (C#, .NET 8, WinUI 3 companion on this PC). You've done two runs here already (docs/reports/windows-first-run.md and windows-second-run.md). Main now has stability fixes for the app window plus two new chat collectors, Telegram and LINE. This session rebuilds, verifies them, and finishes the remaining gate checks.

git checkout main
git pull
pnpm install

Read windows/README.md, windows/Ivy.App/README.md (the third-run checklist and the diagnostics section), docs/GATE-G1.md, and docs/reports/gate-g1-2026-10-10-partial.md.

Ground rules: branch windows-third-run, commit as you go and push the branch, never force-push or change main. Small conservative fixes only; leave the XAML layout alone beyond compile fixes. Don't change windows/Ivy.Core protocol, queue, or storage code to make a test pass; report instead.

1. dotnet test windows/Ivy.sln and pnpm -r test. Expected .NET counts: 87 + 108 (+1 skipped) + 118. Investigate any failure.
2. dotnet build windows/Ivy.Windows.sln -c Release. Fix compile errors in the new conversation panel and the tray and watchdog code if any.
3. Telegram collector: follow the "first run on the PC" steps in the Telegram section of windows/README.md, including the two public client constants it describes; note the source in the commit message.
4. Start the app (keep the existing pairing to the Mac) and walk the third-run checklist in windows/Ivy.App/README.md for the Telegram and LINE rows. Tell me when the first Telegram chats have uploaded. For LINE, run the probe, open the report, and commit the JSON into docs/reports/ after confirming it holds only file names, sizes, and table and column names.
5. Stability: keep the window open with the feed active for 30 minutes; confirm the once-a-minute heartbeat lines in ivy-app.log and that nothing freezes. If it does, note the diagnostics file path and the breadcrumb line.
6. Write docs/reports/windows-third-run.md item by item, commit, push, tell me.

Part 2, gate items c and d: I run the gate on my Mac and relay its prompts. Be ready to run the PowerShell line it prints (it targets the Desktop IVY-G1 folder), tell me when to restart the PC, and after the restart confirm IVY came back from the tray and resumed. Then add a Part 2 section to the report, commit, push, and tell me the branch name.
```

Mac side, same run: with the IVY app open and unlocked,
`cd ~/Desktop/IVY-WMA && pnpm --filter @ivy/gate-g1 run gate --data data --pairing existing --path 'C:\Users\admin\Desktop\IVY-G1\g1-50mb.pdf' --sha256 <hash from the PC>`

### Windows run 4: the Fluent UI redesign

```
Continuing IVY, my personal backup and search app (C#, .NET 8, WinUI 3 companion on this PC). Previous runs: docs/reports/windows-third-run.md. Main now has a redesigned app window (Fluent Design: sidebar navigation, Mica, pages per collector, light and dark) that was written on a Mac and never compiled. This session builds it, fixes what breaks, and checks every page.

git checkout main
git pull
pnpm install

Read windows/Ivy.App/README.md (the "Fourth run: UI" checklist) and windows/README.md.

Ground rules: branch windows-fourth-run, commit as you go and push the branch, never force-push or change main. Fix compile and layout bugs, keep the design as built; don't redesign. Don't change windows/Ivy.Core to make a test pass; report instead.

1. dotnet test windows/Ivy.sln. Expected counts are in the latest commit message on main.
2. dotnet build windows/Ivy.Windows.sln -c Release. Fix XAML and compile errors until it builds.
3. Start the app (existing pairing) and walk the "Fourth run: UI" checklist: every page renders, theme follows the system and the override works, navigation groups expand and remember state, every action from the earlier checklists still works, tray still works. Take a screenshot of each page (light and dark) with the built-in Snipping Tool, save them under docs/ui/windows-screenshots/, and commit them.
4. Write docs/reports/windows-fourth-run.md, commit, push, tell me the branch name.
```

### Windows run 5 (only if the LINE probe found an encrypted store)

Mac prompt first (to the orchestrator): "The LINE probe report is in docs/reports/. Plan and build the LINE store reader for the installed version, keeping everything on the PC per PRD WX2, then give me the run-5 prompt." The device prompt then follows the template in docs/PROMPTSKILL.md with: "LINE: follow the updated LINE section of windows/README.md and walk its checklist rows; report the coverage label the row shows."

### Mac prompt to close Phase 1

"Gate G1 is complete; the report is docs/reports/gate-g1-<date>.md and the Windows branch is pushed. Merge it, mark Phase 1 done in docs/PLAN.md, and start Phase 2."

---

## Phase 2 — Android realtime (PRD Part 3, non-root collectors; gate G2)

### Mac prompt to start Phase 2

"Start the Android phase: tasks 3.1 to 3.4 and 3.6 in docs/PLAN.md (toolchain, app skeleton with protocol port validated against the test vectors, non-root collectors, minimal Fluent-equivalent Material 3 UI matching the Mac's structure, Mac committers exercised). Android stays notification-and-metadata only until Phase 3. When it builds and its JVM tests pass here, give me the first phone prompt."

### Android run 1: build, pair, realtime capture

```
Continuing IVY, my personal backup and search app. This repo now has an Android companion (Kotlin) that captures my own notifications, call log, app usage, and media index on my own phone and uploads them encrypted to my own storage for my Mac. It was built and unit-tested on a Mac and never run on a phone. This session builds it, installs it on my phone over USB, pairs it with my Mac, and verifies capture.

git checkout main
git pull

Read android/README.md (build, install, first-run checklist) and docs/PLAN.md.

Ground rules: branch android-first-run, commit as you go and push the branch, never force-push or change main. Small conservative fixes; keep the design as built. Don't change android/app/src/main/.../protocol or queue code to make a test pass; report instead.

1. ./gradlew :app:testDebugUnitTest. Expected counts are in the latest commit message on main.
2. ./gradlew :app:assembleDebug, then install with adb per the README. Confirm the app opens.
3. Walk the first-run checklist: grant the permissions the app asks for, pair by scanning the code shown on my Mac (I'll have it open), confirm both fingerprints match, enable the collectors, and confirm the foreground notification and the activity feed show captures. Tell me when the first notification upload happens so I can check the Mac.
4. Leave it running for 30 minutes on Wi-Fi, then on mobile data, and note what the app and the feed show in each case.
5. Write docs/reports/android-first-run.md item by item, commit, push, tell me the branch name.
```

### Gate G2 (Mac prompt)

"Run gate G2 per docs/GATE-G2.md: a phone notification searchable on the Mac within 5 minutes on Wi-Fi, call log and usage on the timeline, and the honesty test (notification listener switched off shows a gap on Coverage within a day). Give me the phone prompt for the steps the phone session must do."

---

## Phase 3 — History (PRD Part 3 root adapters; gate G3)

### Mac prompt to start Phase 3

"Start Phase 3: task 3.5 in docs/PLAN.md, adapters in PRD order LINE, Telegram, WhatsApp, SMS, with the source-map verification and coverage labels PRD AC2a to AC2c require, plus manifests for the overnight import. Build and test with fixtures here; then give me the phone prompt."

### Android run 2: history import

```
Continuing IVY, my personal backup and search app. The Android companion now imports my own chat history from the apps on my phone, per the history section of android/README.md, and uploads it encrypted for my Mac. Built and tested with fixtures on a Mac; never run on the phone. This session verifies it on my phone.

git checkout main
git pull

Read android/README.md (the history-import section and its checklist) and docs/reports/android-first-run.md.

Ground rules: branch android-second-run, commit as you go and push the branch, never force-push or change main. Small conservative fixes only. Report rather than change the adapters' verification rules.

1. ./gradlew :app:testDebugUnitTest, then assembleDebug and install per the README.
2. Open the app and walk the history-import checklist row by row, in the order the README lists the apps. For each row, report the coverage label it shows and the per-app progress. Tell me when the first app's import completes so I can check the Mac.
3. Leave the phone on Wi-Fi and charging overnight; next day, note the progress of each row and anything the app flagged.
4. Write docs/reports/android-second-run.md, commit, push, tell me the branch name.
```

### Gate G3 (Mac prompt)

"Run gate G3 per docs/GATE-G3.md: complete LINE, Telegram, WhatsApp, and SMS history on the Mac, LINE first; a search for a word returns every match with pagination; clicking opens the thread at the message; an attachment downloads on demand; deleting a chat on the phone leaves the archived copy marked deleted-at-source. Give me the phone prompt for its manual steps."

---

## Phase 4 — Understanding (PRD Part 2 OCR, origin, timeline, AI; gate G4)

Mostly Mac work; no device prompt needed beyond "keep the devices running".

### Mac prompt

"Phase 4: finish media origin linking (PRD M5, M6), photo-to-context, the local embedding model for semantic search (M4) so cloud stays optional, and the timeline map strip from photo locations; then run gate G4 per docs/GATE-G4.md: a day merges at least six source types with gaps labeled, a screenshot is found by description, an AI answer cites its records, and turning cloud AI off leaves search and timeline untouched. Give me the device prompts only if a step needs the PC or the phone."

---

## Continuous checks (every release, all phases)

Mac prompt: "Run the release checks: the audit on all buckets and both device queues, the honesty test (switch one collector off on each device; Coverage must show it within its interval), and the 7-day soak summary from Coverage. Give me the device prompts for the switch-off steps."

Device prompt for the switch-off step:

```
Quick check on IVY, my personal backup app. In the app on this device, switch the <collector> row off, leave it off for <interval>, then switch it back on. Tell me the exact times you did each, and what the row showed meanwhile. No other changes.
```
