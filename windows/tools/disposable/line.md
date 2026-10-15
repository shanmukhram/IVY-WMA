# LINE data map (local research — work laptop sandbox)

Living notes while mapping LINE for Windows locally. Read-only against the owner's own data. **Account id and chat names are redacted here**; the map, schema, and method are intact.

- **This PC** = work laptop = research sandbox. The **personal LINE account** was logged in here on purpose to map the data locally.
- The PC actually **paired to the Mac is a different machine** (not touched). The Mac's "29 chats" come from there, not from here.
- Store encryption: **wxSQLite3 AES-128-CBC**. The 32-hex passphrase is from LINE's server, held in LINE's process memory while logged in, and (once captured) in DPAPI at `%LocalAppData%\IVY\keys\line-key.bin`. **Never uploaded.**

## 1. On-disk folders — `%LocalAppData%\LINE`

| Folder | Files | Size | Holds | Personal data? |
|---|---|---|---|---|
| `bin` | 185 | 135.5 MB | App binaries (.dll/.exe), icons | No (app code) |
| `Cache` | 1138 | 23.5 MB | `.eimg` thumbnails (149, AES-128-ECB), cached media (962 ext-less), Qt caches | **Yes** (media/thumbnails) |
| `Data\db` | 13 | 26.9 MB | The `.edb` SQLite stores (chats, Keep, stats, album) | **Yes** (messages, contacts) |
| `Data\plugin` | 241 | 294.5 MB | Plugin assets/DLLs | No |
| `Data\Sticker` | 8 | 0.5 MB | Sticker assets | No (downloaded stickers) |
| `Data\bgChat` | 0 | 0 | Chat backgrounds | No |
| `Data\advertisement`, `ampkit`, `utsinfo` | 0 | 0 | Empty / app config | No |

Store-build path (`%LocalAppData%\Packages\NAVER.LINEwin8_*`): **not present** (classic installer only).

## 2. `Data\db` files

Two accounts' stores are present (one set per account):

| File | Size | `-wal`? | Encrypted? | What it is |
|---|---|---|---|---|
| `qwREDACTED-B.edb` | 1456 KB | **yes** | yes | **Chat store, account B = the logged-in PERSONAL account** (the one IVY reads) |
| `qwREDACTED-A.edb` | 528 KB | no | yes | Chat store, account A (other account, not read while B is active) |
| `keep_<acct>.edb` | 48 KB | no | yes | Keep (saved items) per account |
| `chatStats_<acct>.edb` | 28 KB | no | yes | Chat statistics per account |
| `album_<acct>.edb` | 20 KB | no | yes | Albums per account |
| `f59c00309acd...` (loose) | 32 KB | no | ? | Misc |

The collector (`LineStore.FindDb`) opens only the store with a `-wal` = the logged-in account (B). One account at a time.

## 3. Chat store contents — account B (personal, mid `uREDACTED-MID`)

**8 chats total** (all DMs), 993 messages, all captured by IVY, 1 hidden, nothing dropped:

| # | kind | msgs | last | hidden | title |
|---|---|---|---|---|---|
| 1 | dm | 1 | 2026-10-11 | no | (redacted) |
| 2 | dm | 14 | 2026-10-12 | no | (redacted) |
| 3 | dm | 42 | 2026-10-11 | no | (redacted) |
| 4 | dm | 829 | 2026-10-14 | no | (redacted) |
| 5 | dm | 1 | 2026-10-05 | no | (redacted) |
| 6 | dm | 91 | 2026-10-13 | no | (redacted) |
| 7 | dm | 12 | 2026-10-11 | **yes** | (redacted) |
| 8 | dm | 3 | 2026-10-04 | no | (redacted) |

All 8 come from the `_chat` list table; `_message` has 8 distinct chat ids, `_chatOption` 7; union = 8. No message-only or option-only extras.

### Coverage model (the key takeaway)
- LINE for Windows keeps only a **small rolling window of recent chats** locally (here: 8). IVY captures 100% of that window.
- **Full LINE history is phone-only** by design; the complete list comes from the **Android adapter**, not any Windows PC. Windows capture is labelled "partial" on purpose.
- So a Mac showing "29" for this account = cumulative history retained by the Mac over time, exceeding what the live desktop store holds right now.

### Tables the collector reads (from `LineStoreMap.ShippedDefault`)
`_message` (_id, _chatId, _from, _createdTime, _text, _contentType, _contentMetadata), `_chat` (_id), `_groupChat`, `_squareChat`, `_room`, `_contact` (_mid, _displayName, _displayNameOverridden, _targetProfileDetail→profileName), `_profile` (own mid/name), `_chatOption` (_id, _hidden, _notification, _pinnedTime), `_setting` (_key, _value).

> **Exhaustive per-column / per-tag dump of ALL tables in ALL of account B's stores (chat, Keep, chatStats, album) — including everything IVY ignores — is in section 7 (Appendix).**

## 4. Full table schema

### Chat store `qwc93d…edb` — 34 tables (IVY reads 9, ignores 25)

**IVY reads (9):**

| table | rows | what it holds |
|---|---|---|
| `_message` | 993 | every message: `_from`,`_to`,`_id`,`_createdTime`,`_text`,`_contentType`,`_contentMetadata`,`_chatId` (+ `_reactions`,`_location`,`_urlPreview`,`_relatedMessageId`,`_readCount` which IVY does NOT read) |
| `_chat` | 8 | the chat list (`_id`,`_lastMessage`,`_unreadCount`,`_status`…) |
| `_chatOption` | 7 | per-chat options: `_hidden`,`_notification`,`_pinnedTime` |
| `_contact` | 13 | contacts: `_mid`,`_displayName`,`_displayNameOverridden`,`_targetProfileDetail`(JSON name/pic/status),`_blockDetail`,`_picturePath` |
| `_profile` | 1 | the owner's own profile: `_mid`,`_displayName`,`_userid`,`_email`,`_phone`,`_statusMessage`,`_picturePath` |
| `_groupChat` | 0 | group chats (none here) |
| `_room` | 0 | multi-person rooms (none here) |
| `_squareChat` | 0 | OpenChat/Square chats (none here) |
| `_setting` | 9 | app settings (`_key`,`_value`) |

**IVY ignores (25)** — notable ones:

| table | rows | what it holds | note |
|---|---|---|---|
| `_message_fts` + `_message_fts_*` | 993 | **full-text search copy of message text** | a second copy of message bodies on disk |
| `_channelToken` | 4 | `_channelAccessToken`,`_obsToken`,`_refreshToken` | **credentials / tokens — must never leave the device** |
| `_chatE2EEPublicKeys` | 5 | per-chat E2EE public keys | key material |
| `_myE2EEKeyChain` | 1 | the owner's E2EE key chain | **secret key material — must never leave** |
| `_buddyDetail` | 5 | official-account / bot metadata | |
| `_stickerProductNew`,`_sticonProduct`,`_sticker_history`,`_message_sticker` | 1–7 | sticker catalog/history (not message content) | |
| `_square*` (bot/member/thread/token) | 0 | OpenChat metadata (unused here) | |
| `_group_call`,`_voip_bg` | 0 | call UI state | |
| `_meta_info`,`_profileMappedId`,`_chatE2EEPublicKeys` | – | store bookkeeping | |

### Keep store `keep_qwc93d…edb` — 5 tables, **empty** (`_keep_content` = 0 rows)
Tables: `_keep_content` (saved items), `_keep_content_command`, `_keep_command_info`, `_keep_settings`, `_meta_info`. The `LineKeep` collector reads `_keep_content` — there's just nothing saved in Keep on this account right now.

## 5. Media / Keep / Calls (account B)

**Message content-type histogram (993 total):**

| contentType | meaning | count | IVY captures |
|---|---|---|---|
| 0 | text | 773 | yes (text) |
| 6 | **call record** | 136 | yes (via `LineCalls` from `_contentMetadata`) |
| 1 | image | 22 | yes (attachment ref + original if on disk) |
| 2 | video | 3 | yes (attachment ref) |
| 7 | sticker | 1 | yes (as media kind) |
| 17 | (unmapped) | 33 | captured as "other", text kept |
| 22 | (unmapped) | 25 | captured as "other", text kept |

**Attachments / media files:** referenced by `_contentType` + `_contentMetadata` JSON (parsed by `LineAttachments`). Actual files: originals live under the LINE data folder when present (uploaded per the Windows media policy); thumbnails are the **149 `.eimg`** files in `Cache` (AES-128-ECB, per-file key, treated as out-of-scope by the collector).

**Features present in `_message` but NOT captured today:** reactions (14 msgs), URL previews (43), replies/threading (`_relatedMessageId`, 15), read counts, location (0 here). These are candidates if we ever want richer LINE capture.

## 6. Encrypt-vs-never-upload classification

IVY's rule is simple: **everything that leaves the device is encrypted to the Mac's key (ciphertext only in R2).** So the real question is *what gets uploaded at all* vs *what must never leave*.

| Data | Sensitivity | Handling |
|---|---|---|
| Message text (`_message._text`, `_message_fts`), chat list, contact names (`_contact`, `_profile`), chat options, settings | Personal content | **Captured → encrypted to Mac → R2.** Correct. |
| Media originals (images/videos/files) + call records | Personal content | **Captured → encrypted to Mac** (media per Windows media policy). |
| `.eimg` thumbnails (Cache) | Personal (derived) | Out of scope today (encrypted per-file by LINE; not uploaded). |
| **LINE store passphrase** (32-hex, from LINE memory) → `%LocalAppData%\IVY\keys\line-key.bin` (DPAPI) | **Secret** | **Never uploaded. Stays in DPAPI on the PC.** |
| **`_channelToken`** (access/refresh/OBS tokens), **`_myE2EEKeyChain`**, **`_chatE2EEPublicKeys`** | **Secret credentials / key material** | IVY does not read these. **Must never be captured or uploaded.** |
| Cursors, snapshot temp copies, `.plain` decrypt scratch | Operational | Local only; temp deleted after each read. |
| Sticker catalog, bot/official-account metadata, store bookkeeping | Not sensitive | Not captured (no value). |
| **Older/inactive chat history** | — | **Not on this PC at all** — LINE keeps only a recent rolling window locally; full history is phone-only (Android adapter). |

### Bottom line
- The Windows collector captures the right things and already **ignores the dangerous ones** (tokens, E2EE keys, FTS duplicate). Nothing on the "never upload" list is being touched.
- The only "gap" vs a full LINE backup is **inherent to LINE for Windows**: it holds a small recent window (8 chats here), so Windows can only ever be a partial mirror. Completeness comes from the phone.
- Repeating for another account (your personal one) = the same `qw…edb` store read the same way, same classification.


## 7. Appendix — exhaustive schema (account B, every table / column / tag)

Every store, table, column (with type), row count, index/trigger, and JSON key set. `[IVY]` marks a table the current collector reads; everything else it ignores today. JSON key sets are the *tags* found inside a text column (structure only, no values).

### qwREDACTED-B.edb
*CHAT STORE — chats, messages, contacts, profile, settings*

Tables: 34 · indexes: 6 · triggers: 1 · views: 0

#### `_buddyDetail` — 5 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_mid` | TEXT | PK |  |
| `_memberCount` | INTEGER |  |  |
| `_onAir` | INTEGER |  |  |
| `_businessAccount` | INTEGER |  |  |
| `_addable` | INTEGER |  |  |
| `_acceptableContentTypes` | TEXT |  | _lkp|_001, _lkp|_002, _lkp|_003, _lkp|_004, _lkp|_005, _lkp|_006, _lkp|_007, _lkp|_008 |
| `_capableMyhome` | INTEGER |  |  |
| `_freePhoneCallable` | INTEGER |  |  |
| `_phoneNumberToDial` | TEXT |  |  |
| `_needPermissionApproval` | INTEGER |  |  |
| `_channelId` | INTEGER |  |  |
| `_channelProviderName` | TEXT |  |  |
| `_iconType` | INTEGER |  |  |
| `_botType` | INTEGER |  |  |
| `_showRichMenu` | INTEGER |  |  |
| `_richMenuRevision` | INTEGER |  |  |
| `_onAirLabel` | INTEGER |  |  |
| `_onAirVersion` | INTEGER |  |  |
| `_useTheme` | INTEGER |  |  |
| `_themeId` | TEXT |  |  |
| `_useBar` | INTEGER |  |  |
| `_barRevision` | INTEGER |  |  |
| `_useBackground` | INTEGER |  |  |
| `_backgroundId` | TEXT |  |  |
| `_statusBarEnabled` | INTEGER |  |  |
| `_statusBarRevision` | INTEGER |  |  |
| `_searchId` | TEXT |  |  |
| `_blockable` | INTEGER |  |  |
| `_botActiveStatus` | INTEGER |  |  |
| `_membershipEnabled` | INTEGER |  |  |
| `_legalCountryCode` | TEXT |  |  |
| `_botTalkroomAds` | TEXT |  | displayTalkroomAdsToMembershipUser, talkroomAdsEnabled |
| `_botOaCallDetail` | TEXT |  |  |
| `_aiChatBot` | INTEGER |  |  |
| `_supportSpeechToText` | INTEGER |  |  |
| `_voomEnabled` | INTEGER |  |  |
| `_buddyCautionNoticeFromCMS` | TEXT |  | visibility |
| `_region` | TEXT |  |  |
| `_serviceMenuBar` | TEXT |  | items, items.[].type, items.[].url |
| `_brandType` | INTEGER |  |  |
| `_verifiedIconType` | INTEGER |  |  |
| `_lineWorks` | INTEGER |  |  |
| `_revision` | INTEGER |  |  |

#### `_buddyStatusBar` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_label` | TEXT |  |  |
| `_displayType` | INTEGER |  |  |
| `_title` | TEXT |  |  |
| `_iconUrl` | TEXT |  |  |
| `_linkUrl` | TEXT |  |  |
| `_mid` | TEXT | PK |  |
| `_revision` | INTEGER |  |  |

#### `_channelToken` — 4 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_channelId` | TEXT | PK |  |
| `_channelAccessToken` | TEXT |  |  |
| `_expiration` | INTEGER |  |  |
| `_obsToken` | TEXT |  |  |
| `_refreshToken` | TEXT |  |  |
| `_token` | TEXT |  |  |

#### `_chat` — 8 rows `[IVY]`
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_id` | TEXT | PK |  |
| `_midType` | INTEGER |  |  |
| `_lastMessage` | TEXT |  | attribute, chatId, chunks, contentInfo, contentMetadata, contentMetadata.ALT_TEXT, contentMetadata.BOT_CHECK, contentMetadata.BOT_TRACK, contentMetadata.CAUSE, contentMetadata.DURATION, contentMetadata.FLEX_JSON, contentMetadata.FLEX_VER, contentMetadata.NOTIFICATION_DISABLED, contentMetadata.PUBLIC, contentMetadata.RESULT, contentMetadata.SESSION_ID, contentMetadata.TYPE, contentMetadata.VERSION, contentMetadata.e2eeMark, contentMetadata.seq, contentType, createdTime, decrypted, deliveredTime, errorCode, eventInfo, flag, from, fromType, hasContent, hasUrlPreview, id, location, reactionStatus, reactions, readCount, reqSeq, reqSeqV2, rev, sessionId, status, syncToken, text, to, toType, type, urlPreview |
| `_lastUpdatedTime` | INTEGER |  |  |
| `_sendChatCheckedId` | TEXT |  |  |
| `_messageBoxNextId` | INTEGER |  |  |
| `_unreadCount` | INTEGER |  |  |
| `_onAir` | INTEGER |  |  |
| `_showMember` | INTEGER |  |  |
| `_status` | INTEGER |  |  |
| `_memberHistory` | TEXT |  | u4787c142ff9b974f265633d95cead985, u4787c142ff9b974f265633d95cead985.[].createdTime, u4787c142ff9b974f265633d95cead985.[].param1, u4787c142ff9b974f265633d95cead985.[].param2, u4787c142ff9b974f265633d95cead985.[].param3, u4787c142ff9b974f265633d95cead985.[].revision, u4787c142ff9b974f265633d95cead985.[].type, u4d731f98de43828024a59f2167de67e1, u4d731f98de43828024a59f2167de67e1.[].createdTime, u4d731f98de43828024a59f2167de67e1.[].param1, u4d731f98de43828024a59f2167de67e1.[].param2, u4d731f98de43828024a59f2167de67e1.[].param3, u4d731f98de43828024a59f2167de67e1.[].revision, u4d731f98de43828024a59f2167de67e1.[].type, u905e8d301721907471f7a95f56f3b1cd, u905e8d301721907471f7a95f56f3b1cd.[].createdTime, u905e8d301721907471f7a95f56f3b1cd.[].param1, u905e8d301721907471f7a95f56f3b1cd.[].param2, u905e8d301721907471f7a95f56f3b1cd.[].param3, u905e8d301721907471f7a95f56f3b1cd.[].revision, u905e8d301721907471f7a95f56f3b1cd.[].type, ud5af49c11593b91840b6e5966cf49807, ud5af49c11593b91840b6e5966cf49807.[].createdTime, ud5af49c11593b91840b6e5966cf49807.[].param1, ud5af49c11593b91840b6e5966cf49807.[].param2, ud5af49c11593b91840b6e5966cf49807.[].param3, ud5af49c11593b91840b6e5966cf49807.[].revision, ud5af49c11593b91840b6e5966cf49807.[].type |
| `_lastReceivedOpRev` | INTEGER |  |  |
| `_announcement` | TEXT |  |  |
| `_firstUnreadId` | TEXT |  |  |
| `_messageBoxNextCreatedTime` | INTEGER |  |  |
| `_lastSyncToken` | TEXT |  |  |
| `_mediaMessageFlow` | TEXT |  | flowMap, flowMap.1, flowMap.14, flowMap.2, flowMap.3, mediaMessageFlowExpiredAt |
| `_messageEditNotice` | TEXT |  | expiredTimeMillis, noticeReason |

#### `_chatE2EEPublicKeys` — 5 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_chatId` | TEXT | PK |  |
| `_publicKeys` | TEXT |  | _lkp|_001, _lkp|_001.createdTime, _lkp|_001.keyData, _lkp|_001.keyData._hs_19be35042ea1f6f07da69d4b5ddd0104, _lkp|_001.keyData._hs_3684f677d7a29d0e95145897eae94dfb, _lkp|_001.keyData._hs_c2ec073323bee061e2b635ee911504f8, _lkp|_001.keyData._hs_fd40bf8b482200cca9f3b46656df5ca0, _lkp|_001.keyId, _lkp|_001.version |
| `_e2eeEnabled` | INTEGER |  |  |
| `_allowedTypes` | TEXT |  |  |
| `_specVersion` | INTEGER |  |  |
| `_chatCounter` | INTEGER |  |  |
| `_lastNegotiationTime` | INTEGER |  |  |

