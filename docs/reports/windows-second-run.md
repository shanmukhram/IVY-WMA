# Windows second run: media policy verification and gate G1 preparation

Date: 2026-10-10. Branch: `windows-second-run`, from `main` at `83383a9`. Same PC as the first run (`windows-first-run.md`): Windows 11 Pro 26200, x64, standard user, 100 % display scale, .NET SDK 8.0.425, Node 24.11.1, pnpm 10.28.2. All of Part 1 ran against the fake Mac (`tools/fake-mac`) on loopback, with `--keep` so the audit scans real ciphertext.

## Part 1: rebuild and verify

### 1. Tests

| Suite | Result | Expected |
| --- | --- | --- |
| Ivy.App.Core.Tests | 72 passed | 72 |
| Ivy.Collectors.Tests | 73 passed | 73 |
| Ivy.Core.Tests | 103 passed, 1 skipped | 103 + 1 skipped |
| @ivy/protocol | 59 passed | green |
| @ivy/s3-mock | 13 passed | green |
| @ivy/audit | 13 passed | green |
| @ivy/fake-mac | 12 passed | green |
| @ivy/mac-ui | 25 passed | green |
| @ivy/gate-g1 | 7 passed, 2 failed | see below |
| @ivy/mac-service | 9 failed, 2 suite errors, rest passed | see below |
| @ivy/mac-ocr | suite error | see below |
| @ivy/mac-app | no tests found | — |

The .NET side matches the expected counts exactly, with no changes. The Windows test fixes from the first run are still in place and needed nothing new.

`pnpm install` fails on this PC at the build-script stage: `better-sqlite3@13.0.3` (used by `mac/service`) has no prebuilt binary for Node 24 (ABI 137) and falls back to `node-gyp`, which is not installed; a native build would also need a C++ toolchain. `pnpm install --ignore-scripts` links everything else, and that is what the table above ran on. Consequences:

- `@ivy/mac-service`: 9 failures and 2 suite errors, all macOS-only assumptions: paths compared against POSIX literals (`/w/d`, `/tmp/ivy/...`, regexes with `/files/` and `/media/`), a `0o600` file-mode check (Windows reports `0o666`), and `@ivy/mac-ocr`, which requires Apple Vision. The rest of the suite (ingest, pairing, commands, HTTP) passed on Windows. Nothing here concerns the Windows app; the package is the Mac's and is tested there.
- `@ivy/gate-g1`: 2 failures of the same kind: `parseCli` relative-path expectations use POSIX literals, and the end-to-end test checks that `markers.txt` has mode `0o600` (`expected 438 to be 384`). The rest, including the simulated G1 walk-through against the mock and a real service on loopback, passed on Windows.
- `@ivy/mac-ocr`: requires macOS by design.

Not fixed: these are Mac-side packages and the failures are platform assumptions, not bugs on the Mac. If `pnpm -r test` on Windows matters, those tests need separator-aware path expectations and the mode checks skipped off POSIX.

### 2. Build

`dotnet build windows/Ivy.Windows.sln -c Release`: succeeded first try, 0 warnings, 0 errors. The new settings panel compiled unchanged.

### 3. Pairing and the media policy checklist

The app was started on the first run's data directory (paired to the fake Mac's persistent identity). The schema migration ran, a `settings_changed` rescan followed at once, and the previously indexed folder's eligible files (`photo.png`, `doc.pdf`, `notes.txt`, `readme.md`, `data.csv`) went up as `photo` / `document` blobs without re-hashing anything else. That covers the backfill-on-upgrade rule.

Test material: a new indexed folder `ivy-media-test` with `photo-a.jpg` (33 KB), `photo-b.png` (10 KB), `huge-photo.png` (27 MB), `notes-media.txt`, `report.pdf`, `memo.docx` (a minimal valid OOXML package), `archive.zip`, and a subfolder `shots` registered as a second screenshots root, containing `cap-direct.png` and `sub\inner-photo.jpg`. No HEIC file was available on this PC.

