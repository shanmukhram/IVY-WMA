import { describe, it, expect } from "vitest";
import { validateRecord, validateRecordKind, validateManifest } from "../src/index.js";

const common = {
  v: 1 as const,
  deviceId: "11111111-1111-1111-1111-111111111111",
  eventTime: "2026-10-10T08:00:00.000Z",
  captureTime: "2026-10-10T08:00:05.000Z",
};

describe("record schemas", () => {
  it("accepts a valid file_meta record", () => {
    const rec = {
      ...common, kind: "file_meta",
      path: "C:/a/b.pdf", name: "b.pdf", size: 1234, ext: "pdf",
      mtime: "2026-10-01T00:00:00.000Z", quickHash: "abc123",
    };
    expect(validateRecord(rec).kind).toBe("file_meta");
    expect(validateRecordKind("file_meta", rec).name).toBe("b.pdf");
  });

  it("accepts a file_meta deletion with size/mtime/quickHash omitted", () => {
    const rec = {
      ...common, kind: "file_meta",
      path: "C:/a/b.pdf", name: "b.pdf", ext: "pdf", deleted: true,
    };
    const parsed = validateRecordKind("file_meta", rec);
    expect(parsed.deleted).toBe(true);
    expect(parsed.mtime).toBeUndefined();
  });

  it("rejects a live file_meta missing mtime/size/quickHash", () => {
    const rec = {
      ...common, kind: "file_meta",
      path: "C:/a/b.pdf", name: "b.pdf", ext: "pdf",
    };
    expect(() => validateRecordKind("file_meta", rec)).toThrow();
  });

  it("accepts a usage_event whose title is null (captured but excluded)", () => {
    const rec = {
      ...common, kind: "usage_event", app: "Code", exe: "Code.exe",
      title: null, startedAt: common.eventTime, endedAt: common.captureTime,
    };
    const parsed = validateRecordKind("usage_event", rec);
    expect(parsed.title).toBeNull();
    // Absent title (not captured) is also valid.
    const noTitle = { ...rec, title: undefined };
    delete (noTitle as Record<string, unknown>).title;
    expect(validateRecordKind("usage_event", noTitle).title).toBeUndefined();
  });

  it("accepts a message_batch with attachments", () => {
    const rec = {
      ...common, kind: "message_batch",
      platform: "line", account: "bunny", convKey: "c1", convKind: "dm",
      coverage: "complete", cursor: "rowid:42",
      messages: [{
        msgId: "m1", sender: "alice", sentAt: "2026-10-09T10:00:00.000Z",
        text: "hi", sourceStatus: "live",
        attachments: [{ attId: "a1", kind: "image", filename: "p.jpg", size: 99 }],
      }],
    };
    expect(validateRecord(rec).kind).toBe("message_batch");
  });

  it("accepts a command (file_request) and command_status", () => {
    const cmd = {
      ...common, kind: "command", commandId: "cmd1", issuedAt: common.eventTime,
      params: { type: "file_request", fileId: "f1" },
    };
    expect(validateRecord(cmd).kind).toBe("command");
    const st = {
      ...common, kind: "command_status", commandId: "cmd1",
      status: "uploaded", resultOid: "01HZZZ", reportedAt: common.eventTime,
    };
    expect(validateRecord(st).kind).toBe("command_status");
  });

  it("accepts command_status with the done status (rescan/collector_config)", () => {
    const st = {
      ...common, kind: "command_status", commandId: "cmd2",
      status: "done", reportedAt: common.eventTime,
    };
    expect(validateRecordKind("command_status", st).status).toBe("done");
  });

  it("accepts a manifest whose payloadKind is file_original", () => {
    const m = {
      v: 1, objectId: "aabb", payloadKind: "file_original",
      totalSize: 1000, chunkSize: 256, totalChunks: 4, cek: "AAAA",
      chunks: [{ index: 0, ctLen: 300, sha256: "deadbeef" }],
    };
    expect(validateManifest(m).payloadKind).toBe("file_original");
  });

  it("accepts a device_report with collector state", () => {
    const rec = {
      ...common, kind: "device_report", role: "windows",
      queueDepthTotal: 3, reportedAt: common.eventTime,
      collectors: [{ name: "files", enabled: true, queueDepth: 2, cursor: "usn:900" }],
    };
    expect(validateRecord(rec).kind).toBe("device_report");
  });

  it("rejects a record missing the capture time", () => {
    const rec: Record<string, unknown> = {
      ...common, kind: "windows_notification", app: "mail", title: "t", text: "x",
      postedAt: common.eventTime,
    };
    delete rec.captureTime;
    expect(() => validateRecord(rec)).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => validateRecord({ ...common, kind: "bogus" })).toThrow();
  });

  it("validates a manifest", () => {
    const m = {
      v: 1, objectId: "aabb", payloadKind: "screenshot",
      totalSize: 1000, chunkSize: 256, totalChunks: 4, cek: "AAAA",
      chunks: [{ index: 0, ctLen: 300, sha256: "deadbeef" }],
    };
    expect(validateManifest(m).totalChunks).toBe(4);
  });
  it("accepts an optional commandId on a manifest (file_original for a command)", () => {
    const m = {
      v: 1, objectId: "aabb", payloadKind: "file_original",
      totalSize: 1000, chunkSize: 256, totalChunks: 4, cek: "AAAA",
      chunks: [{ index: 0, ctLen: 300, sha256: "deadbeef" }],
      commandId: "c0ffee00-0000-4000-8000-000000000001",
    };
    expect(validateManifest(m).commandId).toBe("c0ffee00-0000-4000-8000-000000000001");
    expect(validateManifest({ ...m, commandId: undefined }).commandId).toBeUndefined();
    expect(() => validateManifest({ ...m, commandId: "" })).toThrow();
    expect(() => validateManifest({ ...m, commandId: 7 })).toThrow();
  });

  it("accepts import progress on device_report collectors and validates it", () => {
    const base = { ...common, kind: "device_report", role: "windows", queueDepthTotal: 0, reportedAt: common.eventTime };
    const ok = validateRecordKind("device_report", {
      ...base,
      collectors: [
        { name: "files", enabled: true, queueDepth: 0, importTotal: 1200, importDone: 300, phase: "initial" },
        { name: "usage", enabled: true, queueDepth: 0 },
        { name: "photos", enabled: true, queueDepth: 0, importDone: 5, phase: "rescan" },
        { name: "notifications", enabled: true, queueDepth: 0, importTotal: 10, importDone: 10, phase: "incremental" },
      ],
    });
    expect(ok.collectors[0]).toMatchObject({ importTotal: 1200, importDone: 300, phase: "initial" });
    expect(ok.collectors[1]!.phase).toBeUndefined();
    for (const bad of [{ importTotal: -1 }, { importDone: 1.5 }, { phase: "bulk" }, { importTotal: "10" }]) {
      expect(() => validateRecordKind("device_report", { ...base, collectors: [{ name: "files", enabled: true, queueDepth: 0, ...bad }] })).toThrow();
    }
  });
});
