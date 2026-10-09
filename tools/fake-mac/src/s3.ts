/** Minimal S3 client over a scoped `<accessKeyId>:<secret>` token (works against the mock and R2). */
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";

export interface ObjectEntry { key: string; size: number }

export function parseToken(token: string): { accessKeyId: string; secretAccessKey: string } {
  const i = token.indexOf(":");
  if (i <= 0 || i === token.length - 1) throw new Error("token must be <accessKeyId>:<secretAccessKey>");
  return { accessKeyId: token.slice(0, i), secretAccessKey: token.slice(i + 1) };
}

export class Bucket {
  readonly name: string;
  private readonly s3: S3Client;

  constructor(endpoint: string, name: string, token: string) {
    this.name = name;
    this.s3 = new S3Client({
      endpoint, region: "auto", forcePathStyle: true, credentials: parseToken(token),
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async list(prefix?: string): Promise<ObjectEntry[]> {
    const out: ObjectEntry[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.name, Prefix: prefix, ContinuationToken: token }));
      for (const c of r.Contents ?? []) out.push({ key: c.Key!, size: c.Size ?? 0 });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.name, Key: key }));
      return await r.Body!.transformToByteArray();
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.name, Key: key, Body: body, ContentType: "application/octet-stream" }));
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.name, Key: key }));
  }

  close(): void { this.s3.destroy(); }
}