| Checklist item | Result |
| --- | --- |
| Panel shows both switches on, caps 25 and 10, default extension lists | PASS. Image list: png, jpg, jpeg, heic, heif, webp, gif, bmp, tiff. Document list: pdf, docx, doc, xlsx, xls, pptx, ppt, txt, md, rtf, csv. |
| `0`, `abc`, `5000` in a cap with Apply | PASS. Each shows "enter sizes in MB, more than 0 and at most 4096"; no `collector_config` line is logged and the stored caps stay unchanged. |
| Eligible files upload as photo/document; the zip and the large photo do not | PASS. The fake Mac received `photo` blobs for photo-a.jpg, photo-b.png and shots\sub\inner-photo.jpg, and `document` blobs for notes-media.txt, report.pdf and memo.docx, each with the source file's SHA-256. The `file_meta` for huge-photo.png and archive.zip carry no `originalBlobOid`, and no blob followed. HEIC, and the Mac-side "cached / OCR / found by words" checks, need the real Mac. |
| `file_meta` first, then blobs | PASS. The feed shows the records captured and uploaded before the originals. |
| "originals: N to upload" in the files row | NOT OBSERVED. With these small sets the stage finished within a second; the detail line read "ok - last full scan ...: N files" at every 2 s sample. |
| Pending records still upload while photos sit in the bulk lane | PASS, with a nuance. Three 20 MB photos were queued under a 512 KB/s cap and a `.txt` saved after the first chunk started. The txt's `file_meta` went out right after that chunk, before the second photo's manifest. Its `document` original, which is also a policy original, went into the bulk lane FIFO and uploaded after the third photo. So the index entry reaches the Mac first, but the text the Mac extracts does not. The checklist's "a newly saved .txt reaches the Mac before the remaining photos" holds for the record only. An in-flight chunk is never preempted, as designed. |
| Copy a photo elsewhere, move another: no new photo blob; edit the txt: a new document blob | PASS. Copy and move produced new `file_meta` records (and thumbnails) and a `deleted` entry for the moved source, no `photo` blob. The edited txt produced one new `document` blob (63 B). |
| Screenshot uploads once as `screenshot`, not also as `photo`; a photo in a subfolder of Screenshots uploads as `photo` | PASS. `shots\cap-direct.png` arrived once, as `screenshot` (8513 B), with no `photo` blob; `shots\sub\inner-photo.jpg` arrived as `photo`. A real Win+PrtScn into `Pictures\Screenshots` was verified in the first run; Pictures was not indexed here, to keep the user's photo library out of the mock. |
| Locked document (Word, .pst) skipped with `original_failed` and "1 unreadable", retried by a rescan only | NOT VERIFIED. No Office or Outlook on this PC. |
| **Upload images** off stops photo blobs, on resumes; raising the image cap to 100 starts one rescan and uploads the large photo without re-hashing | PASS. Each switch change logged `collector_config` and one `settings_changed` scan (0 new/changed). Cap 100 + Apply logged `settings: imageCapMB`, one scan of 2 roots reporting "16 files, 1 new/changed", then the 27 MB `photo` blob (SHA-256 equal to the source on the fake Mac). The rescan took about 2 s; "scanning (settings_changed)" was too brief to catch at a 2 s sampling interval. |
| 256 KB/s cap with a few hundred MB: originals waiting stop at about 1 GB, the disk does not fill; pause, quit, restart keeps counts | PARTIAL. Not run at that scale. Under a 512 KB/s cap 60 MB of originals queued and drained in order; the first run covered quit/relaunch resume. The 1 GB back-pressure ("originals waiting for the uploader") was not exercised. |
| `collector_config` from the Mac with `{"documentCapMB": 2, "documentExtensions": ["pdf","txt"]}` | PASS. Sent with `fake-mac config`; after Sync now the feed showed `command_received`, `collector_config settings: documentCapMB,documentExtensions`, one `settings_changed` scan and `command_completed done`. The panel still showed 10 and the old list until restart, as documented; after tray Quit (exit under 1 s) and relaunch it shows caps 100 / 2, document extensions `pdf, txt`, both switches on, the bandwidth cap 512 KB/s and "current: images up to 100 MB, documents up to 2 MB". |
| OneDrive cloud-only files | NOT VERIFIED. OneDrive is not signed in on this PC. |
| Fake Mac audit | PASS: "Scanned 305 items in full (11.2 MiB); sampled 3 objects above 8 MiB (3 x 1 MiB ranges each); RESULT: PASS (0 hits)", 246 markers. 0 quarantined, 0 rejected over the whole session. |