#### `_chatOption` — 7 rows `[IVY]`
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_id` | TEXT | PK |  |
| `_hidden` | INTEGER |  |  |
| `_notification` | INTEGER |  |  |
| `_pinnedTime` | INTEGER |  |  |
| `_utilityData` | TEXT |  |  |

#### `_contact` — 13 rows `[IVY]`
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_mid` | TEXT | PK |  |
| `_createdTime` | INTEGER |  |  |
| `_type` | INTEGER |  |  |
| `_status` | INTEGER |  |  |
| `_displayName` | TEXT |  |  |
| `_displayNameOverridden` | TEXT |  |  |
| `_phoneDisplayName` | TEXT |  |  |
| `_pictureStatus` | TEXT |  |  |
| `_thumbnailUrl` | TEXT |  |  |
| `_statusMessage` | TEXT |  |  |
| `_favoriteTime` | INTEGER |  |  |
| `_attributes` | INTEGER |  |  |
| `_settings` | INTEGER |  |  |
| `_picturePath` | TEXT |  |  |
| `_recordId` | TEXT |  |  |
| `_addedTime` | INTEGER |  |  |
| `_recommendParams` | TEXT |  |  |
| `_unregisteredContact` | INTEGER |  |  |
| `_videoProfile` | TEXT |  |  |
| `_musicProfile` | TEXT |  |  |
| `_profileUpdateSign` | INTEGER |  |  |
| `_statusMessageContentMetadata` | TEXT |  |  |
| `_userType` | INTEGER |  |  |
| `_targetProfileDetail` | TEXT |  | hiddenFromList, musicProfile, picturePath, pictureStatus, profileId, profileName, snapshotTimeMillis, statusMessage, statusMessage.content, statusMessage.meta, videoProfile |
| `_friendDetail` | TEXT |  | bot, bot.createdTime, bot.hidden, user, user.createdTime, user.favoriteTime, user.hidden, user.overriddenName |
| `_blockDetail` | TEXT |  | bot, notBlocked, user |
| `_recommendationOrNot` | TEXT |  | notRecommended |
| `_notificationSettingEntry` | TEXT |  | notificationSetting, notificationSetting.mute |

#### `_groupChat` — 0 rows `[IVY]`
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_type` | INTEGER |  |  |
| `_chatMid` | TEXT | PK |  |
| `_createdTime` | INTEGER |  |  |
| `_notificationDisabled` | INTEGER |  |  |
| `_favoriteTimestamp` | INTEGER |  |  |
| `_chatName` | TEXT |  |  |
| `_picturePath` | TEXT |  |  |
| `_extra` | TEXT |  |  |
| `_status` | INTEGER |  |  |
| `_addedTime` | INTEGER |  |  |
| `_inviterMId` | TEXT |  |  |

#### `_group_call` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_chat_id` | TEXT | PK |  |
| `_online` | INTEGER |  |  |
| `_video` | INTEGER |  |  |
| `_live` | INTEGER |  |  |

#### `_message` — 993 rows `[IVY]`
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_from` | TEXT |  |  |
| `_to` | TEXT |  |  |
| `_toType` | INTEGER |  |  |
| `_id` | TEXT | PK |  |
| `_createdTime` | INTEGER |  |  |
| `_deliveredTime` | INTEGER |  |  |
| `_text` | TEXT |  |  |
| `_location` | TEXT |  |  |
| `_hasContent` | INTEGER |  |  |
| `_contentType` | INTEGER |  |  |
| `_contentMetadata` | TEXT |  | ALT_TEXT, BOT_CHECK, BOT_ORIGIN, BOT_TRACK, CAUSE, DOWNLOAD_URL, DURATION, FILE_SIZE, FLEX_JSON, FLEX_VER, LINE_TAG_REDIRECTOR, MARKUP_JSON, NOTIFICATION_DISABLED, OID, PREVIEW_URL, PUBLIC, RESULT, SESSION_ID, SID, SPEC_REV, TYPE, UNSENT, VERSION, e2eeMark, seq |
| `_contentPreview` | TEXT |  |  |
| `_sessionId` | INTEGER |  |  |
| `_chunks` | TEXT |  |  |
| `_relatedMessageId` | TEXT |  |  |
| `_messageRelationType` | INTEGER |  |  |
| `_readCount` | INTEGER |  |  |
| `_relatedMessageServiceCode` | INTEGER |  |  |
| `_appExtensionType` | INTEGER |  |  |
| `_reactions` | TEXT |  | _lkp|_001, _lkp|_001.atMillis, _lkp|_001.fromUserMid, _lkp|_001.reactionType, _lkp|_001.reactionType.paidReactionType, _lkp|_001.reactionType.predefinedReactionType |
| `_chatId` | TEXT |  |  |
| `_type` | INTEGER |  |  |
| `_status` | INTEGER |  |  |
| `_reqSeqV2` | INTEGER |  |  |
| `_reqSeq` | INTEGER |  |  |
| `_contentInfo` | TEXT |  | keyMaterial, lastContentOpType, lastContentOpTypeRevision, notNeedUpdate, thumbPath, thumbResCode |
| `_eventInfo` | TEXT |  | type |
| `_rev` | INTEGER |  |  |
| `_errorCode` | INTEGER |  |  |
| `_urlPreview` | TEXT |  | cacheVersion, fake, needToReq, urlPreview, urlPreview.[].desc, urlPreview.[].isVideo, urlPreview.[].phishingBlock, urlPreview.[].success, urlPreview.[].thumbPath, urlPreview.[].thumbnail, urlPreview.[].title, urlPreview.[].url |
| `_hasUrlPreview` | INTEGER |  |  |
| `_syncToken` | TEXT |  |  |
| `_fromType` | INTEGER |  |  |
| `_attribute` | INTEGER |  |  |
| `_flag` | INTEGER |  |  |
| `_reactionStatus` | TEXT |  | countByType, reactionList, reactionList.[].PaidType, reactionList.[].PredefinedType, reactionList.[].cancel, reactionList.[].createdAt, reactionList.[].reactor, reactionList.[].type, reactionList.[].updatedAt, totalCount |

_`_contentMetadata` JSON tags grouped by `_contentType`:_

| contentType | msgs | tags seen in _contentMetadata |
|---|---|---|
| 0 | 773 | BOT_CHECK, BOT_ORIGIN, BOT_TRACK, LINE_TAG_REDIRECTOR, NOTIFICATION_DISABLED, PUBLIC, UNSENT, e2eeMark, seq |
| 6 | 136 | CAUSE, DURATION, RESULT, SESSION_ID, TYPE, VERSION, seq |
| 17 | 33 | ALT_TEXT, BOT_CHECK, BOT_TRACK, DOWNLOAD_URL, LINE_TAG_REDIRECTOR, MARKUP_JSON, NOTIFICATION_DISABLED, PUBLIC, SPEC_REV, seq |
| 22 | 25 | ALT_TEXT, BOT_CHECK, BOT_ORIGIN, BOT_TRACK, FLEX_JSON, FLEX_VER, LINE_TAG_REDIRECTOR, NOTIFICATION_DISABLED, PUBLIC, seq |
| 1 | 22 | BOT_CHECK, BOT_TRACK, DOWNLOAD_URL, FILE_SIZE, OID, PREVIEW_URL, PUBLIC, SID, UNSENT, e2eeMark, seq |
| 2 | 3 | BOT_CHECK, BOT_TRACK, DOWNLOAD_URL, DURATION, FILE_SIZE, OID, PREVIEW_URL, PUBLIC, SID, e2eeMark, seq |
| 7 | 1 | STKID, STKOPT, STKPKGID, STKTXT, STKVER, seq |

#### `_message_fts` — 993 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_text` | - |  |  |

#### `_message_fts_content` — 993 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `docid` | INTEGER | PK |  |
| `c0_text` | - |  |  |

#### `_message_fts_docsize` — 993 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `docid` | INTEGER | PK |  |
| `size` | BLOB |  |  |

#### `_message_fts_segdir` — 10 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `level` | INTEGER | PK |  |
| `idx` | INTEGER | PK |  |
| `start_block` | INTEGER |  |  |
| `leaves_end_block` | INTEGER |  |  |
| `end_block` | INTEGER |  |  |
| `root` | BLOB |  |  |

#### `_message_fts_segments` — 13 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `blockid` | INTEGER | PK |  |
| `block` | BLOB |  |  |

#### `_message_fts_stat` — 1 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `id` | INTEGER | PK |  |
| `value` | BLOB |  |  |

#### `_message_sticker` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_packageId` | INTEGER | PK |  |
| `_stickerId` | INTEGER | PK |  |
| `_message` | TEXT |  |  |

#### `_meta_info` — 27 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `m_n` | varchar(50) | PK |  |
| `m_v` | INTEGER |  |  |
| `m_p` | TEXT |  | k_c |
| `m_s` | TEXT |  | _ableToBeGivenAsPresent, _ableToReceiveMessage, _ableToUseInvitationTicket, _acceptableContentTypes, _active, _addable, _addedTime, _adultOnly, _aiChatBot, _allowSearchByEmail, _allowSearchByUserid, _allowedTypes, _announcement, _appExtensionType, _applicationVersionRange, _attribute, _attributes, _author, _authorId, _authority, _availableForMyself, _availableForPresent, _availableInCountry, _backgroundId, _backwardToken, _barRevision, _bg, _billingCpId, _billingItemId, _blockDetail, _blockable, _botActiveStatus, _botMid, _botOaCallDetail, _botTalkroomAds, _botType, _brandType, _buddyCautionNoticeFromCMS, _businessAccount, _c_premium, _capableMyhome, _categoryId, _channelAccessToken, _channelId, _channelProviderName, _chatCounter, _chatId, _chatImageObsHash, _chatMid, _chatName, _chat_id, _chunks, _contacts, _contentInfo, _contentMetadata, _contentPreview, _contentType, _copyright, _createdAt, _createdTime, _creatorId, _customDownloadButtonLabel, _deliveredTime, _desc, _details, _displayName, _displayNameOverridden, _displayType, _e2eeEnabled, _e2eeKeyChain, _editorsPickBanners, _email, _emblems, _errorCode, _eventInfo, _expiration, _expiredIn, _expiresAt, _extra, _favoriteTime, _favoriteTimestamp, _featureSet, _firstUnreadId, _flag, _freePhoneCallable, _friendDetail, _from, _fromType, _generatedByAI, _grantedByDefault, _hasContent, _hasUrlPreview, _hidden, _iconType, _iconUrl, _id, _images, _installedTime, _invitationURL, _inviterMId, _invitor, _joinMessage, _joinedAt, _key, _label, _lastJoinRequestAt, _lastMessage, _lastMessageAt, _lastModifiedAt, _lastNegotiationTime, _lastReceivedOpRev, _lastSyncToken, _lastUpdatedTime, _lastVisitTime, _latestVersion, _latestVersionString, _legalCountryCode, _lineWorks, _linkUrl, _live, _localizedPrice, _location, _madeWithStickerMaker, _maxMemberCount, _mediaMessageFlow, _memberCount, _memberHistory, _memberMids, _membershipEnabled, _membershipState, _message, _messageBoxNextCreatedTime, _messageBoxNextId, _messageEditNotice, _messageId, _messageRelationType, _metadata, _mid, _midType, _mids, _musicProfile, _myMember, _myMemberId, _name, _needPermissionApproval, _newToOldSticonIdMapping, _noteStatus, _notice, _notification, _notificationDisabled, _notificationSettingEntry, _obsToken, _oldMetaVersion, _oldPackageVersion, _oldProductId, _onAir, _onAirLabel, _onAirVersion, _onSale, _online, _owned, _packageId, _phone, _phoneDisplayName, _phoneNumberToDial, _phoneticName, _picturePath, _pictureStatus, _pinnedTime, _preference, _price, _priceInLineCoin, _priceTier, _productId, _productPromotionProperty, _productProperty, _productSalesState, _profileId, _profileImageObsHash, _profileUpdateSign, _promotionInfo, _publicKeys, _reactionStatus, _reactions, _readCount, _readOnlyAt, _recommendParams, _recommendationOrNot, _recordId, _refreshToken, _region, _regionCode, _relatedMessageId, _relatedMessageServiceCode, _relation, _reqSeq, _reqSeqV2, _rev, _revision, _richMenuRevision, _role, _rootMessage, _salesFlags, _searchId, _searchable, _sendChatCheckedId, _serviceMenuBar, _sessionId, _settings, _showMember, _showRichMenu, _specVersion, _squareChatMid, _squareChatRevision, _squareMemberMid, _squareMid, _squareThreadMember, _state, _status, _statusBarEnabled, _statusBarRevision, _statusMessage, _statusMessageContentMetadata, _stickerId, _stickerIds, _stickerPackageId, _stickerPackageVersion, _stickerResourceType, _subscriptionProperty, _subtype, _supportSpeechToText, _svcTags, _syncTime, _syncToken, _targetProfileDetail, _text, _themeId, _threadMid, _thumb, _thumbnailUrl, _timestamp, _title, _to, _toType, _token, _totalMessageCount, _type, _unreadCount, _unregisteredContact, _urlPreview, _usageState, _useBackground, _useBar, _useTheme, _useTime, _userType, _userid, _utilityData, _validFor, _validUntil, _validation, _value, _verifiedIconType, _version, _versionString, _video, _videoProfile, _voomEnabled, _weight, _welcomeMessage, _wishProperty |
| `m_c` | TEXT |  |  |
| `m_i` | TEXT |  | _chatOption__id__hidden__notification, _chatOption__id__hidden__notification.i_c, _chatOption__id__hidden__notification.i_q, _chatOption__id__hidden__notification.i_t, _chat__id__midType__status__firstUnreadId, _chat__id__midType__status__firstUnreadId.i_c, _chat__id__midType__status__firstUnreadId.i_q, _chat__id__midType__status__firstUnreadId.i_t, _message__chatId__createdTime__contentType__status__hasUrlPreview__rev, _message__chatId__createdTime__contentType__status__hasUrlPreview__rev.i_c, _message__chatId__createdTime__contentType__status__hasUrlPreview__rev.i_q, _message__chatId__createdTime__contentType__status__hasUrlPreview__rev.i_t, _message__flag__chatId, _message__flag__chatId.i_c, _message__flag__chatId.i_q, _message__flag__chatId.i_t, _message__reqSeqV2, _message__reqSeqV2.i_c, _message__reqSeqV2.i_q, _message__reqSeqV2.i_t, _message__status, _message__status.i_c, _message__status.i_q, _message__status.i_t |
| `m_f` | TEXT |  | _text |
| `m_d` | TEXT |  |  |

#### `_myE2EEKeyChain` — 1 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_mid` | TEXT | PK |  |
| `_e2eeKeyChain` | TEXT |  | keychain, keychain.[].createdTime, keychain.[].keyId, keychain.[].privateKey, keychain.[].publicKey, keychain.[].version |
| `_validation` | INTEGER |  |  |

#### `_profile` — 1 rows `[IVY]`
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_allowSearchByEmail` | INTEGER |  |  |
| `_allowSearchByUserid` | INTEGER |  |  |
| `_displayName` | TEXT |  |  |
| `_email` | TEXT |  |  |
| `_mid` | TEXT | PK |  |
| `_phone` | TEXT |  |  |
| `_phoneticName` | TEXT |  |  |
| `_picturePath` | TEXT |  |  |
| `_pictureStatus` | TEXT |  |  |
| `_regionCode` | TEXT |  |  |
| `_statusMessage` | TEXT |  |  |
| `_thumbnailUrl` | TEXT |  |  |
| `_userid` | TEXT |  |  |
| `_videoProfile` | TEXT |  |  |
| `_musicProfile` | TEXT |  |  |
| `_statusMessageContentMetadata` | TEXT |  |  |

#### `_profileMappedId` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_profileId` | TEXT | PK |  |
| `_mids` | TEXT |  |  |

