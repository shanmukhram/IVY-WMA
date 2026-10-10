/**
 * R2 configuration (sealed under the identity key at rest).
 *
 * The Mac holds read+delete on both up-buckets and write on both cmd-buckets.
 * It also holds the DEVICE tokens it hands out during pairing: the device's
 * cmd-bucket read token goes into the pairing string, its up-bucket write token
 * into the sealed bootstrap (PROTOCOL §7). Every token is `<accessKeyId>:<secret>`.
 */
import { z } from "zod";
import { Bucket, parseToken } from "./client.ts";

export type Role = "windows" | "android";
export const ROLES: Role[] = ["windows", "android"];

const token = z.string().refine((t) => { try { parseToken(t); return true; } catch { return false; } }, "token must be <accessKeyId>:<secretAccessKey>");

const roleTokens = z.object({ windows: token.optional(), android: token.optional() });

export const R2ConfigSchema = z.object({
  /** S3 endpoint; default https://<accountId>.r2.cloudflarestorage.com */
  endpoint: z.string().url().optional(),
  accountId: z.string().regex(/^[0-9a-zA-Z]+$/).optional(),
  buckets: z.object({
    upWindows: z.string().default("ivy-up-windows"),
    upAndroid: z.string().default("ivy-up-android"),
    cmdWindows: z.string().default("ivy-cmd-windows"),
    cmdAndroid: z.string().default("ivy-cmd-android"),
  }).default({ upWindows: "ivy-up-windows", upAndroid: "ivy-up-android", cmdWindows: "ivy-cmd-windows", cmdAndroid: "ivy-cmd-android" }),
  /** Mac tokens: read+delete on up-<role>, write on cmd-<role>. `all` is a fallback for every bucket. */
  macTokens: z.object({ up: roleTokens.default({}), cmd: roleTokens.default({}), all: token.optional() }).default({ up: {}, cmd: {} }),
  /** Tokens handed to devices at pairing (least privilege per PRD). */
  deviceTokens: z.object({
    windows: z.object({ upWrite: token, cmdRead: token }).optional(),
    android: z.object({ upWrite: token, cmdRead: token }).optional(),
  }).default({}),
  /** Endpoint written into pairing strings, when devices reach R2 through another URL (tests/LAN). */
  deviceEndpoint: z.string().url().optional(),
}).refine((c) => c.endpoint || c.accountId, "endpoint or accountId is required");

export type R2Config = z.infer<typeof R2ConfigSchema>;

export function endpointOf(c: R2Config): string {
  return (c.endpoint ?? `https://${c.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
}

export function bucketName(c: R2Config, dir: "up" | "cmd", role: Role): string {
  const b = c.buckets;
  if (dir === "up") return role === "windows" ? b.upWindows : b.upAndroid;
  return role === "windows" ? b.cmdWindows : b.cmdAndroid;
}

export function macToken(c: R2Config, dir: "up" | "cmd", role: Role): string | undefined {
  return c.macTokens[dir][role] ?? c.macTokens.all;
}

/** Redacted view for the API: access key ids are shown, secrets never. */
export function redact(c: R2Config) {
  const r = (t?: string) => (t ? { accessKeyId: parseToken(t).accessKeyId, secret: "********" } : null);
  return {
    endpoint: endpointOf(c),
    accountId: c.accountId ?? null,
    deviceEndpoint: c.deviceEndpoint ?? null,
    buckets: c.buckets,
    macTokens: {
      up: { windows: r(c.macTokens.up.windows), android: r(c.macTokens.up.android) },
      cmd: { windows: r(c.macTokens.cmd.windows), android: r(c.macTokens.cmd.android) },
      all: r(c.macTokens.all),
    },
    deviceTokens: {
      windows: c.deviceTokens.windows ? { upWrite: r(c.deviceTokens.windows.upWrite), cmdRead: r(c.deviceTokens.windows.cmdRead) } : null,
      android: c.deviceTokens.android ? { upWrite: r(c.deviceTokens.android.upWrite), cmdRead: r(c.deviceTokens.android.cmdRead) } : null,
    },
  };
}

/** Opens Bucket clients for the configured roles. */
export class R2 {
  readonly config: R2Config;
  private readonly cache = new Map<string, Bucket>();

  constructor(config: R2Config) { this.config = config; }

  bucket(dir: "up" | "cmd", role: Role): Bucket | null {
    const tok = macToken(this.config, dir, role);
    if (!tok) return null;
    const name = bucketName(this.config, dir, role);
    const k = `${dir}:${role}`;
    let b = this.cache.get(k);
    if (!b) { b = new Bucket(endpointOf(this.config), name, tok); this.cache.set(k, b); }
    return b;
  }

  close(): void {
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
  }

  /** Connection check: list each bucket with the Mac's token for it. */
  async check(): Promise<Array<{ bucket: string; dir: "up" | "cmd"; role: Role; ok: boolean; status?: number; error?: string; objects?: number; ms: number }>> {
    const out = [];
    for (const role of ROLES) {
      for (const dir of ["up", "cmd"] as const) {
        const t0 = Date.now();
        const name = bucketName(this.config, dir, role);
        const b = this.bucket(dir, role);
        if (!b) { out.push({ bucket: name, dir, role, ok: false, error: "no Mac token configured for this bucket", ms: 0 }); continue; }
        try {
          const l = await b.list(undefined, undefined, 1);
          out.push({ bucket: name, dir, role, ok: true, objects: l.length, ms: Date.now() - t0 });
        } catch (e) {
          const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
          out.push({ bucket: name, dir, role, ok: false, status, error: (e as Error).message || (e as Error).name, ms: Date.now() - t0 });
        }
      }
    }
    return out;
  }
}
