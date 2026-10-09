import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, CreateMultipartUploadCommand,
  UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { startMock, type MockServer } from "../src/index.ts";

let mock: MockServer;
let root: string;
const client = (accessKeyId = "admin") =>
  new S3Client({
    endpoint: mock.url, region: "auto", forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey: "secret" },
  });
const text = async (b: any) => Buffer.from(await b.transformToByteArray());
const md5 = (b: Buffer) => createHash("md5").update(b).digest();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "s3mock-"));
  mock = await startMock({ root });
});
afterAll(() => mock.stop());

describe("buckets and objects", () => {
  const s3 = () => client();
  it("CreateBucket / HeadBucket / missing bucket", async () => {
    await s3().send(new CreateBucketCommand({ Bucket: "b1" }));
    await s3().send(new HeadBucketCommand({ Bucket: "b1" }));
    await expect(s3().send(new HeadBucketCommand({ Bucket: "nope" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    await expect(s3().send(new CreateBucketCommand({ Bucket: "b1" }))).rejects.toMatchObject({ name: "BucketAlreadyOwnedByYou" });
  });

  it("Put/Get/Head/Delete with special-character keys; bytes on disk", async () => {
    const body = randomBytes(1000);
    const key = "dir one/sp ace+plus&amp/ünï.bin";
    const put = await s3().send(new PutObjectCommand({ Bucket: "b1", Key: key, Body: body, Metadata: { foo: "bar" } }));
    expect(put.ETag).toBe(`"${md5(body).toString("hex")}"`);
    const get = await s3().send(new GetObjectCommand({ Bucket: "b1", Key: key }));
    expect((await text(get.Body)).equals(body)).toBe(true);
    expect(get.Metadata).toEqual({ foo: "bar" });
    const head = await s3().send(new HeadObjectCommand({ Bucket: "b1", Key: key }));
    expect(head.ContentLength).toBe(1000);
    expect(mock.readRaw("b1", key).equals(body)).toBe(true);
    expect(mock.listAll("b1").map((o) => o.key)).toContain(key);
    await s3().send(new DeleteObjectCommand({ Bucket: "b1", Key: key }));
    await expect(s3().send(new GetObjectCommand({ Bucket: "b1", Key: key }))).rejects.toMatchObject({ name: "NoSuchKey" });
    await expect(s3().send(new HeadObjectCommand({ Bucket: "b1", Key: key }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    // delete is idempotent
    await s3().send(new DeleteObjectCommand({ Bucket: "b1", Key: key }));
  });

  it("GetObject with Range variants", async () => {
    const body = Buffer.from("0123456789abcdefghij");
    await s3().send(new PutObjectCommand({ Bucket: "b1", Key: "r", Body: body }));
    const r = async (range: string) => s3().send(new GetObjectCommand({ Bucket: "b1", Key: "r", Range: range }));
    let g = await r("bytes=2-5");
    expect((await text(g.Body)).toString()).toBe("2345");
    expect(g.ContentRange).toBe("bytes 2-5/20");
    expect(g.$metadata.httpStatusCode).toBe(206);
    g = await r("bytes=15-");
    expect((await text(g.Body)).toString()).toBe("fghij");
    g = await r("bytes=-4");
    expect((await text(g.Body)).toString()).toBe("ghij");
    g = await r("bytes=10-999");
    expect((await text(g.Body)).toString()).toBe("abcdefghij");
    await expect(r("bytes=50-60")).rejects.toMatchObject({ $metadata: { httpStatusCode: 416 } });
  });

  it("DeleteObjects", async () => {
    for (const k of ["d/1", "d/2&x", "d/3"]) await s3().send(new PutObjectCommand({ Bucket: "b1", Key: k, Body: "x" }));
    const out = await s3().send(new DeleteObjectsCommand({
      Bucket: "b1", Delete: { Objects: [{ Key: "d/1" }, { Key: "d/2&x" }, { Key: "d/missing" }] },
    }));
    expect(out.Deleted?.map((d) => d.Key).sort()).toEqual(["d/1", "d/2&x", "d/missing"]);
    expect(mock.listAll("b1").map((o) => o.key).filter((k) => k.startsWith("d/"))).toEqual(["d/3"]);
    const quiet = await s3().send(new DeleteObjectsCommand({ Bucket: "b1", Delete: { Objects: [{ Key: "d/3" }], Quiet: true } }));
    expect(quiet.Deleted ?? []).toEqual([]);
    expect(mock.listAll("b1").some((o) => o.key === "d/3")).toBe(false);
  });
});

describe("ListObjectsV2", () => {
  beforeAll(async () => {
    const s3 = client();
    await s3.send(new CreateBucketCommand({ Bucket: "lst" }));
    const keys = [];
    for (let i = 0; i < 25; i++) keys.push(`p/${String(i).padStart(3, "0")}`);
    keys.push("q/a", "q/b", "top.txt", "p/sub/x", "p/sub/y");
    for (const k of keys) await s3.send(new PutObjectCommand({ Bucket: "lst", Key: k, Body: k }));
  });

  it("prefix + pagination with continuation token", async () => {
    const s3 = client();
    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: "lst", Prefix: "p/0", MaxKeys: 10, ContinuationToken: token }));
      pages++;
      expect(out.KeyCount).toBe(out.Contents!.length);
      seen.push(...out.Contents!.map((c) => c.Key!));
      token = out.NextContinuationToken;
      expect(out.IsTruncated).toBe(!!token);
    } while (token);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `p/${String(i).padStart(3, "0")}`));
  });

  it("start-after and max-keys", async () => {
    const out = await client().send(new ListObjectsV2Command({ Bucket: "lst", Prefix: "p/0", StartAfter: "p/020", MaxKeys: 3 }));
    expect(out.Contents!.map((c) => c.Key)).toEqual(["p/021", "p/022", "p/023"]);
    expect(out.IsTruncated).toBe(true);
  });

  it("delimiter produces common prefixes", async () => {
    const out = await client().send(new ListObjectsV2Command({ Bucket: "lst", Delimiter: "/" }));
    expect(out.Contents!.map((c) => c.Key)).toEqual(["top.txt"]);
    expect(out.CommonPrefixes!.map((c) => c.Prefix)).toEqual(["p/", "q/"]);
    const sub = await client().send(new ListObjectsV2Command({ Bucket: "lst", Prefix: "p/", Delimiter: "/", MaxKeys: 1000 }));
    expect(sub.CommonPrefixes!.map((c) => c.Prefix)).toEqual(["p/sub/"]);
    expect(sub.Contents!.length).toBe(25);
  });

  it("delimiter with pagination does not repeat or skip prefixes", async () => {
    const s3 = client();
    const keys: string[] = [], prefixes: string[] = [];
    let token: string | undefined;
    do {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: "lst", Delimiter: "/", MaxKeys: 1, ContinuationToken: token }));
      keys.push(...(out.Contents ?? []).map((c) => c.Key!));
      prefixes.push(...(out.CommonPrefixes ?? []).map((c) => c.Prefix!));
      token = out.NextContinuationToken;
    } while (token);
    expect(keys).toEqual(["top.txt"]);
    expect(prefixes.sort()).toEqual(["p/", "q/"]);
  });

  it("empty bucket and unknown bucket", async () => {
    await client().send(new CreateBucketCommand({ Bucket: "empty" }));
    const out = await client().send(new ListObjectsV2Command({ Bucket: "empty" }));
    expect(out.KeyCount).toBe(0);
    await expect(client().send(new ListObjectsV2Command({ Bucket: "ghost" }))).rejects.toMatchObject({ name: "NoSuchBucket" });
  });
});

