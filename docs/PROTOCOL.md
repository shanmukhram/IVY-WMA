# IVY wire protocol

Normative specification. The TypeScript reference implementation lives in
`packages/protocol` (`@ivy/protocol`); the C# (Windows, `Ivy.Core`) and Kotlin
(Android) ports MUST implement this document and MUST reproduce the vectors in
`docs/test-vectors/` byte-for-byte.

This covers only the wire format and reference crypto: the envelope, key
material, object-key layout, record schemas, and pairing. Bucket lifecycle,
ingest ledger, and UI are specified in `docs/PRD.md`.

Terms from the PRD that are binding here: *Product principles* (R2 is a mailbox:
every object is ciphertext; private keys never leave their machine) and *Shared
architecture: buckets, keys, pairing*.

## 0. Conventions

- All multi-byte integers are **big-endian**.
- Strings in binary structures and in AAD are **UTF-8**, no BOM.
- Binary values inside JSON use **standard base64** unless a field is named
  `...Hex` (lowercase hex) or the site says base64url.
- AES-256-GCM: 32-byte key, **12-byte nonce**, **16-byte tag appended** to the
  ciphertext (`ciphertext || tag`). This matches .NET `AesGcm` and Java
  `AES/GCM/NoPadding` when the port appends the tag.
- X25519 per RFC 7748. Keys are 32 bytes. The secret scalar is used directly;
  clamping happens inside the X25519 function.
- HKDF is HKDF-SHA256 (RFC 5869).
- `||` is concatenation; `0x00` is a single separator byte written `SEP` below.

## 1. Cryptographic overview

Hybrid public-key encryption, one object at a time (the same scheme as Session
Sync):

1. A fresh random **content key** (CEK, 32 bytes) encrypts the payload with
   AES-256-GCM.
2. The CEK is **wrapped to the recipient's X25519 public key**: an ephemeral
   X25519 keypair is generated, ECDH gives a shared secret, HKDF-SHA256 turns it
   into a key-encryption key (KEK), and the CEK is AES-256-GCM-encrypted under
   the KEK.
3. The object's **storage key** and its **kind** are bound into the GCM AAD of
   both the wrap and the body, so an object cannot be moved to another key or
   relabelled as another kind without authentication failing.

Device → Mac objects are wrapped to the **Mac's** public key. Mac → device
commands are wrapped to **that device's** public key. Only the holder of the
matching private key can recover the CEK, so R2 holds nothing readable
(principle 1).

## 2. Envelope format

### 2.1 Single-shot (mode `0x01`)

Byte layout:

| Offset | Len | Field |
| --- | --- | --- |
| 0 | 4 | magic `IVY1` (0x49 0x56 0x59 0x31) |
| 4 | 1 | version `0x01` |
| 5 | 1 | mode `0x01` |
| 6 | 1 | kind id (§5) |
| 7 | 1 | reserved `0x00` (decoders MUST reject any other value) |
| 8 | 32 | ephemeral X25519 public key (`epk`) |
| 40 | 12 | wrap nonce |
| 52 | 48 | wrapped CEK (`ciphertext(32) || tag(16)`) |
| 100 | 12 | body nonce |
| 112 | … | body `ciphertext || tag` |

Minimum length is 112 + 16 = 128 bytes. A single-shot envelope of an N-byte
plaintext is `112 + N + 16` bytes.

**Key schedule.** Let `R` be the recipient public key, `e` the ephemeral secret
key, `epk = X25519(e, basepoint)`.

```
shared = X25519(e, R)                      # sender side
       = X25519(recipient_secret, epk)     # recipient side (same value)
KEK    = HKDF-SHA256(
           ikm  = shared,
           salt = epk,                      # 32 bytes
           info = "IVY1 kek v1" || R,       # ASCII || 32-byte recipient pubkey
           L    = 32)
```

**AAD.** With `k` = kind id byte and `K` = object key UTF-8 bytes:

```
AAD_wrap = "ivy/v1/wrap" || SEP || K || SEP || k || SEP || epk
AAD_body = "ivy/v1/body" || SEP || K || SEP || k || SEP || epk
```

**Encrypt.**

