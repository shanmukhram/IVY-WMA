# Gate G1 runbook

Gate G1 closes Phase 1 (PRD Part 4). It passes when all four of these hold, with the real Mac dashboard, the real Windows app and real Cloudflare R2:

| Item | Passes when |
| --- | --- |
| **(a)** | Windows and Mac pair over R2 from different networks (phone hotspot on one side) |
| **(b)** | a 50 MB PDF requested on the Mac arrives encrypted and intact (SHA-256 equal on the PC and on the Mac) |
| **(c)** | the bucket dump shows zero plaintext (all four buckets) |
| **(d)** | a PC reboot mid-queue loses nothing |

The same run also does two of the continuous checks: the **zero-plaintext audit** (buckets plus the PC's queue) and the **honesty test** (switch a Windows collector off; the Mac's coverage page must show it within one report interval, and the timeline must show the missing period).

`tools/gate-g1` (`@ivy/gate-g1`) does the Mac side of every check against the running service and R2, and prompts you for the steps only a person can do: pairing on the PC, the hotspot, the reboot and the collector switch. It writes `docs/reports/gate-g1-<date>.md` with a PASS/FAIL table, timestamps, the evidence for each item and every manual step with the time you answered it. G1 passes only if (a), (b), (c) and (d) are all PASS. SKIP means the item was not done in this run (you typed `skip`, or it could not apply); NOT RUN means the run never reached it; INTERRUPTED means the run stopped during it.

The gate never fully locks the vault. The bucket audit runs inside the Mac service with the service's own R2 tokens, so no copy of the tokens is needed on disk.

Plan about 45 minutes. The PC moves about 120 MB over the hotspot (the PDF twice, plus overhead).

## 1. Before you start

### R2