describe("multipart", () => {
  const MB = 1024 * 1024;
  it("3-part upload: ListParts, Complete, ETag semantics, bytes", async () => {
    const s3 = client();
    await s3.send(new CreateBucketCommand({ Bucket: "mp" }));
    const parts = [randomBytes(5 * MB), randomBytes(5 * MB), randomBytes(1234)];
    const create = await s3.send(new CreateMultipartUploadCommand({ Bucket: "mp", Key: "big/file.bin", ContentType: "application/x-ivy" }));
    const id = create.UploadId!;
    expect(id).toBeTruthy();

    const etags: string[] = [];
    // upload out of order to prove ordering comes from Complete
    for (const n of [2, 1, 3]) {
      const up = await s3.send(new UploadPartCommand({ Bucket: "mp", Key: "big/file.bin", UploadId: id, PartNumber: n, Body: parts[n - 1]! }));
      expect(up.ETag).toBe(`"${md5(parts[n - 1]!).toString("hex")}"`);
      etags[n - 1] = up.ETag!;
    }
    const lp = await s3.send(new ListPartsCommand({ Bucket: "mp", Key: "big/file.bin", UploadId: id }));
    expect(lp.Parts!.map((p) => [p.PartNumber, p.Size, p.ETag])).toEqual([
      [1, 5 * MB, etags[0]], [2, 5 * MB, etags[1]], [3, 1234, etags[2]],
    ]);
    const page = await s3.send(new ListPartsCommand({ Bucket: "mp", Key: "big/file.bin", UploadId: id, MaxParts: 2 }));
    expect(page.IsTruncated).toBe(true);
    expect(page.Parts!.length).toBe(2);

    // not visible before completion
    await expect(s3.send(new HeadObjectCommand({ Bucket: "mp", Key: "big/file.bin" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });

    const done = await s3.send(new CompleteMultipartUploadCommand({
      Bucket: "mp", Key: "big/file.bin", UploadId: id,
      MultipartUpload: { Parts: etags.map((ETag, i) => ({ ETag, PartNumber: i + 1 })) },
    }));
    const expectedEtag = `"${md5(Buffer.concat(parts.map(md5))).toString("hex")}-3"`;
    expect(done.ETag).toBe(expectedEtag);

    const whole = Buffer.concat(parts);
    const get = await s3.send(new GetObjectCommand({ Bucket: "mp", Key: "big/file.bin" }));
    expect(get.ETag).toBe(expectedEtag);
    expect(get.ContentType).toBe("application/x-ivy");
    expect((await text(get.Body)).equals(whole)).toBe(true);
    expect(mock.readRaw("mp", "big/file.bin").equals(whole)).toBe(true);
    // upload state is gone
    await expect(s3.send(new ListPartsCommand({ Bucket: "mp", Key: "big/file.bin", UploadId: id }))).rejects.toMatchObject({ name: "NoSuchUpload" });
  });

  it("abort removes upload; complete with wrong etag fails; small non-final part fails", async () => {
    const s3 = client();
    const mk = async (key: string) => (await s3.send(new CreateMultipartUploadCommand({ Bucket: "mp", Key: key }))).UploadId!;
    const id = await mk("abort-me");
    await s3.send(new UploadPartCommand({ Bucket: "mp", Key: "abort-me", UploadId: id, PartNumber: 1, Body: Buffer.from("x") }));
    await s3.send(new AbortMultipartUploadCommand({ Bucket: "mp", Key: "abort-me", UploadId: id }));
    await expect(s3.send(new UploadPartCommand({ Bucket: "mp", Key: "abort-me", UploadId: id, PartNumber: 2, Body: Buffer.from("y") })))
      .rejects.toMatchObject({ name: "NoSuchUpload" });

    const id2 = await mk("bad-etag");
    await s3.send(new UploadPartCommand({ Bucket: "mp", Key: "bad-etag", UploadId: id2, PartNumber: 1, Body: Buffer.from("x") }));
    await expect(s3.send(new CompleteMultipartUploadCommand({
      Bucket: "mp", Key: "bad-etag", UploadId: id2, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"deadbeef"' }] },
    }))).rejects.toMatchObject({ name: "InvalidPart" });

    const id3 = await mk("too-small");
    const e1 = (await s3.send(new UploadPartCommand({ Bucket: "mp", Key: "too-small", UploadId: id3, PartNumber: 1, Body: Buffer.from("x") }))).ETag!;
    const e2 = (await s3.send(new UploadPartCommand({ Bucket: "mp", Key: "too-small", UploadId: id3, PartNumber: 2, Body: Buffer.from("y") }))).ETag!;
    await expect(s3.send(new CompleteMultipartUploadCommand({
      Bucket: "mp", Key: "too-small", UploadId: id3,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: e1 }, { PartNumber: 2, ETag: e2 }] },
    }))).rejects.toMatchObject({ name: "EntityTooSmall" });
  });
});

