/**
 * Minimal S3 client over one scoped `<accessKeyId>:<secretAccessKey>` token.
 * SigV4, path-style, region "auto": works against Cloudflare R2 (HTTPS) and the
 * local S3 mock. Bodies are read with a size cap so one object never takes
 * unbounded memory.
 */
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

export interface ObjectEntry { key: string; size: number; lastModified?: string }

export function parseToken(token: string): { accessKeyId: string; secretAccessKey: string } {
  const i = token.indexOf(":");
  if (i <= 0 || i === token.length - 1) throw new Error("token must be <accessKeyId>:<secretAccessKey>");
  return { accessKeyId: token.slice(0, i), secretAccessKey: token.slice(i + 1) };
}

export class TooLargeError extends Error {}

export const httpStatus = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

export class Bucket {
  readonly name: string;
  private readonly s3: S3Client;

  constructor(endpoint: string, name: string, token: string, opts: { timeoutMs?: number } = {}) {
    this.name = name;
    this.s3 = new S3Client({
      endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: parseToken(token),
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
      requestHandler: { requestTimeout: opts.timeoutMs ?? 120_000, connectionTimeout: 10_000 } as never,
    });
  }

  /** List keys under a prefix, optionally starting strictly after `startAfter`. */
  async list(prefix?: string, startAfter?: string, maxKeys?: number): Promise<ObjectEntry[]> {
    const out: ObjectEntry[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.name, Prefix: prefix, ContinuationToken: token,
        StartAfter: token ? undefined : startAfter, MaxKeys: maxKeys,
      }));
      for (const c of r.Contents ?? []) out.push({ key: c.Key!, size: c.Size ?? 0, lastModified: c.LastModified?.toISOString() });
      if (maxKeys && out.length >= maxKeys) break;
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** GET an object; null if it does not exist. Throws TooLargeError past maxBytes. */
  async get(key: string, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array | null> {
    let r;
    try {
      r = await this.s3.send(new GetObjectCommand({ Bucket: this.name, Key: key }));
    } catch (e) {
      if (httpStatus(e) === 404 || (e as { name?: string }).name === "NoSuchKey") return null;
      throw e;
    }
    if (r.ContentLength !== undefined && r.ContentLength > maxBytes) {
      (r.Body as Readable | undefined)?.destroy?.();
      throw new TooLargeError(`${key} is ${r.ContentLength} bytes (cap ${maxBytes})`);
    }
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of r.Body as Readable) {
      const b = c as Buffer;
      n += b.length;
      if (n > maxBytes) { (r.Body as Readable).destroy(); throw new TooLargeError(`${key} exceeds ${maxBytes} bytes`); }
      chunks.push(b);
    }
    return new Uint8Array(Buffer.concat(chunks, n));
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.name, Key: key, Body: body, ContentType: "application/octet-stream" }));
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.name, Key: key }));
  }

  /**
   * Delete many objects in as few round-trips as possible (S3 DeleteObjects takes up to 1000 keys per call).
   * Deleting committed objects one at a time is the ingest bottleneck; this turns a backlog's worth of
   * deletes into a handful of calls. Returns the keys that failed, so the caller can retry them next pass.
   */
  async deleteMany(keys: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      const r = await this.s3.send(new DeleteObjectsCommand({ Bucket: this.name, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
      for (const e of r.Errors ?? []) if (e.Key) failed.push(e.Key);
    }
    return failed;
  }

  close(): void { this.s3.destroy(); }
}
