## Conversation capture: Telegram desktop (`Ivy.Collectors/Telegram/`, task 1.11, WT1–WT4, WX1–WX2)

Telegram Desktop is already signed in on the PC. The collector **reuses that
existing session and never logs in** (WT1): it reads the MTProto auth key straight
out of `tdata` and connects as that same device. No phone number, no login code,
no new session ever.

**Layer 1 — `tdata` reader (`Telegram/TData/`).** Reads
`%APPDATA%\Telegram Desktop\tdata` (or a configured / portable path): the
`key_datas` local key, the account map, and each account's `dbiMtpAuthorization`
block (main DC id, user id, per-DC auth keys). It ports tdesktop's own crypto —
the `TDF$` container, AES-256-IGE, the MTProto-1.0 SHA-1 KDF, and the
PBKDF2-HMAC-SHA512 passcode key. If the user set a **local passcode** it is entered
**once** in the IVY window and held in **DPAPI** (`DpapiTelegramPasscodeStore`);
with no passcode the empty-passcode key is used. **Auth keys and the passcode live
only in memory/DPAPI — never in the queue, a record, a blob, a log, or the
collector's SQLite tables** (WX2; a Mac test asserts the key bytes appear in none
of those).

**Layer 2 — the MTProto client (`Telegram/Client/`).** Everything the collector
needs from Telegram is behind `ITelegramClient` (connect from a raw auth key + DC,
walk dialogs, page history, get the update difference, download a file). The
production implementation is **`WTelegramClientAdapter`** over the **WTelegramClient**
NuGet package (MIT, pure .NET): `WTelegramSession` builds the library's own session
blob straight from the raw auth key + DC + user id recovered from `tdata` (no login
flow), the auth key living only inside that AES-encrypted blob keyed by a
per-process key; the running session is kept in memory or, in the app, written to
`%LOCALAPPDATA%\IVY\keys\telegram-session.bin` DPAPI-protected (`DpapiSessionProtector`),
never in the queue dir (WX2). `TelegramTypeMapper` turns the library's TL types into
the domain types, `TelegramAttachmentRef` is a self-contained file handle for
`download`/`file_request`, and the adapter maps `FLOOD_WAIT_X` →
`FloodWaitException` and auth-key rejection → `SessionInvalidException`. The one
thing still filled in **on the PC** is `TelegramApiCredentials.DesktopDefault`: the
api_id/api_hash must be Telegram Desktop's own public constants (and the device/app
string match it) so Telegram lists IVY as the **same** session, not a new client.
Until that is set the factory returns null, the row reads **not configured**, and
nothing else runs — so the whole collector, the mapping and the session
construction are exercised on the Mac through a scripted fake and hand-built TL
objects, with no Telegram install. On Windows, `CollectorHost` wires the real
factory automatically once the credentials are set
(`PlatformServices.CreateTelegramClientFactory`).

**What it captures (WT2).** Every cloud dialog (DMs, groups, and channels when
`includeChannels` is on), **complete history** per chat via `messages.getHistory`
paging with a **per-chat cursor** in `tg_chat_state`, then live **updates, edits
and deletions** via the update difference. Edits carry `editedAt`; deletions emit
`sourceStatus = deleted_at_source` with `deletedAtSource`. Records are
`message_batch` with `sourceSession = "windows:telegram-desktop"`,
`coverage = complete` for cloud chats, carrying `chatMeta`, using the typed
`MessageBatchRecord` (PROTOCOL.md §6). `FLOOD_WAIT_X` is honored: the row shows the
wait and backs off until it elapses.

**Secret chats** are device-local and never exist in the cloud, so they are
**reported phone-only in status and never emitted as records** (WT3).

**Attachments / media policy (WT4, PLAN decision 8).** Every attachment keeps its
metadata and a stable platform reference. Images and documents **under the caps**
(`imageCapMB` 25, `documentCapMB` 10 by default) are downloaded through the session
and uploaded as blobs (`payloadKind` `photo`/`document`), deduplicated by content
hash, bounded by `originalsBytesPerTick` so bulk media never starves the index.
Everything else (video, audio, over a cap) stays metadata-only and is fetched **on
request** via a `file_request` with `fileId = "tg:<ref>"`
(`TelegramFileRequestHandler`, uploaded as `payloadKind` `attachment`).

