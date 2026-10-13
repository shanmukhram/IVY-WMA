/**
 * AI layer (PRD A1, A2, A3, T6, Q7). Ask AI is a chat: conversations on the left, the thread in
 * bubbles, the composer at the bottom. Facts carry record chips that open the record in a sheet;
 * inferences are set apart; missing information is listed. The same answer view sits in the drawer
 * beside search results and the timeline, never replacing them. Cloud off: nothing is sent.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { errText } from "../api.ts";
import { useApi, useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { friendlyTime, shortWhen } from "../format.ts";
import { Icon } from "../components/Icon.tsx";
import { Link } from "../components/Controls.tsx";
import { Empty, ErrorLine, Notice } from "../components/Feedback.tsx";
import { RecordSheet, type Item } from "./records.tsx";

export interface AiContext { searchQuery?: string; filters?: Record<string, string>; date?: string; timeline?: boolean | { date?: string; device?: string; type?: string }; tz?: string }
export interface AiTurn {
  conversationId: string; kind?: string; model?: string;
  answer: string;
  facts: Array<{ text: string; recordIds: string[] }>;
  inferences: Array<{ text: string; basis: string }>;
  missing: string[];
  records: Item[];
  toolCalls?: Array<{ name: string; summary: string }>;
  retried?: boolean;
}

const TYPE_SHORT: Record<string, string> = { message: "message", notification: "notification", screenshot: "screenshot", photo: "photo", file: "file", usage: "app usage", call: "call", browsing: "Google activity" };

/** One answer: facts with record chips, inferences apart, missing listed. */
export function Answer({ t }: { t: AiTurn }) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(t.records.map((r) => [r.id, r]));
  const openRec = open ? byId.get(open) : undefined;
  return (
    <article className="answer" data-testid="ai-answer" aria-label="Answer">
      <p className="a-text">{t.answer}</p>
      {t.facts.length > 0 && (
        <section aria-label="Facts">
          <h3>Facts · each linked to records</h3>
          <ul className="facts">{t.facts.map((f, i) => (
            <li key={i}><span className="fact-text">{f.text}</span>
              {f.recordIds.map((id) => {
                const r = byId.get(id);
                return (
                  <button key={id} className="rec-chip" disabled={!r} title={r ? `Open ${r.type} record` : "record no longer available"}
                    aria-haspopup="dialog" onClick={() => setOpen(id)}>
                    <Icon name="paperclip" size={11} />{r ? `${TYPE_SHORT[r.type] ?? r.type} · ${friendlyTime(r.eventTime)}` : `record ${id.slice(0, 8)} (gone)`}
                  </button>
                );
              })}
            </li>
          ))}</ul>
        </section>
      )}
      {t.inferences.length > 0 && (
        <section aria-label="Inferences" className="inferences">
          <h3>Inferences · not stated by any record</h3>
          <ul>{t.inferences.map((x, i) => <li key={i} className="inference"><span className="badge badge-purple">inference</span> {x.text}<span className="basis">basis: {x.basis}</span></li>)}</ul>
        </section>
      )}
      {t.missing.length > 0 && (
        <section aria-label="Missing information" className="missing">
          <h3>Missing or not covered</h3>
          <ul>{t.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </section>
      )}
      <p className="a-foot">
        {t.records.length} linked record(s){t.toolCalls?.length ? ` · looked up: ${t.toolCalls.map((c) => c.summary).join("; ")}` : ""}{t.model ? ` · ${t.model}` : ""}{t.retried ? " · first answer rejected for missing evidence, retried" : ""}
      </p>
      {openRec && <RecordSheet it={openRec} onClose={() => setOpen(null)} />}
    </article>
  );
}

function Turn({ q, t }: { q: string; t: AiTurn }) {
  return (
    <>
      <div className="bubble-row mine"><div className="bubble q">{q}</div></div>
      <div className="bubble-row"><Answer t={t} /></div>
    </>
  );
}

function Typing() { return <div className="bubble-row" aria-label="Working"><div className="typing"><span /><span /><span /></div></div>; }

function CloudOff({ whatIsSent }: { whatIsSent?: string }) {
  return (
    <Empty icon="cloud" title="Cloud AI is off" action={<Link to="/settings?section=ai" className="btn btn-primary">Open Settings › AI</Link>}>
      Nothing leaves this Mac. Search, timeline and browsing work fully without it. {whatIsSent ?? ""}
    </Empty>
  );
}

