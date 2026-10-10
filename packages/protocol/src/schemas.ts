/**
 * Versioned JSON record schemas (zod). These describe the PLAINTEXT that goes
 * inside an envelope body for each kind. Every record carries, as separate
 * fields: schema version (`v`), record kind (`kind`), device id (`deviceId`),
 * original event time (`eventTime`), and capture time (`captureTime`). The event
 * time is the source's truth; the capture time is when the device observed it.
 * They are never merged.
 *
 * The C# and Kotlin ports serialize to the same JSON shape; field names and the
 * `v`/`kind` discriminators are normative.
 */
import { z } from "zod";

/** ISO-8601 timestamp string (kept as a string so all ports agree byte-for-byte). */
const ts = z.string().min(1);
const uuid = z.string().min(1);

/** Fields present on every capture/command record. */
const base = {
  v: z.literal(1),
  deviceId: uuid,
  eventTime: ts,
  captureTime: ts,
};

export const FileMetaRecord = z.object({
  ...base,
  kind: z.literal("file_meta"),
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative().optional(),
  ext: z.string(),
  mtime: ts.optional(),
  quickHash: z.string().optional(),
  thumbBlobOid: z.string().optional(),
  /**
   * oid of a chunked blob holding the file's original bytes, uploaded by the device
   * on its own under its media policy (PLAN decision 8; payloadKind `photo` or
   * `document`). Optional: absent means the original is available on request only.
   */
  originalBlobOid: z.string().min(1).optional(),
  /**
   * True when this record reports a deletion (default false). When true, `size`,
   * `mtime` and `quickHash` MAY be omitted and `eventTime` is when the deletion was
   * observed. A live record (deleted absent/false) still carries all three.
   */
  deleted: z.boolean().optional(),
}).superRefine((r, ctx) => {
  // Only a deletion may omit size/mtime/quickHash; a live record still carries them.
  if (!r.deleted) {
    if (r.size === undefined) ctx.addIssue({ code: "custom", path: ["size"], message: "size is required unless deleted" });
    if (r.mtime === undefined) ctx.addIssue({ code: "custom", path: ["mtime"], message: "mtime is required unless deleted" });
    if (r.quickHash === undefined) ctx.addIssue({ code: "custom", path: ["quickHash"], message: "quickHash is required unless deleted" });
  }
});

export const ScreenshotRecord = z.object({
  ...base,
  kind: z.literal("screenshot"),
  sourcePath: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  sha256: z.string(),
  /** oid of the chunked blob holding the original image bytes */
  blobOid: z.string(),
  takenAt: ts.optional(),
  savedAt: ts.optional(),
});

export const UsageEventRecord = z.object({
  ...base,
  kind: z.literal("usage_event"),
  app: z.string(),
  exe: z.string().optional(),
  /**
   * The foreground window title. Absent means the title was not captured (capture
   * off, or no title); `null` means a title was captured but excluded by a
   * `titleExclusions` setting; a string is the captured title.
   */
  title: z.string().nullable().optional(),
  startedAt: ts,
  endedAt: ts,
});

export const WindowsNotificationRecord = z.object({
  ...base,
  kind: z.literal("windows_notification"),
  app: z.string(),
  title: z.string(),
  text: z.string(),
  sender: z.string().optional(),
  postedAt: ts,
});

export const AndroidNotificationRecord = z.object({
  ...base,
  kind: z.literal("android_notification"),
  app: z.string(),
  title: z.string(),
  sender: z.string().optional(),
  preview: z.string(),
  notifKey: z.string().optional(),
  postedAt: ts,
});

export const CallRecord = z.object({
  ...base,
  kind: z.literal("call"),
  direction: z.enum(["incoming", "outgoing", "missed"]),
  contact: z.string().optional(),
  number: z.string(),
  startedAt: ts,
  durationS: z.number().int().nonnegative(),
});

export const MessageAttachment = z.object({
  attId: z.string(),
  kind: z.enum(["image", "video", "audio", "doc"]),
  filename: z.string(),
  size: z.number().int().nonnegative(),
  originHash: z.string().optional(),
  /** oid of the chunked blob holding the attachment original, when uploaded */
  blobOid: z.string().optional(),
});

export const Message = z.object({
  /**
   * The platform's own message id (Telegram message id, LINE local/server id, WhatsApp key id, SMS
   * provider id), never one the collector made up. The Mac merges copies of the same message that
   * arrive from different sources (Windows session, Android database, notification) on
   * platform + account + convKey + msgId (WX1, C8).
   */
  msgId: z.string().min(1),
  sender: z.string(),
  /** true when the account's own user sent this; the UI uses it for the bubble side, not a name guess */
  fromMe: z.boolean().optional(),
  /** the sender's resolved human display name; `sender` stays the stable platform id (used for merge) */
  senderName: z.string().min(1).optional(),
  sentAt: ts,
  text: z.string(),
  replyTo: z.string().optional(),
  editedAt: ts.optional(),
  sourceStatus: z.enum(["live", "deleted_at_source"]),
  /** who the message was forwarded from, as the platform shows it (a name, channel or id) */
  forwardedFrom: z.string().min(1).optional(),
  /** the media kind as the platform names it (photo, sticker, voice, video_note, ...); absent for plain text */
  mediaKind: z.string().min(1).optional(),
  /** when the source observed the deletion; only with sourceStatus deleted_at_source (C6) */
  deletedAtSource: ts.optional(),
  attachments: z.array(MessageAttachment).default([]),
}).superRefine((m, ctx) => {
  if (m.deletedAtSource !== undefined && m.sourceStatus !== "deleted_at_source") {
    ctx.addIssue({ code: "custom", path: ["deletedAtSource"], message: "deletedAtSource requires sourceStatus deleted_at_source" });
  }
});

