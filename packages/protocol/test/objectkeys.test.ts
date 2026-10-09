import { describe, it, expect } from "vitest";
import {
  upKey, blobManifestKey, blobChunkKey, statusReportKey, deviceReportKey,
  pairingDeviceKey, cmdKey, pairingBootstrapKey, parseKey, oidAfter,
  makeOid, newOid,
} from "../src/index.js";

describe("object keys", () => {
  it("builds and parses capture keys", () => {
    const k = upKey("file_meta", "01HZZZ0000000000000000000A");
    expect(k).toBe("up/file/01HZZZ0000000000000000000A");
    const p = parseKey(k);
    expect(p.area).toBe("up");
    expect(p.kind).toBe("file_meta");
    expect(p.oid).toBe("01HZZZ0000000000000000000A");
  });

  it("builds and parses blob manifest and chunk keys", () => {
    const m = blobManifestKey("01HZZZ0000000000000000000A");
    expect(parseKey(m)).toMatchObject({ area: "up", kind: "manifest", blobPart: "manifest" });
    const c = blobChunkKey("01HZZZ0000000000000000000A", 42);
    expect(c).toBe("up/blob/01HZZZ0000000000000000000A/p/00000042");
    expect(parseKey(c)).toMatchObject({ area: "up", kind: "blob_chunk", chunkIndex: 42 });
  });

  it("builds status, device report, command, pairing keys", () => {
    expect(statusReportKey("x")).toBe("up/cstat/x");
    expect(deviceReportKey("x")).toBe("up/status/x");
    expect(cmdKey("x")).toBe("cmd/x");
    expect(pairingBootstrapKey("pid")).toBe("pair/pid");
    expect(pairingDeviceKey("pid")).toBe("pair/pid/device");
    expect(parseKey("pair/pid")).toMatchObject({ area: "pair", pairingId: "pid" });
    expect(parseKey("pair/pid/device")).toMatchObject({ kind: "pairing_device", pairingId: "pid" });
    expect(parseKey("cmd/01HZZZ0000000000000000000A")).toMatchObject({ kind: "command" });
  });

  it("rejects bad keys", () => {
    expect(() => parseKey("nope/x")).toThrow();
  });
});

describe("oid ordering", () => {
  it("sorts lexicographically by time", () => {
    const r = new Uint8Array(10);
    const early = makeOid(1_000_000_000_000, r);
    const late = makeOid(2_000_000_000_000, r);
    expect(early < late).toBe(true);
    expect(oidAfter(late, early)).toBe(true);
    expect(oidAfter(early, late)).toBe(false);
  });

  it("newOid is 26 chars and time-ordered", () => {
    const a = newOid(1000);
    const b = newOid(2000);
    expect(a.length).toBe(26);
    expect(a < b).toBe(true);
  });
});
