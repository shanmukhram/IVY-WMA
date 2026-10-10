/**
 * The Mac's own R2 tokens, read from the same r2.json Bunny gave to `PUT /api/r2`
 * (the service keeps them sealed and never returns them). They are used only to
 * list and read the four buckets for the audit and the in-flight checks; the file
 * is cross-checked against the service's redacted config so the audit looks at
 * exactly the buckets the service uses.
 */
import { readFileSync } from "node:fs";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

export type Role = "windows" | "android";
export type Dir = "up" | "cmd";
export const ROLES: Role[] = ["windows", "android"];

export interface BucketRef { name: string; dir: Dir; role: Role; token: string; accessKeyId: string }
export interface MacR2 { endpoint: string; buckets: BucketRef[] }

const keyId = (t: string) => {
  const i = t.indexOf(":");
  if (i <= 0 || i === t.length - 1) throw new Error("token must be <accessKeyId>:<secretAccessKey>");
  return t.slice(0, i);
};

export function parseR2Json(raw: unknown): MacR2 {
  const c = raw as {
    endpoint?: string; accountId?: string;
    buckets?: Partial<Record<"upWindows" | "upAndroid" | "cmdWindows" | "cmdAndroid", string>>;
    macTokens?: { up?: Partial<Record<Role, string>>; cmd?: Partial<Record<Role, string>>; all?: string };
  };
  if (!c || (!c.endpoint && !c.accountId)) throw new Error("r2.json needs endpoint or accountId");
  const endpoint = (c.endpoint ?? `https://${c.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
  const names = { upWindows: "ivy-up-windows", upAndroid: "ivy-up-android", cmdWindows: "ivy-cmd-windows", cmdAndroid: "ivy-cmd-android", ...(c.buckets ?? {}) };
  const buckets: BucketRef[] = [];
  for (const role of ROLES) {
    for (const dir of ["up", "cmd"] as const) {
      const token = c.macTokens?.[dir]?.[role] ?? c.macTokens?.all;
      if (!token) throw new Error(`r2.json has no Mac token for ${dir}/${role} (macTokens.${dir}.${role} or macTokens.all)`);
      const name = names[`${dir}${role === "windows" ? "Windows" : "Android"}` as keyof typeof names];
      buckets.push({ name, dir, role, token, accessKeyId: keyId(token) });
    }
  }
  return { endpoint, buckets };
}

export const loadR2File = (path: string): MacR2 => parseR2Json(JSON.parse(readFileSync(path, "utf8")));

/** Compare with GET /api/r2 (redacted: endpoint, bucket names, access key ids). Returns mismatches. */
export function compareWithService(mine: MacR2, redacted: any): string[] {
  const out: string[] = [];
  if (!redacted) return ["the service has no R2 configuration"];
  if (String(redacted.endpoint).replace(/\/+$/, "") !== mine.endpoint) out.push(`endpoint differs: r2.json ${host(mine.endpoint)}, service ${host(redacted.endpoint)}`);
  for (const b of mine.buckets) {
    const svcName = redacted.buckets?.[`${b.dir}${b.role === "windows" ? "Windows" : "Android"}`];
    if (svcName !== b.name) out.push(`bucket ${b.dir}/${b.role}: r2.json ${b.name}, service ${svcName}`);
    const svcKey = redacted.macTokens?.[b.dir]?.[b.role]?.accessKeyId ?? redacted.macTokens?.all?.accessKeyId;
    if (svcKey !== b.accessKeyId) out.push(`Mac token for ${b.name}: access key id differs from the service's`);
  }
  return out;
}

export const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
export const isRealR2 = (endpoint: string) => /\.r2\.cloudflarestorage\.com$/i.test(host(endpoint));

export function s3For(endpoint: string, token: string): S3Client {
  const i = token.indexOf(":");
  return new S3Client({
    endpoint, region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: token.slice(0, i), secretAccessKey: token.slice(i + 1) },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export async function listKeys(s3: S3Client, bucket: string, prefix?: string): Promise<Array<{ key: string; size: number }>> {
  const out: Array<{ key: string; size: number }> = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const c of r.Contents ?? []) out.push({ key: c.Key!, size: c.Size ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** First `bytes` of an object, or null if it is gone (the Mac may delete it at any moment). */
export async function head(s3: S3Client, bucket: string, key: string, bytes = 1 << 20): Promise<Buffer | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    return Buffer.from(await r.Body!.transformToByteArray());
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (e as Error).name === "NoSuchKey") return null;
    throw e;
  }
}