/**
 * The capture source of a batch, `<role>:<collector>`: for example `windows:telegram-desktop`,
 * `windows:line-desktop`, `android:root-db`, `android:notification`. Lowercase; the role is the
 * sending device's role.
 */
export const SourceSession = z.string().regex(/^(windows|android):[a-z0-9][a-z0-9._-]*$/, "sourceSession must be <role>:<collector>");

/** Optional chat metadata as the platform reports it. */
export const ChatMeta = z.object({
  title: z.string().optional(),
  participantCount: z.number().int().nonnegative().optional(),
  /** the chat type as the platform names it (private, group, supergroup, channel, secret, ...) */
  chatType: z.string().min(1).optional(),
  /** the chat/peer profile image, uploaded as a chunked blob with payloadKind "avatar" */
  avatarBlobOid: z.string().min(1).optional(),
});


/** A LINE contact as the store records it (used to show the friends, blocked, and hidden lists). */
export const LineContact = z.object({
  mid: z.string(),
  displayName: z.string().optional(),
  status: z.string().optional(),            // the store's own _status value (e.g. relationship state)
  type: z.string().optional(),              // the store's _type value
  settings: z.number().int().optional(),    // the per-contact _settings integer (holds the block bit)
  blocked: z.boolean().optional(),          // resolved from settings/status when known
  statusMessage: z.string().optional(),
  picturePath: z.string().optional(),
  thumbnailUrl: z.string().optional(),
});