```
CEK          = random(32)
wrapped_cek  = AES-256-GCM(key=KEK, nonce=wrap_nonce, pt=CEK,       aad=AAD_wrap)
body         = AES-256-GCM(key=CEK, nonce=body_nonce, pt=plaintext, aad=AAD_body)
envelope     = header || body
```

**Decrypt.** Check magic, version, mode. Read `epk`, nonces, `wrapped_cek`,
`body`. Derive `KEK` from `X25519(recipient_secret, epk)`. Recover
`CEK = AES-256-GCM-open(KEK, wrap_nonce, wrapped_cek, AAD_wrap)`, then
`plaintext = AES-256-GCM-open(CEK, body_nonce, body, AAD_body)`. Any
authentication failure aborts with no plaintext returned. If `expectedKind` is
supplied, the header kind must equal it.

Nonces for single-shot objects are random. CEK reuse is avoided by generating a
fresh CEK per object.

### 2.2 Chunked objects (mode `0x02`)

For large originals (files and media up to GBs) uploaded as independent
multipart parts. One CEK encrypts every chunk of the object; a **manifest**
(itself a single-shot envelope) carries that CEK and a SHA-256 over each part,
binding the parts together.

**Chunk part** byte layout:

| Offset | Len | Field |
| --- | --- | --- |
| 0 | 4 | magic `IVY1` |
| 4 | 1 | version `0x01` |
| 5 | 1 | mode `0x02` |
| 6 | 1 | kind id = `blob_chunk` (0x09) |
| 7 | 1 | reserved `0x00` (decoders MUST reject any other value; the kind byte MUST be `blob_chunk`) |
| 8 | 16 | object id (binary) = the 16 bytes of the blob's `oid` (§4.1) |
| 24 | 4 | chunk index (u32) |
| 28 | 4 | total chunks (u32) |
| 32 | … | body `ciphertext || tag` |

The chunk header is 32 bytes. The per-chunk nonce is **derived**, not stored:

```
chunk_nonce(i) = 0x00000000 || u64be(i)          # 12 bytes
AAD_chunk(i)   = "ivy/v1/chunk" || SEP || object_id || u32be(i) || u32be(total)
                 || kind_id(blob_chunk)
body(i)        = AES-256-GCM(key=CEK, nonce=chunk_nonce(i), pt=chunk_i, aad=AAD_chunk(i))
```

Because the CEK is unique per object and the nonce encodes the chunk index,
`(CEK, nonce)` never repeats. The index and total in the AAD make a chunk
undecryptable in any position but its own — this is the cryptographic basis for
reorder rejection.

**Manifest** (plaintext inside a single-shot envelope of kind `manifest`, stored
at `up/blob/<oid>/manifest`):

```json
{
  "v": 1,
  "objectId": "<hex of the 16-byte object id>",
  "payloadKind": "screenshot",
  "totalSize": 600,
  "chunkSize": 256,
  "totalChunks": 3,
  "cek": "<base64 32-byte content key>",
  "chunks": [
    { "index": 0, "ctLen": 304, "sha256": "<hex of the full part bytes>" }
  ],
  "commandId": "6f1c…",
  "committedParts": [0, 1]
}
```

- `objectId` is the hex of the same 16 bytes as the `oid` in the blob's object key (`up/blob/<oid>/…`); receivers read it from the manifest and MUST check it against the key.
- `payloadKind` is the logical kind of the reconstructed object, one of:
  `file_original` (an original file uploaded in answer to a `file_request`),
  `screenshot`, `thumbnail`, `photo` (an image original a device uploads on its own,
  e.g. a Windows image outside the Screenshots folder, PLAN decision 8), `attachment`,
  `media`, `document` (a document original a device uploads on its own under its
  media policy, PLAN decision 8). It is a string in its own namespace, distinct from
  the record kinds of §5. `photo` and `document` blobs are referenced from
  `file_meta.originalBlobOid` (§6).
- `cek` is the object content key. It is only ever present inside the encrypted
  manifest envelope, so it never exists as plaintext at rest.
- `chunks[i].sha256` is SHA-256 over the **entire part** (header + ciphertext +
  tag), so the chunk header is covered too.
