/** Thin REST client for @ivy/mac-service. Same-origin; auth is the ivy_session cookie. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message); this.status = status; this.code = code; this.body = body;
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface Api {
  get<T = any>(path: string, query?: Query): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
  del<T = any>(path: string): Promise<T>;
}

export function qs(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** `onStatus` sees 401/423 so the shell can fall back to the token or lock screen. */
export function httpApi(base = "", onStatus?: (status: number) => void): Api {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(base + path, {
      method, credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: any = null;
    const text = await r.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!r.ok) {
      if (r.status === 401 || r.status === 423) onStatus?.(r.status);
      throw new ApiError(r.status, json?.error ?? "http_error", json?.message ?? `${r.status} ${r.statusText}`, json);
    }
    return json as T;
  }
  return {
    get: (p, q) => call("GET", p + qs(q)),
    post: (p, b) => call("POST", p, b ?? {}),
    put: (p, b) => call("PUT", p, b ?? {}),
    del: (p) => call("DELETE", p),
  };
}

export const errText = (e: unknown): string => (e instanceof ApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e));
