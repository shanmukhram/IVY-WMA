/** Live event stream (WebSocket /events). Events carry ids, keys, kinds and counts, not content. */
export interface ServiceEvent { id?: number; at: string; type: string; data: Record<string, any> }

export interface EventStream {
  subscribe(fn: (ev: ServiceEvent) => void): () => void;
}

export class WsEvents implements EventStream {
  private ws: WebSocket | null = null;
  private subs = new Set<(ev: ServiceEvent) => void>();
  private delay = 1000;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events`) {}

  start(): void { this.stopped = false; this.connect(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.ws?.close(); this.ws = null; }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.delay = 1000; };
    ws.onmessage = (m) => {
      let ev: ServiceEvent;
      try { ev = JSON.parse(String(m.data)); } catch { return; }
      for (const s of this.subs) s(ev);
    };
    ws.onclose = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 10_000);
    };
  }

  subscribe(fn: (ev: ServiceEvent) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
}

/** In-memory stream for tests. */
export class FakeEvents implements EventStream {
  private subs = new Set<(ev: ServiceEvent) => void>();
  subscribe(fn: (ev: ServiceEvent) => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  emit(type: string, data: Record<string, any> = {}) { const ev = { at: new Date().toISOString(), type, data }; for (const s of this.subs) s(ev); }
}