- `ctLen` is the full part length.
- `commandId` is optional. A sender that uploads an original in answer to a
  `file_request` command (`payloadKind: "file_original"`) SHOULD set it to that
  command's `commandId`; every other blob omits it. When absent the key is left
  out of the JSON entirely (not `null`), so manifests without it are unchanged
  byte-for-byte (the §9 vector has none). Serialized after `chunks`. It lets the
  receiver link the blob to the command as soon as the manifest arrives and show
  the command as transferring, with part progress, before the `command_status`
  (`uploaded`) is reported. A receiver MUST NOT trust it blindly: the Mac links it
  only to an outstanding `file_request` sent to a device of the bucket's role.
- `committedParts` is optional receiver-side resume state (which parts the Mac
  has already committed); a sender omits it.

**Receiver verification**, per part `i`, in order `0 … totalChunks-1`:

1. The manifest entry `i` must exist with `index == i`.
2. The supplied part length must equal `ctLen`.
3. `SHA-256(part) == chunks[i].sha256` (fast tamper/reorder check).
4. The part header's `index` must equal `i` and `totalChunks` must match.
5. AES-256-GCM-open with `CEK`, `chunk_nonce(i)`, `AAD_chunk(i)`.

A reordered, substituted, truncated, tampered, or missing part fails at least one
of (3)–(5). The reassembled length must equal `totalSize`. A part can be
encrypted and uploaded independently (it is self-describing); the manifest is
uploaded first so the Mac can track `committedParts` and resume after a
disconnect without re-uploading committed parts (PRD AU3, S5).

## 3. Key material

### 3.1 Mac keypair — deterministic from passphrase