#### `_room` — 0 rows `[IVY]`
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_mid` | TEXT | PK |  |
| `_createdTime` | INTEGER |  |  |
| `_contacts` | TEXT |  |  |
| `_notificationDisabled` | INTEGER |  |  |
| `_invitor` | TEXT |  |  |
| `_memberMids` | TEXT |  |  |

#### `_setting` — 9 rows `[IVY]`
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_key` | TEXT | PK |  |
| `_value` | TEXT |  | GroupModelRevision, MigratedGroupToGroupChat, _lgrk, _lirk, _lrk, _lrsv2, _sck, _sck.configMap, _sck.configMap.contact_ui.show_addressbook, _sck.configMap.function.account.age.check.required, _sck.configMap.function.account.device.attestation.enabled, _sck.configMap.function.account.device.attestation.jitter_minutes, _sck.configMap.function.account.device.attestation.period_minutes, _sck.configMap.function.account.idfederation_callback_url, _sck.configMap.function.account.settings.account_center.check_privacy_policy_version, _sck.configMap.function.account.settings.account_center_enabled, _sck.configMap.function.account.settings.account_center_url, _sck.configMap.function.account.settings.account_deletion.unlinked_paypay_points.enabled, _sck.configMap.function.account.settings.eap.yahoojapan.channel_page.url, _sck.configMap.function.account.settings.eap.yahoojapan.link_button_dogfooding, _sck.configMap.function.account.settings.idfederation.paypay.enabled, _sck.configMap.function.account.settings.idfederation.yjapp_autologin.supported_version_code, _sck.configMap.function.account.settings.idfederation_url, _sck.configMap.function.account.settings.idfederation_url.routing, _sck.configMap.function.account.smartswitch_restoration.enabled, _sck.configMap.function.account.token.v3.fetch_token, _sck.configMap.function.account.token.v3.use_token, _sck.configMap.function.addressbook.auto_sync.enabled, _sck.configMap.function.addressbook.sync_interval_in_minutes, _sck.configMap.function.adp, _sck.configMap.function.adp.optout, _sck.configMap.function.adp.timeline, _sck.configMap.function.ai.agenti.enabled, _sck.configMap.function.ai.agenti.home.url, _sck.configMap.function.ai.agenti.liff.base.url, _sck.configMap.function.ai.agenti.url.whitelist, _sck.configMap.function.ai.aiedit.lyp.disable, _sck.configMap.function.ai.aiedit.recommend.preset.disable, _sck.configMap.function.ai.aiedit.recommend.reason.disable, _sck.configMap.function.ai.assistant.config, _sck.configMap.function.ai.assistant.lyp, _sck.configMap.function.ai.assistant.subscription, _sck.configMap.function.ai.character.display_button, _sck.configMap.function.ai.character.entry.new_contents, _sck.configMap.function.ai.character.event.enabled, _sck.configMap.function.ai.character.line_point.enabled, _sck.configMap.function.ai.character.native_migration_v1.update_pop_up, _sck.configMap.function.ai.character.native_migration_v1_supported_version, _sck.configMap.function.ai.character.v2.enabled, _sck.configMap.function.ai.chat_ai.poc, _sck.configMap.function.ai.keyword_expansion.debounce_interval_millis, _sck.configMap.function.ai.keyword_expansion.enabled, _sck.configMap.function.ai.keyword_expansion.lyp_plan_disabled, _sck.configMap.function.ai.lineai.enabled_entry_points, _sck.configMap.function.ai.lineai.force_liff_launch, _sck.configMap.function.ai.mention.agenti.mid, _sck.configMap.function.ai.mention.enabled, _sck.configMap.function.ai.mention.message_count, _sck.configMap.function.ai.mention.timeout_seconds, _sck.configMap.function.ai.personal_ai.poc, _sck.configMap.function.ai.scheduling_agent.chip_index, _sck.configMap.function.ai.service.subscription, _sck.configMap.function.ai.speech_translator.test, _sck.configMap.function.ai.subscription.page_enable, _sck.configMap.function.ai.talk.suggestions.chip_lang_bundle, _sck.configMap.function.ai.talk.suggestions.chip_list, _sck.configMap.function.ai.talk.suggestions.chip_visibility_map, _sck.configMap.function.ai.talk.suggestions.enabled, _sck.configMap.function.ai.talk.suggestions.is_lyp_premium_upsell_disabled, _sck.configMap.function.ai.talk.suggestions.op_name.input_chip, _sck.configMap.function.ai.talk.suggestions.op_name.main_chip, _sck.configMap.function.ai.talk.suggestions.sticker.enabled, _sck.configMap.function.ai.talk.suggestions.subscription.productid, _sck.configMap.function.ai.talk.suggestions.use_lisa, _sck.configMap.function.album.ad.enabled, _sck.configMap.function.album.ad.end_inventory_key, _sck.configMap.function.album.ad.sdk.renovation.enabled, _sck.configMap.function.album.agreement.enable, _sck.configMap.function.album.agreement.version, _sck.configMap.function.album.android.refactoringrx2.enable, _sck.configMap.function.album.background_transfer.enabled, _sck.configMap.function.album.feed.enabled, _sck.configMap.function.album.like.enabled, _sck.configMap.function.album.like.gnb.push_ui.enabled, _sck.configMap.function.album.premium.image_quality_setting_abtest, _sck.configMap.function.album.premium.lyp.chat_entry_policy, _sck.configMap.function.album.premium.lyp.picker_abtest, _sck.configMap.function.album.premium.lyp.promote_update, _sck.configMap.function.album.premium.picker_floating_chip, _sck.configMap.function.album.premium.show_premium_contents_in_setting, _sck.configMap.function.album.reboot, _sck.configMap.function.apicapability.dry_run_methods_list, _sck.configMap.function.apicapability.fetchops_blacklist, _sck.configMap.function.apicapability.find_and_add_contact, _sck.configMap.function.apicapability.group, _sck.configMap.function.apicapability.group_chat, _sck.configMap.function.apicapability.persona_service, _sck.configMap.function.apicapability.premium_backup, _sck.configMap.function.apicapability.relation_find_and_sync_contacts_v3, _sck.configMap.function.apicapability.relation_get_contactsv3, _sck.configMap.function.apicapability.remove_all_messages_whitelist, _sck.configMap.function.apicapability.service_methods_map, _sck.configMap.function.auto_suggest.add_promotion, _sck.configMap.function.auto_suggest.anonymous_uts.input_keyword, _sck.configMap.function.auto_suggest.anonymous_uts.view_filter, _sck.configMap.function.auto_suggest.asfreetrial.count, _sck.configMap.function.auto_suggest.asfreetrial.duration, _sck.configMap.function.auto_suggest.asfreetrial.redisplay, _sck.configMap.function.auto_suggest.asfreetrial.status, _sck.configMap.function.auto_suggest.asfreetrial.url, _sck.configMap.function.auto_suggest.asfreetrial2.count, _sck.configMap.function.auto_suggest.asfreetrial2.panel.after.url, _sck.configMap.function.auto_suggest.asfreetrial2.panel.during.url, _sck.configMap.function.auto_suggest.asfreetrial2.preview.after.url, _sck.configMap.function.auto_suggest.asfreetrial2.preview.during.url, _sck.configMap.function.auto_suggest.asfreetrial2.preview.sticker.after.url, _sck.configMap.function.auto_suggest.asfreetrial2.status, _sck.configMap.function.auto_suggest.buddysticker, _sck.configMap.function.auto_suggest.buddysticker_maxdisplayfrequency, _sck.configMap.function.auto_suggest.buddysticker_redisplayperiod, _sck.configMap.function.auto_suggest.continuous_emoji, _sck.configMap.function.auto_suggest.custom_order, _sck.configMap.function.auto_suggest.experiment.multiconnection, _sck.configMap.function.auto_suggest.followupsticker, _sck.configMap.function.auto_suggest.followupsticker_autooff, _sck.configMap.function.auto_suggest.followupsticker_displayspeed, _sck.configMap.function.auto_suggest.followupsticker_displaytime, _sck.configMap.function.auto_suggest.freemium_maxdisplayfrequency, _sck.configMap.function.auto_suggest.freetrial.guide, _sck.configMap.function.auto_suggest.freetrial.status, _sck.configMap.function.auto_suggest.lypagreement, _sck.configMap.function.auto_suggest.nlp, _sck.configMap.function.auto_suggest.np_sticker.lifetime_second, _sck.configMap.function.auto_suggest.p_mark_removal, _sck.configMap.function.auto_suggest.showcase_arrangement, _sck.configMap.function.auto_suggest.smartsticker_autooff, _sck.configMap.function.auto_suggest.smartsticker_displaydelay, _sck.configMap.function.auto_suggest.smartsticker_displayduration, _sck.configMap.function.auto_suggest.ui.v2, _sck.configMap.function.avatar.blocked_devices, _sck.configMap.function.avatar.download.multi, _sck.configMap.function.avatar.friends, _sck.configMap.function.avatar.log_enabled, _sck.configMap.function.avatar.max.count, _sck.configMap.function.avatar.selectavatar.max.count, _sck.configMap.function.avatar.service, _sck.configMap.function.avatar.settings.oa, _sck.configMap.function.avatar.sticker, _sck.configMap.function.avatar.suggestion, _sck.configMap.function.avatar.suggestion.ml, _sck.configMap.function.backup.premium.agreement.lan, _sck.configMap.function.backup.premium.agreement.version, _sck.configMap.function.backup.premium.chat.expired.banner, _sck.configMap.function.backup.premium.initial_error_retry, _sck.configMap.function.backup.premium.initial_stop, _sck.configMap.function.beacon, _sck.configMap.function.beacon.libratest, _sck.configMap.function.bot.pnp, _sck.configMap.function.calendar.ad.all_inventory_key, _sck.configMap.function.calendar.ad.chat_inventory_key, _sck.configMap.function.calendar.ad.enable, _sck.configMap.function.calendar.app2app.enable, _sck.configMap.function.calendar.app2app_friendstab.enable, _sck.configMap.function.calendar.enable, _sck.configMap.function.camera.effect_row.disabled, _sck.configMap.function.camera.engine_type, _sck.configMap.function.camera.font, _sck.configMap.function.camera.launch.blocked_devices, _sck.configMap.function.camera.qrscan.sms, _sck.configMap.function.channel.in_app_web_wkwebview, _sck.configMap.function.channel.setting_page.url, _sck.configMap.function.chatapp.more.badge, _sck.configMap.function.chatroom.antifraud.celebrity.alert_popup, _sck.configMap.function.chatroom.antifraud.celebrity.input_blocker, _sck.configMap.function.chatroom.bgm.enable, _sck.configMap.function.chatroom.chatmenu_v2, _sck.configMap.function.chatroom.content_preview.disable, _sck.configMap.function.chatroom.contextmenu.greendot, _sck.configMap.function.chatroom.draftmessage, _sck.configMap.function.chatroom.draftmessage.sampling.log, _sck.configMap.function.chatroom.draftmessage.tooltip, _sck.configMap.function.chatroom.dt_unsupportedurl, _sck.configMap.function.chatroom.flex_note_album_reply, _sck.configMap.function.chatroom.group_penalty, _sck.configMap.function.chatroom.inputmenu.test, _sck.configMap.function.chatroom.message.ocr.binary, _sck.configMap.function.chatroom.message.ocr.language, _sck.configMap.function.chatroom.message.ocr.obs, _sck.configMap.function.chatroom.message.ocr.translation.mapping, _sck.configMap.function.chatroom.message.qr.binary, _sck.configMap.function.chatroom.message.qr.obs, _sck.configMap.function.chatroom.message.react.enabled, _sck.configMap.function.chatroom.message.react.timelimit, _sck.configMap.function.chatroom.message.reply, _sck.configMap.function.chatroom.message.translation, _sck.configMap.function.chatroom.message.translation.language, _sck.configMap.function.chatroom.message.type.filter.enabled, _sck.configMap.function.chatroom.message.unsend, _sck.configMap.function.chatroom.message.unsend.mark, _sck.configMap.function.chatroom.message.unsend.oa, _sck.configMap.function.chatroom.message.unsend.premium.server.timelimit, _sck.configMap.function.chatroom.message.unsend.premium.timelimit, _sck.configMap.function.chatroom.message.unsend.server.timelimit, _sck.configMap.function.chatroom.message.unsend.timelimit, _sck.configMap.function.chatroom.message.video.auto_play, _sck.configMap.function.chatroom.message.voice.recorder, _sck.configMap.function.chatroom.message_edit.server.timelimit.keepmemo, _sck.configMap.function.chatroom.message_edit.server.timelimit.privatechat, _sck.configMap.function.chatroom.message_edit.timelimit.keepmemo, _sck.configMap.function.chatroom.message_edit.timelimit.privatechat, _sck.configMap.function.chatroom.moneylink.enable, _sck.configMap.function.chatroom.multiple.image.carousel, _sck.configMap.function.chatroom.multiple.image.grouping, _sck.configMap.function.chatroom.mute_message.guide.floatingchip, _sck.configMap.function.chatroom.mute_message.guide.tooltip, _sck.configMap.function.chatroom.non_friend_message.antifraud, _sck.configMap.function.chatroom.non_friend_message.antifraud_display_type, _sck.configMap.function.chatroom.non_friend_message.celeb_whitelist, _sck.configMap.function.chatroom.non_friend_message.chrome_antifraud, _sck.configMap.function.chatroom.patrolagent_feature, _sck.configMap.function.chatroom.plusmenu.icons, _sck.configMap.function.chatroom.portal_search, _sck.configMap.function.chatroom.premium.floating_chip.priority, _sck.configMap.function.chatroom.reaction.confirmation.enable, _sck.configMap.function.chatroom.report.melody, _sck.configMap.function.chatroom.settings.deletedata, _sck.configMap.function.chatroom.tooltip.pay_campaign, _sck.configMap.function.chattab.activity_module.enabled, _sck.configMap.function.chattab.ad_rc.banner.static_sizes, _sck.configMap.function.chattab.ad_rc.enabled, _sck.configMap.function.chattab.ad_rc.google_unit_id, _sck.configMap.function.chattab.ad_rc.logic, _sck.configMap.function.chattab.friends.birthday, _sck.configMap.function.chattab.friends.newlyaddedfriends, _sck.configMap.function.chattab.friendsubtab.gcs.enabled, _sck.configMap.function.chattab.friendsubtab.oa.recommend, _sck.configMap.function.chattab.friendsubtab.oa.recommend.ml.logic, _sck.configMap.function.chattab.grand_design.mode, _sck.configMap.function.chattab.grand_design.onboarding.enabled, _sck.configMap.function.chattab.headericon.calendar.enabled, _sck.configMap.function.chattab.mrb.enabled, _sck.configMap.function.chattab.payment.alert.enabled, _sck.configMap.function.chattab.profile.birthday_badge, _sck.configMap.function.chattab.recentlyupdated.duration, _sck.configMap.function.chattab.safetycheck.enabled, _sck.configMap.function.chattab.searchbar.enabled, _sck.configMap.function.chattab.service_chat.enabled, _sck.configMap.function.chattab.smartch.ad.test, _sck.configMap.function.chattab.smartch.ad.uiupdate_enabled, _sck.configMap.function.chattab.smartch.beacon_trigger_immediateization, _sck.configMap.function.chattab.smartch.beacon_trigger_ttl_sec, _sck.configMap.function.chattab.smartch.display_content_setting.enabled, _sck.configMap.function.chattab.smartch.fixed_display, _sck.configMap.function.chattab.smartch.ignore_instantnews, _sck.configMap.function.chattab.smartch.iicon.radiuschange_enabled, _sck.configMap.function.chattab.smartch.imp_detection_type, _sck.configMap.function.chattab.smartch.landscape.disabled, _sck.configMap.function.chattab.smartch.larger_smartch.ab_test, _sck.configMap.function.chattab.smartch.larger_smartch.enabled, _sck.configMap.function.chattab.smartch.overlay_expand_mode, _sck.configMap.function.chattab.smartch.overlay_when_swipe_down, _sck.configMap.function.chattab.smartch.prefetch.enabled, _sck.configMap.function.chattab.smartch.prefetch.retry.interval_sec, _sck.configMap.function.chattab.smartch.reload_before_view_did_appear.enabled, _sck.configMap.function.chattab.smartch.return_chatlist, _sck.configMap.function.chattab.smartch.sampling.log, _sck.configMap.function.chattab.smartch.trigger_when_mute, _sck.configMap.function.chattab.smartch.uen.overwrite, _sck.configMap.function.chattab.smartch.version, _sck.configMap.function.chattab.talkhead, _sck.configMap.function.chattab.talkhead.ad_only, _sck.configMap.function.chattab.talkhead.ad_only.advmute, _sck.configMap.function.chattab.talkhead.ad_only.imp, _sck.configMap.function.chattab.talkhead.ad_only.requestatt, _sck.configMap.function.chattab.talkhead.ad_only.service, _sck.configMap.function.chattab.ui.actionsheet, _sck.configMap.function.client.effect, _sck.configMap.function.client.effect.keywords, _sck.configMap.function.client.iab_auto_login, _sck.configMap.function.client_effect.compose.renderer.enabled, _sck.configMap.function.client_internal.adopt_core_data_store_for_bot_db, _sck.configMap.function.client_internal.adopt_core_data_store_for_contact_db, _sck.configMap.function.client_internal.adopt_core_data_store_for_socialgraph_db, _sck.configMap.function.client_internal.adopt_core_data_store_for_talk_db, _sck.configMap.function.client_internal.adopt_core_data_store_for_user_db, _sck.configMap.function.client_internal.allow_reset_db_corruption, _sck.configMap.function.client_internal.android_autobackup_scheduling_jitter, _sck.configMap.function.client_internal.android_disable_operation_batch, _sck.configMap.function.client_internal.android_max_log_count_per_day_for_ignored_operation, _sck.configMap.function.client_internal.android_max_log_count_per_day_for_process_received_op_error, _sck.configMap.function.client_internal.android_max_log_count_per_day_for_save_revision_error, _sck.configMap.function.client_internal.android_remove_work_database_on_fatal_error, _sck.configMap.function.client_internal.android_use_fts_module, _sck.configMap.function.client_internal.android_use_grouped_square_event_transaction, _sck.configMap.function.client_internal.android_use_unencrypted_db, _sck.configMap.function.client_internal.app_performance_tracking, _sck.configMap.function.client_internal.assetdownloader_new_obsclient, _sck.configMap.function.client_internal.call_from_contacts, _sck.configMap.function.client_internal.chat_effect.link, _sck.configMap.function.client_internal.collect_chatlist_performance_log, _sck.configMap.function.client_internal.desktop.h2, _sck.configMap.function.client_internal.desktop.openchat_pv, _sck.configMap.function.client_internal.desktop.sentry_sample_rate_crash, _sck.configMap.function.client_internal.desktop.sentry_sample_rate_log, _sck.configMap.function.client_internal.desktop_file_sent_log, _sck.configMap.function.client_internal.disable_deletion_of_corrupted_db_during_backup, _sck.configMap.function.client_internal.enable_anr_nelo_log, _sck.configMap.function.client_internal.enable_crashlytics, _sck.configMap.function.client_internal.enable_custom_logs_for_user_migration_ios, _sck.configMap.function.client_internal.enable_fetch_operation_logs, _sck.configMap.function.client_internal.enable_firebase_perfmon, _sck.configMap.function.client_internal.enable_merge_groupids_from_fetchop, _sck.configMap.function.client_internal.enable_nelo, _sck.configMap.function.client_internal.enable_nelo_native, _sck.configMap.function.client_internal.enable_new_receive_operation_processor, _sck.configMap.function.client_internal.enable_qrcamera_llb, _sck.configMap.function.client_internal.enable_qrcamera_mlkit, _sck.configMap.function.client_internal.enable_sentry_anr_log, _sck.configMap.function.client_internal.enable_sentry_apphangs_log, _sck.configMap.function.client_internal.enable_sentry_backup_cs, _sck.configMap.function.client_internal.enable_sentry_error_log, _sck.configMap.function.client_internal.enable_sentry_ndk_log, _sck.configMap.function.client_internal.enable_sentry_perf_log, _sck.configMap.function.client_internal.enable_sentry_trace_log, _sck.configMap.function.client_internal.enable_sentry_watchdog_log, _sck.configMap.function.client_internal.enable_use_only_picture_path_profileimage, _sck.configMap.function.client_internal.enable_user_database_migration_success_log_ios, _sck.configMap.function.client_internal.enable_video_hdr_to_sdr_tonemapping, _sck.configMap.function.client_internal.fetch_operation_v2, _sck.configMap.function.client_internal.google_assistant, _sck.configMap.function.client_internal.grpc_placesearch, _sck.configMap.function.client_internal.ios.chatlist_revamp_phase_1, _sck.configMap.function.client_internal.jumble_operations_whitelist, _sck.configMap.function.client_internal.kizuna_enable_chat_members_in_user_db, _sck.configMap.function.client_internal.kizuna_find_sync_contacts_v3_api, _sck.configMap.function.client_internal.kizuna_repair_address_book_names, _sck.configMap.function.client_internal.kizuna_sync_and_update_api, _sck.configMap.function.client_internal.live_activity_media_upload, _sck.configMap.function.client_internal.max_log_count_per_day_for_ignored_operation, _sck.configMap.function.client_internal.max_log_count_per_day_for_process_received_op_error, _sck.configMap.function.client_internal.message_restore_at_migration, _sck.configMap.function.client_internal.message_search_module_version, _sck.configMap.function.client_internal.network.sockopts, _sck.configMap.function.client_internal.obs.delayed_upload, _sck.configMap.function.client_internal.obs.use_socket, _sck.configMap.function.client_internal.opengl.method, _sck.configMap.function.client_internal.os_ignore_sigpipe, _sck.configMap.function.client_internal.phishing_site_detection_enabled, _sck.configMap.function.client_internal.ppy, _sck.configMap.function.client_internal.prevent_updating_created_time_evd, _sck.configMap.function.client_internal.remove_getcontacts_v2_cache, _sck.configMap.function.client_internal.report_flex_recommendation_time, _sck.configMap.function.client_internal.report_metrickit_payload.oable, _sck.configMap.function.client_internal.report_search_debuglog, _sck.configMap.function.client_internal.require_invitation_by_default, _sck.configMap.function.client_internal.resume_full_sync_from_message_id, _sck.configMap.function.client_internal.room_dogfooding, _sck.configMap.function.client_internal.sentry_apphang_timeout_ms, _sck.configMap.function.client_internal.sentry_full_rate_duration_days, _sck.configMap.function.client_internal.sentry_sample_rate_anr, _sck.configMap.function.client_internal.sentry_sample_rate_app_hang, _sck.configMap.function.client_internal.sentry_sample_rate_call_mac, _sck.configMap.function.client_internal.sentry_sample_rate_call_win, _sck.configMap.function.client_internal.sentry_sample_rate_debug_level, _sck.configMap.function.client_internal.sentry_sample_rate_error, _sck.configMap.function.client_internal.sentry_sample_rate_error_level, _sck.configMap.function.client_internal.sentry_sample_rate_fatal_level, _sck.configMap.function.client_internal.sentry_sample_rate_info_level, _sck.configMap.function.client_internal.sentry_sample_rate_profile, _sck.configMap.function.client_internal.sentry_sample_rate_trace, _sck.configMap.function.client_internal.sentry_sample_rate_viewer_win, _sck.configMap.function.client_internal.sentry_sample_rate_warn_level, _sck.configMap.function.client_internal.server_push_sync, _sck.configMap.function.client_internal.skip_contact_group_sync_in_registration, _sck.configMap.function.client_internal.split_screen_blocked_devices, _sck.configMap.function.client_internal.sync_group_members_in_evd, _sck.configMap.function.client_internal.talk_database_migration, _sck.configMap.function.client_internal.track_encrypted_user_defaults_failure_rate, _sck.configMap.function.client_internal.url_preview_cache_period, _sck.configMap.function.client_internal.url_preview_disabled, _sck.configMap.function.client_internal.url_usage_tracking.enabled, _sck.configMap.function.client_internal.use_assetdownloader, _sck.configMap.function.client_internal.use_async_chat_list, _sck.configMap.function.client_internal.use_async_diffable_chat_messages, _sck.configMap.function.client_internal.use_chat_folder_swipe, _sck.configMap.function.client_internal.use_chat_messages_store, _sck.configMap.function.client_internal.use_chat_module_v2, _sck.configMap.function.client_internal.use_custom_chatroom_header, _sck.configMap.function.client_internal.use_elsa_camera, _sck.configMap.function.client_internal.use_getcontacts_v2, _sck.configMap.function.client_internal.use_getcontacts_v3, _sck.configMap.function.client_internal.use_kizuna_relation_api, _sck.configMap.function.client_internal.use_legy_h2, _sck.configMap.function.client_internal.use_message_markdown, _sck.configMap.function.client_internal.use_native_search_image_store, _sck.configMap.function.client_internal.use_navigation_scheme_v2, _sck.configMap.function.client_internal.use_new_core_data_stack, _sck.configMap.function.client_internal.use_new_group_database, _sck.configMap.function.client_internal.use_new_last_message_label, _sck.configMap.function.client_internal.use_new_line_photos, _sck.configMap.function.client_internal.use_new_line_photos_album, _sck.configMap.function.client_internal.use_new_message_cell_update, _sck.configMap.function.client_internal.use_new_message_model, _sck.configMap.function.client_internal.use_new_room, _sck.configMap.function.client_internal.use_new_service_configuration.album, _sck.configMap.function.client_internal.use_new_text_builder, _sck.configMap.function.client_internal.use_new_zipfoundation, _sck.configMap.function.client_internal.use_newcontext_for_message_restoration, _sck.configMap.function.client_internal.use_obs_module_v2, _sck.configMap.function.client_internal.use_push_tracking_file_logs, _sck.configMap.function.client_internal.use_qrcamera_ui_module, _sck.configMap.function.client_internal.use_resource_referrer, _sck.configMap.function.client_internal.use_share_module_v2, _sck.configMap.function.client_internal.use_split_contact_db, _sck.configMap.function.client_internal.use_sqlite_module_v2, _sck.configMap.function.client_internal.use_swift_channelscheme, _sck.configMap.function.client_internal.use_system_socket_factory, _sck.configMap.function.client_internal.use_url_preview_module, _sck.configMap.function.client_internal.use_url_session_networking, _sck.configMap.function.client_internal.use_video_player_v2, _sck.configMap.function.client_internal.use_video_transcoder, _sck.configMap.function.client_internal.use_wrong_large_screen_logger, _sck.configMap.function.client_internal.use_zipfoundation, _sck.configMap.function.client_internal.user_database_migration_max_retry_count_ios, _sck.configMap.function.client_internal.user_database_migration_should_fallback_on_mismatch_ios, _sck.configMap.function.client_internal.userdefault_encryption_mode, _sck.configMap.function.coin.show_point_as_coin, _sck.configMap.function.commercetab.gnb_badge_schedule, _sck.configMap.function.commercetab.lpid.integrate.url, _sck.configMap.function.commercetab.snackbar.gift.url, _sck.configMap.function.commercetab.snackbar.yshp.url, _sck.configMap.function.commercetab.topnavi.agenti.url, _sck.configMap.function.commercetab.topnavi.gift.url, _sck.configMap.function.commercetab.topnavi.lshp.url, _sck.configMap.function.commercetab.wishlist.gift.url, _sck.configMap.function.commercetab.wishlist.lshp.url, _sck.configMap.function.commercetab.wishlist.yshp.url, _sck.configMap.function.cube.desktop.poll.channel, _sck.configMap.function.cube.desktop.poll.landing_url, _sck.configMap.function.cube.desktop.poll_url, _sck.configMap.function.cube.group_event, _sck.configMap.function.cube.group_event.square, _sck.configMap.function.cube.group_event.url, _sck.configMap.function.cube.jungle_pang, _sck.configMap.function.cube.jungle_pang.url, _sck.configMap.function.cube.ladder_shuffle, _sck.configMap.function.cube.ladder_shuffle.url, _sck.configMap.function.cube.square.bot, _sck.configMap.function.cube.square.bot.url, _sck.configMap.function.cube.square.permission, _sck.configMap.function.cube.square.permission.url, _sck.configMap.function.cube.square.stats.url, _sck.configMap.function.cube.translator, _sck.configMap.function.cube.translator.url, _sck.configMap.function.cube.youtube, _sck.configMap.function.cube.youtube.url, _sck.configMap.function.e2ee, _sck.configMap.function.e2ee.group, _sck.configMap.function.e2ee.hidden_preview_for_all_message, _sck.configMap.function.e2ee.hide_lettersealing_menu, _sck.configMap.function.e2ee.indicator, _sck.configMap.function.e2ee.key_backup, _sck.configMap.function.e2ee.key_backup_period, _sck.configMap.function.e2ee.key_restore, _sck.configMap.function.e2ee.push_using_regular, _sck.configMap.function.e2ee.push_using_voip, _sck.configMap.function.e2ee.report.voip_push_rate, _sck.configMap.function.e2ee.settings_default, _sck.configMap.function.elsa.qoe.enable.modelloading, _sck.configMap.function.elsa.qoe.enable.profiling, _sck.configMap.function.elsa.qoe.modelloading.sentry.enable, _sck.configMap.function.elsa.uts.qoe.enable.profiling, _sck.configMap.function.elsa.vision.solution.type, _sck.configMap.function.esc-test-real.configkey.test, _sck.configMap.function.eticket, _sck.configMap.function.eticket.api.url, _sck.configMap.function.eticket.web.url, _sck.configMap.function.event.geofence, _sck.configMap.function.extimage.line, _sck.configMap.function.extimage.ycon, _sck.configMap.function.extimage.ycon.url, _sck.configMap.function.file.extension.whitelist, _sck.configMap.function.file.original, _sck.configMap.function.freecall.allow_one_way_friend, _sck.configMap.function.freecall.rating.block, _sck.configMap.function.freecall.rating.ratio, _sck.configMap.function.freecall.show_promotion, _sck.configMap.function.friendtab.addfriend.shakeit, _sck.configMap.function.friendtab.addfriend.simplify, _sck.configMap.function.friendtab.index, _sck.configMap.function.friendtab.ui.actionsheet, _sck.configMap.function.gcs.android.flex.compose.enabled, _sck.configMap.function.gcs.flush.sampling.log, _sck.configMap.function.gcs.performance.sampling.log, _sck.configMap.function.giftshop, _sck.configMap.function.giftshop.url, _sck.configMap.function.global_home.birthday_effect, _sck.configMap.function.global_home.file_expiration.duration_days, _sck.configMap.function.global_home.file_expiration.lookback_window_days, _sck.configMap.function.global_home.friends_list_tooltip, _sck.configMap.function.global_home.onboarding, _sck.configMap.function.global_home.scroll_affordance.enable, _sck.configMap.function.glp.active, _sck.configMap.function.glp.nickname, _sck.configMap.function.group.auto_accept, _sck.configMap.function.group.create.onestep, _sck.configMap.function.group.create.policy, _sck.configMap.function.group.create.shortpath, _sck.configMap.function.group.longertitle.length, _sck.configMap.function.groupcall, _sck.configMap.function.groupcall.live, _sck.configMap.function.groupcall.meeting, _sck.configMap.function.groupcall.meeting.ageverification, _sck.configMap.function.groupcall.rating.block, _sck.configMap.function.groupcall.rating.ratio, _sck.configMap.function.groupcall.reaction.button, _sck.configMap.function.groupcall.video, _sck.configMap.function.groupchat.chat_meta_only_enabled, _sck.configMap.function.groupchat.dynamic_group_title, _sck.configMap.function.groupchat.enable_chat_ticket, _sck.configMap.function.groupchat.enable_chat_ticket_promotion, _sck.configMap.function.groupchat.group_max_members, _sck.configMap.function.groupchat.max_chats_per_user, _sck.configMap.function.groupchat.mention.oa, _sck.configMap.function.groupchat.optional_chat_title, _sck.configMap.function.groupchat.room_max_members, _sck.configMap.function.groupchat.roomchat_enabled, _sck.configMap.function.hiddenchat, _sck.configMap.function.hometab, _sck.configMap.function.hometab.account_center.tooltip.enabled, _sck.configMap.function.hometab.ad_rc.banner.static_sizes, _sck.configMap.function.hometab.ad_rc.enabled, _sck.configMap.function.hometab.ad_rc.google_unit_id, _sck.configMap.function.hometab.ad_rc.logic, _sck.configMap.function.hometab.ads.displayrate, _sck.configMap.function.hometab.ads.displayrate.bottom, _sck.configMap.function.hometab.birthday_display, _sck.configMap.function.hometab.effect, _sck.configMap.function.hometab.effect.seasonal, _sck.configMap.function.hometab.effect_cdn_url, _sck.configMap.function.hometab.friendicon.enabled, _sck.configMap.function.hometab.friends.birthday, _sck.configMap.function.hometab.friends.birthday.giftpage, _sck.configMap.function.hometab.friendsection.enabled, _sck.configMap.function.hometab.gcs.enabled, _sck.configMap.function.hometab.grand_design.modal.interval, _sck.configMap.function.hometab.grand_design.modal.url, _sck.configMap.function.hometab.header.notification.version, _sck.configMap.function.hometab.hometab.recommendation.gnbbadge.enabled, _sck.configMap.function.hometab.hotdeal.display.time, _sck.configMap.function.hometab.hotdeal.lyp.url, _sck.configMap.function.hometab.hotdeal.maxnumber, _sck.configMap.function.hometab.hotdeal.request.interval_sec, _sck.configMap.function.hometab.lyp.premium.fixed, _sck.configMap.function.hometab.lyp.premium.fixed.label, _sck.configMap.function.hometab.minorregions, _sck.configMap.function.hometab.notification.hub, _sck.configMap.function.hometab.notification.setting.birthday.enabled, _sck.configMap.function.hometab.performance.sampling.log, _sck.configMap.function.hometab.recentlyupdated.duration, _sck.configMap.function.hometab.recommendation.floating.enabled, _sck.configMap.function.hometab.retry.interval_sec, _sck.configMap.function.hometab.safetycheck.enabled, _sck.configMap.function.hometab.servicelist.v4.display, _sck.configMap.function.hometab.servicelist.v4.miniapp.maxnumber, _sck.configMap.function.hometab.servicetab.banner, _sck.configMap.function.hometab.servicetab.recently.value, _sck.configMap.function.hometab.servicetab.spot, _sck.configMap.function.hometab.subprofile.entry.enabled, _sck.configMap.function.hometab.ui.integratedsubtab, _sck.configMap.function.hometab.urlhistory.display, _sck.configMap.function.hometab.v2.friendsonly, _sck.configMap.function.hometab.v2.ladgbanner.display, _sck.configMap.function.hometab.v2.recommendation.displayflex, _sck.configMap.function.hometab.v2.recommendation.displaymode, _sck.configMap.function.hometab.v2.recommendation.enabled, _sck.configMap.function.hometab.v2.servicelist.display, _sck.configMap.function.hometab.v3ABtest, _sck.configMap.function.hometab.version, _sck.configMap.function.iab.footer_menu_bar, _sck.configMap.function.iab.minimize, _sck.configMap.function.iab.search_bar, _sck.configMap.function.image.show_progress_size, _sck.configMap.function.image.support.livephoto, _sck.configMap.function.invoice.qrscan.action_url, _sck.configMap.function.invoice.qrscan.pattern, _sck.configMap.function.keep.enabled, _sck.configMap.function.keep.endnotice, _sck.configMap.function.keep.endnotice.text, _sck.configMap.function.keep.keepchat, _sck.configMap.function.keep.promote_update, _sck.configMap.function.lab, _sck.configMap.function.lab.callrecording, _sck.configMap.function.lab.callstt, _sck.configMap.function.lab.chat_ai, _sck.configMap.function.lab.chatfolder, _sck.configMap.function.lab.chatroom_search, _sck.configMap.function.lab.contents_suggest, _sck.configMap.function.lab.font, _sck.configMap.function.lab.font.list, _sck.configMap.function.lab.media_search, _sck.configMap.function.lab.media_search.image_model, _sck.configMap.function.lab.message_edit, _sck.configMap.function.lab.pip, _sck.configMap.function.lab.premium_friends_management, _sck.configMap.function.lab.refine_message, _sck.configMap.function.lab.safari, _sck.configMap.function.lab.scheduling_agent, _sck.configMap.function.lab.silent_message, _sck.configMap.function.lab.silent_message_notice, _sck.configMap.function.lab.video_highlight_wizard, _sck.configMap.function.lab.voice_search, _sck.configMap.function.lad.common_memory_caching_hometab, _sck.configMap.function.lad.common_memory_caching_openchat, _sck.configMap.function.lad.common_memory_caching_voom, _sck.configMap.function.lad.container_tracker_album, _sck.configMap.function.lad.container_tracker_digest, _sck.configMap.function.lad.container_tracker_home, _sck.configMap.function.lad.container_tracker_openchat, _sck.configMap.function.lad.container_tracker_smartch, _sck.configMap.function.lad.container_tracker_talkroom, _sck.configMap.function.lad.container_tracker_voom, _sck.configMap.function.lad.container_tracker_voom_ios_feed, _sck.configMap.function.lad.container_tracker_wallet, _sck.configMap.function.lad.coredata_businessqueue, _sck.configMap.function.lad.desktop_is_lgfp, _sck.configMap.function.lad.disable_displaylink_background, _sck.configMap.function.lad.function.lad.viewer_impression_tracker, _sck.configMap.function.lad.home_is_lgfp, _sck.configMap.function.lad.lad.video_buffertime, _sck.configMap.function.lad.openchat_is_lgfp, _sck.configMap.function.lad.skad_impression, _sck.configMap.function.lad.timeline_is_lgfp, _sck.configMap.function.lad.timeline_videoplayer, _sck.configMap.function.lad.vast_trackingevents, _sck.configMap.function.lad.videoevent_measurement, _sck.configMap.function.lad.voom_autoplay_image, _sck.configMap.function.lad.voom_autoplay_video, _sck.configMap.function.lad.voom_video_prefetch, _sck.configMap.function.lad.wallet_is_lgfp, _sck.configMap.function.lad.wallet_videoplayer, _sck.configMap.function.lfl.experiment_setting, _sck.configMap.function.lfl.platform.activated, _sck.configMap.function.lfl.smart_sticker_suggest, _sck.configMap.function.lfl.smart_sticker_suggest.activated, _sck.configMap.function.lfl.smart_sticker_suggest.label_score_threshold, _sck.configMap.function.lfl.smart_sticker_suggest.maximum_labels, _sck.configMap.function.lfl.sticker_autosuggest, _sck.configMap.function.lfl.sticker_autosuggest.activated, _sck.configMap.function.lfl.sticker_autosuggest_premium, _sck.configMap.function.liff.actionsheet.v2, _sck.configMap.function.liff.darkmode_support_in_subwindow, _sck.configMap.function.liff.favorite_nudge.dismiss_cooldown_hours, _sck.configMap.function.liff.favorite_nudge.history_reentry, _sck.configMap.function.liff.favorite_nudge.per_app_lifetime_cap, _sck.configMap.function.liff.favorite_nudge.per_duration_nudge_cap, _sck.configMap.function.liff.favorite_nudge.remove_cooldown_hours, _sck.configMap.function.liff.favorite_nudge.repeat_use, _sck.configMap.function.liff.favorite_nudge.repeat_use_min_count, _sck.configMap.function.liff.fido, _sck.configMap.function.liff.hide_close_button_in_subwindow, _sck.configMap.function.liff.incremental_consent_ui_abt, _sck.configMap.function.liff.init_performance_log, _sck.configMap.function.liff.ios_return_chatid_null, _sck.configMap.function.liff.ios_unify_url_handling, _sck.configMap.function.liff.ipad_fire_lifecycle_event_in_bg, _sck.configMap.function.liff.liff_transition_autologin_without_redirects, _sck.configMap.function.liff.mapp_dar_age_gates, _sck.configMap.function.liff.minimize, _sck.configMap.function.liff.multitab.number_of_maximum_all_tabs, _sck.configMap.function.liff.multitab.number_of_webviewinstance_maintained, _sck.configMap.function.liff.new_ua_implementation, _sck.configMap.function.liff.out_of_liff_popup, _sck.configMap.function.liff.render_performance_log, _sck.configMap.function.liff.urlhistory.display, _sck.configMap.function.liff.wallettab_mini_tooltip, _sck.configMap.function.limes_edge_ai.stt.collection_id_and_versions, _sck.configMap.function.limit.sync.incrementalbackupindexentries, _sck.configMap.function.limit.sync.incrementalbackupmessages, _sck.configMap.function.limit.sync.messageboxes, _sck.configMap.function.limit.sync.notificationsettings, _sck.configMap.function.limit.sync.read.ranges, _sck.configMap.function.limit.sync.relation.blocks, _sck.configMap.function.limit.sync.relation.contactcalendarevents, _sck.configMap.function.limit.sync.relation.friends, _sck.configMap.function.limit.sync.relation.recommendations, _sck.configMap.function.limit.sync.relation.targetprofiles, _sck.configMap.function.line_at.local_info, _sck.configMap.function.line_at.local_info.url, _sck.configMap.function.line_at.near_search, _sck.configMap.function.line_at.near_search.url, _sck.configMap.function.line_home.activity.fixed_services.suppress_gnb_reddot, _sck.configMap.function.line_home.auto_tab_landing, _sck.configMap.function.line_home.auto_tab_landing.reset_hour, _sck.configMap.function.line_home.flush_uts_impression, _sck.configMap.function.line_home.friends_list_close, _sck.configMap.function.line_home.mvp.friends_list_tooltip, _sck.configMap.function.line_home.mvp.onboarding, _sck.configMap.function.line_home.scroll_affordance.enable, _sck.configMap.function.line_home.scroll_affordance.test, _sck.configMap.function.line_iap_platform.agreement_tou.version, _sck.configMap.function.line_iap_platform.enabled, _sck.configMap.function.line_iap_platform.purchasehistory, _sck.configMap.function.lineapp_setting.notification.on.banner, _sck.configMap.function.lineapp_setting.passkey, _sck.configMap.function.lineapp_setting.search.help_center_articles, _sck.configMap.function.linepay, _sck.configMap.function.linepay.chatroom.menu, _sck.configMap.function.linepay.enable_notification, _sck.configMap.function.linepay.improvement.launcher.enabled, _sck.configMap.function.linepay.transferportal.epi.chat.url, _sck.configMap.function.linepay.transferportal.epi.url, _sck.configMap.function.linepay.transferportal.url, _sck.configMap.function.linepay.web.interface.allow.regex, _sck.configMap.function.linethings, _sck.configMap.function.low_data_mode.request_datamode_when_launches, _sck.configMap.function.ly_shared_storage.consumer_signature_whitelist, _sck.configMap.function.maintab.commercetab, _sck.configMap.function.maintab.commercetab.onboarding, _sck.configMap.function.maintab.commercetwtab, _sck.configMap.function.maintab.function.maintab.newstab.widget.searchurl, _sck.configMap.function.maintab.grand_design.mode, _sck.configMap.function.maintab.line_home, _sck.configMap.function.maintab.line_home_global, _sck.configMap.function.maintab.minitab, _sck.configMap.function.maintab.newsrowtab.enable, _sck.configMap.function.maintab.newsrowtab.publisher_id, _sck.configMap.function.maintab.newsrowtab.tos_items, _sck.configMap.function.maintab.newstab.enable_gma_webview_ads_api, _sck.configMap.function.maintab.newstab.enable_switch_bridge_version, _sck.configMap.function.maintab.newstab.iab_search_bar, _sck.configMap.function.maintab.newstab.ipad, _sck.configMap.function.maintab.newstab.notification_url, _sck.configMap.function.maintab.newstab.search_bar_keyword.rolling_interval_ms, _sck.configMap.function.maintab.newstab.search_bar_type, _sck.configMap.function.maintab.newstab.search_type, _sck.configMap.function.maintab.newstab.tooltip.profile.enabled, _sck.configMap.function.maintab.openchat_tab, _sck.configMap.function.maintab.portaltab, _sck.configMap.function.maintab.servicetab.pod, _sck.configMap.function.maintab.servicetab.pod.channel, _sck.configMap.function.media.image_high, _sck.configMap.function.media.image_medium, _sck.configMap.function.media.message.flow.v2.audio, _sck.configMap.function.media.message.flow.v2.file, _sck.configMap.function.media.message.flow.v2.image, _sck.configMap.function.media.message.flow.v2.video, _sck.configMap.function.media.transfer_quality, _sck.configMap.function.media.transfer_quality_high, _sck.configMap.function.media.transfer_quality_low, _sck.configMap.function.media.transfer_quality_medium, _sck.configMap.function.minitab.campaign.enabled, _sck.configMap.function.minitab.common.tutorial, _sck.configMap.function.minitab.module.layout.api.enabled, _sck.configMap.function.minitab.module.order, _sck.configMap.function.moa.album, _sck.configMap.function.moa.album.ad.enabled, _sck.configMap.function.moa.album.ad.list_inventory_key, _sck.configMap.function.moa.album.zoom.enabled, _sck.configMap.function.moretab.oa_recommend, _sck.configMap.function.moretab.sticker_popular, _sck.configMap.function.moretab.sticker_popular.lifetime, _sck.configMap.function.music, _sck.configMap.function.music.install_url, _sck.configMap.function.music.launch_url, _sck.configMap.function.music.package_name, _sck.configMap.function.music.service, _sck.configMap.function.music.use_melody_bgm, _sck.configMap.function.my_home.addfriend.reject.crossregion, _sck.configMap.function.my_home.ai_image.original_cropratio, _sck.configMap.function.my_home.ai_image.original_facesize_min, _sck.configMap.function.my_home.oa_profile.url, _sck.configMap.function.my_home.profile.ai_avatar_open, _sck.configMap.function.my_home.profile.ai_studio, _sck.configMap.function.my_home.profile.ai_studio.vana_face.score, _sck.configMap.function.my_home.profile.ai_studio_nbadge, _sck.configMap.function.my_home.profile.ai_studio_open, _sck.configMap.function.my_home.profile.antifraud.banner, _sck.configMap.function.my_home.profile.antifraud.chromebanner, _sck.configMap.function.my_home.profile.antifraud_phase2.banner, _sck.configMap.function.my_home.profile.avatar_acrz, _sck.configMap.function.my_home.profile.birthday_icon, _sck.configMap.function.my_home.profile.custom_font, _sck.configMap.function.my_home.profile.deco.style_media_version, _sck.configMap.function.my_home.profile.friends.postmenu, _sck.configMap.function.my_home.profile.melody_bgm, _sck.configMap.function.my_home.profile.music.liffplayer, _sck.configMap.function.my_home.profile.music.line_music_integration, _sck.configMap.function.my_home.profile.mv_cover, _sck.configMap.function.my_home.profile.my.postmenu, _sck.configMap.function.my_home.profile.new_oa, _sck.configMap.function.my_home.profile.nft_badge, _sck.configMap.function.my_home.profile.sharetostory.ignorelastsetting, _sck.configMap.function.my_home.profile.status_message_story, _sck.configMap.function.my_home.profile.story, _sck.configMap.function.nearby, _sck.configMap.function.nearby.match_count, _sck.configMap.function.nearby.range_in_km, _sck.configMap.function.network.use_legy_fast_write, _sck.configMap.function.note.ad.enabled, _sck.configMap.function.note.ad.end_inventory_key, _sck.configMap.function.note.ad.list_inventory_key, _sck.configMap.function.note.ad.renovation_sdk.enabled, _sck.configMap.function.note.change_media_download.cdn_to_obs, _sck.configMap.function.note.openchat_search.enabled, _sck.configMap.function.note.support_pn_notice_banner, _sck.configMap.function.note.support_pn_video_filter, _sck.configMap.function.note.support_video_upload, _sck.configMap.function.obs.use_obs_client_v2, _sck.configMap.function.official_account.badge_rebranding, _sck.configMap.function.official_account.clean_message_null_character_ios, _sck.configMap.function.official_account.dt_antifraud, _sck.configMap.function.official_account.event_sticker_block_control.release_scope, _sck.configMap.function.official_account.event_sticker_block_control.target_mids, _sck.configMap.function.official_account.line_touch, _sck.configMap.function.official_account.membership, _sck.configMap.function.official_account.message_annotation, _sck.configMap.function.official_account.profile_region, _sck.configMap.function.official_account.rich_ui, _sck.configMap.function.official_account.talkroom_ad, _sck.configMap.function.official_account.talkroom_ad.close_duration_in_min, _sck.configMap.function.official_account.talkroom_ad.introduction_url, _sck.configMap.function.official_account.talkroom_event_tracking, _sck.configMap.function.official_account.talkroom_warning, _sck.configMap.function.official_account.talkroom_warning.report_button, _sck.configMap.function.official_account.webapp, _sck.configMap.function.official_account.webapp.url, _sck.configMap.function.placesearch.foursquare.auto_search_interval, _sck.configMap.function.placesearch.google.auto_search_interval, _sck.configMap.function.plusmenu.group, _sck.configMap.function.plusmenu.onetoone, _sck.configMap.function.plusmenu.option.contact.mybridge, _sck.configMap.function.plusmenu.paypay_for_1on1.use_liff, _sck.configMap.function.plusmenu.paypay_for_group.use_liff, _sck.configMap.function.plusmenu.room, _sck.configMap.function.plusmenu.scheduling_agent, _sck.configMap.function.plusmenu.square, _sck.configMap.function.poi.kingway.auto_search_interval, _sck.configMap.function.poi.yahoojapan.auto_search_interval, _sck.configMap.function.poll, _sck.configMap.function.poll.url, _sck.configMap.function.popup.apprating.friendstab, _sck.configMap.function.popup.apprating.moretab, _sck.configMap.function.popup.apprating.profile, _sck.configMap.function.popup.apprating.timeline, _sck.configMap.function.popup.battery_restrict_type, _sck.configMap.function.popup.update_tel_no, _sck.configMap.function.premium.common.addedyou, _sck.configMap.function.premium.common.album, _sck.configMap.function.premium.common.album.agreement.lan, _sck.configMap.function.premium.common.album.agreement.version, _sck.configMap.function.premium.common.android_guideline_url, _sck.configMap.function.premium.common.appicon.enabled, _sck.configMap.function.premium.common.appicon.list, _sck.configMap.function.premium.common.appicon.notice.tooltip, _sck.configMap.function.premium.common.appicon.updatepopup.key, _sck.configMap.function.premium.common.appicon.use_cms, _sck.configMap.function.premium.common.backup, _sck.configMap.function.premium.common.badge.nonsubscriber, _sck.configMap.function.premium.common.badge.subscriber, _sck.configMap.function.premium.common.benefit_url, _sck.configMap.function.premium.common.chat.expired.banner.cross_exposure, _sck.configMap.function.premium.common.chat.message_edit, _sck.configMap.function.premium.common.chat.message_edit.edited_mark_entry, _sck.configMap.function.premium.common.chat.message_entry.album, _sck.configMap.function.premium.common.cms_popup, _sck.configMap.function.premium.common.datastore_performance_monitoring.enabled, _sck.configMap.function.premium.common.font, _sck.configMap.function.premium.common.font.cms_popup.enabled, _sck.configMap.function.premium.common.font.lyp_badge, _sck.configMap.function.premium.common.font.new_badge, _sck.configMap.function.premium.common.help_url, _sck.configMap.function.premium.common.home_cta_button_test, _sck.configMap.function.premium.common.home_url, _sck.configMap.function.premium.common.home_url.netflix, _sck.configMap.function.premium.common.ios_guideline_url, _sck.configMap.function.premium.common.lite_entry.enjoy, _sck.configMap.function.premium.common.manage_nonsubscription_url, _sck.configMap.function.premium.common.manage_subscription_url, _sck.configMap.function.premium.common.message_edit.agreement.lan, _sck.configMap.function.premium.common.message_edit.agreement.version, _sck.configMap.function.premium.common.message_scheduling.agreement.lan, _sck.configMap.function.premium.common.message_scheduling.agreement.version, _sck.configMap.function.premium.common.music.lite_enjoy_display, _sck.configMap.function.premium.common.mute_message, _sck.configMap.function.premium.common.mute_message.agreement.version, _sck.configMap.function.premium.common.netflix_entry, _sck.configMap.function.premium.common.oa, _sck.configMap.function.premium.common.planchange_url, _sck.configMap.function.premium.common.premiumblock, _sck.configMap.function.premium.common.profilemodal.nonsubscriber, _sck.configMap.function.premium.common.restore_url, _sck.configMap.function.premium.common.rtrbt.lyp_badge, _sck.configMap.function.premium.common.scroll_preview, _sck.configMap.function.premium.common.service, _sck.configMap.function.premium.common.settings.new_order, _sck.configMap.function.premium.common.splash, _sck.configMap.function.premium.common.subprofile.agreement.lan, _sck.configMap.function.premium.common.subprofile.agreement.version, _sck.configMap.function.premium.common.subprofile.enabled, _sck.configMap.function.premium.common.subprofile.groupchat_create, _sck.configMap.function.premium.common.subprofile.groupchat_memberlist, _sck.configMap.function.premium.common.subprofile.lyp_flow, _sck.configMap.function.premium.common.subprofile.profile_list, _sck.configMap.function.premium.common.subprofile.readonly, _sck.configMap.function.premium.common.subprofile.recently_updated_profile, _sck.configMap.function.premium.common.subprofile.recently_updated_profile_tooltip, _sck.configMap.function.premium.common.subprofile.supported_region_list, _sck.configMap.function.premium.common.subscription_group_id, _sck.configMap.function.premium.common.tou_services_url, _sck.configMap.function.premium.common.unfinished_transaction_recovery, _sck.configMap.function.premium.common.unsend, _sck.configMap.function.premium.common.unsend.agreement.lan, _sck.configMap.function.premium.common.unsend.agreement.version, _sck.configMap.function.premium.common.unsend.system.link, _sck.configMap.function.premium.common.unsend.timeoutpopup.type, _sck.configMap.function.premium.common.userprofile.premium_benefit, _sck.configMap.function.premium.common.welcome_url, _sck.configMap.function.premium.common.welcome_url.planchange, _sck.configMap.function.premium.lyp.album, _sck.configMap.function.premium.lyp.linked_service_domains, _sck.configMap.function.premium.lyp.service, _sck.configMap.function.premium.lyp.special_campaign_codes, _sck.configMap.function.privacy.allow.follow.default, _sck.configMap.function.privacy.app_tracking_transparency.enabled, _sck.configMap.function.privacy.app_tracking_transparency.prepopup.enabled, _sck.configMap.function.privacy.location.information, _sck.configMap.function.privacy.location.postponement.duration, _sck.configMap.function.privacy.location.upgrade.required, _sck.configMap.function.privacy.location.version, _sck.configMap.function.privacy.policy.postponement.duration, _sck.configMap.function.privacy.policy.upgrade.required, _sck.configMap.function.privacy.policy.version, _sck.configMap.function.privacy.policy.zap.redirect, _sck.configMap.function.privacy.settings, _sck.configMap.function.privacy.settings.ad_personalize_center_url, _sck.configMap.function.privacy.settings.oa_ai.required_version, _sck.configMap.function.privacy.share.personal.info, _sck.configMap.function.privacy.share.personal.info.menu, _sck.configMap.function.privacy.show.follow.list.default, _sck.configMap.function.privacy.status.message.history.default, _sck.configMap.function.profile_plus, _sck.configMap.function.profile_plus.url, _sck.configMap.function.provided_data.beacon.report, _sck.configMap.function.provided_data.location.interval_seconds, _sck.configMap.function.provided_data.location.min_refresh_distance_m, _sck.configMap.function.provided_data.location.min_refresh_interval_s, _sck.configMap.function.provided_data.wifi.report, _sck.configMap.function.push.apns.background_notification, _sck.configMap.function.push.birthday_os_push.action_uri, _sck.configMap.function.push.birthday_os_push.affinity_threshold, _sck.configMap.function.push.birthday_os_push.content, _sck.configMap.function.push.birthday_os_push.enabled, _sck.configMap.function.push.birthday_os_push.icon_url, _sck.configMap.function.push.birthday_os_push.title, _sck.configMap.function.push.ee_field_android, _sck.configMap.function.push.normal_apns_expiration_sec, _sck.configMap.function.push.remove_content_available, _sck.configMap.function.push.report, _sck.configMap.function.push.rollout.apns_background, _sck.configMap.function.push.unsend_message_using_regular, _sck.configMap.function.push.use_fcm_v1, _sck.configMap.function.push.use_os_push_phase2, _sck.configMap.function.pushsphere.rollout.apns_silent, _sck.configMap.function.pushsphere.rollout.category.album, _sck.configMap.function.pushsphere.rollout.category.call, _sck.configMap.function.pushsphere.rollout.category.chat, _sck.configMap.function.pushsphere.rollout.category.contact, _sck.configMap.function.pushsphere.rollout.category.echo_push, _sck.configMap.function.pushsphere.rollout.category.message, _sck.configMap.function.pushsphere.rollout.category.message_square, _sck.configMap.function.pushsphere.rollout.category.music, _sck.configMap.function.pushsphere.rollout.category.none, _sck.configMap.function.pushsphere.rollout.category.noticenter, _sck.configMap.function.pushsphere.rollout.category.pay, _sck.configMap.function.pushsphere.rollout.category.square, _sck.configMap.function.repair.auto, _sck.configMap.function.repair.auto.logtype, _sck.configMap.function.repair.auto.profile_and_settings, _sck.configMap.function.repair.fullsync_on_decoding_thrift_failure, _sck.configMap.function.repair.manual.max_chats, _sck.configMap.function.repair.unbound_users, _sck.configMap.function.reservation, _sck.configMap.function.reservation.url, _sck.configMap.function.schedule, _sck.configMap.function.schedule.url, _sck.configMap.function.search.autocomplete.enable, _sck.configMap.function.search.autocomplete.max_queue, _sck.configMap.function.search.autocomplete.min_interval, _sck.configMap.function.search.context_search, _sck.configMap.function.search.default_show, _sck.configMap.function.search.group_member_search, _sck.configMap.function.search.iab_log.enable, _sck.configMap.function.search.korean_initial_consonant_search, _sck.configMap.function.search.liff, _sck.configMap.function.search.liff.url, _sck.configMap.function.search.line_ai_entry.enabled, _sck.configMap.function.search.location_info_agreement, _sck.configMap.function.search.log.to_web_search, _sck.configMap.function.search.native, _sck.configMap.function.search.native.entry_collection_search, _sck.configMap.function.search.native.see_other_results, _sck.configMap.function.search.native.url, _sck.configMap.function.search.popular_category, _sck.configMap.function.search.portal_search_rolling_keyword.enabled, _sck.configMap.function.search.portal_search_rolling_keyword.url, _sck.configMap.function.search.search_bar_keyword.update, _sck.configMap.function.search.show_portal_search_btn, _sck.configMap.function.search.show_searchtab, _sck.configMap.function.search.web, _sck.configMap.function.search.yj.search_url, _sck.configMap.function.search.yj.suggest.appid, _sck.configMap.function.search.yj.suggest.src, _sck.configMap.function.search.yj.suggest.url, _sck.configMap.function.security.ltee, _sck.configMap.function.security.ltee.encryption.message, _sck.configMap.function.shake, _sck.configMap.function.shake.custom_event, _sck.configMap.function.shake.custom_event_url, _sck.configMap.function.square.ad.lad_fallback.type.private, _sck.configMap.function.square.ad.lad_fallback.type.public, _sck.configMap.function.square.ad.lad_last.enabled, _sck.configMap.function.square.ad.refresh_seconds.google_ad, _sck.configMap.function.square.chat_event_fetch_v2.enabled, _sck.configMap.function.square.chat_lazy_delete.enabled, _sck.configMap.function.square.chatmenu.userguide_link, _sck.configMap.function.square.chatroom.ad.inventory, _sck.configMap.function.square.chatroom.ad.libra, _sck.configMap.function.square.chatroom.ad.timeout, _sck.configMap.function.square.chatroom.ad.unreadcount, _sck.configMap.function.square.chatroom.allmention.enabled, _sck.configMap.function.square.chatroom.create_livetalk.adult_age_verification.enabled, _sck.configMap.function.square.chatroom.create_livetalk.minimum_members_verification, _sck.configMap.function.square.chatroom.create_livetalk.minimum_minutes_verification, _sck.configMap.function.square.chatroom.create_thread.maximum_minutes_from_message_creation, _sck.configMap.function.square.chatroom.header_ad.enabled, _sck.configMap.function.square.chatroom.header_ad.google_unit_id, _sck.configMap.function.square.chatroom.header_ad.inventory, _sck.configMap.function.square.chatroom.header_ad.refresh_seconds, _sck.configMap.function.square.chatroom.header_ad.rollout_percentage, _sck.configMap.function.square.chatroom.header_ad.target_square_mid_list, _sck.configMap.function.square.chatroom.header_ad.type.private, _sck.configMap.function.square.chatroom.header_ad.type.public, _sck.configMap.function.square.chatroom.integration_ad.embed_ad_interval_minutes, _sck.configMap.function.square.chatroom.integration_ad.enabled, _sck.configMap.function.square.chatroom.message.unsend.timelimit, _sck.configMap.function.square.chatroom.message_reaction, _sck.configMap.function.square.chatroom.multiple.image.grouping, _sck.configMap.function.square.chatroom.readonly_default_chat.enabled, _sck.configMap.function.square.chatroom.summary.expand_button_condition.minimum_hours_since_last_visit, _sck.configMap.function.square.chatroom.summary.expand_button_condition.minimum_unread_message_count, _sck.configMap.function.square.chatroom.summary.liff_url, _sck.configMap.function.square.chatroom.unsend.enabled, _sck.configMap.function.square.cover_webview.scheme, _sck.configMap.function.square.dt_antifraud, _sck.configMap.function.square.dt_button.create_openchat.enabled, _sck.configMap.function.square.dt_chatroom.send_file_message_menu.enabled, _sck.configMap.function.square.dt_main.enabled, _sck.configMap.function.square.feature, _sck.configMap.function.square.feature.able_to_search_message.enabled, _sck.configMap.function.square.feature.adultonly_chat.enabled, _sck.configMap.function.square.feature.phone_number_verification.enabled, _sck.configMap.function.square.idpa_report.enabled, _sck.configMap.function.square.join.show_popup_after_profilesetting, _sck.configMap.function.square.lad_sdk_renovation.phase1.enabled, _sck.configMap.function.square.lad_sdk_renovation.phase2.enabled, _sck.configMap.function.square.left_square_members_webview.scheme, _sck.configMap.function.square.main_webview.enabled, _sck.configMap.function.square.main_webview.scheme, _sck.configMap.function.square.managed_object_sync_version, _sck.configMap.function.square.new_badge, _sck.configMap.function.square.note.header_ad.enabled, _sck.configMap.function.square.note.header_ad.end.google_unit_id, _sck.configMap.function.square.note.header_ad.end.lad_inventory, _sck.configMap.function.square.note.header_ad.list.google_unit_id, _sck.configMap.function.square.note.header_ad.list.lad_inventory, _sck.configMap.function.square.note.header_ad.type.private, _sck.configMap.function.square.note.header_ad.type.public, _sck.configMap.function.square.oashop.enabled, _sck.configMap.function.square.show_popular_keyword.create_chat, _sck.configMap.function.square.tab.yourchat_url, _sck.configMap.function.square.thread.userguide_link, _sck.configMap.function.square.thread_space.header_ad.enabled, _sck.configMap.function.square.thread_space.header_ad.google_unit_id, _sck.configMap.function.square.thread_space.header_ad.lad_inventory, _sck.configMap.function.square.thread_space.header_ad.type.private, _sck.configMap.function.square.thread_space.header_ad.type.public, _sck.configMap.function.square.your_threads.header_ad.enabled, _sck.configMap.function.square.your_threads.header_ad.google_unit_id, _sck.configMap.function.square.your_threads.header_ad.lad_inventory, _sck.configMap.function.square.your_threads.header_ad.type.private, _sck.configMap.function.square.your_threads.header_ad.type.public, _sck.configMap.function.sticker.endpage.related_area, _sck.configMap.function.sticker.premium, _sck.configMap.function.sticker.webapp, _sck.configMap.function.sticker.webapp.url, _sck.configMap.function.sticker_keyboard.3mcp.tab, _sck.configMap.function.sticker_keyboard.apng4android, _sck.configMap.function.sticker_keyboard.assetdonwloader_replace, _sck.configMap.function.sticker_keyboard.banner.3mcp.banner, _sck.configMap.function.sticker_keyboard.banner.newyear2025, _sck.configMap.function.sticker_keyboard.banner.springcp2025, _sck.configMap.function.sticker_keyboard.collection.enable_owned_stickers, _sck.configMap.function.sticker_keyboard.collection.enable_owned_stickers_android, _sck.configMap.function.sticker_keyboard.combination_autosuggest_preview, _sck.configMap.function.sticker_keyboard.combination_create_and_send, _sck.configMap.function.sticker_keyboard.combination_display, _sck.configMap.function.sticker_keyboard.combination_enable_fixed_scale_metadata, _sck.configMap.function.sticker_keyboard.combination_history, _sck.configMap.function.sticker_keyboard.combination_reedit, _sck.configMap.function.sticker_keyboard.disable_legacy_sticon_conversion, _sck.configMap.function.sticker_keyboard.during.freemium.url, _sck.configMap.function.sticker_keyboard.freemium, _sck.configMap.function.sticker_keyboard.freemium.url, _sck.configMap.function.sticker_keyboard.freemium_post_expiry_days, _sck.configMap.function.sticker_keyboard.freesticker_banner, _sck.configMap.function.sticker_keyboard.immediate_gss_sync, _sck.configMap.function.sticker_keyboard.nearlyexpired.date, _sck.configMap.function.sticker_keyboard.openchat.combination_enable, _sck.configMap.function.sticker_keyboard.recommend_section, _sck.configMap.function.sticker_keyboard.remove_expiredtab.date, _sck.configMap.function.sticker_keyboard.show_orderediting_tooltip, _sck.configMap.function.sticker_keyboard.skiphalfview.dogfooding, _sck.configMap.function.sticker_keyboard.sticon_download_rxjava_migration, _sck.configMap.function.sticker_keyboard.swipetopreview, _sck.configMap.function.sticker_keyboard.tagsearch.enable, _sck.configMap.function.sticker_keyboard.tagsearch.p_mark_removal, _sck.configMap.function.sticker_keyboard.welcomebanner, _sck.configMap.function.stickershop.billingsdklog.enable, _sck.configMap.function.stickershop.collection, _sck.configMap.function.stickershop.combination_enabled, _sck.configMap.function.stickershop.endpage.liff.enable, _sck.configMap.function.stickershop.endpage.messagesticker_guide, _sck.configMap.function.stickershop.endpage.premium_emoji_popup, _sck.configMap.function.stickershop.endpage.premium_popup, _sck.configMap.function.stickershop.messagesticker_guide.url, _sck.configMap.function.stickershop.multiplelargeemoji.enable, _sck.configMap.function.stickershop.paid_reaction_receive, _sck.configMap.function.stickershop.paid_reaction_send, _sck.configMap.function.stickershop.premium_chunghwatelecom.url, _sck.configMap.function.stickershop.premium_deluxe, _sck.configMap.function.stickershop.premium_linemo.url, _sck.configMap.function.stickershop.premium_lyp.url, _sck.configMap.function.stickershop.purchase_coins.uirenewal, _sck.configMap.function.stickershop.purchase_complete.messagesticker_guide, _sck.configMap.function.stickershop.recommend.url, _sck.configMap.function.stickershop.report.url, _sck.configMap.function.stickershop.settings.enablelyppromotion, _sck.configMap.function.stickershop.settings.lsp.202607.priceincrease.lp, _sck.configMap.function.stickershop.settings.lsp.lypmusic.notes, _sck.configMap.function.stickershop.sticker_resource_url_versioning, _sck.configMap.function.stickershop.unfinished_transaction_recovery, _sck.configMap.function.stickershop.wishlist, _sck.configMap.function.sync.call_sync, _sck.configMap.function.sync.category_sync_max_retry_count, _sck.configMap.function.sync.disable_init_message_sync, _sck.configMap.function.sync.enable_timeout_retry_resume_feature, _sck.configMap.function.sync.full_sync_server_triggered, _sck.configMap.function.sync.group_timeout_interval_sec, _sck.configMap.function.sync.log_duration_threshold_ms, _sck.configMap.function.talkcapability.penalty_notification.halt_deliver_message, _sck.configMap.function.talkcapability.penalty_notification.might_halt_one_way_messaging, _sck.configMap.function.themeshop, _sck.configMap.function.themeshop.detail.url, _sck.configMap.function.themeshop.detail.use_liff, _sck.configMap.function.themeshop.focusmodeguide, _sck.configMap.function.themeshop.liquidglass.autoconvert, _sck.configMap.function.themeshop.report.url, _sck.configMap.function.themeshop.webapp, _sck.configMap.function.themeshop.webapp.url, _sck.configMap.function.timeline.advertise.enable, _sck.configMap.function.timeline.bulk.follow.size.limit, _sck.configMap.function.timeline.change.effect.category_index.creator, _sck.configMap.function.timeline.collection.buttontxt, _sck.configMap.function.timeline.collection.enable, _sck.configMap.function.timeline.collection.entry, _sck.configMap.function.timeline.defaulttab, _sck.configMap.function.timeline.discover, _sck.configMap.function.timeline.discover_expire_min, _sck.configMap.function.timeline.discoversearch, _sck.configMap.function.timeline.dont_recommend_account, _sck.configMap.function.timeline.event.visible, _sck.configMap.function.timeline.feed_list_expire_min, _sck.configMap.function.timeline.follow, _sck.configMap.function.timeline.follow.migration, _sck.configMap.function.timeline.foryou.swipeguide.show.checkswipe, _sck.configMap.function.timeline.foryou.swipeguide.show.time, _sck.configMap.function.timeline.foryou_event_entry, _sck.configMap.function.timeline.foryou_game_contents_event_entry, _sck.configMap.function.timeline.friend_request, _sck.configMap.function.timeline.full_public, _sck.configMap.function.timeline.gnb.foryoudark, _sck.configMap.function.timeline.hashtagsearchbar, _sck.configMap.function.timeline.lights.download.enable, _sck.configMap.function.timeline.lights.enable, _sck.configMap.function.timeline.lights.template.enable, _sck.configMap.function.timeline.lights.template.entry_type_variation, _sck.configMap.function.timeline.lights.transcoding.policy, _sck.configMap.function.timeline.lights.write, _sck.configMap.function.timeline.lights.write_blocked_devices, _sck.configMap.function.timeline.list_order, _sck.configMap.function.timeline.live.enable, _sck.configMap.function.timeline.live.gnb.enable, _sck.configMap.function.timeline.live.menu, _sck.configMap.function.timeline.live.notification_setting.enable, _sck.configMap.function.timeline.live.previewduration, _sck.configMap.function.timeline.mememaker.menu, _sck.configMap.function.timeline.myvideo.download.enable, _sck.configMap.function.timeline.oa_not_friend_allow, _sck.configMap.function.timeline.oacms_liff, _sck.configMap.function.timeline.performance.sampling.log, _sck.configMap.function.timeline.post.creation.policy, _sck.configMap.function.timeline.prefetch, _sck.configMap.function.timeline.reaction_default_theme_download_url, _sck.configMap.function.timeline.reboot.phase, _sck.configMap.function.timeline.reboot.target, _sck.configMap.function.timeline.reddot.immediate_removal, _sck.configMap.function.timeline.renewalpopup, _sck.configMap.function.timeline.reply.create.oapost, _sck.configMap.function.timeline.reply.create.userpost, _sck.configMap.function.timeline.report.copyright.enable, _sck.configMap.function.timeline.setting.menu, _sck.configMap.function.timeline.sound_entry_policy, _sck.configMap.function.timeline.story.recommend, _sck.configMap.function.timeline.story.share, _sck.configMap.function.timeline.tab_landing_expire_min, _sck.configMap.function.timeline.tab_landing_foryou, _sck.configMap.function.timeline.textmore, _sck.configMap.function.timeline.themebar.enable, _sck.configMap.function.timeline.themebar.swipe.enable, _sck.configMap.function.timeline.timeline.auto_refresh_min, _sck.configMap.function.timeline.video.buffertime, _sck.configMap.function.timeline.video.preload, _sck.configMap.function.timeline.video.transcoding.policy, _sck.configMap.function.timeline.videohub.creatordata, _sck.configMap.function.timeline.videohub.musicdata, _sck.configMap.function.timeline.viewer.autoscroll.commonskip, _sck.configMap.function.timeline.viewer.autoscroll.enable, _sck.configMap.function.timeline.viewer.autoscroll.liveskip, _sck.configMap.function.timeline.viewerbadge.affordance, _sck.configMap.function.timeline.voom.desktop.myhome_noti, _sck.configMap.function.timeline.voom.desktop.url, _sck.configMap.function.timeline.voom.effect_drawer.thumbnail.rato.change, _sck.configMap.function.timeline.voom.following_tab.refresh_button, _sck.configMap.function.timeline.voom.following_tab.story_fold, _sck.configMap.function.timeline.voom.idpa_report, _sck.configMap.function.timeline.voom.use.camera_server_cms.template, _sck.configMap.function.timeline.voom_animation, _sck.configMap.function.tracking_service.ts.opt_out_filter, _sck.configMap.function.tracking_service.uts.chatroom.opt_out_filter, _sck.configMap.function.tracking_service.uts.enabled, _sck.configMap.function.tracking_service.uts.impression.flush_throttling, _sck.configMap.function.ts, _sck.configMap.function.ui.send_button_default, _sck.configMap.function.ui.voice_button_size, _sck.configMap.function.ultrasonic, _sck.configMap.function.video, _sck.configMap.function.video.auto_play, _sck.configMap.function.video.exoplayer.enable_media3, _sck.configMap.function.video.exoplayer.version, _sck.configMap.function.video.slideshow.blocked_devices, _sck.configMap.function.video.slideshow.limit_profilelevel, _sck.configMap.function.video.transcoding, _sck.configMap.function.video.transcoding.blocked_devices, _sck.configMap.function.video.transcoding.cruiser.blocked_devices, _sck.configMap.function.video.transcoding.cruiser.crop, _sck.configMap.function.video.transcoding.policy, _sck.configMap.function.video.transcoding.quality, _sck.configMap.function.videohub.glc.init, _sck.configMap.function.videohub.voom.init, _sck.configMap.function.videoprofile.b612, _sck.configMap.function.videoprofile.egg, _sck.configMap.function.videoprofile.rounding_unsupported_devices, _sck.configMap.function.voip.aggressive_setup, _sck.configMap.function.voip.antifraud.popup, _sck.configMap.function.voip.antifraud.popup.contact_createdtime_condition, _sck.configMap.function.voip.antifraud.popup.link, _sck.configMap.function.voip.callkit, _sck.configMap.function.voip.callrecording, _sck.configMap.function.voip.callrecording_settings, _sck.configMap.function.voip.callrecording_video_upload_quality_override, _sck.configMap.function.voip.callstt, _sck.configMap.function.voip.e2ee, _sck.configMap.function.voip.extra_service, _sck.configMap.function.voip.hdvideo, _sck.configMap.function.voip.linemusic, _sck.configMap.function.voip.melody, _sck.configMap.function.voip.melody.eventpopup, _sck.configMap.function.voip.melody.rbt_list_url, _sck.configMap.function.voip.melody.rt_list_url, _sck.configMap.function.voip.melody.store_url, _sck.configMap.function.voip.photobooth, _sck.configMap.function.voip.photobooth.freeticket, _sck.configMap.function.voip.photobooth.freeticket.hour, _sck.configMap.function.voip.photobooth.freeticket.number, _sck.configMap.function.voip.photobooth.greendot, _sck.configMap.function.voip.photobooth.newcontents, _sck.configMap.function.voip.photobooth.onetoone, _sck.configMap.function.voip.photobooth.purikura, _sck.configMap.function.voip.push_using_voip, _sck.configMap.function.voip.ringbacktone, _sck.configMap.function.voip.ringbacktone.music, _sck.configMap.function.voip.ringtone, _sck.configMap.function.voip.ringtone.dl_url, _sck.configMap.function.voip.ringtone.music, _sck.configMap.function.voip.siliconmac, _sck.configMap.function.voip.stamp, _sck.configMap.function.voip.testcall, _sck.configMap.function.voip.tone.service.type, _sck.configMap.function.voip.tunneling, _sck.configMap.function.voip.watchtogether.screenshare.doodle, _sck.configMap.function.voip.watchtogether.youtube, _sck.configMap.function.voip.watchtogether.youtube.chatroom, _sck.configMap.function.wallet.common.tutorial, _sck.configMap.function.wallet.hk.v4.enabled, _sck.configMap.function.wallet.jp.campaign.enabled, _sck.configMap.function.wallet.jp.v3.quickmenu.coachmark, _sck.configMap.function.wallet.jp.v3.tab.order, _sck.configMap.function.wallet.minitab.switching, _sck.configMap.function.wallet.module.order, _sck.configMap.function.wallet.nelolog.enabled, _sck.configMap.function.wallet.notification_center.enabled, _sck.configMap.function.wallet.th.campaign.enabled, _sck.configMap.function.wallet.th.v4.enabled, _sck.configMap.function.wallet.tw.v4.enabled, _sck.configMap.function.wallet.v3.enabled, _sck.configMap.function.wallet.v3.module.order.tab.asset, _sck.configMap.function.wallet.v3.module.order.tab.wallet, _sck.configMap.group.max_size, _sck.configMap.keep.sharelink, _sck.configMap.libra.experiment_id, _sck.configMap.libra.group_id, _sck.configMap.limit.sync.contacts, _sck.configMap.limit.sync.groups, _sck.configMap.limit.sync.messages, _sck.configMap.main_tab.default, _sck.configMap.main_tab.hometab, _sck.configMap.main_tab.hubtab, _sck.configMap.main_tab.hubtab.channel, _sck.configMap.main_tab.newstab, _sck.configMap.main_tab.newstab.channel, _sck.configMap.main_tab.newstab.log, _sck.configMap.main_tab.newstab.navbar_url, _sck.configMap.main_tab.newstab.notification_button, _sck.configMap.main_tab.newstab.search_button, _sck.configMap.main_tab.newstab.search_channel, _sck.configMap.main_tab.newstab.search_url, _sck.configMap.main_tab.newstab.service, _sck.configMap.main_tab.newstab.url, _sck.configMap.main_tab.show_calltab, _sck.configMap.main_tab.show_timeline, _sck.configMap.main_tab.show_timeline_2018, _sck.configMap.main_tab.wallettab, _sck.configMap.room.max_size, _sck.revision, ampkitDeviceKey, chatSetting, chatSetting.u00371e58f1f06b8d75a23e1da490cc26, chatSetting.u00371e58f1f06b8d75a23e1da490cc26.announcementRequested, chatSetting.u4787c142ff9b974f265633d95cead985, chatSetting.u4787c142ff9b974f265633d95cead985.announcementRequested, chatSetting.u4d731f98de43828024a59f2167de67e1, chatSetting.u4d731f98de43828024a59f2167de67e1.announcementRequested, chatSetting.u6856b0d2e09587b42ce16c831b46035e, chatSetting.u6856b0d2e09587b42ce16c831b46035e.announcementRequested, chatSetting.u905e8d301721907471f7a95f56f3b1cd, chatSetting.u905e8d301721907471f7a95f56f3b1cd.announcementRequested, chatSetting.u9ce34de3654336a0cd96111911df410d, chatSetting.u9ce34de3654336a0cd96111911df410d.announcementRequested, chatSetting.ud5af49c11593b91840b6e5966cf49807, chatSetting.ud5af49c11593b91840b6e5966cf49807.announcementRequested, chatSticonHistory, commonChannelDomains, commonChannelDomainsTimeStamp, firstAutoResendStarted, groupChatForceRecoveryVersion, idSanctionedForAdvertiser, lastLineContactsSyncDateV2, lastPrimaryClientBindTime, lastRequestedSyncType, lineSettings, lineSettings.accountMigrationPincodeType, lineSettings.agreementAdByWebAccess, lineSettings.agreementAlbumUsageData, lineSettings.agreementAlbumUsageDataVersion, lineSettings.agreementBeacon, lineSettings.agreementCommunicationInfo, lineSettings.agreementContentsSuggest, lineSettings.agreementContentsSuggestDataCollection, lineSettings.agreementGdpr, lineSettings.agreementIcna, lineSettings.agreementInAppPurchase, lineSettings.agreementInAppPurchaseVersion, lineSettings.agreementLineOutProvideInfo, lineSettings.agreementLineOutUse, lineSettings.agreementLocationVersion, lineSettings.agreementLypPremiumAlbum, lineSettings.agreementLypPremiumAlbumVersion, lineSettings.agreementLypPremiumBackup, lineSettings.agreementLypPremiumBackupVersion, lineSettings.agreementLypPremiumMessageEdit, lineSettings.agreementLypPremiumMessageEditVersion, lineSettings.agreementLypPremiumMessageScheduling, lineSettings.agreementLypPremiumMessageSchedulingPremiumType, lineSettings.agreementLypPremiumMessageSchedulingVersion, lineSettings.agreementLypPremiumMultiProfile, lineSettings.agreementLypPremiumMultiProfileVersion, lineSettings.agreementLypPremiumUnsend, lineSettings.agreementLypPremiumUnsendVersion, lineSettings.agreementMid, lineSettings.agreementMobileContactName, lineSettings.agreementNearbyTime, lineSettings.agreementOaAiAssistant, lineSettings.agreementOaAiAssistantVersion, lineSettings.agreementOcrImageCollection, lineSettings.agreementPdp, lineSettings.agreementPdpa, lineSettings.agreementPhoneNumberMatching, lineSettings.agreementPremiumAlbumPremiumType, lineSettings.agreementPremiumBackupPremiumType, lineSettings.agreementProvideLocation, lineSettings.agreementShakeFunction, lineSettings.agreementSnowAiAvatar, lineSettings.agreementSoundToText, lineSettings.agreementSquareTime, lineSettings.agreementThingsWirelessCommunication, lineSettings.agreementTriggerMessage, lineSettings.allowUnregistrationSecondaryDevice, lineSettings.botUseAgreementAcceptedAt, lineSettings.contactMyTicket, lineSettings.customModes, lineSettings.e2eeEnable, lineSettings.eapAllowedToConnect, lineSettings.eapAllowedToConnect.1, lineSettings.eapAllowedToConnect.6, lineSettings.eapOnlyAccountTargetCountry, lineSettings.emailConfirmationStatus, lineSettings.enforcedInputAccountMigrationPincode, lineSettings.hitokotoBackupRequested, lineSettings.homeNotificationAlbumLike, lineSettings.homeNotificationBirthday, lineSettings.homeNotificationFavoriteFriendUpdate, lineSettings.homeNotificationGroupMemberUpdate, lineSettings.homeNotificationNewFriend, lineSettings.homeNotificationNoteComment, lineSettings.homeNotificationNoteCommentLike, lineSettings.homeNotificationNoteMention, lineSettings.homeNotificationNoteNoteLike, lineSettings.identityProvider, lineSettings.labMessageEdit, lineSettings.labPremiumFriendsManagement, lineSettings.notificationAlbumLike, lineSettings.notificationBadgeTalkOnly, lineSettings.notificationDisabledWithSub, lineSettings.notificationEnable, lineSettings.notificationGroupInvitation, lineSettings.notificationIncomingCall, lineSettings.notificationMention, lineSettings.notificationMuteExpiration, lineSettings.notificationNewMessage, lineSettings.notificationNoteComment, lineSettings.notificationNoteCommentLike, lineSettings.notificationNoteMention, lineSettings.notificationNoteReaction, lineSettings.notificationPayment, lineSettings.notificationReaction, lineSettings.notificationShowMessage, lineSettings.notificationShowProfileImage, lineSettings.notificationThumbnail, lineSettings.phoneNumberDeleteEnable, lineSettings.phoneRegistration, lineSettings.preferenceLocale, lineSettings.privacyAgeResultReceived, lineSettings.privacyAgreeUseLineCoinToPaidCall, lineSettings.privacyAgreeUsePaidCall, lineSettings.privacyAllowFollow, lineSettings.privacyAllowFriendRequest, lineSettings.privacyAllowNearby, lineSettings.privacyAllowSecondaryDeviceLogin, lineSettings.privacyPolicyVersion, lineSettings.privacyProfileImagePostToMyhome, lineSettings.privacyProfileMusicPostToMyhome, lineSettings.privacyReceiveMessagesFromNotFriend, lineSettings.privacySearchByEmail, lineSettings.privacySearchByPhoneNumber, lineSettings.privacySearchByUserid, lineSettings.privacySharePersonalInfoToFriends, lineSettings.privacyShowFollowList, lineSettings.privacySyncContacts, lineSettings.pwlessPrimaryCredentialRegistration, lineSettings.securityCardRequired, lineSettings.securityCenterSettingsType, lineSettings.snsAccounts, lineSettings.zhdPageAllowedToShow, obsTokenGeneral, obsTokenGeneral.timestamp, obsTokenGeneral.token, premiumBlockContactSyncRevision, premiumDataRetention, premiumDataRetention.dataRetentions, premiumDataRetention.loadStatus, premiumDataRetention.noSyncUntil, premiumProductTiers, premiumProductTiers.loadStatus, premiumProductTiers.noSyncUntil, premiumProductTiers.productTiers, premiumProductTiers.productTiers.JP, premiumProductTiers.productTiers.TH, premiumProductTiers.productTiers.TW, premiumStatus, premiumStatus.freeTrialUsed, premiumStatus.loadStatus, premiumStatus.nextPaymentTime, premiumStatus.noSyncUntil, premiumStatus.onFreeTrial, premiumStatus.status, premiumStatus.updateRevision, premiumStatus.updatedTime, premiumStatus.validUntil, premiumStatus.willExpire, sticker_premium_status, syncCompletedMessageWrapupList, timelineGroupListRev, timerJobs, value |

