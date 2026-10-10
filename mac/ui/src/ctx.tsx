import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Api } from "./api.ts";
import type { EventStream, ServiceEvent } from "./events.ts";

export interface AppServices { api: Api; events: EventStream; now?: () => number }
export const Services = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const s = useContext(Services);
  if (!s) throw new Error("Services missing");
  return s;
}
export const useApi = () => useServices().api;

/** Subscribe to service events; `types` are prefixes ("command." matches command.sent). */
export function useEvents(fn: (ev: ServiceEvent) => void, types?: string[]): void {
  const { events } = useServices();
  const ref = useRef(fn);
  ref.current = fn;
  const key = types?.join(",") ?? "";
  useEffect(() => events.subscribe((ev) => {
    if (!key || key.split(",").some((t) => ev.type.startsWith(t))) ref.current(ev);
  }), [events, key]);
}

/** Load data from the API; reload() re-runs. */
export function useLoad<T>(fn: (api: Api) => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const api = useApi();
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn(api).then((data) => live && setState({ data, error: null, loading: false }), (error) => live && setState((s) => ({ data: s.data, error, loading: false })));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, n, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}

/** Re-run `fn` at most once per `ms` while events keep coming. */
export function useDebounced(fn: () => void, ms = 500): () => void {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return useCallback(() => {
    if (t.current) return;
    t.current = setTimeout(() => { t.current = null; ref.current(); }, ms);
  }, [ms]);
}
