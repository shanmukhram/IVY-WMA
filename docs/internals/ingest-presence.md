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
- `ingester.touchDeviceSeen(deviceId, force?)` refreshes `last_seen` on every committed object including blob parts and manifests, throttled to once per 10 s per device; a standalone media blob's device is resolved by role (one device per role). A single record still forces an immediate touch.
- A wall-clock cap on the bulk/blob phase of a pass (`config.ingestPassBudgetMs`, default 20 s). High-priority records (heartbeat, control, conversations) are always committed first and in full; once the budget elapses the rest of the backlog stops for this pass so it completes and the next poll re-lists. The pass result carries `capped` and emits `ingest.capped`.
- Presence (`coverage` device `status`) follows the freshest of `last_report_at` and `last_seen` (`lastHeard`); a device that has never once reported is still red. A heartbeat that lags while uploads continue is surfaced as an amber problem ("uploading, but no heartbeat for X"), distinct from a truly silent device ("last heard X ago").

Tests: mac/service/test/presence.test.ts.
