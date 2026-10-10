/**
 * AI layer UI (PRD A1, A2, T6, Q7): ask / overview with evidence-linked answers.
 * Facts carry record chips that open the record; inferences are shown apart
 * from facts; missing information is listed. The drawer sits beside search
 * results or the timeline and never replaces them.
 */
import { useEffect, useState, type FormEvent } from "react";
import { errText } from "../api.ts";
import { useApi, useLoad } from "../ctx.tsx";
import { href, useLocation } from "../router.ts";
import { Chip, Empty, ErrorLine, Link, Time, fmtTime } from "../ui.tsx";
import { ItemRow, type Item } from "./items.tsx";

export interface AiContext { searchQuery?: string; filters?: Record<string, string>; date?: string; timeline?: boolean; tz?: string }
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
export function Answer({ t, question }: { t: AiTurn; question?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(t.records.map((r) => [r.id, r]));
  const openRec = open ? byId.get(open) : undefined;
  return (
    <article className="ai-answer" data-testid="ai-answer">
      {question && <p className="ai-q"><strong>Q:</strong> {question}</p>}
      <p className="ai-a">{t.answer}</p>
      {t.facts.length > 0 && (
        <section aria-label="Facts">
          <h4>Facts (each linked to records)</h4>
          <ul className="ai-facts">{t.facts.map((f, i) => (
            <li key={i}>{f.text}{" "}
              {f.recordIds.map((id) => {
                const r = byId.get(id);
                return (
                  <button key={id} className={`chip chip-rec${open === id ? " active" : ""}`} aria-pressed={open === id} disabled={!r}
                    title={r ? `open ${r.type} record` : "record no longer available"} onClick={() => setOpen(open === id ? null : id)}>
                    {r ? `${TYPE_SHORT[r.type] ?? r.type} · ${fmtTime(r.eventTime)}` : `record ${id.slice(0, 8)} (gone)`}
                  </button>
                );
              })}
            </li>
          ))}</ul>
        </section>
      )}
      {openRec && <div className="ai-record" aria-label="Opened record"><ItemRow it={openRec} /></div>}
      {t.inferences.length > 0 && (
        <section aria-label="Inferences" className="ai-inferences">
          <h4>Inferences (not stated by any record)</h4>
          <ul>{t.inferences.map((x, i) => <li key={i} className="inference"><Chip kind="warn">inference</Chip> {x.text} <span className="muted small">basis: {x.basis}</span></li>)}</ul>
        </section>
      )}
      {t.missing.length > 0 && (
        <section aria-label="Missing information">
          <h4>Missing or not covered</h4>
          <ul className="ai-missing">{t.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </section>
      )}
      <p className="small muted">
        {t.records.length} linked record(s){t.toolCalls?.length ? ` · looked up: ${t.toolCalls.map((c) => c.summary).join("; ")}` : ""}{t.model ? ` · ${t.model}` : ""}{t.retried ? " · first answer rejected for missing evidence, retried" : ""}
      </p>
    </article>
  );
}

/** Ask box + the conversation so far; follow-ups keep the conversation and the current context (Q7). */
export function AiPanel({ context, overview, onConversation }: { context?: AiContext; overview?: boolean; onConversation?: (id: string) => void }) {
  const api = useApi();
  const s = useLoad<any>((a) => a.get("/api/ai/settings"), []);
  const [turns, setTurns] = useState<Array<{ q: string; t: AiTurn }>>([]);
  const [cid, setCid] = useState<string | null>(null);
  const [text, setText] = useState("");
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
  const ask = (e: FormEvent) => { e.preventDefault(); const q = text.trim(); if (!q) return; setText(""); void run("/api/ai/ask", { question: q }, q); };

  if (s.loading && !s.data) return <p className="muted small">Loading AI settings…</p>;
  if (!on) {
    return (
      <div className="ai-off" role="note">
        <p><strong>Cloud AI is off.</strong> Nothing leaves this Mac. Search, timeline and browsing work fully without it.</p>
        <p className="small">Turn it on in <Link to="/settings">Settings &gt; AI</Link>. {s.data?.whatIsSent ?? ""}</p>
      </div>
    );
  }
  return (
    <div className="ai-panel">
      {overview && turns.length === 0 && (
        <button disabled={busy} onClick={() => void run("/api/ai/overview", {}, context?.searchQuery ? `Overview of “${context.searchQuery}”` : `Overview of ${context?.date ?? "this day"}`)}>
          {busy ? "Working…" : context?.searchQuery ? "Overview of these results" : "Overview of this day"}
        </button>
      )}
      {turns.map((x, i) => <Answer key={i} t={x.t} question={x.q} />)}
      <ErrorLine error={err} />
      <form onSubmit={ask} className="ai-ask">
        <input aria-label="Ask about your records" placeholder={turns.length ? "Follow-up question" : "Ask about your records"} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
        <button type="submit" disabled={busy || !text.trim()}>{busy ? "Working…" : "Ask"}</button>
      </form>
      <p className="small muted">Sent to OpenAI: your question and the records the assistant retrieves while answering. {context?.searchQuery ? `Context: search “${context.searchQuery}”.` : context?.date ? `Context: timeline ${context.date}.` : ""}</p>
    </div>
  );
}

/** Closable side drawer beside search results or the timeline (T6). */
export function AiDrawer({ context, label = "AI overview" }: { context: AiContext; label?: string }) {
  const [open, setOpen] = useState(false);
  const key = JSON.stringify(context);
  useEffect(() => setOpen(false), [key]); // a new search / day starts a new conversation
  return (
    <>
      <button className="ai-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Close AI" : label}</button>
      {open && (
        <aside className="ai-drawer" aria-label="AI drawer">
          <div className="toolbar"><strong>AI</strong><span className="spacer" /><button onClick={() => setOpen(false)} aria-label="Close AI drawer">Close</button></div>
          <AiPanel key={key} context={context} overview />
        </aside>
      )}
    </>
  );
}

/** /ai: ask without a view context, and the local history of earlier conversations. */
export function AiView() {
  const { query } = useLocation();
  const id = query.get("c");
  const list = useLoad<any>((a) => a.get("/api/ai/conversations"), []);
  return (
    <div className="ai-page">
      <section className="panel">
        <h2>Ask about your records</h2>
        <AiPanel onConversation={() => list.reload()} />
      </section>
      {id ? <ConversationHistory id={id} /> : null}
      <section aria-label="AI history">
        <h3>Earlier conversations (stored on this Mac)</h3>
        <ErrorLine error={list.error} />
        {(list.data?.items ?? []).length === 0 ? <Empty>No AI conversations yet.</Empty> : (
          <ul>{list.data.items.map((c: any) => (
            <li key={c.id}><Link to={href("/ai", { c: c.id })}>{c.title}</Link> <span className="muted small">{c.kind} · {c.turns} turn(s) · <Time at={c.updatedAt} /></span></li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}

function ConversationHistory({ id }: { id: string }) {
  const api = useApi();
  const c = useLoad<any>((a) => a.get(`/api/ai/conversations/${id}`), [id]);
  const [msg, setMsg] = useState<string | null>(null);
  const del = async () => { try { await api.del(`/api/ai/conversations/${id}`); setMsg("Moved to the recovery bin."); c.reload(); } catch (e) { setMsg(errText(e)); } };
  return (
    <section className="panel" aria-label="AI conversation">
      <ErrorLine error={c.error} />
      {msg && <p role="status">{msg}</p>}
      {c.data && (
        <>
          <div className="toolbar"><strong>{c.data.title}</strong><span className="spacer" /><button onClick={() => void del()}>Move to bin</button></div>
          {c.data.turns.map((t: any, i: number) => <Answer key={i} t={t.result} question={t.question} />)}
        </>
      )}
    </section>
  );
}
