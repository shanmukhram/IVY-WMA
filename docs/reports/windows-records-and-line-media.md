# New records flow and LINE media coverage

Date: 2026-10-11. On `main`. Same PC: Telegram Desktop and LINE for Windows both installed and signed in, the app paired to the Mac. Report holds file/table/column names, sizes, and counts only.

## Part A: the new records on a capture cycle

Built `windows/Ivy.App/Ivy.App.csproj -c Release` (clean) and ran the app. It reused the existing Telegram Desktop session and the local LINE store; no new sign-in. Both conversation rows are Working: Telegram "Chats 97/97, 229 messages", LINE "Capturing all 3 chats on this PC". Counts are read from the PC's own activity log (capture -> encrypt -> queue -> upload); decrypted contents are confirmed on the Mac.

| New record | Flowed this cycle? | Evidence on the PC |
| --- | --- | --- |
| **LINE account snapshot** (`line_account`) | **Yes** | Captured, encrypted, queued and uploaded: `up/lineacct/...`, ~100 KB, once per snapshot interval (seen 3 times across the run). This carries the profile, contacts, hidden chats, blocked contacts and settings as one record. |
| **LINE Keep** as a conversation | Not this cycle | No new `message_batch` for a Keep conversation emitted (see below). |
| **Telegram chat avatars** | Not this cycle | No `avatar` blob emitted (blob kinds this cycle: none; historically photo/screenshot/thumbnail only). |
| **fromMe + senderName on messages** | Not this cycle | These are fields inside `message_batch` records; no new `message_batch` emitted this cycle. |

**Why three of the four did not flow, and it is not an error.** The Telegram backfill (97/97) and the LINE capture (3 chats) both completed on earlier builds, so their cursors are advanced: `tg_chat_state` shows all 97 chats `history_complete`, and the LINE cursor is at `chats=3`. Avatars, `fromMe`/`senderName` and the Keep conversation ride on freshly captured chat and message records. With every existing chat already complete and no new incoming messages during the run, nothing re-emitted. Toggling both collectors off and on did not re-walk completed chats either (by design: they resume from the cursor).

`line_account` did flow because it is a periodic full snapshot, not tied to message cursors, so it re-emitted on the new build straight away.

**To exercise the other three** one of these is needed, none of which I did unprompted: a new message arriving in a Telegram or LINE chat (the natural path; the next message carries the new fields and its chat's avatar), or a full re-backfill on the new build. A re-backfill is safe because the Mac merges by platform message id (PLAN 1.10), but it means a fresh pairing, which needs a new string from you and would interrupt your current Mac session. Say the word and I will drive a re-backfill, or send yourself one message in each app and I will confirm the new fields upload.

No capture errors occurred during the run. (The only errors in the log are the LINE key failures from Oct 10, before the key was set.)

## Part B: LINE media, honestly (PLAN decision 12)

### 1. Are user-saved chat files covered?

**Not yet, because Downloads is not an indexed root.** The file index currently covers only two folders: `C:\Users\admin\Desktop\IVY-G1` and `C:\Users\admin\Desktop\ivy test\ivy-stress-test`. LINE's Save / Save As drops files into `C:\Users\admin\Downloads`, which exists but is not indexed, so those saved files are not captured today. Per your note, I am not adding it; your call whether to add `Downloads` as an indexed root. Once added, saved LINE files are captured as ordinary `file_meta` (and media originals per the policy) and can be matched back to a chat on the Mac.

### 2. Honest coverage label (committed)

The LINE page's Partial coverage note now also states the media situation, in plain words (commit `811e7cb`):

> Always partial from Windows: LINE for Windows holds only what this PC has synced. The phone has the full history. Media: only files you saved from a chat (Save or Save As) are captured, through the file index; inline chat-media originals are not kept on this PC and come from the phone.

No behaviour change; wording only. Verified it renders on the LINE page.

### 3. .eimg thumbnail evidence (observation only, no code added)

Per the prompt this is optional and skippable if it adds much code, so I did not add probe code for it. As a plain observation from disk: `...\LINE\Cache` holds **42 `.eimg` files**, dated **2026-10-06 (28 files)** and **2026-10-10 (14 files)**. These are LINE's encrypted thumbnails (PLAN decision 12): there is no original and no recoverable key, so nothing was decrypted or uploaded. The count and dates are only a signal that media existed in chats; the real media comes from the phone.

## Summary

- `line_account` is the one new record that flowed this cycle (uploaded, ~100 KB).
- Avatars, Keep, and `fromMe`/`senderName` need a fresh capture (a new message or a re-backfill) because the existing chats are already complete; nothing re-emits on a plain cycle.
- Downloads is **not** indexed, so user-saved LINE files are not captured yet; your decision whether to add it.
- The LINE page now labels media coverage honestly.
- 42 `.eimg` thumbnails exist (Oct 6 and Oct 10); no attempt made on their bytes or keys, by design.
