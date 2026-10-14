# Chat tags and every chat in the chat list (PLAN decision 22)

Diagnosis, Oct 14 2026, on a copy of the live vault.

| Count | Value |
| --- | --- |
| Conversations stored (not deleted) | 34: LINE 29, Telegram 5 |
| `/api/views/chats` total before the change | 34 (no cap) |
| `line_chat_options` rows, active account `ucf2ef8…` | 30: 28 match a conversation, 2 do not, and LINE Keep (`keep`) has no option row |
| `line_chat_options` rows, two accounts signed out of the PC | 7 and 3, with no conversations |
| LINE collector cursor | `chats=30` |
| Telegram collector cursor | `chatsDone 4 / chatsTotal 93`, rescan, last run 2026-10-13T16:58Z |
| Quarantine | 9 `up/lineacct/` objects from Oct 11 (before `lineacct` was a known prefix) and 15 abandoned blob manifests. All are old; current snapshots commit. |

## Where the tags live

- `conversations.listing`: from each `message_batch`'s `chatMeta.listing`. LINE for Windows sends `normal` for every chat (decision 16).
- `line_chat_options(account, chat_id, hidden, notification, pinned)`: from the `line_account` snapshot, read by Windows from LINE's `_chatOption` (`_hidden`, `_notification`, `_pinnedTime > 0`). `notification = 0` means notifications are off (muted). Each snapshot replaces its account's rows.

`mac/service/src/query/chat-tags.ts` joins them on `platform = 'line' AND account AND chat_id = conv_key`. The listing shown is `hidden` when either source says hidden, otherwise the stored listing. `muted` and `pinned` are null when no options row exists (every Telegram chat, LINE Keep).

## Placeholder chats

An options row with no conversation row for that account and chat id (live or in the recovery bin) is listed as a placeholder with id `lineopt:<account>:<chatId>`. It has no messages and no coverage claim, and its title is the contact's name when the chat id is a contact, otherwise the id. Placeholders are listed only for an account with at least one captured conversation that passes the view's device scope, source and role filters, so leftover options from a signed-out account stay out. They sort after every captured conversation, in account then chat-id order. The route pages across both kinds: `total` counts both, and a page takes captured chats first, then placeholders from `offset − capturedTotal`. Once a message for the chat arrives, the real conversation replaces the placeholder and keeps the tags.

The UI opens a placeholder as a pane with its tags and "No messages captured on this PC". It never asks the thread route for its messages.

## Paging in the UI

`fetchAllChats` asks for page 1 with pageSize 500, then fetches the remaining pages in order and keeps each chat id once. The header count and the rows rendered are the same set.
