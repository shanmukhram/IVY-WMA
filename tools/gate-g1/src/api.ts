/** Thin client for the Mac service's local HTTP API (bearer token from data/session.token). */
import { createHash } from "node:crypto";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export class ServiceApi {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw new ApiError(r.status, json?.error ?? `http_${r.status}`, `${method} ${path}: ${r.status} ${json?.message ?? text.slice(0, 200)}`);
    return json as T;
  }

  get<T = any>(path: string) { return this.req<T>("GET", path); }
  post<T = any>(path: string, body: unknown = {}) { return this.req<T>("POST", path, body); }

  /** Stream a response body through SHA-256 (the retrieved original never sits in memory whole). */
  async sha256Of(path: string): Promise<{ sha256: string; size: number }> {
    const r = await fetch(this.baseUrl + path, { headers: { authorization: `Bearer ${this.token}` } });
    if (!r.ok || !r.body) throw new ApiError(r.status, `http_${r.status}`, `GET ${path}: ${r.status}`);
    const h = createHash("sha256");
    let size = 0;
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) { h.update(chunk); size += chunk.length; }
    return { sha256: h.digest("hex"), size };
  }
}

/** /api/health needs no token. */
export async function health(baseUrl: string): Promise<{ ok: boolean; version: string; keystore: string }> {
  const r = await fetch(baseUrl.replace(/\/+$/, "") + "/api/health");
  if (!r.ok) throw new Error(`health: HTTP ${r.status}`);
  return (await r.json()) as { ok: boolean; version: string; keystore: string };
}
