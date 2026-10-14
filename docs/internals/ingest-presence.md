# Ingest presence: why a live device looked stale, and the fix

Diagnosis (Oct 13 2026), from the live Mac service and vault.db at 17:34 UTC while the Windows app was open:

- The device's last report carried `queueDepthTotal: 291` (mid-backfill, not idle).
- Over 1,000 of its blob chunks committed in the preceding 50 minutes (893 photo, 240 document, 11 thumbnail).
- `/api/ingest/status` showed the last COMPLETED pass started 16:35 and ran 528,314 ms (8.8 min); a new pass began ~16:44 and was still running ~50 min later (committing chunks at 17:33).
- `device_report` commits stopped at 16:44; `devices.last_seen` froze at 16:46:07.

So the device was alive and the Mac was receiving its objects continuously; the Mac failed to keep presence current. Two Mac bugs:

1. `last_seen` was written only by `ingestSingle` (single records), never by `ingestPart`/`ingestManifest`. A device uploading thousands of media blobs never refreshed its presence.
2. One ingest pass drained the whole media flood before it re-listed. The poll is single-flight and the per-pass budget (3,000) bounded a count, not wall-clock time; manifests and avatars bypassed it. With 2,131 photos assembling, one pass ran tens of minutes. Device reports (priority 0, processed first each pass) were never reached because the pass never completed to re-list, so `last_report_at` froze and the dot (driven by `last_report_at` age, amber after 15 min) went orange.

Fix (mac/ only):
- ~~`touchDeviceSeen` refreshed `last_seen` on every committed blob.~~ Replaced the same day, see "Correction" below.
- A wall-clock cap on the bulk/blob phase of a pass (`config.ingestPassBudgetMs`, default 20 s). High-priority records (heartbeat, control, conversations) are always committed first and in full; once the budget elapses the rest of the backlog stops for this pass so it completes and the next poll re-lists. The pass result carries `capped` and emits `ingest.capped`.
- Presence (`coverage` device `status`) follows `lastHeard`, the freshest of `last_report_at` and `last_upload_at` (see Correction); a device that has never once reported is still red. A heartbeat that lags while uploads continue is surfaced as an amber problem ("uploading, but no heartbeat for X"), distinct from a truly silent device ("last heard X ago").

## Correction (same day, 18:08 UTC): commit time is not "heard from"

After the first fix ran live, the UI showed "last seen just now" with "last report 12 min ago". Evidence from vault.db and an R2 listing:

- Windows writes a `device_report` every 30 s (oid times 17:52:37, 17:53:07, 17:53:37, 17:54:07). The newest one was made at 17:54:07 and was committed; `last_report_at` = 17:54:07.437Z matched it exactly.
- The newest object of any kind the Mac had committed from Windows was made at 17:54:07. Objects committed at 18:08 were made at 16:47-16:53 (backlog).
- Listing `ivy-up-windows` showed nothing newer than 17:54 waiting (the 23 `up/status/` objects left there date from 15:54).

So Windows stopped uploading at 17:54:07, and the Mac was still committing its hour-old backlog. Touching `last_seen` with the Mac's clock on each commit made the quiet device look alive. That is a Mac bug in the first fix. Why Windows stopped is a Windows-side question.

Fix: `devices.last_upload_at` (migration v16) holds the creation time of the newest committed object from the device, read from its oid and never later than the Mac's clock (`ingester.noteUpload`, called for records, blob parts and manifests). `lastHeard = freshest(last_report_at, last_upload_at)`; both are device times. `last_seen` is back to its original meaning (when the Mac last committed something; it is still what device-return detection uses) and the UI shows it as "Last saved", next to "Last heard" and "Last report".

Tests: mac/service/test/presence.test.ts (including: an old backlog committed now leaves a quiet device stale; a future-dated oid is capped at the Mac's clock).

## A backlog only the full listing reaches (Oct 14 2026, PLAN decision 23)

Live evidence, Oct 14 2026 around 02:40 UTC: 1,044 photo blobs (1,042 Telegram attachments) `assembling` since 17:13–19:04 UTC on Oct 13, `committed_parts` empty, no ledger row for any `p/00000000`, yet `up/blob/<oid>/p/00000000` present in R2 for every sampled oid. The blob position (`pos:ivy-up-windows:blob`) was far above their oids. A full listing forced through pause/resume listed 22,686 keys, replayed 1,040 manifests and ended `capped` with no part fetched.

Order inside a pass, all after the deadline is set: bulk singles (file listings), the forgotten-device loop over leftover blob objects (no deadline check of its own), phase 1 (manifests), phase 2 (parts). Phase 2 checked the deadline before its first blob, so whatever the earlier steps cost came out of phase 2 only.

Now:
- `MIN_BLOB_PROGRESS` (= PREFETCH, 64): phase 1 opens at least that many new manifests and phase 2 commits at least that many new parts before honouring the deadline or the count budget. `capped` still reports that the pass ran over.
- Phase 1 settles the manifest of a blob already `assembling` straight from the ledger (its parts are verified against the manifest recorded when it was opened), without the deadline check.
- `blobsLeft` on a bucket result: the pass stopped with listed manifests or parts it did not reach. After a full listing it puts the bucket in `fullNext`, so the next pass lists in full again. Each such pass has made its minimum progress, so the chain ends; a pass that only ran long does not set it.
- `poll({ full: true })` while a pass runs waits for it and then runs one full pass, shared by every caller asking meanwhile.