#### `_square` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_mid` | TEXT | PK |  |
| `_name` | TEXT |  |  |
| `_welcomeMessage` | TEXT |  |  |
| `_profileImageObsHash` | TEXT |  |  |
| `_desc` | TEXT |  |  |
| `_searchable` | INTEGER |  |  |
| `_type` | INTEGER |  |  |
| `_categoryId` | INTEGER |  |  |
| `_invitationURL` | TEXT |  |  |
| `_revision` | INTEGER |  |  |
| `_ableToUseInvitationTicket` | INTEGER |  |  |
| `_state` | INTEGER |  |  |
| `_emblems` | TEXT |  |  |
| `_adultOnly` | INTEGER |  |  |
| `_svcTags` | TEXT |  |  |
| `_createdAt` | INTEGER |  |  |
| `_authority` | TEXT |  |  |
| `_creatorId` | TEXT |  |  |
| `_status` | TEXT |  |  |
| `_myMemberId` | TEXT |  |  |
| `_featureSet` | TEXT |  |  |
| `_metadata` | TEXT |  |  |
| `_lastJoinRequestAt` | INTEGER |  |  |
| `_lastVisitTime` | INTEGER |  |  |
| `_noteStatus` | TEXT |  |  |

#### `_squareBot` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_botMid` | TEXT | PK |  |
| `_active` | INTEGER |  |  |
| `_displayName` | TEXT |  |  |
| `_profileImageObsHash` | TEXT |  |  |
| `_iconType` | INTEGER |  |  |
| `_lastModifiedAt` | INTEGER |  |  |
| `_expiredIn` | INTEGER |  |  |
| `_syncTime` | INTEGER |  |  |

