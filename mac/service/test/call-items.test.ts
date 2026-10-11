import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { commitMessageBatch } from "../src/ingest/committers.ts";
import { callLabel } from "../src/util/call.ts";

let svc: Service;
let dir: string;
const DEV = "win-1";
const SYS = "Call History : 2757000 millisecs, Result: 18";
const T = (h: number) => `2026-09-24T${String(h).padStart(2, "0")}:00:00.000Z`;

beforeEach(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  svc.ctx.db.prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k', 'FP', ?)").run(DEV, T(0));
  commitMessageBatch(svc.ctx.db, {
    v: 1, kind: "message_batch", deviceId: DEV, eventTime: T(9), captureTime: "2026-10-01T00:00:00.000Z",
    sourceSession: "windows:line-desktop", platform: "line", account: "me", convKey: "c", peer: "Aki", convKind: "dm", coverage: "partial", cursor: "1",
    messages: [
      { msgId: "k1", sender: "Aki", sentAt: T(9), text: SYS, mediaKind: "call", sourceStatus: "live", attachments: [],
        call: { kind: "video", outcome: "completed", durationSec: 155, direction: "incoming" } },
      { msgId: "k2", sender: "Aki", sentAt: T(10), text: SYS, mediaKind: "call", sourceStatus: "live", attachments: [],
        call: { kind: "audio", outcome: "missed", direction: "incoming" } },
      { msgId: "k3", sender: "Aki", sentAt: T(11), text: "see you soon", sourceStatus: "live", attachments: [] },
    ],
  } as never);
});
afterEach(async () => { await svc.close(); rm(dir); });

describe("call messages in timeline and search", () => {
  it("label wording", () => {
    expect(callLabel({ kind: "video", outcome: "completed", durationSec: 155 })).toBe("Video call · 2:35");
    expect(callLabel({ kind: "audio", outcome: "missed" })).toBe("Missed audio call");
    expect(callLabel({ kind: "unknown", outcome: "declined" })).toBe("Declined call");
  });

  it("the timeline returns the call label as body and the call object", async () => {
    const r = await api(svc, "GET", "/api/timeline?date=2026-09-24&tz=UTC&types=message");
    expect(r.status).toBe(200);
    const items = r.json.items as Array<Record<string, any>>;
    expect(items.map((i) => i.body)).toEqual(["Video call · 2:35", "Missed audio call", "see you soon"]);
    expect(items[0]!.call).toEqual({ kind: "video", outcome: "completed", durationSec: 155, direction: "incoming" });
    expect(items[1]!.call).toEqual({ kind: "audio", outcome: "missed", direction: "incoming" });
    expect(items[2]).not.toHaveProperty("call");
    expect(r.body).not.toContain("Call History");
  });

  it("search finds a call message by a word in its stored text and shows the label, not the system text", async () => {
    const r = await api(svc, "GET", "/api/search?q=millisecs&types=message");
    expect(r.status).toBe(200);
    const items = r.json.items as Array<Record<string, any>>;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.snippet).sort()).toEqual(["Missed audio call", "Video call · 2:35"]);
    expect(items.map((i) => i.snippetHtml).sort()).toEqual(["Missed audio call", "Video call · 2:35"]);
    expect(items.every((i) => i.call && i.body === i.snippet)).toBe(true);
    // an ordinary message in the same result keeps its highlight and has no call
    const plain = (await api(svc, "GET", "/api/search?q=soon&types=message")).json.items[0];
    expect(plain.snippetHtml).toContain("<mark>");
    expect(plain).not.toHaveProperty("call");
  });
});
