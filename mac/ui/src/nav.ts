/** Navigation model: sidebar sections, per-device sources and the routes they open. */
import type { IconName } from "./components/Icon.tsx";

export type Role = "windows" | "android";

export interface DeviceSource {
  key: string;
  label: string;
  icon: IconName;
  /** what the per-device view shows for this source */
  view:
    | { kind: "files" }
    | { kind: "media"; mediaKind?: "screenshot" | "photo" }
    | { kind: "records"; type: string; empty: string }
    | { kind: "notifications" }
    | { kind: "browse" }
    | { kind: "chats"; platform: string; source?: string };
  /** what the collector captures (D4), shown in the per-device view */
  captures: string;
}

export const DEVICE_SOURCES: Record<Role, DeviceSource[]> = {
  windows: [
    { key: "files", label: "Files", icon: "doc", view: { kind: "files" }, captures: "File index with thumbnails; originals on request (images and documents under the size caps upload automatically)." },
    { key: "browse", label: "Browse PC", icon: "folder", view: { kind: "browse" }, captures: "The whole drive as a file tree from the device catalogue; fetch any file or folder on demand at full quality." },
    { key: "screenshots", label: "Screenshots", icon: "screenshot", view: { kind: "media", mediaKind: "screenshot" }, captures: "Screenshot originals, OCR'd on the Mac." },
    { key: "usage", label: "Usage", icon: "usage", view: { kind: "records", type: "usage", empty: "No app usage from Windows yet." }, captures: "Foreground app spans with window titles when title capture is on." },
    { key: "notifications", label: "Notifications", icon: "bell", view: { kind: "notifications" }, captures: "Notifications as shown: partial records, not conversations." },
    { key: "telegram", label: "Telegram", icon: "chat", view: { kind: "chats", platform: "telegram", source: "windows:telegram-desktop" }, captures: "Complete cloud history through the Telegram Desktop session." },
    { key: "line", label: "LINE", icon: "chat", view: { kind: "chats", platform: "line", source: "windows:line-desktop" }, captures: "LINE for Windows local store: always partial (what the PC has synced)." },
  ],
  android: [
    { key: "notifications", label: "Notifications", icon: "bell", view: { kind: "notifications" }, captures: "Every notification from the listener: partial records, kept after dismissal." },
    { key: "calls", label: "Calls", icon: "call", view: { kind: "records", type: "call", empty: "No calls from Android yet." }, captures: "Call log: direction, contact, number, start time and duration." },
    { key: "usage", label: "Usage", icon: "usage", view: { kind: "records", type: "usage", empty: "No app usage from Android yet." }, captures: "App usage events." },
    { key: "media", label: "Media", icon: "photo", view: { kind: "media" }, captures: "Photos and screenshots with capture and save times." },
    { key: "line", label: "LINE", icon: "chat", view: { kind: "chats", platform: "line" }, captures: "Complete history from the rooted LINE database." },
    { key: "telegram", label: "Telegram", icon: "chat", view: { kind: "chats", platform: "telegram" }, captures: "History from the rooted Telegram database." },
    { key: "whatsapp", label: "WhatsApp", icon: "chat", view: { kind: "chats", platform: "whatsapp" }, captures: "History from the rooted WhatsApp database." },
    { key: "sms", label: "SMS", icon: "chat", view: { kind: "chats", platform: "sms" }, captures: "Text messages from the SMS provider." },
  ],
};

export const ROLES: Role[] = ["windows", "android"];