function Composer({ onSend, busy, placeholder, note }: { onSend: (q: string) => void; busy: boolean; placeholder: string; note?: string }) {
  const [text, setText] = useState("");
  const send = () => { const q = text.trim(); if (!q || busy) return; setText(""); onSend(q); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } };
  return (
    <div className="composer">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); send(); }}>
        <textarea rows={1} aria-label="Ask about your records" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <button type="submit" className="btn btn-primary send" disabled={busy || !text.trim()} aria-label="Ask"><Icon name="arrowUp" size={15} /></button>
      </form>
      {note && <p className="composer-note">{note}</p>}
    </div>
  );
}

/** Ask + follow-ups beside a view (drawer); the conversation keeps the view's context (Q7). */
export function AiPanel({ context, overview, onConversation }: { context?: AiContext; overview?: boolean; onConversation?: (id: string) => void }) {
  const api = useApi();
  const s = useLoad<any>((a) => a.get("/api/ai/settings"), []);
  const [turns, setTurns] = useState<Array<{ q: string; t: AiTurn }>>([]);
  const [cid, setCid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const on = !!s.data?.cloudEnabled;

  const run = async (path: string, body: Record<string, unknown>, q: string) => {
    setBusy(true); setErr(null);
    try {
      const t = await api.post<AiTurn>(path, { ...body, context, ...(cid ? { conversationId: cid } : {}) });
      setTurns((x) => [...x, { q, t }]);
      setCid(t.conversationId); onConversation?.(t.conversationId);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  if (s.loading && !s.data) return <p className="muted small">Loading AI settings…</p>;
  if (!on) {
    return (
      <div role="note" className="stack-sm">
        <p><strong>Cloud AI is off.</strong> Nothing leaves this Mac. Search, timeline and browsing work fully without it.</p>
        <p className="small muted">Turn it on in <Link to="/settings?section=ai">Settings › AI</Link>. {s.data?.whatIsSent ?? ""}</p>
      </div>
    );
  }
  return (
    <div className="stack">
      {overview && turns.length === 0 && (
        <button className="btn btn-primary" disabled={busy} onClick={() => void run("/api/ai/overview", {}, context?.searchQuery ? `Overview of “${context.searchQuery}”` : `Overview of ${context?.date ?? "this day"}`)}>
          <Icon name="sparkles" size={14} />{busy ? "Working…" : context?.searchQuery ? "Overview of these results" : "Overview of this day"}
        </button>
      )}
      {turns.map((x, i) => <div key={i} className="stack-sm"><div className="bubble-row mine"><div className="bubble q">{x.q}</div></div><Answer t={x.t} /></div>)}
      {busy && <Typing />}
      <ErrorLine error={err} />
      <div className="composer" style={{ padding: 0 }}>
        <ComposerInline busy={busy} placeholder={turns.length ? "Follow-up question" : "Ask about your records"} onSend={(q) => void run("/api/ai/ask", { question: q }, q)} />
      </div>
      <p className="small faint">Sent to OpenAI: your question and the records the assistant retrieves while answering. {context?.searchQuery ? `Context: search “${context.searchQuery}”.` : context?.date ? `Context: timeline ${context.date}.` : ""}</p>
    </div>
  );
}

function ComposerInline(props: { onSend: (q: string) => void; busy: boolean; placeholder: string }) {
  const [text, setText] = useState("");
  const send = () => { const q = text.trim(); if (!q || props.busy) return; setText(""); props.onSend(q); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); send(); }}>
      <textarea rows={1} aria-label="Ask about your records" placeholder={props.placeholder} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
      <button type="submit" className="btn btn-primary send" disabled={props.busy || !text.trim()} aria-label="Ask"><Icon name="arrowUp" size={15} /></button>
    </form>
  );
}

/** Closable right-hand drawer beside search results or the timeline (T6). */
export function AiDrawer({ context, label = "AI overview", open, onClose }: { context: AiContext; label?: string; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <aside className="ai-drawer" aria-label="AI drawer">
      <div className="drawer-head"><Icon name="sparkles" /><h2>{label}</h2><button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close AI drawer"><Icon name="close" size={14} /></button></div>
      <div className="drawer-body"><AiPanel key={JSON.stringify(context)} context={context} overview /></div>
    </aside>
  );
}

