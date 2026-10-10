# LINE page verify, second pass (improved Detect)

Date: 2026-10-10. Branch: `windows-line-verify-2`, from `main` at `fafdb98` (includes `98254a9` "LINE detect tries every candidate and keeps the one that decrypts"). Same PC: LINE for Windows 26.5.0.0 installed and signed in, app paired to the Mac.

## Result: LINE works now

Pressed **Detect from LINE** on the LINE page. This time it found a key that decrypts the store and the row reached **Working** and started capturing.

- Dot: **Working**
- Status, word for word: **Ok partial: 3 chats, 7 new this tick (coverage partial, mirror of the phone)**
- Last capture and last upload: within a minute (the records uploaded).
- Stable across the following minute of checks.

The first pass (`windows-line-verify`) got a candidate key that did not fit and the row stayed on "The LINE key does not fit this store." The improvement (trying every candidate and keeping the one that decrypts) fixed it: Detect now lands on a working key on this PC with no manual entry.

Coverage reads **partial**, as designed: LINE for Windows holds only what this PC has synced; the phone has the full history. 3 chats and 7 messages is the slice present in the local store here.

## Do the chats appear on the Mac?

LINE captured and uploaded (last upload within a minute), so the records are on their way to the Mac. Confirm on the Mac dashboard: Conversations should show a "LINE · Windows" entry with these 3 chats. (I verify the Windows side; the Mac view is yours to check.)

## Tests and build

- `dotnet test windows/Ivy.sln`: 144 + 108 (+1 skipped) + 135 of 136. The one failure is the known PC-specific `TelegramCollectorTests.Missing_tdata_reports_not_found` (expects `TdataNotFound`, gets `SessionInvalid` because this PC has a real Telegram profile). Unrelated to LINE; not a regression.
- `dotnet build windows/Ivy.Windows.sln -c Release`: clean, first try.

## State of the two chat sources from Windows

- Telegram: Working, full cloud backfill done earlier (97/97 chats).
- LINE: Working now, partial coverage (3 chats on this PC), uploading.