#### `_squareChat` — 0 rows `[IVY]`
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_squareChatMid` | TEXT | PK |  |
| `_squareMid` | TEXT |  |  |
| `_type` | INTEGER |  |  |
| `_name` | TEXT |  |  |
| `_chatImageObsHash` | TEXT |  |  |
| `_squareChatRevision` | INTEGER |  |  |
| `_maxMemberCount` | INTEGER |  |  |
| `_state` | INTEGER |  |  |
| `_status` | TEXT |  |  |
| `_myMember` | TEXT |  |  |
| `_joinedAt` | INTEGER |  |  |
| `_announcement` | TEXT |  |  |
| `_featureSet` | TEXT |  |  |

#### `_squareMember` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_squareMemberMid` | TEXT | PK |  |
| `_squareMid` | TEXT |  |  |
| `_displayName` | TEXT |  |  |
| `_profileImageObsHash` | TEXT |  |  |
| `_ableToReceiveMessage` | INTEGER |  |  |
| `_membershipState` | INTEGER |  |  |
| `_role` | INTEGER |  |  |
| `_revision` | INTEGER |  |  |
| `_preference` | TEXT |  |  |
| `_joinMessage` | TEXT |  |  |
| `_relation` | TEXT |  |  |
| `_myMember` | TEXT |  |  |

