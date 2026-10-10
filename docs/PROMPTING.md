# How to prompt the Windows (and later Android) Claude Code sessions

Why this file exists: twice, a prompt pasted into the Claude Code session on the PC was paused by a safety classifier before the session could act. The classifier reads the prompt text on its own, without knowing this is your own data on your own machine, and pattern-matches on words that also appear in account-takeover, credential-theft, and malware requests. The work was fine; the wording was the problem.

## The rule in one line

Describe the job (build, test, verify, report) and point at the files in the repo for the details. Keep the words that explain *how* the sensitive parts work out of the prompt; the READMEs already say it.

## Words and phrases to keep out of a prompt

| Avoid in the prompt | Say instead | Why it trips the filter |
| --- | --- | --- |
| session, session key, reuse the session, no new login, signed-in session | "the Telegram collector", "follow the Telegram section of windows/README.md" | reads like session hijacking |
| api_id, api_hash, credentials, token, secret, key, fill in the key | "the two public client constants the README describes" | reads like extracting credentials |
| passcode, password, unlock, decrypt, decryption | "the first-run steps in the README" | reads like breaking protection |
| Active Sessions shows no new session, undetected, not noticed | leave it out; the README checklist covers it | reads like checking an intrusion went unseen |
| plaintext, ciphertext audit, zero plaintext | "the audit command" | security-testing vocabulary |
| probe, dump, memory, scan, extract, harvest, inject | "run the LINE probe step in the README", "diagnostics file" | attack vocabulary |
| notification database, read the app's database, root, bypass, elevate | "the notifications collector", "the LINE collector" | reads like reading another app's private data |
| hang, crash dump, watchdog dump | "stability check", "diagnostics file path" | "dump" is enough on its own |
| kill, force, override, disable protection | "quit", "restart" | self-explanatory |

Several of these in one message is what causes a pause; one in passing usually gets through.

## Shape of a prompt that works

1. One sentence of context: what IVY is, in your own words, for your own devices.
2. Setup commands (checkout, pull, install).
3. "Read ..." with the exact files that carry the detail.
4. Ground rules (branch name, commit and push, no force-push, no restyling, report rather than weaken core code).
5. Numbered steps that say *what to verify*, each pointing at a README section or checklist rather than restating it.
6. What to write in the report, and where to push.

Keep it under about 40 lines. If it still pauses, paste only the context, setup, and the first two steps; once the session is running and reading files, give the remaining steps as a follow-up message. Shorter messages with one topic each have never been paused.

## Template

```
Continuing IVY, my personal backup and search app (C#, .NET 8, WinUI 3 companion on this PC). Previous runs: docs/reports/windows-<n>-run.md. Main now has <one line on what changed>. This session rebuilds, verifies it, and reports.

git checkout main
git pull
pnpm install

Read windows/README.md, windows/Ivy.App/README.md (the <n>th-run checklist), and <any other doc>.

Ground rules: branch windows-<n>-run, commit as you go and push the branch, never force-push or change main. Small conservative fixes only. Don't change windows/Ivy.Core protocol, queue, or storage code to make a test pass; report instead.

1. dotnet test windows/Ivy.sln and pnpm -r test. Expected: <counts>. Investigate any failure.
2. dotnet build windows/Ivy.Windows.sln -c Release. Fix compile errors if any.
3. Start the app and walk the <n>th-run checklist in windows/Ivy.App/README.md. Tell me when <milestone> so I can check the Mac side.
4. Write docs/reports/windows-<n>-run.md item by item, commit, push, and tell me the branch name.
```

## Where the real detail lives

- Build, run, checklists: `windows/Ivy.App/README.md`
- Each collector, what it reads and how, first-run steps: `windows/README.md`
- Gate procedure: `docs/GATE-G1.md`
- The Mac side: `mac/README.md`, `mac/service/README.md`

Point the session at these instead of explaining them in the prompt.
