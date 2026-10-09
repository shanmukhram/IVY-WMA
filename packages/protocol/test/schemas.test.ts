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
});