/** A chat's options, including whether it is hidden. */
export const LineChatOption = z.object({
  chatId: z.string(),
  hidden: z.boolean().optional(),
  notification: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

/**
 * line_account: a snapshot of the user's own LINE account state so the dashboard can show a standalone LINE
 * settings page — the own profile, the contact list with blocked/hidden state, and the app's settings. This
 * is the user's own account data, the same thing LINE's own Friends settings show.
 */
export const LineAccountRecord = z.object({
  ...base,
  kind: z.literal("line_account"),
  account: z.string(),
  ownProfile: z.object({ mid: z.string(), displayName: z.string().optional(), userId: z.string().optional(),
                         statusMessage: z.string().optional(), picturePath: z.string().optional() }).optional(),
  contacts: z.array(LineContact).default([]),
  chatOptions: z.array(LineChatOption).default([]),
  settings: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
});

export const MessageBatchRecord = z.object({
  ...base,
  kind: z.literal("message_batch"),
  platform: z.enum(["line", "telegram", "whatsapp", "sms", "instagram", "snapchat"]),
  account: z.string(),
  convKey: z.string(),
  peer: z.string().optional(),
  convKind: z.enum(["dm", "group"]),
  /** which capture source produced this batch (WX1) */
  sourceSession: SourceSession,
  /** what THIS source holds for the conversation; the Mac keeps one claim per source */
  coverage: z.enum(["complete", "partial", "notification_only"]),
  chatMeta: ChatMeta.optional(),
  messages: z.array(Message),
  /** per-conversation progress cursor (rowid or hash) */
  cursor: z.string(),
});

export const ManifestChunkEntry = z.object({
  index: z.number().int().nonnegative(),
  ctLen: z.number().int().positive(),
  sha256: z.string(),
});

export const ManifestRecord = z.object({
  v: z.literal(1),
  objectId: z.string(),
  payloadKind: z.string(),
  totalSize: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive(),
  totalChunks: z.number().int().positive(),
  cek: z.string(),
  chunks: z.array(ManifestChunkEntry),
  /**
   * Optional: the commandId of the file_request this blob answers. A sender sets it on
   * originals it uploads for a command, so the Mac can show the transfer before the
   * command_status arrives. Absent on every other blob.
   */
  commandId: z.string().min(1).optional(),
  /** receiver-side resume tracking; indices already committed */
  committedParts: z.array(z.number().int().nonnegative()).optional(),
});

export const FileRequestParams = z.object({
  type: z.literal("file_request"),
  /** locate by file id (preferred) or path */
  fileId: z.string().optional(),
  path: z.string().optional(),
});

export const RescanParams = z.object({
  type: z.literal("rescan"),
  collector: z.string(),
  /** optional scope, e.g. a drive, folder, or conversation */
  scope: z.string().optional(),
});

export const CollectorConfigParams = z.object({
  type: z.literal("collector_config"),
  collector: z.string(),
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const CommandRecord = z.object({
  ...base,
  kind: z.literal("command"),
  commandId: z.string(),
  issuedAt: ts,
  params: z.discriminatedUnion("type", [FileRequestParams, RescanParams, CollectorConfigParams]),
});

export const CommandStatusRecord = z.object({
  ...base,
  kind: z.literal("command_status"),
  commandId: z.string(),
  status: z.enum(["uploaded", "done", "not_found", "access_denied", "too_large", "error"]),
  detail: z.string().optional(),
  /** oid of the result object (e.g. the uploaded blob), when status=uploaded */
  resultOid: z.string().optional(),
  reportedAt: ts,
});

export const CollectorState = z.object({
  name: z.string(),
  enabled: z.boolean(),
  lastRunAt: ts.optional(),
  cursor: z.string().optional(),
  queueDepth: z.number().int().nonnegative(),
  /**
   * Optional import progress of the collector's current (or last) bulk pass: items
   * expected (`importTotal`) and processed so far (`importDone`). A sender that does not
   * know a total yet omits `importTotal`.
   */
  importTotal: z.number().int().nonnegative().optional(),
  importDone: z.number().int().nonnegative().optional(),
  /** which pass the progress belongs to: the first index, live incremental capture, or a rescan */
  phase: z.enum(["initial", "incremental", "rescan"]).optional(),
});

export const DeviceReportRecord = z.object({
  ...base,
  kind: z.literal("device_report"),
  role: z.enum(["windows", "android"]),
  appVersion: z.string().optional(),
  queueDepthTotal: z.number().int().nonnegative(),
  collectors: z.array(CollectorState),
  reportedAt: ts,
});

export const PairingDeviceRecord = z.object({
  ...base,
  kind: z.literal("pairing_device"),
  role: z.enum(["windows", "android"]),
  pairingId: z.string(),
  /** base64 device X25519 public key */
  publicKey: z.string(),
  fingerprint: z.string(),
});

/** Discriminated union of every capture/command record kind. */
export const AnyRecord = z.discriminatedUnion("kind", [
  FileMetaRecord,
  ScreenshotRecord,
  UsageEventRecord,
  WindowsNotificationRecord,
  AndroidNotificationRecord,
  CallRecord,
  MessageBatchRecord,
  CommandRecord,
  CommandStatusRecord,
  DeviceReportRecord,
  PairingDeviceRecord,
]);

export type FileMetaRecordT = z.infer<typeof FileMetaRecord>;
export type ScreenshotRecordT = z.infer<typeof ScreenshotRecord>;
export type UsageEventRecordT = z.infer<typeof UsageEventRecord>;
export type WindowsNotificationRecordT = z.infer<typeof WindowsNotificationRecord>;
export type AndroidNotificationRecordT = z.infer<typeof AndroidNotificationRecord>;
export type CallRecordT = z.infer<typeof CallRecord>;
export type MessageBatchRecordT = z.infer<typeof MessageBatchRecord>;
export type LineAccountRecordT = z.infer<typeof LineAccountRecord>;
export type LineContactT = z.infer<typeof LineContact>;
export type LineChatOptionT = z.infer<typeof LineChatOption>;
export type MessageT = z.infer<typeof Message>;
export type ChatMetaT = z.infer<typeof ChatMeta>;
export type ManifestRecordT = z.infer<typeof ManifestRecord>;
export type CommandRecordT = z.infer<typeof CommandRecord>;
export type CommandStatusRecordT = z.infer<typeof CommandStatusRecord>;
export type DeviceReportRecordT = z.infer<typeof DeviceReportRecord>;
export type PairingDeviceRecordT = z.infer<typeof PairingDeviceRecord>;
export type AnyRecordT = z.infer<typeof AnyRecord>;

const BY_KIND = {
  file_meta: FileMetaRecord,
  screenshot: ScreenshotRecord,
  usage_event: UsageEventRecord,
  windows_notification: WindowsNotificationRecord,
  android_notification: AndroidNotificationRecord,
  call: CallRecord,
  message_batch: MessageBatchRecord,
  command: CommandRecord,
  command_status: CommandStatusRecord,
  device_report: DeviceReportRecord,
  line_account: LineAccountRecord,
  pairing_device: PairingDeviceRecord,
} as const;

export type RecordKindName = keyof typeof BY_KIND;

/** Validate a decoded record against the schema for its declared kind. Throws on failure. */
export function validateRecord(obj: unknown): AnyRecordT {
  return AnyRecord.parse(obj);
}

/** Validate against a specific kind's schema. */
export function validateRecordKind<K extends RecordKindName>(
  kind: K,
  obj: unknown,
): z.infer<(typeof BY_KIND)[K]> {
  return BY_KIND[kind].parse(obj) as z.infer<(typeof BY_KIND)[K]>;
}

/** Validate a chunked-object manifest. */
export function validateManifest(obj: unknown): ManifestRecordT {
  return ManifestRecord.parse(obj);
}