Carried over from the first run:

| Item | Result |
| --- | --- |
| Bad or expired pairing string refused with a clear message | PASS, tested on the reset, unpaired app in Part 2: "this is not a pairing string" and an `IVYPAIR9.` prefix give "Pairing failed: not an IVY pairing string"; a string with its tail replaced, or one byte flipped inside the payload, gives "Pairing failed: malformed pairing string"; the fake Mac's own string pasted 20 minutes after issue gives "Pairing failed: pairing code expired". The box stayed editable every time, and no device key or pairing file was written (`%LOCALAPPDATA%IVYkeys` was never created). |
| 150 % display scaling | NOT VERIFIED. Changing the scale factor needs a sign-out on this PC, which would end the session. |

Other observations, not changed:

- The fake Mac writes policy originals as `received\<oid>.bin`; `screenshot` and `file_request` results get an extension hint but `photo` / `document` payloads do not. Cosmetic.
- The files row never showed the originals stage on this small data set; the README wording probably describes larger first indexes.
- Each switch flip on the panel triggers its own rescan (two flips, two counting walks). Cheap here; on a large root it is two walks.

### 4. Commits

No product or test code needed changes in Part 1. This report is the only commit of Part 1.

## Part 2: gate G1 preparation (PC)

All done except that the test folder had to move, see item 2.

1. **Fresh, unpaired PC.** Quit from the tray (exit under 1 s), `%LOCALAPPDATA%\IVY` deleted, the `IVY` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` deleted. Verified afterwards: no state directory, no Run value, no `Ivy.App.exe` process. The fake Mac is stopped. The old Windows device still has to be revoked in the real Mac dashboard before the run.
2. **Test folder and PDF.** `Documents\IVY-G1` cannot be created from PowerShell on this PC: **Controlled Folder Access** is on (Defender event 1123: "powershell.exe has been blocked from modifying %userprofile%\Documents\IVY-G1"). `cmd.exe` is blocked the same way, and the allowed-app list needs an administrator. Desktop is not protected here, so the file was created with the runbook snippet at

   | | |
   | --- | --- |
   | Path | `C:\Users\admin\Desktop\IVY-G1\g1-50mb.pdf` |
   | Size | 52 429 198 bytes (a 398-byte PDF followed by 50 MB of random padding) |
   | SHA-256 | `C3D5C1CC926F624051D02E7C682B4334B5344CC4363103BA2DE7D3A8E3813C7E` |

   Pass that path to the gate with `--path`. The same restriction will hit the `reboot.now` step, whose PowerShell line writes 10 marker files into the indexed folder, so the indexed folder must be outside the protected set, or PowerShell must be allowed in Controlled Folder Access, which needs an administrator (Claude does not change security settings). IVY itself only reads indexed files and writes under `%LOCALAPPDATA%`, which is not protected.
3. **Build.** `dotnet build windows/Ivy.Windows.sln -c Release` rebuilt clean; the exe at `windows\Ivy.App\bin\x64\Release\net8.0-windows10.0.19041.0\win-x64\Ivy.App.exe` is ready and not running. The document cap is at its default (10 MB) on a fresh data directory, so the 50 MB PDF will be indexed as metadata and uploaded only on request.

## Part 3: the gate run

Filled in after the run.