- [ ] Four buckets exist: `ivy-up-windows`, `ivy-up-android`, `ivy-cmd-windows`, `ivy-cmd-android`.
- [ ] Lifecycle rules (PLAN decision 6): **no** expiry rule on the two `ivy-up-*` buckets; a **30-day** expiry rule on the two `ivy-cmd-*` buckets.
- [ ] Tokens as in `mac/service/README.md`: Mac tokens ("Object Read & Write") for all four buckets, and per device an up-write token and a cmd-read token.
- [ ] No `r2.json` is needed on the Mac for the gate: the service audits the buckets with the tokens it holds (sealed at rest, in memory while unlocked) through `POST /api/r2/audit`. (`--r2 r2.json` remains as a fallback that reads the buckets directly; the gate then checks the file matches the service's configuration.)

### Mac

```sh
cd ~/IVY-WMA
pnpm install
pnpm --filter @ivy/mac-ui build                  # the dashboard
pnpm --filter @ivy/mac-service start             # serves it at http://127.0.0.1:4777, data in mac/service/data
```

(Or start the Electron app, which runs the same service.) In the dashboard: the vault is initialized and **unlocked**, R2 is configured, and the R2 check shows all four buckets reachable. The Mac stays on its usual network (for example home Wi-Fi) for the whole run.

### PC

- [ ] IVY for Windows is built and starts (see `windows/Ivy.App/README.md`).
- [ ] For a strict (a), the PC is **not paired** yet. To start fresh: quit IVY from the tray, delete `%LOCALAPPDATA%\IVY`, delete the `IVY` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, and revoke the old Windows device in the dashboard.
- [ ] A folder for the test, for example `C:\Users\admin\Desktop\IVY-G1`, that you will add as an indexed folder after pairing. Any folder works: the gate takes it from `--path` (the folder that holds the PDF) and uses it in every prompt, including the reboot test's PowerShell line.
- [ ] A PDF of at least 50 MB in that folder. Any real PDF works. If you have none, pad a small one: the gate compares bytes, and most viewers still open it.

  ```powershell
  $dir = "$env:USERPROFILE\Desktop\IVY-G1"; New-Item -ItemType Directory -Force $dir | Out-Null
  $src = "$env:USERPROFILE\Documents\any.pdf"            # any PDF you have
  $dst = Join-Path $dir "g1-50mb.pdf"
  $pad = New-Object byte[] (50MB); (New-Object Random).NextBytes($pad)
  $b = [IO.File]::ReadAllBytes($src)
  $fs = [IO.File]::Create($dst); $fs.Write($b, 0, $b.Length); $fs.Write($pad, 0, $pad.Length); $fs.Close()
  (Get-Item $dst).Length                                  # at least 50000000
  ```

  Keep the document upload cap at its default (10 MB, PLAN decision 8), so the 50 MB original stays on the PC until the Mac requests it.
- [ ] A phone with a hotspot. The **PC** joins the hotspot; the Mac stays on its network.
- [ ] Optional, for the PC-side queue audit: the repo checked out on the PC with `pnpm install` done.

## 2. Run the gate

On the Mac, from the repo root:

```sh
pnpm --filter @ivy/gate-g1 run gate \
  --path 'C:\Users\admin\Desktop\IVY-G1\g1-50mb.pdf' \
  --export-markers
```

Relative paths resolve against the directory you ran the command from. Defaults: service `http://127.0.0.1:4777`, data directory `mac/service/data` (the Electron app keeps its data in `data/` at the repo root instead: add `--data data`), report `docs/reports/gate-g1-<date>.md`. `node tools/gate-g1/src/cli.ts --help` lists every option.

The gate first runs a **preflight**: it reads `data/session.token`, checks that the service answers and the vault is unlocked, that R2 is configured for a Cloudflare R2 endpoint, that `POST /api/r2/check` reaches all four buckets, that the service offers the bucket audit (`GET /api/r2/objects`; with `--r2`, that `r2.json` matches the service's config instead), and lists the paired devices. Nothing else runs if the preflight fails.

Then it walks through the items below. Every prompt says exactly what to do; press Enter (or type the answer) when it is done.

**Skipping.** Every prompt also accepts `skip`: the item is recorded as SKIP with the prompt you skipped at, anything the gate set up for it is undone (a paused ingest is resumed), and the gate goes on to the next item. Steps that depend on it are skipped too: skipping the test file's path or hash skips (b) and (d) without asking again; skipping (a) with no Windows device paired skips (b), (d) and the honesty test. At `audit.pc`, `skip` (or Enter) only means the PC queue was not audited.

**Interrupting.** Ctrl-C (SIGINT), SIGTERM or any error stops the run but still writes the report: everything gathered so far, the item in progress as INTERRUPTED (with the prompt it waited at and the last log line), and the items not reached as NOT RUN. If ingest was paused, it is resumed first. The exit code is 130 (SIGINT), 143 (SIGTERM) or 2 (error).

### (a) Pairing over R2 from different networks

1. Prompt `network.mac`: type the Mac's network (for example `home Wi-Fi`).
2. Prompt `network.pc`: switch the PC to the phone hotspot (turn its home Wi-Fi off), then type its network (for example `iPhone hotspot`). The two answers must differ.
3. Prompt `pair.source`: press Enter. The gate creates a Windows pairing (`POST /api/pairings`), prints the `IVYPAIR1.` string and saves it to `.gate-g1/pairing.txt`. (Type `dashboard` instead to start the pairing on the dashboard's Devices page.) Get the string to the PC (for example in a note to yourself).
4. Prompt `pair.paste`: on the PC, open IVY, paste the string, press **Pair**. Press Enter on the Mac once the PC shows the two fingerprints.
5. The gate waits for the device's pairing record to arrive through R2 and be consumed, then prints both fingerprints. Prompt `pair.fingerprints`: answer `y` only if the PC shows the same **This device** and **Mac** fingerprints.
6. The gate waits for the PC's first device report over R2.

PASS: different networks stated, pairing consumed, fingerprints confirmed on the PC, a device report received. The PC stays on the hotspot for the rest of the run.

If a Windows device is already paired, prompt `pair.mode` lets you keep it (`--pairing existing`); (a) is then SKIP (the data path from the hotspot is still checked with a fresh device report), so G1 is not passed by that run.

Now, on the PC, add the test folder (the folder of `--path`, for example `C:\Users\admin\Desktop\IVY-G1`) under **Indexed folders and drives** and wait until the files row shows the scan.

### (b) 50 MB PDF arrives encrypted and intact

1. The gate looks the path up in the vault index (prompt `file.index` if it is not indexed yet).
2. Prompt `file.sha256`: on the PC, in PowerShell,

   ```powershell
   (Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\Users\admin\Desktop\IVY-G1\g1-50mb.pdf').Hash
   ```

   and paste the 64 hex characters (case does not matter). `--sha256` skips the prompt.
3. The gate requests the original (`POST /api/files/<id>/request`, **forced**), asks the service to ingest every 15 s, and prints the command's progress: `sent`, `transferring parts 1/2 ...`, `done`. The PC picks the command up within its 2-minute command poll. The request is always forced, so if the file is already in the vault from an earlier run, the PC still sends it again; the report then says the vault already held a copy and that every check uses this run's transfer.
4. While it waits it lists `up/blob/` in `ivy-up-windows` (through the service, `GET /api/r2/objects`) and has the service scan every part object it catches before the Mac ingests it (`POST /api/r2/audit` with that key as prefix: `%PDF` magic, the file name and path, JSON and long printable runs).
5. When the command is `done`, the gate streams `GET /api/files/<id>/content` through SHA-256 and compares it with the PC's hash and the manifest's hash, and checks that the vault's copy is the one this request's blob produced. It also reads the ingest ledger: the manifest and every part went through R2 as an encrypted object that the Mac authenticated (AES-GCM) before committing it.

PASS: `done`; the Mac's SHA-256 equals the PC's; the copy is this run's transfer; at least 50 MB; every part committed through the ledger; zero plaintext hits in the parts caught in flight. The report also records the retrieval time against the PRD metric (50 MB within 5 minutes on broadband; on a hotspot it is usually slower, which is information, not a failure).

To check the hash independently on the Mac:

```sh
shasum -a 256 mac/service/data/files/*/g1-50mb.pdf
```

### (d) PC reboot mid-queue loses nothing (with (c) in the middle)

1. Prompt `reboot.prepare`: check that the test folder (the folder of `--path`; `--reboot-dir` overrides it) is indexed, press Enter.
2. The gate requests the PDF again (forced), then **pauses Mac ingest** (`POST /api/ingest/pause`). The vault stays unlocked and the key stays in memory, but the service reads and deletes nothing in the up-buckets, so everything the PC uploads from now on stays in R2: that is the queue the bucket audit (c) will scan. The pause ends by itself after twice `--wait-min` (90 minutes by default) in case the gate dies without resuming; Ctrl-C, `skip` and errors resume it at once. (`--no-hold` skips the pause; (c) then audits nearly empty buckets.)
3. The gate waits until the first part objects of the new transfer appear in R2.
4. Prompt `reboot.now`: on the PC,
   1. run the PowerShell line the prompt prints. It creates 10 small files named `ivyg1<random>-1.txt` ... in the test folder with `Set-Content` only (no `New-Item`: the folder exists, and this works under Controlled Folder Access on the Desktop or in Documents). The random token is new every run. For example:

      ```powershell
      $d = 'C:\Users\admin\Desktop\IVY-G1'; 1..10 | ForEach-Object { Set-Content -LiteralPath (Join-Path $d "ivyg1a1b2c3d4-$_.txt") -Value "IVY G1 reboot test ivyg1a1b2c3d4 $_" }
      ```
   2. within a few seconds, restart the PC: **Start > Power > Restart**, without waiting for IVY's upload to finish;
   3. press Enter on the Mac right after clicking Restart.

   The gate counts the transfer's part objects in R2 at that moment: fewer than the file's part count (32 MiB parts, so 2 for a 50 MB file) proves the reboot interrupted the transfer.
5. Prompt `reboot.back`: wait for the PC to restart and sign in. IVY starts in the tray by itself (run at login), resumes the interrupted multipart upload and drains its queue. Open IVY and wait until **Queue** shows 0 pending objects, then press Enter.
6. **(c) runs now**, see below (the gate renews the pause first).
7. The gate resumes Mac ingest (`POST /api/ingest/resume`) and starts a full ingest pass. No passphrase is needed: the vault was never locked.
8. The gate follows the second request to `done` and checks the SHA-256 again, waits for all 10 marker files in the vault index, and counts quarantined objects since the step started.

PASS: the reboot happened mid-transfer; the file arrived with the PC's SHA-256; all 10 marker files created just before the reboot are in the vault; nothing was quarantined.

If the upload finishes before you can reboot (fast hotspot), the gate says so and (d) fails; rerun with `--only d --pairing existing` and reboot sooner, or use a bigger file.

### (c) The bucket dump shows zero plaintext

Runs inside (d) while Mac ingest is paused, so the buckets hold the PC's real queue: the second PDF transfer's ciphertext parts, the marker files' `file_meta`, device reports, and the Mac's `cmd/<oid>` in `ivy-cmd-windows`.

The gate calls `POST /api/r2/audit` on the service, which runs `@ivy/audit` over each of the four buckets with its own in-memory token for that bucket (the endpoint has the same guards as the rest of the API: loopback, session token, vault unlocked; it works while ingest is paused). The service harvests the markers from the vault, like `tools/fake-mac` harvests its ledger: file paths and names, extracted document text, window titles, notification text, OCR text, message text, chat titles, and printable runs from the retrieved originals in `data/files/` (including the PDF); the gate adds the test file's name and path and the reboot test's marker token. Every object up to 8 MiB is read in full; three larger objects (the 32 MiB parts) are sampled in three 1 MiB windows each. An object deleted between listing and reading is counted as gone, not as unreadable. A pending pairing bootstrap `pair/<id>` is a sealed JSON container by spec, so only its printable-run hits are exempt (marker and magic hits still count), as in fake-mac. The service answers with counts and, per hit, the object key and rule only (a marker rule as its length), never the matched plaintext.

With `--r2 r2.json` the gate does the same itself with the Mac's tokens from the file (fallback).

PASS: zero hits and no unreadable object. The report names objects with hits by key and rule, never the matched plaintext. SKIP when the buckets were empty.

`--export-markers` writes the markers to `.gate-g1/markers.txt` (mode 0600) for the PC-side audit below. It is plaintext from your vault: delete it from both machines afterwards.

### Continuous check: zero-plaintext audit

The bucket half is (c). Prompt `audit.pc` covers the device queue (PRD: "dump both device queues"). On the PC, quit IVY from the tray, copy `markers.txt` from the Mac, and from the repo run:

```powershell
pnpm --filter @ivy/audit audit --sqlite "$env:LOCALAPPDATA\IVY\vault-agent.db" --dir "$env:LOCALAPPDATA\IVY\queue" --markers markers.txt
```

Type `PASS` or `FAIL` as it prints (`RESULT: PASS (0 hits)`), or press Enter to skip. Restart IVY, then delete `markers.txt`. The answer is recorded as a manual step.

### Continuous check: honesty test

1. Prompt `honesty.disable`: in the IVY window on the PC, switch the **notifications** row off (`--collector` picks another), and press Enter at that moment.
2. The gate polls `GET /api/coverage` (and asks the service to ingest every 15 s) until the collector shows `off` ("disabled on the device") with an open `disabled` gap, and checks that `GET /api/timeline` shows the missing period. The limit is one report interval (Windows: 5 minutes; `--report-interval-min`) plus one minute for upload and ingest. The report records the measured latency.
3. Prompt `honesty.enable`: switch it back on; the gate waits until coverage shows it enabled again.

PASS: off and the gap shown within the limit, the timeline shows it, and it shows on again afterwards.

## 3. The result

The gate prints the table and writes `docs/reports/gate-g1-<date>.md` (`--out` for another path). Exit code 0 means G1 passed, 1 not passed, 2 a usage or fatal error.

```
Item                              Result  Started               Finished              Check
Preflight                         PASS    ...
G1 (a)                            PASS    ...                                         Pairing over R2 from different networks
G1 (b)                            PASS    ...                                         50 MB PDF retrieval
G1 (c)                            PASS    ...                                         Bucket dump: zero plaintext
G1 (d)                            PASS    ...                                         PC reboot mid-queue
Continuous: zero-plaintext audit  PASS    ...
Continuous: honesty test          PASS    ...

GATE G1: PASS (a-d must all be PASS)
```

The report holds hashes, object keys, fingerprints, device ids, counts and times. It holds no captured content apart from the test file's path and the marker token.

## 4. Repeating parts

Each item can be rerun on its own with the existing pairing, for example `--only b --pairing existing`, `--only d,c --pairing existing`, `--only honesty`. A strict (a) needs a new pairing (reset the PC as in section 1). The gate never locks the vault, and an interrupted run resumes ingest before it exits.

| Symptom | Likely cause |
| --- | --- |
| preflight: endpoint is not Cloudflare R2 | the service is configured for the mock; `--allow-non-r2` is only for rehearsals |
| preflight: this service has no POST /api/r2/audit | the service predates the audit endpoint: update and restart it, or pass `--r2 r2.json` |
| preflight: r2.json does not match | (only with `--r2`) a different token or bucket set than the one in `PUT /api/r2` |
| ingest stays paused after a crashed run | the pause ends by itself (twice `--wait-min`); or `POST /api/ingest/resume`, or restart the service |
| (a) no pairing record within 15 minutes | the string expired (10 minutes + 5 grace), or the PC could not reach R2 from the hotspot |
| (b) `not_found` / `access_denied` | the path is wrong or outside the indexed roots |
| (b) `too_large` | the file is above the PC's request limit (2 GB) |
| (b) no result within 45 minutes | the PC is off, paused, or its uploads fail; check IVY's footer and feed |
| (c) hits | read the object keys and rules in the report; a hit in `up/` means a device wrote readable bytes |
| (d) the upload had already finished | reboot sooner, or use a bigger file |
| honesty: not shown in time | the PC's device report did not arrive; check IVY's queue and the coverage page |

## 5. Rehearsal without the PC

`pnpm --filter @ivy/gate-g1 test` runs the whole gate against the S3 mock, a real Mac service on loopback and a simulated Windows device (on the wire only: pairing string, scoped tokens, encrypted records and chunked uploads, a reboot in the middle of a transfer, collector switches). The human steps are answered by a scripted operator keyed by the prompt ids above. The tests also cover `skip` at prompts, an error mid-run, and SIGINT sent to a child run of the CLI (the report is written with INTERRUPTED and NOT RUN items, exit 130).
