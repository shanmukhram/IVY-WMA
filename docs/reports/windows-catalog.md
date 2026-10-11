# Catalog my PC

Date: 2026-10-11. On `main`. App paired to the Mac. Counts, names and sizes only; no file contents are read by the catalog.

## What was wired (committed `eed9dfb`)

A plain **Catalog my PC** button in the Settings Maintenance section. It calls a new adapter method that sets the catalog collector's roots to `MediaPolicyDefaults.CatalogScope()` and saves, so the idle catalog collector starts listing every file's metadata (names, sizes, dates; no contents). New `ICollectorHostView.CatalogMyPcAsync`, implemented in the adapter, the stored fallback and the test fakes. App.Core tests pass (144); the app builds.

## Catalog roots set

`CatalogScope()` on this PC resolves to the whole profile:

```
C:\Users\admin
```

This is the only root, because `admin` holds everything here: the profile covers the system drive (C:), and there are no other fixed drives. The catalog row/status shows "Cataloguing (names, sizes, dates only): C:\Users\admin".

## What the catalogue covers

`C:\Users\admin` holds about **1.35 million files** (mostly `AppData`). The catalog walks it with the default exclusions (OS, Program Files, temp, recycle bin, build/VCS folders), so the catalogued subset is smaller than that, but still very large. While observed it was actively cataloguing and had seen **21,100+ files and climbing** (it had not finished the walk).

## Did catalogOnly file_meta upload to R2?

**Not in this run: 0 catalog records reached R2.** The records are produced and queued correctly, but none uploaded. Details:

- The catalog records are valid and correctly formed for upload: `up/file/<oid>`, `kind = file_meta`, ~430 bytes each, lane 0, status `queued`, 0 attempts, no errors. They carry `catalogOnly` (collector = `catalog`). ~21,470 were queued and climbing.
- The upload path for this record kind is proven: the files collector's own `file_meta` records were uploading to `up/file/...` at the same time (4,840+ done). Catalog records are identical in kind and lane, so they upload the same way once reached.
- They have not been reached because of two things:
  1. **A large pre-existing files-collector backlog is ahead in the FIFO lane.** `files.roots` still includes `Desktop` (the IVY project checkout) from an earlier session, plus Documents/Pictures/Downloads, leaving ~33,000 `file_meta` records queued ahead of the catalog's. The prompt said not to change indexed roots, so I left them.
  2. **The uploader drains far slower than capture produces.** It uploads serially, roughly 1-2 objects/sec to R2 (network round-trip per object), about 90/min. The catalog produces ~3,000/min. So the queue grows rather than drains: it went from ~40,500 to ~52,000 rows in four minutes. Lane 0 (records) held 51,049 rows (~32 MB); lane 1 (media originals from the files media policy) held 1,190 rows (~1.09 GB).

At this rate the ~33k files backlog alone would take many hours to clear serially, and a full catalogue of a 1.35M-file profile would be hundreds of thousands of tiny records on top of that. So cataloguing completes and uploads over a long time, not within a session, and I could not confirm a catalog record on R2.

## Errors

No upload or capture errors. The uploader is healthy (one object uploading, unlimited bandwidth cap, no failed rows); it is simply throughput-bound.

## Honest summary

- The **Catalog my PC** action works: roots set to `C:\Users\admin`, and the catalog collector is listing the profile (names/sizes/dates only).
- Catalog `file_meta` records are valid and queued (~21,470 and climbing), but **0 have uploaded to R2 yet**, held behind a ~33k files backlog and a serial uploader that cannot keep pace with capture.
- Two things make this slow, both worth a decision: the files roots still include the Desktop project tree (clogs the queue ahead of the catalog), and the uploader's serial per-object rate is the real bottleneck for hundreds of thousands of tiny catalog records. Parallel small-record uploads, or a batched catalog record, would be the fix; that is a core change, so I am flagging it rather than making it.
- I did not change media caps or the indexed roots.
