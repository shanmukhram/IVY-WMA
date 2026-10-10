# Gate G1, first real run (partial), 2026-10-10

Real Mac dashboard (Electron app, data in `data/`), real Windows app (branch `windows-second-run`), real Cloudflare R2. PC on a phone hotspot, Mac on home network. Run interrupted by the operator at item (d); the gate CLI did not write its own report (fixed afterwards), so this is transcribed from the terminal output.

| Item | Result | Evidence |
| --- | --- | --- |
| (a) Pair over R2 from different networks | **PASS** | Fingerprints confirmed on the PC 03:20:52; first device report over R2 at 03:19:40Z |
| (b) 50 MB PDF requested on the Mac arrives encrypted and intact | **PASS** | File `C:\Users\admin\Desktop\IVY-G1\g1-50mb.pdf`, 52 429 198 bytes. Command sent 03:30:55, transferring 2 parts from 03:32:02, done 03:32:24. SHA-256 on PC, Mac and manifest all `c3d5c1cc…3c7e`. Manifest + 2 part objects of ciphertext, each AES-GCM authenticated and committed through the ingest ledger. Retrieval 1.5 min over the hotspot (PRD target: 5 min on broadband). |
| (c) Bucket dump shows zero plaintext | SKIP | Needs the Mac's tokens; the run had no `--r2` file. The Windows-side audit against the fake Mac passed earlier the same day (305 objects, 0 hits). |
| (d) PC reboot mid-queue loses nothing | SKIP | Operator skipped. Equivalent evidence from the first Windows run: forced process kill at part 3 of 4 of a 120 MB transfer, relaunch resumed at part 3, file intact. |
| Honesty test | SKIP | Not reached. |

G1 is not closed by this run: (c) and (d) remain to be executed with the real pipeline. (a) and (b) prove pairing and encrypted retrieval over real R2 from different networks.