#### `_squareThread` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_threadMid` | TEXT | PK |  |
| `_chatMid` | TEXT |  |  |
| `_squareMid` | TEXT |  |  |
| `_messageId` | TEXT |  |  |
| `_state` | INTEGER |  |  |
| `_expiresAt` | INTEGER |  |  |
| `_readOnlyAt` | INTEGER |  |  |
| `_revision` | INTEGER |  |  |
| `_squareThreadMember` | TEXT |  |  |
| `_totalMessageCount` | INTEGER |  |  |
| `_unreadCount` | INTEGER |  |  |
| `_lastMessage` | TEXT |  |  |
| `_rootMessage` | TEXT |  |  |
| `_lastMessageAt` | INTEGER |  |  |

#### `_squareToken` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_id` | TEXT | PK |  |
| `_token` | TEXT |  |  |
| `_backwardToken` | TEXT |  |  |
| `_timestamp` | INTEGER |  |  |

#### `_stickerProductNew` — 7 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_id` | TEXT | PK |  |
| `_billingItemId` | TEXT |  |  |
| `_billingCpId` | TEXT |  |  |
| `_type` | TEXT |  |  |
| `_subtype` | INTEGER |  |  |
| `_name` | TEXT |  |  |
| `_author` | TEXT |  |  |
| `_details` | TEXT |  |  |
| `_copyright` | TEXT |  |  |
| `_notice` | TEXT |  |  |
| `_promotionInfo` | TEXT |  | promotionType |
| `_latestVersion` | INTEGER |  |  |
| `_latestVersionString` | TEXT |  |  |
| `_version` | INTEGER |  |  |
| `_versionString` | TEXT |  |  |
| `_applicationVersionRange` | TEXT |  |  |
| `_owned` | INTEGER |  |  |
| `_grantedByDefault` | INTEGER |  |  |
| `_validFor` | INTEGER |  |  |
| `_validUntil` | INTEGER |  |  |
| `_onSale` | INTEGER |  |  |
| `_salesFlags` | TEXT |  |  |
| `_availableForPresent` | INTEGER |  |  |
| `_availableForMyself` | INTEGER |  |  |
| `_priceTier` | INTEGER |  |  |
| `_price` | TEXT |  | amount, currency, priceString |
| `_priceInLineCoin` | TEXT |  |  |
| `_localizedPrice` | TEXT |  | amount, currency, priceString |
| `_images` | TEXT |  |  |
| `_attributes` | TEXT |  | hasAnimation, hasSound, subtype |
| `_authorId` | TEXT |  |  |
| `_stickerResourceType` | INTEGER |  |  |
| `_productProperty` | TEXT |  | stickerProperty, stickerProperty.availableForCombinationSticker, stickerProperty.availableForPhotoEdit, stickerProperty.combinationStickerProperty, stickerProperty.combinationStickerProperty.useType, stickerProperty.compactStickerOptions, stickerProperty.cpdProduct, stickerProperty.hasAnimation, stickerProperty.hasPopup, stickerProperty.hasSound, stickerProperty.stickerIds, stickerProperty.stickerOptions, stickerProperty.stickerResourceType, stickerProperty.stickerSize |
| `_productSalesState` | INTEGER |  |  |
| `_installedTime` | INTEGER |  |  |
| `_wishProperty` | TEXT |  |  |
| `_subscriptionProperty` | TEXT |  | availableForSubscribe, subscriptionAvailability |
| `_productPromotionProperty` | TEXT |  |  |
| `_availableInCountry` | INTEGER |  |  |
| `_editorsPickBanners` | TEXT |  |  |
| `_ableToBeGivenAsPresent` | INTEGER |  |  |
| `_madeWithStickerMaker` | INTEGER |  |  |
| `_customDownloadButtonLabel` | TEXT |  |  |
| `_generatedByAI` | INTEGER |  |  |
| `_usageState` | INTEGER |  |  |
| `_c_premium` | INTEGER |  |  |