describe("token scope policy and access-key recording", () => {
  it("enforces per-key bucket/operation scope and records access key ids", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "s3mock-pol-"));
    const m = await startMock({
      root: root2,
      buckets: ["ivy-up-windows", "ivy-cmd-windows", "ivy-up-android"],
      policy: {
        "win-write": { bucket: "ivy-up-windows", operations: ["PutObject", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload", "ListParts"] },
        "win-read": { bucket: "ivy-cmd-windows", operations: ["GetObject", "HeadObject", "ListObjectsV2", "DeleteObject"] },
        mac: [
          { bucket: "ivy-up-windows", operations: ["GetObject", "ListObjectsV2", "DeleteObject", "DeleteObjects", "HeadObject"] },
          { bucket: "ivy-cmd-windows", operations: ["PutObject"] },
        ],
      },
    });
    try {
      const c = (ak: string) => new S3Client({ endpoint: m.url, region: "auto", forcePathStyle: true, credentials: { accessKeyId: ak, secretAccessKey: "s" } });
      const win = c("win-write"), winRead = c("win-read"), mac = c("mac");

      await win.send(new PutObjectCommand({ Bucket: "ivy-up-windows", Key: "x/1", Body: "cipher" }));
      // Windows write token cannot read its own up bucket, list it, or touch other buckets
      await expect(win.send(new GetObjectCommand({ Bucket: "ivy-up-windows", Key: "x/1" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 }, name: "AccessDenied" });
      await expect(win.send(new ListObjectsV2Command({ Bucket: "ivy-up-windows" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
      await expect(win.send(new PutObjectCommand({ Bucket: "ivy-up-android", Key: "x", Body: "y" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
      await expect(win.send(new DeleteObjectCommand({ Bucket: "ivy-up-windows", Key: "x/1" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
      // Windows read token cannot read ivy-up-windows
      await expect(winRead.send(new GetObjectCommand({ Bucket: "ivy-up-windows", Key: "x/1" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
      // Unknown key is denied everywhere
      await expect(c("stranger").send(new ListObjectsV2Command({ Bucket: "ivy-up-windows" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
      // Mac can read/delete up, write cmd
      expect(await text((await mac.send(new GetObjectCommand({ Bucket: "ivy-up-windows", Key: "x/1" }))).Body)).toEqual(Buffer.from("cipher"));
      await mac.send(new PutObjectCommand({ Bucket: "ivy-cmd-windows", Key: "cmd/1", Body: "c" }));
      expect(await text((await winRead.send(new GetObjectCommand({ Bucket: "ivy-cmd-windows", Key: "cmd/1" }))).Body)).toEqual(Buffer.from("c"));
      await expect(mac.send(new PutObjectCommand({ Bucket: "ivy-up-android", Key: "z", Body: "z" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
      // denied writes left nothing behind
      expect(m.listAll("ivy-up-android")).toEqual([]);

      // access key accounting
      expect(m.accessKeysSeen("ivy-up-windows").sort()).toEqual(["mac", "stranger", "win-read", "win-write"]);
      const winWrites = m.requests().filter((r) => r.accessKeyId === "win-write" && r.status < 300);
      expect(winWrites.every((r) => r.bucket === "ivy-up-windows" && r.operation === "PutObject")).toBe(true);
      const denied = m.requests().filter((r) => r.status === 403);
      expect(denied.length).toBeGreaterThanOrEqual(7);
    } finally {
      await m.stop();
    }
  });

  it("persists across restart (disk is the source of truth)", async () => {
    const root3 = mkdtempSync(join(tmpdir(), "s3mock-persist-"));
    const m1 = await startMock({ root: root3, buckets: ["a"] });
    await new S3Client({ endpoint: m1.url, region: "auto", forcePathStyle: true, credentials: { accessKeyId: "k", secretAccessKey: "s" } })
      .send(new PutObjectCommand({ Bucket: "a", Key: "k/1", Body: "hello" }));
    await m1.stop();
    const m2 = await startMock({ root: root3 });
    expect(m2.readRaw("a", "k/1").toString()).toBe("hello");
    expect(existsSync(root3)).toBe(true);
    await m2.stop();
  });
});
