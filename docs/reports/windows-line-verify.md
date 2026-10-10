# LINE page verify

Date: 2026-10-10. Branch: `windows-line-verify`, from `main` at `9b49ec4`. Same PC: LINE for Windows 26.5.0.0 installed and signed in, the app paired to the Mac.

## 1. Tests

`dotnet test windows/Ivy.sln`:

| Suite | Result | Expected |
| --- | --- | --- |
| Ivy.App.Core.Tests | 144 passed | 144 |
| Ivy.Core.Tests | 108 passed, 1 skipped | 108 + 1 skipped |
| Ivy.Collectors.Tests | 133 passed, 1 failed | 134 |

The one failure is the long-standing PC-specific one: `TelegramCollectorTests.Missing_tdata_reports_not_found` expects `TdataNotFound` but gets `SessionInvalid`, because this PC has a real Telegram profile, so the "missing" path the test wants is not what the collector sees. Unrelated to LINE; not a regression; not changed here.

## 2. Build

`dotnet build windows/Ivy.Windows.sln -c Release`: succeeded first try, 0 warnings, 0 errors.

## 3. The LINE page and its card

The LINE page now carries a **LINE key** card: "LINE encrypts its chat store with a 32-character key that is not saved to disk. Enter it once to read your LINE messages on this PC. It is stored with DPAPI and never uploaded." It offers a key box with **Save key**, and a **Detect from LINE** button.

Before any key, the row read: "LINE 26.5 store is encrypted and no key is set, so Windows captures no LINE messages. Enter the LINE key on the LINE page, or let the phone supply the complete history."

**Followed the card with Detect from LINE** (the path that does not require me to type or see the key; the app stores it with DPAPI). Detect ran and did find and store a candidate ("key found and stored; reading LINE"), but the next read rejected it. The row settled on:

- Dot: **Error**
- Status, word for word: **The LINE key does not fit this store (wrong key, or a changed LINE version); re-enter it.**
- Last capture: never. Last upload: never. Queue: Nothing waiting to upload.
- No LINE entries in the activity feed.
- **Detect from LINE** stays enabled (can retry); **Save key** stays disabled until a key is typed.

So the auto-detect recovered a candidate key, but it does not unlock the LINE 26.5 store on this PC. The honest result stands: nothing is captured, and the row says why.

## 4. Do the chats appear on the Mac?

No. LINE captured no messages, so there is nothing for the Mac to show. Telegram remains the working conversation source from Windows.

## 5. Next step

The store stays unreadable until a key that fits it is set. The manual path is there: enter the 32-character key in the box and press **Save key**. Detect's candidate did not fit, so either the detection does not yet match this LINE version's key, or the correct key has to be supplied by hand. No key was brute-forced or guessed. The probe report from the earlier run (`docs/reports/line-probe-26.5-windows.json`) still describes the store's files for matching the reader.
