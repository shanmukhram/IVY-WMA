import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { parseToken } from "../src/r2/client.ts";
import { R2, R2ConfigSchema, endpointOf, redact } from "../src/r2/config.ts";
import { makeTokens, startS3, r2ConfigFor, rm } from "./helpers/harness.ts";

const tokens = makeTokens();
let s3: Awaited<ReturnType<typeof startS3>>;
beforeAll(async () => { s3 = await startS3(tokens); });
afterAll(async () => { await s3.mock.stop(); rm(s3.root); });

describe("R2 configuration", () => {
  it("parses <accessKeyId>:<secretAccessKey> tokens and rejects others", () => {
    expect(parseToken("abc:def:ghi")).toEqual({ accessKeyId: "abc", secretAccessKey: "def:ghi" });
    expect(() => parseToken("nocolon")).toThrow();
    expect(() => R2ConfigSchema.parse({ accountId: "abc", macTokens: { all: "bad" } })).toThrow();
  });

  it("derives the R2 endpoint from the account id and defaults the bucket names", () => {
    const c = R2ConfigSchema.parse({ accountId: "0123abcd" });
    expect(endpointOf(c)).toBe("https://0123abcd.r2.cloudflarestorage.com");
    expect(c.buckets).toEqual({ upWindows: "ivy-up-windows", upAndroid: "ivy-up-android", cmdWindows: "ivy-cmd-windows", cmdAndroid: "ivy-cmd-android" });
  });

  it("redacts secrets", () => {
    const c = R2ConfigSchema.parse(r2ConfigFor("http://127.0.0.1:1", tokens));
    const s = JSON.stringify(redact(c));
    for (const t of Object.values(tokens)) expect(s).not.toContain(t.split(":")[1]);
    expect(s).toContain("mac");
  });

  it("connection check lists all four buckets against the mock", async () => {
    const r2 = new R2(R2ConfigSchema.parse(r2ConfigFor(s3.mock.url, tokens)));
    const res = await r2.check();
    expect(res).toHaveLength(4);
    expect(res.every((b) => b.ok)).toBe(true);
    r2.close();
  });

  it("connection check reports a bad token per bucket", async () => {
    const r2 = new R2(R2ConfigSchema.parse({ ...r2ConfigFor(s3.mock.url, tokens), macTokens: { all: "nobody:secret" } }));
    const res = await r2.check();
    expect(res.every((b) => !b.ok && b.status === 403)).toBe(true);
    r2.close();
  });
});