#### `_sticker_history` — 1 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_packageId` | INTEGER | PK |  |
| `_stickerId` | INTEGER | PK |  |
| `_message` | TEXT | PK |  |
| `_useTime` | INTEGER |  |  |
| `_weight` | INTEGER |  |  |

#### `_sticonProduct` — 1 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_id` | TEXT | PK |  |
| `_billingItemId` | TEXT |  |  |
| `_billingCpId` | TEXT |  |  |
| `_type` | TEXT |  |  |
| `_subtype` | INTEGER |  |  |
| `_name` | TEXT |  |  |
| `_author` | TEXT |  |  |
| `_details` | TEXT |  |  |
| `_copyright` | TEXT |  |  |
| `_notice` | TEXT |  |  |
| `_promotionInfo` | TEXT |  | promotionType |
| `_latestVersion` | INTEGER |  |  |
| `_latestVersionString` | TEXT |  |  |
| `_version` | INTEGER |  |  |
| `_versionString` | TEXT |  |  |
| `_applicationVersionRange` | TEXT |  | lowerBound, lowerBoundInclusive, upperBoundInclusive |
| `_owned` | INTEGER |  |  |
| `_grantedByDefault` | INTEGER |  |  |
| `_validFor` | INTEGER |  |  |
| `_validUntil` | INTEGER |  |  |
| `_onSale` | INTEGER |  |  |
| `_salesFlags` | TEXT |  |  |
| `_availableForPresent` | INTEGER |  |  |
| `_availableForMyself` | INTEGER |  |  |
| `_priceTier` | INTEGER |  |  |
| `_price` | TEXT |  | amount, currency, priceString |
| `_priceInLineCoin` | TEXT |  |  |
| `_localizedPrice` | TEXT |  | amount, currency, priceString |
| `_images` | TEXT |  |  |
| `_attributes` | TEXT |  |  |
| `_authorId` | TEXT |  |  |
| `_stickerResourceType` | INTEGER |  |  |
| `_productProperty` | TEXT |  | sticonProperty, sticonProperty.availableForPhotoEdit, sticonProperty.endPageMainImages, sticonProperty.sticonIds, sticonProperty.sticonResourceType |
| `_productSalesState` | INTEGER |  |  |
| `_installedTime` | INTEGER |  |  |
| `_wishProperty` | TEXT |  |  |
| `_subscriptionProperty` | TEXT |  | availableForSubscribe, subscriptionAvailability |
| `_productPromotionProperty` | TEXT |  |  |
| `_availableInCountry` | INTEGER |  |  |
| `_editorsPickBanners` | TEXT |  |  |
| `_ableToBeGivenAsPresent` | INTEGER |  |  |
| `_madeWithStickerMaker` | INTEGER |  |  |
| `_customDownloadButtonLabel` | TEXT |  |  |
| `_generatedByAI` | INTEGER |  |  |
| `_usageState` | INTEGER |  |  |
| `_c_premium` | INTEGER |  |  |