The Mac identity is an X25519 keypair **derived deterministically** from the
passphrase and a stored 16-byte salt, so a restored Mac re-derives the identical
key and every object already wrapped to it still decrypts ("re-pairing from
passphrase", PRD; Session Sync parity).

```
seed       = Argon2id(password = passphrase_utf8, salt = macSalt, params)   # 32 bytes
secret_key = seed
public_key = X25519(seed, basepoint)
```

**Argon2id parameters (normative — ports MUST match exactly):**

| Parameter | Value |
| --- | --- |
| variant | Argon2id |
| memory | 65536 KiB (64 MiB) |
| iterations (time cost) | 3 |
| parallelism | 1 |
| salt length | 16 bytes |
| output length | 32 bytes |

The salt is generated once per Mac identity and stored in the clear (it is not
secret). Argon2 version 0x13 (19).

### 3.2 Device keypairs — random

Windows and Android device keypairs are **random** X25519 keypairs
(`public = X25519(random(32), basepoint)`), generated on the device at pairing.
The secret key is stored in **DPAPI** (Windows) / **Android Keystore** and never
leaves the device. Nothing on a device can decrypt vault content (only the Mac
holds the private key that device objects are wrapped to).

### 3.3 Private key at rest

A private key is **never serialized in the clear**. The only on-disk form is an
AES-256-GCM blob under an Argon2id-derived key, with its own fresh salt
(independent of the identity salt):

```
wrapKey = Argon2id(passphrase, atRestSalt, params)      # same params as §3.1
blob    = "IVYK1" || AES-256-GCM(key=wrapKey, nonce, pt=secret_key, aad="ivy/v1/keystore")
```

Serialized container (JSON): `{ v:1, salt, nonce, blob }` with base64 fields.
(On the Mac the key is held in memory after one passphrase entry and auto-locks;
on devices the OS keystore performs the at-rest protection instead.)

### 3.4 Fingerprint

Short, human-comparable identifier shown on both screens during pairing:

```
fingerprint(pub) = uppercase_hex( SHA-256(pub)[0:8] ) grouped as XXXX-XXXX-XXXX-XXXX
```

Example (from `docs/test-vectors/keys.json`): `CF0A-77FB-0DA6-ACE6`. 16 hex
characters, four groups of four. Deterministic and identical across ports.

## 4. Object-key layout

Buckets (PRD): `ivy-up-windows`, `ivy-up-android` (device → Mac);
`ivy-cmd-windows`, `ivy-cmd-android` (Mac → device). Keys:

| Key | Bucket | Meaning |
| --- | --- | --- |
| `up/<prefix>/<oid>` | up | one capture record (prefix per kind, §5) |
| `up/blob/<oid>/manifest` | up | chunked-object manifest (trailer) |
| `up/blob/<oid>/p/<nnnnnnnn>` | up | one chunk part (index zero-padded to 8) |
| `up/cstat/<oid>` | up | command-status report |
| `up/status/<oid>` | up | device heartbeat / collector-state report |
| `pair/<pairingId>/device` | up | pairing: device public key, wrapped to Mac |
| `cmd/<oid>` | cmd | one command (file request, rescan, config) |
| `pair/<pairingId>` | cmd | pairing bootstrap, sealed to the one-time secret |

### 4.1 Object id (`oid`) — time-ordered

An `oid` is a 128-bit identifier in ULID layout: 48-bit millisecond timestamp
(big-endian) followed by 80 random bits, encoded as **26 Crockford base32**
characters (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no padding). Because the
time is the high-order part and base32 preserves byte order, **sorting oids as
strings sorts them by time**. Bit packing is normative: the 128 bits are consumed
most-significant first in 5-bit groups, and the final group is the last 3 bits
padded on the **right** with two zero bits (this differs from off-the-shelf ULID
text encoders, which pad at the front; ports MUST NOT use a ULID library). "List objects since marker M" is therefore every
key whose `oid` string is `> M`. This drives the Mac's incremental sync marker
(PRD S1).

Prefixes let a reader page one kind at a time. The full prefix → kind mapping is
in §5.

## 5. Record kinds

Each encrypted object declares a kind. The kind id is a single AAD byte; the
prefix is the object-key segment. Append-only; ids are never reused.

| Kind | id | prefix |
| --- | --- | --- |
| `file_meta` | 0x01 | `file` |
| `screenshot` | 0x02 | `scr` |
| `usage_event` | 0x03 | `usg` |
| `windows_notification` | 0x04 | `wnotif` |
| `android_notification` | 0x05 | `anotif` |
| `call` | 0x06 | `call` |
| `message_batch` | 0x07 | `msg` |
| `manifest` | 0x08 | `blob` |
| `blob_chunk` | 0x09 | `blob` |
| `command` | 0x0a | `cmd` |
| `command_status` | 0x0b | `cstat` |
| `device_report` | 0x0c | `status` |
| `pairing_device` | 0x0d | `pair` |
| `line_account` | 0x0e | `lineacct` |

## 6. Record schemas (JSON, versioned)

Every capture/command record carries, as **separate** fields: `v` (schema
version, currently `1`), `kind`, `deviceId`, `eventTime` (the source's original
event time), and `captureTime` (when the device observed it). Event and capture
times are never merged. Timestamps are ISO-8601 strings (kept as strings so all
ports agree byte-for-byte).

The authoritative schemas are the zod definitions in
`packages/protocol/src/schemas.ts`. Summary:

**file_meta** — `path, name, ext, size, mtime, quickHash, thumbBlobOid?,
originalBlobOid?, deleted?` (WC1/WC2; metadata, plus the original when the
device's media policy uploads it, PLAN decision 8). `originalBlobOid` is optional:
when present it is the oid of a chunked blob (§2.2, payloadKind `photo` or
`document`) holding the file's original bytes, uploaded by the device on its own;
the blob MAY arrive before or after the record, and several records (copies or a
moved file with the same content) MAY name the same blob. When absent the original
is available on request (`file_request`) only. `deleted` is an optional
boolean (default false). When `deleted` is true the file has been observed removed
(watcher delete, USN delete reason, or missing in a rescan); `size`, `mtime` and
`quickHash` MAY then be omitted, and `eventTime` is when the deletion was observed.
A live record (deleted absent or false) still carries `size`, `mtime` and
`quickHash`.

**screenshot** — `sourcePath, width?, height?, sha256, blobOid, takenAt?,
savedAt?` where `blobOid` references the chunked blob holding the original image
(WC3, M1/M2/M7).

**usage_event** — `app, exe?, title?, startedAt, endedAt` (WC4/AC9). `title` is
`string | null`: a string is the captured window title, `null` means a title was
captured but excluded by a `titleExclusions`/capture setting, and an absent `title`
means no title was captured at all.

**windows_notification** — `app, title, text, sender?, postedAt` (WC5).

**android_notification** — `app, title, sender?, preview, notifKey?, postedAt`
(AC1; `preview` is a partial record).

**call** — `direction(incoming|outgoing|missed), contact?, number, startedAt,
durationS` (AC8).

**message_batch** — `platform(line|telegram|whatsapp|sms|instagram|snapchat),
account, convKey, peer?, convKind(dm|group), sourceSession, coverage(complete|partial|
notification_only), chatMeta?, cursor, messages[]`. Each message:
`msgId, sender, sentAt, text, replyTo?, editedAt?,
sourceStatus(live|deleted_at_source), forwardedFrom?, mediaKind?, deletedAtSource?,
attachments[]`. Each attachment:
`attId, kind(image|video|audio|doc), filename, size, originHash?, blobOid?`
(C1–C10, AC2/AC5/AC6, WT1–WT4, WL1–WL3, WX1; `sentAt` is the source's truth,
`captureTime` is ours).

- `sourceSession` (required) names the capture source as `<role>:<collector>`,
  lowercase, where `<role>` is the sending device's role: for example
  `windows:telegram-desktop`, `windows:line-desktop`, `android:root-db`,
  `android:notification`. The Mac quarantines a batch whose role prefix is not
  the sending device's role.
- `coverage` is what **this source** holds for the conversation. The Mac keeps
  one claim per source and shows the best any source claims, with every source
  listed (e.g. "complete via windows:telegram-desktop; partial via
  android:notification"). Each source's latest claim replaces its earlier one. A
  notification source (`*:notification`) is never counted above `partial`, and
  LINE from a `windows:` source is never counted above `partial` (WL2), whatever
  the batch says.
- `msgId` (required, non-empty) is the **platform's own message id**, never one
  the collector invents. Copies of one message from different sources merge on
  `platform + account + convKey + msgId` into one record listing every source
  (WX1, C8). A notification source sends a batch only when the notification
  exposes the platform id; otherwise its previews stay `android_notification`
  records and the Mac links them (N3): a linked notification is listed as a
  `<role>:notification` source of the message too.
- Merge rules on the Mac: a notification preview never overwrites text from a
  non-notification source; a fuller copy replaces a preview (not recorded as an
  edit); a changed text with a later `editedAt`, or from the source that gave
  the current text, is an edit (the prior text goes to the edit history); a copy
  with an older `editedAt` never reverts a newer one; between sources with the
  same `editedAt` the longer text wins (the shorter goes to the edit history);
  a deletion reported by any source marks the message deleted at source and
  never removes it.
- `forwardedFrom?` — who it was forwarded from, as the platform shows it.
- `mediaKind?` — the media kind as the platform names it (`photo`, `sticker`,
  `voice`, …); absent for plain text.
- `deletedAtSource?` — when the source observed the deletion; only valid with
  `sourceStatus: deleted_at_source` (a deletion without it is dated by
  `captureTime`).
- `chatMeta?` — `{ title?, participantCount?, chatType? }`, as the platform
  reports them (`chatType` in the platform's own words: `private`, `group`,
  `supergroup`, `channel`, `secret`, …).

**manifest** — see §2.2 (`objectId, payloadKind, totalSize, chunkSize,
totalChunks, cek, chunks[], commandId?, committedParts?`).

**command** — `commandId, issuedAt, params` where `params` is a discriminated
union on `type`:
- `file_request`: `{ type, fileId?, path? }` (F2, WR1/AR1)
- `rescan`: `{ type, collector, scope? }` (WR3/AC2a)
- `collector_config`: `{ type, collector, enabled?, settings? }` (WR3)

**command_status** — `commandId, status(uploaded|done|not_found|access_denied|
too_large|error), detail?, resultOid?, reportedAt` (WR2/AR1). `uploaded` is for
`file_request` (with `resultOid` = the blob oid); `done` is the success status for
`rescan` and `collector_config`. A command whose `deviceId` is not the receiving
device's own id is ignored and reported as `error`.

**device_report** — `role(windows|android), appVersion?, queueDepthTotal,
reportedAt, collectors[]`. Each collector:
`name, enabled, lastRunAt?, cursor?, queueDepth, importTotal?, importDone?,
phase?`. This is what lets the Mac show honest coverage: per-collector last run,
cursor, enabled flag, and queue depth (PRD principle 4; D1–D5).

Import progress (all optional, non-negative integers / enum): `importTotal` is
how many items the collector's current (or last) bulk pass expects,
`importDone` how many it has processed, and `phase` which pass that is:
`initial` (the first full index), `rescan` (a later full or scoped pass:
periodic, settings change, rescan command, lost events), or `incremental` (live
capture after a completed pass; `importTotal`/`importDone` then describe the
last completed pass). A sender omits `importTotal` until it has a real count and
never guesses one; it reports `importTotal >= importDone`. A collector without a
bulk pass omits all three. The Mac computes its percentage from these numbers
and shows "counting" when `importTotal` is absent.

**pairing_device** — `role, pairingId, publicKey(base64), fingerprint` (§7).

## 7. Pairing

Implements PLAN decision 1. A fresh device has no R2 credentials, so the
one-time code carries a bootstrap.

**Pairing string** (shown as text and as a QR of the same bytes):

```
IVYPAIR1.<base64url(UTF-8 JSON payload)>
```

Prefix `IVYPAIR1`, a literal `.`, then base64url of the JSON. Compact,
pasteable, and QR-friendly (on Windows, "entering the code" is pasting this
string). Payload fields:

```json
{
  "v": 1,
  "r2Endpoint": "https://<acct>.r2.cloudflarestorage.com",
  "role": "windows",
  "cmdBucket": "ivy-cmd-windows",
  "upBucket": "ivy-up-windows",
  "cmdReadToken": "<accessKeyId>:<secretAccessKey>  (device cmd-bucket READ token)",
  "macPublicKey": "<base64 Mac X25519 public key>",
  "macFingerprint": "CF0A-77FB-0DA6-ACE6",
  "pairingId": "<hex>",
  "secret": "<base64 32-byte one-time secret>",
  "exp": 1760000600000
}
```

**Bootstrap object** `pair/<pairingId>` (written by the Mac into the device's
**cmd-bucket**), sealed to the one-time secret (the device has no exchanged
keypair yet, so this is symmetric):

```
bootKey   = HKDF-SHA256(ikm=secret, salt=pairingId_utf8, info="IVY1 pair v1", L=32)
AAD_boot  = "ivy/v1/pair" || SEP || pairingId_utf8
sealed    = AES-256-GCM(key=bootKey, nonce, pt=bootstrapJSON, aad=AAD_boot)
```

serialized as `{ v:1, nonce, ct }` (base64). Bootstrap plaintext:
`{ v:1, upBucket, upWriteToken, pairingId }` — the up-bucket **write** token.
All R2 tokens on the wire are the string `<accessKeyId>:<secretAccessKey>`
(S3 SigV4 credentials); the vector tokens are placeholders, not usable credentials.

**Flow and verification.**

1. Mac generates `pairingId` + `secret`, writes the sealed bootstrap to
   `pair/<pairingId>` in the device's cmd-bucket, and shows the pairing string +
   QR + its own fingerprint.
2. Device decodes the string; checks `v == 1` and `now <= exp` (expiry is a
   backstop); verifies `fingerprint(macPublicKey) == macFingerprint`.
3. Device fetches `pair/<pairingId>` with `cmdReadToken`, derives `bootKey` from
   `secret`, and opens the bootstrap to get the up-bucket write token.
4. Device generates its random X25519 keypair (stored in DPAPI/Keystore) and
   writes `pair/<pairingId>/device` to its up-bucket: a normal envelope of kind
   `pairing_device`, wrapped to the Mac's public key, carrying the device public
   key + fingerprint.
5. Mac ingests `pair/<pairingId>/device`, decrypts with its private key, records
   the device, and both screens show the matching fingerprints to confirm.

**Single-use.** The Mac deletes `pair/<pairingId>` once consumed and refuses a
second `pair/<pairingId>/device`. Re-pairing after a Mac restore works because
the Mac re-derives the same key from the passphrase (§3.1).

## 8. Threat notes

- **What R2 sees.** Object **sizes, timing, and prefixes/keys** only. Keys reveal
  the kind (prefix) and capture time (the `oid` timestamp), and that a blob has N
  parts. No plaintext, no content keys, no compute (principle 1; PRD "What R2
  sees"). Chunk sizes leak the rough size of large originals; pad at the
  collector if this matters.
- **A leaked token** is bucket- and verb-scoped. A device's **up-write** token
  can only *write* to that up-bucket — it can inject or overwrite ciphertext
  objects (a DoS/garbage vector, mitigated by the Mac quarantining undecryptable
  objects, PRD S4) but cannot read anything, since it cannot decrypt and has no
  read verb. A device's **cmd-read** token can only *read* that cmd-bucket:
  commands are wrapped to the device key, so a stolen token off-device reveals
  nothing. The Mac's tokens (read+delete on up-buckets, write on cmd-buckets)
  are the most sensitive and live only on the Mac.
- **Replay / relocation.** The object key and kind are in the AAD of both the
  wrap and the body, so an object copied to a different key or relabelled fails
  authentication; it cannot be "replayed under a different key". Within chunked
  objects, per-chunk index+total in the AAD plus manifest hashes defeat
  reordering, substitution, and truncation.
- **Rollback.** R2 object overwrite/rollback is not prevented cryptographically;
  the Mac's ingest ledger commits idempotently and advances a monotonic
  marker (PRD S2/S3), and up-objects are deleted on ingest, so a replayed old
  object is recognised as already-committed. Device cmd-bucket tokens are
  read-only, so a device cannot delete commands: it records executed command
  ids locally and ignores repeats, and the Mac deletes `cmd/<oid>` when it
  ingests the matching `command_status` (PLAN decision 4).
- **One-time pairing secret.** Short-lived (`exp`) and single-use (the Mac
  deletes the bootstrap and refuses a second device object). A leaked secret
  before consumption could decrypt the bootstrap (the up-write token); the Mac
  invalidates a pairing id that was not completed, and tokens can be rotated.

## 9. Test vectors

`docs/test-vectors/*.json`, generated deterministically by
`pnpm --filter @ivy/protocol vectors` (or `pnpm vectors` from the repo root). All
"random" inputs — private keys, ephemeral keys, content keys, nonces, oids,
pairing secret — are hard-coded, so output is byte-for-byte reproducible. The
reference tests in `packages/protocol/test/vectors.test.ts` re-run the vectors
and assert equality; the C# and Kotlin ports MUST do the same. The reference
exposes the injection point as `setRandomSource` plus per-call `options` (fixed
`ephemeralSecretKey`, `contentKey`, nonces); ports expose equivalent hooks.

Files:

| File | Covers | Key fields |
| --- | --- | --- |
| `keys.json` | §3.4, X25519 pub derivation | `macSecretKeyHex`, `macPublicKeyHex`, `macPublicKeyB64`, `fingerprint` |
| `argon2id.json` | §3.1 passphrase → keypair | `params`, `passphrase`, `saltHex`, `derivedSecretKeyHex`, `derivedPublicKeyHex`, `fingerprint` |
| `envelope-single.json` | §2.1 | `recipient*Hex`, `kind`, `objectKey`, `inputs.*`, `plaintextHex`, `envelopeHex` |
| `envelope-chunked.json` | §2.2 | `objectIdHex`, `chunkSize`, `inputs.*`, `manifest`, `manifestKey`, `manifestEnvelopeHex`, `parts[].bytesHex` |
| `pairing.json` | §7 | `pairingPayload`, `pairingString`, `bootstrapInputs.*`, `bootstrapPlaintext`, `sealedBootstrap` |

Vector format rules a port follows:

- `*Hex` fields are lowercase hex; `*B64` and other binary JSON fields are
  standard base64; `pairingString` is the literal string.
- To reproduce `envelopeHex`: encrypt `plaintextHex` under the given recipient
  key, kind, objectKey, and the fixed `inputs` (ephemeral secret, content key,
  wrap nonce, body nonce); the result must equal `envelopeHex`.
- To reproduce `envelope-chunked.json`: the plaintext is the 600-byte sequence
  `byte[i] = i mod 256`; with the fixed content key and manifest inputs,
  `manifestEnvelopeHex` and every `parts[i].bytesHex` must match.
- To reproduce `sealedBootstrap`: seal `bootstrapPlaintext` under
  `bootstrapInputs.secretHex` with `bootstrapInputs.nonceHex`.
- `argon2id.json` is the single most important cross-port check: if a port's
  Argon2id output differs, passphrase-derived keys and at-rest blobs will not
  interoperate. Verify `derivedSecretKeyHex` first.
