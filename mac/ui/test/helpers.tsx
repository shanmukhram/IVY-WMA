import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { ApiError, type Api } from "../src/api.ts";
import { FakeEvents } from "../src/events.ts";
import { Services } from "../src/ctx.tsx";

export type Handler = (arg: any) => unknown;
export interface MockApi extends Api { calls: Array<{ method: string; path: string; arg: any }>; routes: Record<string, Handler | unknown> }

/** Routes are "METHOD /path" (exact path, query passed to the handler); a handler may throw ApiError. */
export function mockApi(routes: Record<string, Handler | unknown>): MockApi {
  const calls: MockApi["calls"] = [];
  const run = async (method: string, path: string, arg: any) => {
    calls.push({ method, path, arg });
    const r = api.routes[`${method} ${path}`];
    if (r === undefined) throw new ApiError(404, "not_found", `no mock for ${method} ${path}`);
    const v = typeof r === "function" ? (r as Handler)(arg) : r;
    return structuredClone(await v);
  };
  const api: MockApi = {
    calls, routes,
    get: (p, q) => run("GET", p, q ?? {}) as any,
    post: (p, b) => run("POST", p, b) as any,
    put: (p, b) => run("PUT", p, b) as any,
    del: (p, b) => run("DELETE", p, b) as any,
  };
  return api;
}

export function renderWith(ui: ReactElement, api: Api, opts: { path?: string; now?: () => number } = {}) {
  window.history.replaceState(null, "", opts.path ?? "/");
  const events = new FakeEvents();
  const r = render(<Services.Provider value={{ api, events, now: opts.now }}>{ui}</Services.Provider>);
  return { ...r, events };
}

export const locked = (status: number, code = "locked") => () => { throw new ApiError(status, code, code); };