#### `_sticon_mapping` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_productId` | TEXT | PK |  |
| `_oldProductId` | TEXT |  |  |
| `_newToOldSticonIdMapping` | TEXT |  |  |
| `_oldPackageVersion` | INTEGER |  |  |
| `_oldMetaVersion` | INTEGER |  |  |
| `_stickerPackageId` | INTEGER |  |  |
| `_stickerPackageVersion` | INTEGER |  |  |
| `_stickerIds` | TEXT |  |  |

#### `_voip_bg` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_bg` | TEXT | PK |  |
| `_thumb` | TEXT |  |  |
| `_type` | INTEGER |  |  |

Indexes: `_chatOption__id__hidden__notification`, `_chat__id__midType__status__firstUnreadId`, `_message__chatId__createdTime__contentType__status__hasUrlPreview__rev`, `_message__flag__chatId`, `_message__reqSeqV2`, `_message__status`

Triggers: `_message_delete_trigger`

### keep_qwREDACTED-B.edb
*KEEP STORE — saved items*

Tables: 5 · indexes: 1 · triggers: 0 · views: 0

#### `_keep_command_info` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_id` | TEXT | PK |  |
| `_commandType` | INTEGER | PK |  |
| `_customData` | TEXT |  |  |

#### `_keep_content` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_contentId` | TEXT | PK |  |
| `_createdTime` | INTEGER |  |  |
| `_modifiedTime` | INTEGER |  |  |
| `_clientId` | TEXT |  |  |
| `_revision` | INTEGER |  |  |
| `_serviceType` | INTEGER |  |  |
| `_source` | TEXT |  |  |
| `_contentData` | TEXT |  |  |
| `_status` | INTEGER |  |  |
| `_tags` | TEXT |  |  |
| `_collectionInfos` | TEXT |  |  |
| `_pinInfo` | TEXT |  |  |
| `_messageId` | TEXT |  |  |
| `_name` | TEXT |  |  |
| `_size` | INTEGER |  |  |
| `_mainType` | INTEGER |  |  |
| `_updateState` | INTEGER |  |  |
| `_attribute` | INTEGER |  |  |
| `_contentInfo` | TEXT |  |  |

#### `_keep_content_command` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_id` | TEXT | PK |  |
| `_commandType` | INTEGER |  |  |
| `_clientRevision` | INTEGER |  |  |
| `_contentData` | TEXT |  |  |
| `_source` | TEXT |  |  |
| `_tags` | TEXT |  |  |
| `_uploadableItemCount` | INTEGER |  |  |
| `_totalSize` | INTEGER |  |  |
| `_commandState` | INTEGER |  |  |
| `_revision` | INTEGER |  |  |
| `_customData` | TEXT |  |  |

#### `_keep_settings` — 1 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_key` | TEXT | PK |  |
| `_value` | TEXT |  |  |

#### `_meta_info` — 4 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `m_n` | varchar(50) | PK |  |
| `m_v` | INTEGER |  |  |
| `m_p` | TEXT |  | k_c |
| `m_s` | TEXT |  | _attribute, _clientId, _clientRevision, _collectionInfos, _commandState, _commandType, _contentData, _contentId, _contentInfo, _createdTime, _customData, _id, _key, _mainType, _messageId, _modifiedTime, _name, _pinInfo, _revision, _serviceType, _size, _source, _status, _tags, _totalSize, _updateState, _uploadableItemCount, _value |
| `m_c` | TEXT |  |  |
| `m_i` | TEXT |  | _keep_content__name__status__createdTime, _keep_content__name__status__createdTime.i_c, _keep_content__name__status__createdTime.i_q, _keep_content__name__status__createdTime.i_t |
| `m_f` | TEXT |  |  |
| `m_d` | TEXT |  |  |

Indexes: `_keep_content__name__status__createdTime`

### chatStats_qwREDACTED-B.edb
*CHAT STATS STORE*

Tables: 3 · indexes: 1 · triggers: 0 · views: 0

#### `_chatStats` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_chatId` | TEXT |  |  |
| `_event` | INTEGER |  |  |
| `_weekday` | INTEGER |  |  |
| `_hour` | INTEGER |  |  |
| `_hourTimestamp` | INTEGER |  |  |
| `_timestamp` | INTEGER |  |  |
| `_valueNumber` | INTEGER |  |  |
| `_valueText` | TEXT |  |  |

#### `_chatStatsSetting` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_key` | TEXT | PK |  |
| `_value` | TEXT |  |  |

#### `_meta_info` — 2 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `m_n` | varchar(50) | PK |  |
| `m_v` | INTEGER |  |  |
| `m_p` | TEXT |  | k_c |
| `m_s` | TEXT |  | _chatId, _event, _hour, _hourTimestamp, _key, _timestamp, _value, _valueNumber, _valueText, _weekday |
| `m_c` | TEXT |  |  |
| `m_i` | TEXT |  | _chatStats__chatId__event__weekday__hourTimestamp, _chatStats__chatId__event__weekday__hourTimestamp.i_c, _chatStats__chatId__event__weekday__hourTimestamp.i_q, _chatStats__chatId__event__weekday__hourTimestamp.i_t |
| `m_f` | TEXT |  |  |
| `m_d` | TEXT |  |  |

Indexes: `_chatStats__chatId__event__weekday__hourTimestamp`

### album_qwREDACTED-B.edb
*ALBUM STORE — shared albums/media*

Tables: 2 · indexes: 0 · triggers: 0 · views: 0

#### `_album_upload_retry` — 0 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `_homeId_albumId` | TEXT | PK |  |
| `_data` | TEXT |  |  |

#### `_meta_info` — 1 rows
| column | type | pk | json tags (keys seen) |
|---|---|---|---|
| `m_n` | varchar(50) | PK |  |
| `m_v` | INTEGER |  |  |
| `m_p` | TEXT |  | k_c |
| `m_s` | TEXT |  | _data, _homeId_albumId |
| `m_c` | TEXT |  |  |
| `m_i` | TEXT |  |  |
| `m_f` | TEXT |  |  |
| `m_d` | TEXT |  |  |


## 8. Media files on disk (Cache / Sticker / albums)

### `%LocalAppData%\LINE\Cache` — content-addressed media cache
Layout: two top shard dirs (`3543ffa…` 575 files/16.2 MB, `b3968fe…` 536 files/6.6 MB) → single-char subdirs (`c`,`e`,`p`,…) → files named by a 40-hex content hash (no extensions). Plus `dinfo.bin`/`uinfo.bin` (device/user cache info) and Qt caches (`qmlcache`, `qtpipelinecache`, not media).

Classification by magic bytes (all Cache files, Qt caches excluded):

| class | count | size | meaning |
|---|---|---|---|
| **other/encrypted** | 945 | 11.2 MB | cached media stored **encrypted at rest** (not readable as files) |
| **`.eimg` (encrypted thumb)** | 149 | 2.5 MB | thumbnails, AES-128-ECB, per-file key (collector treats as out-of-scope) |
| PNG | 9 | 8.7 MB | plaintext — UI/asset images, not chat media |
| JPEG | 7 | 0.5 MB | plaintext — few cached images/UI |
| tiny | 1 | 0 | marker |

**Key point:** chat media originals are **not sitting as plain files** here. The cache is encrypted and content-addressed; the originals live on LINE's object storage (obs). So on Windows you can read a message's media *reference/metadata* but not the original bytes without either an authenticated download (via `DOWNLOAD_URL` + the `_channelToken`/obs token) or decrypting the cache (`.eimg` per-file keys — out of scope).

### How a message points at its media (`_message._contentMetadata`, per type)
| type | tags that locate the media |
|---|---|
| 1 image | `OID`, `SID`, `DOWNLOAD_URL`, `PREVIEW_URL`, `FILE_SIZE` |
| 2 video | same + `DURATION` |
| 6 call | `TYPE`, `RESULT`, `CAUSE`, `DURATION`, `SESSION_ID` (no media file; call record) |
| 7 sticker | `STKID`, `STKPKGID`, `STKVER`, `STKTXT`, `STKOPT` (→ Sticker folder / sticker CDN) |
| 17 | `MARKUP_JSON`, `DOWNLOAD_URL`, `ALT_TEXT`, `SPEC_REV` (rich/markup message) |
| 22 | `FLEX_JSON`, `FLEX_VER`, `ALT_TEXT` (Flex bubble; self-contained JSON, no external file) |

`OID` = LINE obs object id; `SID` = storage/service id; `DOWNLOAD_URL`/`PREVIEW_URL` = obs URLs (need auth). Flex/markup messages carry their full content inline in the JSON (no download needed).

### `Data\Sticker` — 8 PNGs (downloaded sticker assets)
`27533208.png`, `27533221.png`, `29682576.png`, `438570328.png`, `17306.png`, `42125.png`, `52114147.png` + `52114147_key.png` (a keyed/animated sticker). These are plaintext sticker images keyed by sticker id (match `STKID` in messages).

### Empty on this account
- `Data\bgChat` (chat backgrounds): 0 files.
- `album_<acct>.edb`: `_album`, `_album_upload_retry` = 0 rows (no shared albums).
- `chatStats_<acct>.edb`: `_chatStats`, `_chatStatsSetting` = 0 rows.

### Media capture implication (for "capture everything")
- **Available on disk now:** message media *metadata/refs* (OID/SID/URLs/sizes), sticker ids, Flex/markup JSON (full content), call records (full metadata).
- **Encrypted on disk (would need per-file keys):** the `.eimg` thumbnails and the 945 encrypted cache blobs.
- **Server-side only (would need authenticated obs download):** full-resolution image/video/file originals via `DOWNLOAD_URL` + obs/`_channelToken`.


## 9. Thumbnail / preview decryption — full investigation

This section documents the whole dig (method, dead ends, and results) so it never has to be repeated. **It supersedes PLAN decision 12 / `NOTES.md`, which claimed the LINE media key is "received from the server, wiped from memory, no key on disk." That is wrong** — a per‑media key is in the store. (Below, the local `.eimg` still turned out to need a *different* key, so the practical conclusion is nuanced — read on.)

### 9.1 Breakthrough — the per‑media key is in the store
Dug into the decrypted chat store's `_message` columns `_contentInfo` / `_contentPreview` / `_contentMetadata`:
- `_contentPreview` — **empty** on every media message (not used in this version).
- `_contentInfo` (JSON, ~270 chars on image messages) contains:
  - **`keyMaterial`** — base64, length 44 → **decodes to a 32‑byte AES key** (the E2EE media content key). Present on E2EE images.
  - **`thumbPath`** — the **full local path to that message's `.eimg` thumbnail**, e.g.
    `C:\Users\admin\AppData\Local/LINE/Cache/3543ffa1…/1d4a406b…/m/8/<hash>.eimg`
  - **`thumbResCode`** — a thumbnail resolution code (number).
- `_contentMetadata` (JSON) contains `OID` (obs object id, ~59–62 chars), `SID`, `FILE_SIZE`, `seq`, `e2eeMark=1`. Non‑E2EE images instead carry `DOWNLOAD_URL` + `PREVIEW_URL` (and no `keyMaterial`).

So, reading only with the store key we already have, we recover **both** the per‑message AES key **and** the exact path of its cached thumbnail. The intended chain looked like: `keyMaterial` + the `.eimg` at `thumbPath` → decrypt → thumbnail.

### 9.2 Locating the thumbnail — solved by `thumbPath`
No hash‑matching needed: `thumbPath` is the literal path to the `.eimg`. (For reference, cache files are otherwise content‑addressed: 40‑hex SHA‑1 names sharded under single‑char dirs.)

### 9.3 Decryption attempts on the `.eimg` — what was tried
First tried `keyMaterial` as a raw AES key in the obvious ways against the `.eimg` bytes:
- AES‑256 (key = `keyMaterial`) and AES‑128 (key = `keyMaterial[0:16]`, IV = `keyMaterial[16:32]`), modes CBC / ECB / CTR / GCM, with and without small header skips (0/4/8/16/32 bytes).
- Result: **no image** produced by any of them.

### 9.4 `.eimg` structure analysis
Dumped the raw bytes to look for a container/header:
- Example file: 28708 bytes, **size mod 16 = 4** (not block‑aligned).
- First 96 and last 48 bytes: no magic, no plaintext header, no length field.
- **Shannon entropy 7.99 bits/byte** (8.0 = random) across the whole file → ciphertext from byte 0, no header.
- Conclusion: it's a **stream cipher** (CTR/OFB/CFB/GCM — those allow non‑aligned length), and the key is almost certainly **derived** from `keyMaterial` (hash/split), not used raw.

### 9.5 Systematic crack — and the result
Ran an exhaustive matrix on the `.eimg`:
- **keys:** `km`, `km[0:16]`, `km[16:32]`, `sha256(km)`, `sha256(km)[0:16]`, `md5(km)`, `sha1(km)[0:16]`
- **IVs/nonces:** zero, `km[0:16]`, `km[16:32]`, `sha256(km)[0:16]`, `sha256(km)[16:32]`, `md5(km)`, `file[0:16]`
- **modes:** CTR, OFB, CFB, CBC (skip‑4), ECB (skip‑4), GCM
- **success test:** image magic (JPEG/PNG/GIF/WEBP) **or** a zlib/gzip/deflate header (in case the thumbnail is compressed).
- **Result: 0 hits.**

**Conclusion:** the message `keyMaterial` does **not** decrypt the local `.eimg`. The `.eimg` is encrypted under a **separate local key that is not in the store** (consistent with a per‑file key held only in memory). `keyMaterial` is for the **obs‑hosted copy** of the media, not the local thumbnail.

### 9.6 Plaintext already on disk — the `/e/` cache namespace
LINE keeps **two** cache namespaces under `…\LINE\Cache\<shard>\<shard>\`:
- **`/m/…/<hash>.eimg`** — encrypted thumbnails (the ones above).
- **`/e/…/<hash>`** (no extension) — **plaintext images**:
  - **7 × 1280×720 JPEG** (49–117 KB) — look like chat/link/video previews **already in the clear** (owner identifying them).
  - **8 × 1040×1040 PNG** (0.9–2.0 MB) — stickers.
  - one 78×78 PNG — an icon.
- Two shard dirs (`3543ffa…`, `b3968fe…`) are parallel caches; some hashes appear in both.

So *some* previews are readable with **zero crypto** — but only for media that has been viewed/cached, not the whole history.

### 9.7 Correction to prior research
`NOTES.md` / PLAN decision 12 said there is "no key on disk and no original to recover." The accurate picture:
- A per‑media key (`keyMaterial`, 32‑byte AES) **is** on disk, in the store, and we can read it.
- It decrypts the **server (obs)** copy, **not** the local `.eimg` (which uses a separate local key we don't have).
- Therefore: originals/previews are recoverable **via obs download + `keyMaterial`**, and some previews are already plaintext in the `/e/` cache. "No key / unrecoverable" was too strong.

### 9.8 Routes to previews (ranked)
1. **Plaintext `/e/` cache** — already readable, no crypto. Partial coverage (recently viewed only).
2. **obs download + `keyMaterial`** — fetch each image's `PREVIEW_URL`/`OID` and decrypt with its `keyMaterial`. Full coverage of E2EE images. **Needs a network call to LINE + the obs/`_channelToken` (sensitive, acts on the account) — requires explicit go‑ahead.**
3. **Local `.eimg` decryption** — blocked: the `.eimg` key is not in the store (separate, likely in‑memory per‑file key). Not currently recoverable locally.

## 10. Deleted / unsent message recovery (fresh dig)

**Question:** can we recover deleted ("Unsent") messages?

### Server (authenticated obs download): NO
- Message **text** is E2EE and the server exposes **no "fetch old/deleted messages" API** — there is nothing to pull.
- **Media** of an *unsent* message: LINE **revokes the obs object** on unsend, so its `OID`/`DOWNLOAD_URL` 404s. And once a row is gone locally you don't even hold the `OID`/`keyMaterial` to try.
- So route‑2 (obs) does **not** resurrect deleted content.

### Local store: PARTIALLY YES — via the FTS residue
On **Unsend**, LINE **clears `_message._text`** and keeps a tombstone row (`_contentMetadata.UNSENT = 1`), **but it does NOT purge the `_message_fts` full‑text index.** The original words remain in `_message_fts_content.c0_text`, keyed by `docid = _message.rowid`.

**Evidence (this account):**
- 5 unsent rows: rowid **101, 829, 830, 831, 832** (`UNSENT=1`), all with `_text` length 0.
- FTS still holds text for **3 of them**: rowid 829 (6 chars), 830 (9 chars), 831 (8 chars). rowid 101 and 832 (an image) left no FTS text.
- `_message` rows = 995, `_message_fts_content` rows = 995 (index kept in lock‑step by count, but content not wiped on unsend).

**Recovery method (local, no network):**
```
SELECT f.c0_text FROM _message_fts_content f JOIN _message m ON m.rowid=f.docid
WHERE (m._text IS NULL OR m._text='') AND length(f.c0_text)>0;
```
`c0_text` is the FTS "content" copy of the original message text → recovered as plaintext.

### Caveats / further residue (not yet pulled)
- Only **text** survives this way; an unsent **image** (rowid 832) leaves no FTS text, though its cached `.eimg`/`/e/` preview may linger on disk separately (survives the message).
- Deeper forensic residue (SQLite **freelist / WAL pages**, deleted-row slack) may hold more; not extracted here.
- Scope: the owner's own chat data on the owner's own device; local only; nothing uploaded.
