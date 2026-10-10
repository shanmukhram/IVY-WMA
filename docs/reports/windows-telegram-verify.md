# Telegram row verify after the reader fix

Date: 2026-10-10. Branch: `windows-telegram-verify`, from `main` at `b50c139` ("windows: match the Telegram reader to the real on-disk layout"). Same PC, Telegram Desktop installed and signed in. The app stayed paired to the Mac.

## 1. Tests

`dotnet test windows/Ivy.sln`:

| Suite | Result | Expected |
| --- | --- | --- |
| Ivy.App.Core.Tests | 142 passed | 142 |
| Ivy.Core.Tests | 108 passed, 1 skipped | 108 + 1 skipped |
| Ivy.Collectors.Tests | 130 passed, 1 failed | 131 |

The one failure is the same one the third and fourth runs reported: `TelegramCollectorTests.Missing_tdata_reports_not_found` expects `TdataNotFound` and gets `SessionInvalid`, because this PC now has a real Telegram profile, so the "missing" path the test wants is not what the collector sees. It is not a regression from the reader fix. Not changed here (it needs the test made independent of the PC's own profile).

## 2. Build

`dotnet build windows/Ivy.Windows.sln -c Release`: succeeded first try, 0 warnings, 0 errors.

## 3. The Telegram row

Watched for just over two minutes on the Telegram page. The row did **not** reach ok and no per-chat progress appeared.

- Header: "Telegram has a problem"
- Status line, word for word: **Encrypted block is malformed (bad length)**
- Last capture: never. Last upload: never. Queue: Nothing waiting to upload.
- History: "No progress reported yet. It appears after the first sync with Telegram Desktop's session."
- The status was stable across four 30-second checks; the log recorded it once at start (`WRN telegram: telegram: encrypted block is malformed (bad length)`) and nothing after.

**This is progress.** Before the fix the row said "No usable accounts in tdata (no MTProto authorization found)": the reader could not locate the account's files at all. Now it locates and opens them (the file-naming and folder-layout gaps are closed) and gets as far as a block whose length does not parse. That is the last of the three gaps the layout report named: the real serialization of the authorization block. The next fix is there.

## 4. Status

Telegram is not yet capturing. The exact status line to close the next gap is "Encrypted block is malformed (bad length)". LINE is unchanged, on its honest encrypted-store state.