**Honest states (the Telegram row).** `ok` (connected, capturing), `needs
passcode` (a local passcode is set — enter it once), `tdata not found`, `session
invalid` (logged out elsewhere / unreadable tdata), `flood-wait until T`, `not
configured` (no MTProto client in this build). Per-chat progress, last capture /
upload, and import totals (chats done/total, message count) feed the device
report. Settings (`collector_config`): `tdataPath`, `includeChannels`,
`historyPageSize`, `historyPagesPerTick`, `autoUploadImages`/`imageCapMB`,
`autoUploadDocuments`/`documentCapMB`, `originalsBytesPerTick`. Registered in
`CollectorHost` and the App UI row list.

**What must be verified on the PC (no Telegram install exists on this Mac). First
run with the real adapter.**
1. The **`tdata` byte layout** of a real install: the per-account file naming
   (`ToFilePart`/`ComputeDataNameKey`), the `key_datas` framing, and especially the
   real `dbiMtpAuthorization` serialization — the reader currently parses the shape
   the test writer produces, which mirrors tdesktop but is **confirmed only against
   the generated fixture**, not a live profile. Point the collector at a copy of the
   real `tdata` and confirm it recovers the account(s) and the auth key.
2. The **local passcode** path end to end: with Telegram Desktop locked, the row
   reads **needs passcode**; enter it once in the IVY window (**Conversation
   capture → Telegram**), press **Apply** (DPAPI-stored, `telegram-passcode.bin`),
   and confirm the next tick decrypts `tdata` and connects.
3. Set `TelegramApiCredentials.DesktopDefault` to Telegram Desktop's real
   `api_id`/`api_hash` (and the device/app string to match), start IVY, and confirm
   in Telegram's **Settings → Devices / Active sessions** that **no new session**
   appears — IVY rides the existing Telegram Desktop session. A new "IVY"/unknown
   session there means the constants or device string are wrong.
4. A full backfill + incremental run against the live account: the row shows
   backfill progress (chats done/total, message count); edits carry `editedAt` and
   deletions `deletedAtSource`; `FLOOD_WAIT` shows "flood-wait until T" and resumes;
   the **include channels** toggle adds/removes broadcast channels; secret chats
   show **phone-only** and emit no records. Confirm a chat's messages decrypt on the
   fake Mac (`tools/fake-mac`), and that an image/PDF under the caps arrives as a
   blob while a video stays metadata-only until a `file_request`.

**Tested here (Mac, no Telegram install):** the `tdata` crypto primitives and a
**byte-for-byte round trip** (single account, multi-account with active index,
passcode-protected, wrong passcode → needs-passcode, missing/corrupt → honest
failure) via a test-only `tdata` writer that uses the same primitives; and the full
collector against a fake transport — complete-history backfill with `chatMeta`,
oldest-ward paging that **resumes across a process restart** with no duplicates,
incremental edits/deletions, `FLOOD_WAIT` back-off and resume, session-invalid /
tdata-not-found / needs-passcode / not-configured states, secret chats reported
phone-only, the media policy (image uploaded, video left metadata-only), the
on-request `file_request`, and an assertion that **no auth-key bytes** reach any
record, blob, or the vault database. Plus, for the real adapter: the
**TL → domain mapping** (dialogs for DMs/groups/channels/supergroups, messages with
text/edit/reply/forward, photo and document attachments with a round-tripping
`TelegramAttachmentRef`, service and empty messages) against hand-built TL objects,
and **`WTelegramSession` construction** from a fixture auth key — the session
decrypts to the JSON WTelegramClient expects (main DC, api_id, user id, base64 key,
seed DC address) while the **raw key bytes never appear in the produced buffer** in
plaintext.


Poll cadence: the collector ticks every 5 seconds (was 30) so a new message shows up almost at once; an idle tick costs one `GetDifference` call, with the dialog list refreshed about once a minute (and sooner on re-sync or when a new chat appears).
