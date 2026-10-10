# Telegram row verify after the reader fixes

Date: 2026-10-10. Branch: `windows-telegram-verify`. Same PC, Telegram Desktop installed and signed in, app paired to the Mac. This covers three builds of `main` as the reader was fixed in steps.

## Result: the Telegram row now works

At `main` = `c05c72d` ("unwrap the account block's length-prefixed framing in the Telegram reader") the row reaches **Working** and backfills the account. Watched on the Telegram page:

- Status climbed: "Chats 50/97, 180 messages." then "Chats 97/97, 229 messages."
- Dot: Working. Last capture and last upload: within seconds during the backfill. Queue drained to 0 once the backfill finished.
- Stable at "Chats 97/97, 229 messages" across the following minutes; it has the full cloud history and moves to incremental updates from here.

Tell the Mac side to look for a "Telegram · Windows" entry under Conversations.

## How it got here, build by build

| main | Row status | Meaning |
| --- | --- | --- |
| `b50c139` match the reader to the real on-disk layout | "No usable accounts in tdata (no MTProto authorization found)" → then "Encrypted block is malformed (bad length)" | The file-naming and folder-layout gaps closed; the reader found and opened the account files but a block length did not parse. |
| `c05c72d` unwrap the account block's length-prefixed framing | **Working, backfilling** | The last gap (the block's framing) closed; the row reaches Working and the history climbs. |

## One transient error during backfill

At 16:03:11 one history request failed with `TL.RpcException: -500 No workers running`, logged as a tick failure (`WRN CollectorHost: telegram tick failed`) and surfaced briefly on the row as "No workers running". This is a **Telegram server-side error** (RPC code -500, their "no worker available" response), not a fault in IVY, in the same family as FLOOD_WAIT. The collector backed off, retried, and recovered: the row returned to Working and reached 97/97. It occurred once and did not recur.

## Tests and build

- `dotnet test windows/Ivy.sln`: 142 + 108 (+1 skipped) + 130 of 131. The one failure is the known PC-specific one: `TelegramCollectorTests.Missing_tdata_reports_not_found` expects `TdataNotFound` but gets `SessionInvalid` because this PC has a real Telegram profile. Not a regression; not changed here.
- `dotnet build windows/Ivy.Windows.sln -c Release`: clean on every build above.

## LINE

Unchanged, still on its honest encrypted-store state.