/** /ai: chat with conversation history (stored on this Mac). */
export function AiView() {
  const api = useApi();
  const { query } = useLocation();
  const id = query.get("c");
  const s = useLoad<any>((a) => a.get("/api/ai/settings"), []);
  const list = useLoad<any>((a) => a.get("/api/ai/conversations"), []);
  const conv = useLoad<any>((a) => (id ? a.get(`/api/ai/conversations/${id}`) : Promise.resolve(null)), [id]);
  const [local, setLocal] = useState<Array<{ q: string; t: AiTurn }>>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { setLocal([]); setErr(null); setMsg(null); }, [id]);
  const on = !!s.data?.cloudEnabled;

  const stored: Array<{ q: string; t: AiTurn }> = ((conv.data?.turns ?? []) as Array<{ question: string; result: AiTurn }>).map((t) => ({ q: t.question, t: t.result }));
  const turns = [...stored, ...local];
  useEffect(() => { scroll.current?.scrollTo?.({ top: scroll.current.scrollHeight, behavior: "smooth" }); }, [turns.length, busy]);

  const ask = async (q: string) => {
    setBusy(true); setErr(null); setPending(q);
    try {
      const t = await api.post<AiTurn>("/api/ai/ask", { question: q, ...(id ? { conversationId: id, context: conv.data?.context ?? undefined } : {}) });
      if (!id) { navigate(href("/ai", { c: t.conversationId }), true); list.reload(); setLocal([]); }
      else { setLocal((x) => [...x, { q, t }]); list.reload(); }
    } catch (e) { setErr(e); } finally { setBusy(false); setPending(null); }
  };
  const del = async () => {
    if (!id) return;
    try { await api.del(`/api/ai/conversations/${id}`); setMsg("Moved to the recovery bin."); list.reload(); navigate("/ai"); } catch (e) { setMsg(errText(e)); }
  };
  const items = (list.data?.items ?? []) as Array<{ id: string; title: string; kind: string; turns: number; updatedAt: string }>;

  return (
    <div className="panes">
      <section className="pane pane-list" aria-label="AI conversations">
        <div className="pane-head"><h1>Ask AI</h1><span className="spacer" />
          <Link to="/ai" className="btn btn-sm" aria-label="New chat"><Icon name="plus" size={13} />New</Link>
        </div>
        <div className="pane-scroll" style={{ padding: 8 }}>
          <ErrorLine error={list.error} />
          {list.data && items.length === 0 && <p className="small faint" style={{ padding: "8px 12px" }}>No AI conversations yet. They are stored on this Mac.</p>}
          {items.map((c) => (
            <Link key={c.id} to={href("/ai", { c: c.id })} className="chat-list-item" aria-current={c.id === id ? "true" : undefined}>
              <span className="cl-title" title={c.title}>{c.title}</span>
              <span className="cl-sub">{c.kind} · {c.turns} turn(s) · {shortWhen(c.updatedAt)}</span>
            </Link>
          ))}
        </div>
      </section>
      <section className="pane pane-main" aria-label="AI chat">
        <div className="pane-head">
          <h2 className="ellipsis">{id ? conv.data?.title ?? "Conversation" : "New chat"}</h2>
          <span className="spacer" />
          {msg && <span role="status" className="small muted">{msg}</span>}
          {id && <button className="btn btn-sm" onClick={() => void del()}><Icon name="trash" size={13} />Move to bin</button>}
        </div>
        <div className="thread-scroll" ref={scroll}>
          <ErrorLine error={conv.error} />
          {turns.length === 0 && !pending && (s.data && !on ? <CloudOff whatIsSent={s.data?.whatIsSent} /> : (
            <Empty icon="sparkles" title="Ask about your records">
              Answers cite the records they come from. Facts carry chips you can open; inferences and missing information are shown apart.
            </Empty>
          ))}
          {turns.map((x, i) => <Turn key={i} q={x.q} t={x.t} />)}
          {pending && <div className="bubble-row mine"><div className="bubble q">{pending}</div></div>}
          {busy && <Typing />}
          <ErrorLine error={err} />
        </div>
        {s.data && !on ? (
          turns.length > 0 ? <div className="composer"><Notice tone="warn">Cloud AI is off: follow-ups are disabled. <Link to="/settings?section=ai">Turn it on in Settings › AI</Link>.</Notice></div> : null
        ) : (
          <Composer busy={busy} onSend={(q) => void ask(q)} placeholder={turns.length ? "Ask a follow-up…" : "Ask about your records…"}
            note="Enter to send · Shift+Enter for a new line · Sent to OpenAI: your question and the records the assistant retrieves" />
        )}
      </section>
    </div>
  );
}
