# Re-sync conversations, standard folders, and the LINE Keep finding

Date: 2026-10-11. On `main`. Telegram Desktop and LINE for Windows both signed in; app paired to the Mac. Counts, names and sizes only.

## What was wired (committed `d82f483`)

Two plain buttons in a new **Maintenance** section on the Settings page:

- **Re-sync conversations (one time)** calls the existing `RequestResync()` on the Telegram and LINE collectors (via the host) and ticks each, so both re-walk their whole history and re-emit. The Mac merges by message id, so nothing duplicates.
- **Index my standard folders** unions `MediaPolicyDefaults.StandardUserFolders()` (Downloads, Desktop, Documents, Pictures that exist) into `files.roots`, de-duped, and saves; the status line shows the resulting roots.

New `ICollectorHostView` methods `ResyncConversationsAsync` and `IndexStandardFoldersAsync`, implemented in the adapter, the stored fallback and the test fakes. App.Core tests pass (144).

## Active indexed roots

After pressing **Index my standard folders**:

```
C:\Users\admin\Desktop\IVY-G1
C:\Users\admin\Desktop\ivy test\ivy-stress-test
C:\Users\admin\Desktop
C:\Users\admin\Documents
C:\Users\admin\Pictures
C:\Users\admin\Downloads
```

Downloads, Desktop, Documents and Pictures are now indexed. I **kept** the two earlier test folders (my call), but they are now redundant: both sit under `Desktop`, which is indexed, so you can drop them if you want. Say the word and I will remove them.

**Heads-up on indexing Desktop.** `Desktop` contains `Desktop\ivy test`, which is the whole IVY project checkout (this git repo). The first scan after adding these roots produced 6500+ `file_meta` and hundreds of image/document blobs in a few minutes, from the real Pictures/Documents/Downloads plus the project tree (build output, source, excluding `node_modules`/`.git`). That is expected for "index Desktop", but it is a large one-time backlog and it churns the capture pipeline for a while. If you did not mean to back up the project checkout, consider indexing `Documents`, `Pictures`, `Downloads` and a specific work folder instead of all of `Desktop`.

## What flowed on the re-sync

Pressing **Re-sync conversations** made both collectors re-walk and re-emit. Observed on the PC (capture -> encrypt -> queue -> upload in the activity log; decrypted contents are confirmed on the Mac):

| Record | Flowed? | Evidence |
| --- | --- | --- |
| **Telegram avatars** | **Yes** | Blobs with payload kind `avatar`, e.g. 9 317, 16 516 and 9 431 bytes, encrypted and uploaded under `up/blob/`. |
| **fromMe + senderName on messages** | **Yes** (in the records) | All message batches re-emitted (seen: 197 `message_batch` captures right after the click; `up/msg/` uploads). `fromMe` and `senderName` are fields inside `message_batch`, so the Mac is where they render; the PC confirms the records re-emitted. |
| **LINE messages re-emitted with sides/names** | **Yes** | The 3 LINE chats re-emitted as 3 `message_batch` records on the re-sync. |
| **LINE account snapshot** (`line_account`) | **Yes** | `up/lineacct/...`, ~100 KB, periodic. |
| **LINE Keep conversation** | **No** | See the finding below. |

Exact totals are approximate: the `activity_log` is a bounded table that trims old rows, and the Desktop file-index backlog (6500+ `file_meta`) evicted the conversation entries from the retained window within minutes. A clean re-sync measured right after the click showed the LINE side as 3 `message_batch` + `line_account`, and 134 Telegram captures in three minutes. No capture errors.

## LINE Keep finding (step 5)

LINE Keep did not emit. Diagnosed with the collector's own read path and the stored key (counts only; no note contents read):

| Check | Result |
| --- | --- |
| `keep_*.edb` present under the LINE data folder | **Yes** — `...\LINE\Data\db\keep_qw475325499f9a96254fda282dc4d8f6.edb`, 49 152 bytes |
| Decrypts with the stored key | **Yes** |
| `_keep_content` table | present; columns `_contentId, _createdTime, _modifiedTime, _clientId, _revision, _serviceType, _source, _contentData, _status, _tags, _collectionInfos, _pinInfo, _messageId, _name, _size, _mainType, _updateState, _attribute, _contentInfo` |
| `_keep_content` total rows | **0** |
| `_keep_content` rows with a non-null `_contentId` | **0** |

So the store is readable and the Keep table is there, it is simply empty: there are no saved LINE Keep items on this PC. `EmitKeep` returns early when there are no items, which is why no Keep conversation emitted. This is correct, not a fault. When you save a Keep note or media, it will emit as a "LINE Keep" conversation on the next re-sync or tick.

## Summary

- Active roots: IVY-G1, ivy-stress-test, Desktop, Documents, Pictures, Downloads (test folders kept, now redundant under Desktop).
- On re-sync: Telegram avatars, re-emitted messages (with fromMe/senderName), LINE messages, and the LINE account snapshot all flowed; LINE Keep did not, because `_keep_content` is empty.
- Indexing Desktop pulls in the project checkout and is a large one-time backlog, flagged above.
- No media caps or anything unrelated were changed.
