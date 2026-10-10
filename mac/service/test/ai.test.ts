/**
 * AI layer (PRD A1-A4, T6, Q7, M4/Q6) against a seeded vault, with a fake
 * OpenAI client shaped like the official one (no network). The tools the fake
 * model calls are the real local tools.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { setOpenAIFactory, pickDefaultChatModel, pickDefaultEmbeddingModel, type ChatMessage, type OpenAILike } from "../src/ai/openai.ts";
import { softDelete, purge } from "../src/bin/recovery.ts";

const KEY = "sk-test-" + "k".repeat(40);
const AND = "dev-and";
const DAY = "2026-09-24";
const MODELS = ["gpt-4.1", "gpt-5", "gpt-5.1", "gpt-5.5", "gpt-5.5-mini", "gpt-5.5-2026-04-23", "gpt-6-sol", "gpt-4o-audio-preview", "text-embedding-3-small", "text-embedding-3-large"];

type Step = (body: { model: string; messages: ChatMessage[]; tools: unknown[]; tool_choice: string }) => Partial<ChatMessage>;

interface Fake extends OpenAILike { bodies: Array<{ model: string; messages: ChatMessage[]; tool_choice: string }>; constructed: number; embedInputs: string[][]; failEmbeddings: boolean }

let fake: Fake;
let script: Step[] = [];

function makeFake(): Fake {
  const f: Fake = {
    bodies: [], constructed: 0, embedInputs: [], failEmbeddings: false,
    chat: { completions: { async create(body: any) {
      f.bodies.push(structuredClone(body));
      const step = script.shift();
      if (!step) throw Object.assign(new Error("no scripted reply"), { status: 500 });
      return { choices: [{ message: { role: "assistant", content: null, ...step(body) } as ChatMessage }] };
    } } },
    models: { list: () => Promise.resolve({ data: MODELS.map((id) => ({ id })) }) },
    embeddings: { async create(body) {
      if (f.failEmbeddings) throw Object.assign(new Error("network down"), { status: 503 });
      f.embedInputs.push(body.input);
      return { data: body.input.map((t, index) => ({ index, embedding: vec(t) })) };
    } },
  };
  return f;
}

/** deterministic bag-of-words vector */
function vec(t: string): number[] {
  const v = new Array(32).fill(0);
  for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 32] += 1; }
  return v;
}

const toolCall = (name: string, args: unknown, id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`) => ({ tool_calls: [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const final = (a: unknown) => ({ content: JSON.stringify(a) });
/** ids of records in the latest tool message the model was sent */
function lastToolIds(body: { messages: ChatMessage[] }): string[] {
  const t = [...body.messages].reverse().find((m) => m.role === "tool")!;
  const o = JSON.parse(t.content!);
  return (o.items ?? o.messages ?? [o]).map((x: { id: string }) => x.id);
}

let svc: Service;
let dir: string;
let msgInvoice = "", msgOther = "", shot = "";

beforeAll(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  const db = svc.ctx.db;
  db.prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'android', 'k', 'FP', 't')").run(AND);
  db.prepare("INSERT INTO conversations(id, device_id, platform, account, conv_key, peer, kind, coverage, created_at, updated_at) VALUES ('c1', ?, 'line', 'bunny', 'k1', 'Aki', 'dm', 'complete', 't', 't')").run(AND);
  const ins = db.prepare("INSERT INTO messages(id, conversation_id, device_id, msg_key, sender, sent_at, captured_at, text) VALUES (?, 'c1', ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', ?)");
  ins.run("m1", AND, "1", "Aki", `${DAY}T09:00:00.000Z`, "Did you pay the invoice from Kyoto Robotics?");
  ins.run("m2", AND, "2", "bunny", `${DAY}T09:05:00.000Z`, "Yes, paid it this morning, 120000 yen");
  ins.run("m3", AND, "3", "Aki", `${DAY}T18:00:00.000Z`, "unrelated dinner plans with the zebra club");
  msgInvoice = "m1"; msgOther = "m3";
  db.prepare(`INSERT INTO media(id, device_id, kind, source_path, captured_at, imported_at, taken_at, ocr_text, ocr_status)
              VALUES ('s1', ?, 'screenshot', '/sdcard/shot.png', 't', 't', '${DAY}T10:00:00.000Z', 'Bank transfer receipt Kyoto Robotics invoice 120000', 'done')`).run(AND);
  shot = "s1";
});
afterAll(async () => { await svc.close(); rm(dir); });
beforeEach(() => {
  fake = makeFake();
  script = [];
  setOpenAIFactory(svc.ctx, () => { fake.constructed++; return fake; });
});

const setAi = (b: Record<string, unknown>) => api(svc, "PUT", "/api/ai/settings", b);

describe("cloud AI off (A3, A4)", () => {
  it("every AI route answers 409 and no OpenAI client is constructed", async () => {
    expect((await api(svc, "GET", "/api/ai/settings")).json).toMatchObject({ cloudEnabled: false, apiKeySet: false, embeddings: false });
    await setAi({ apiKey: KEY }); // a stored key alone does not turn anything on
    for (const [m, u, b] of [
      ["POST", "/api/ai/ask", { question: "what did I pay?" }],
      ["POST", "/api/ai/overview", { context: { date: DAY } }],
      ["GET", "/api/ai/models", undefined],
      ["POST", "/api/ai/embeddings/run", {}],
    ] as const) {
      const r = await api(svc, m, u, b);
      expect(r.status, u).toBe(409);
      expect(r.json.error).toBe("ai_disabled");
      expect(r.json.message).toMatch(/Nothing is sent/);
    }
    expect(fake.constructed).toBe(0);
    expect(fake.bodies).toHaveLength(0);
  });

  it("search, timeline, records and browsing work fully with cloud AI off, and the same with it on", async () => {
    const snapshot = async () => ({
      search: (await api(svc, "GET", "/api/search?q=invoice")).json,
      timeline: (await api(svc, "GET", `/api/timeline?date=${DAY}&tz=UTC`)).json,
      item: (await api(svc, "GET", `/api/items/message/${msgInvoice}`)).json,
      conv: (await api(svc, "GET", "/api/conversations/c1/messages")).json,
      media: (await api(svc, "GET", "/api/media")).json,
    });
    const off = await snapshot();
    expect(off.search.exactTotal).toBe(2);
    expect(off.search.semantic.enabled).toBe(false);
    expect(off.timeline.total).toBe(4);
    expect(off.item.id).toBe(msgInvoice);
    expect(off.conv.messages).toHaveLength(3);
    expect(off.media.total).toBe(1);
    // on, with embeddings on but OpenAI unreachable: exact search is unaffected
    await setAi({ cloudEnabled: true, embeddings: true });
    fake.failEmbeddings = true;
    const on = await snapshot();
    expect(on.search.items).toEqual(off.search.items);
    expect(on.search.semantic).toMatchObject({ enabled: true, items: [] });
    expect(on.timeline.items).toEqual(off.timeline.items);
    await setAi({ cloudEnabled: false, embeddings: false });
  });

  it("cloud AI on without a key is 409 ai_no_key", async () => {
    await setAi({ cloudEnabled: true, apiKey: "" });
    const r = await api(svc, "POST", "/api/ai/ask", { question: "x" });
    expect([r.status, r.json.error]).toEqual([409, "ai_no_key"]);
    await setAi({ cloudEnabled: false });
  });
});

describe("API key", () => {
  it("is sealed at rest and never returned", async () => {
    const r = await setAi({ apiKey: KEY });
    expect(r.json.apiKeySet).toBe(true);
    for (const u of ["/api/ai/settings", "/api/ui-settings", "/api/activity?limit=500", "/api/r2"]) expect((await api(svc, "GET", u)).body).not.toContain(KEY.slice(8));
    expect(JSON.stringify(r.json)).not.toContain(KEY.slice(8));
    const raw = svc.ctx.db.prepare("SELECT key, value FROM settings").all();
    expect(JSON.stringify(raw)).not.toContain(KEY.slice(8));
    expect((await setAi({ apiKey: "short" })).status).toBe(400);
    expect((await setAi({ other: 1 })).status).toBe(400);
  });
});

describe("assistant (A1, A2)", () => {
  beforeAll(async () => { await setAi({ cloudEnabled: true, apiKey: KEY }); });
  afterAll(async () => { await setAi({ cloudEnabled: false }); });

  it("runs real local tools in a loop and returns facts linked to records, inferences and missing", async () => {
    script = [
      () => toolCall("search", { query: "invoice" }),
      (body) => toolCall("open_conversation", { messageId: lastToolIds(body).find((i) => i === msgInvoice) }),
      (body) => {
        const ids = lastToolIds(body);
        return final({
          answer: "You paid the Kyoto Robotics invoice on 24 September.",
          facts: [{ text: "Aki asked whether the invoice was paid", recordIds: [msgInvoice] }, { text: "You replied it was paid, 120000 yen", recordIds: [ids.find((i) => i === "m2")] }],
          inferences: [{ text: "The screenshot is probably the transfer receipt", basis: "same amount and payee" }],
          missing: ["No bank record is in the vault"],
        });
      },
    ];
    const r = await api(svc, "POST", "/api/ai/ask", { question: "Did I pay the Kyoto invoice?", context: { searchQuery: "invoice" } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.facts).toHaveLength(2);
    expect(r.json.facts.every((f: { recordIds: string[] }) => f.recordIds.length > 0)).toBe(true);
    expect(r.json.records.map((x: { id: string; type: string }) => `${x.type}:${x.id}`).sort()).toEqual(["message:m1", "message:m2"]);
    expect(r.json.inferences[0]).toMatchObject({ basis: "same amount and payee" });
    expect(r.json.missing).toEqual(["No bank record is in the vault"]);
    expect(r.json.toolCalls.map((t: { name: string }) => t.name)).toEqual(["search", "open_conversation"]);
    expect(r.json.model).toBe("gpt-5.5"); // newest plain GPT-5-class id from the API list, not hardcoded
    expect(r.json.retried).toBe(false);

    // the model received the question with the current context, and only what the tools returned
    const first = fake.bodies[0]!;
    expect(first.messages[0]!.role).toBe("system");
    expect(first.messages[1]!.content).toMatch(/Did I pay the Kyoto invoice\?[\s\S]*Current view: search for "invoice"/);
    const searchResult = JSON.parse(fake.bodies[1]!.messages.at(-1)!.content!);
    expect(searchResult.items.map((i: { id: string }) => i.id).sort()).toEqual([msgInvoice, shot].sort()); // real FTS over the seeded vault
    const beforeOpen = JSON.stringify(fake.bodies.slice(0, 2));
    expect(beforeOpen).toContain("Kyoto Robotics");
    expect(beforeOpen).not.toContain("zebra club"); // an unrelated record is not sent until a tool returns it
    expect(JSON.stringify(fake.bodies[2]!.messages.at(-1))).toContain("zebra club"); // open_conversation returned the thread, which includes it
  });

  it("rejects an answer with an unlinked fact, retries once, then accepts", async () => {
    script = [
      () => toolCall("search", { query: "receipt" }),
      () => final({ answer: "x", facts: [{ text: "a payment happened", recordIds: [] }], inferences: [], missing: [] }),
      () => final({ answer: "A transfer receipt screenshot exists.", facts: [{ text: "receipt screenshot", recordIds: [shot] }], inferences: [], missing: [] }),
    ];
    const r = await api(svc, "POST", "/api/ai/ask", { question: "receipt?" });
    expect(r.status, r.body).toBe(200);
    expect(r.json.retried).toBe(true);
    expect(r.json.records[0]).toMatchObject({ type: "screenshot", id: shot });
    expect(fake.bodies[2]!.messages.at(-1)!.content).toMatch(/rejected: fact 1 .* has no record id/);
  });

  it("fails rather than show facts citing records no tool returned", async () => {
    const before = (svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM ai_conversations").get() as { n: number }).n;
    script = [
      () => final({ answer: "x", facts: [{ text: "made up", recordIds: ["not-a-record"] }], inferences: [], missing: [] }),
      () => final({ answer: "x", facts: [{ text: "still made up", recordIds: [msgOther] }], inferences: [], missing: [] }), // real id, but never retrieved
    ];
    const r = await api(svc, "POST", "/api/ai/ask", { question: "anything?" });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("ai_unlinked_facts");
    expect((svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM ai_conversations").get() as { n: number }).n).toBe(before);
  });

  it("an honest 'nothing found' answer lists what is missing", async () => {
    script = [
      () => toolCall("search", { query: "flamingo" }),
      () => final({ answer: "The vault shows nothing about flamingos.", facts: [], inferences: [], missing: ["No record mentions flamingo"] }),
    ];
    const r = await api(svc, "POST", "/api/ai/ask", { question: "flamingo?" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ facts: [], missing: ["No record mentions flamingo"], records: [] });
  });

  it("keeps the conversation and context for follow-ups (Q7), and history is soft-delete aware", async () => {
    script = [
      () => toolCall("timeline", { date: DAY }),
      (body) => final({ answer: "Four records that day.", facts: [{ text: "invoice question", recordIds: [lastToolIds(body)[0]] }], inferences: [], missing: [] }),
    ];
    const a = await api(svc, "POST", "/api/ai/ask", { question: "What happened that day?", context: { date: DAY, timeline: true, tz: "UTC" } });
    expect(a.status, a.body).toBe(200);
    const cid = a.json.conversationId;
    // follow-up: no new tool call; it may cite a record retrieved in the first turn
    script = [() => final({ answer: "The receipt screenshot was at 10:00.", facts: [{ text: "screenshot at 10:00", recordIds: [shot] }], inferences: [], missing: [] })];
    const b = await api(svc, "POST", "/api/ai/ask", { question: "And the screenshot?", conversationId: cid, context: { date: DAY, timeline: true, tz: "UTC" } });
    expect(b.status, b.body).toBe(200);
    expect(b.json.conversationId).toBe(cid);
    const sent = fake.bodies.at(-1)!.messages;
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
    expect(sent[1]!.content).toContain("What happened that day?");
    expect(sent.at(-1)!.content).toMatch(/And the screenshot\?[\s\S]*Current view: timeline of 2026-09-24/);

    const conv = await api(svc, "GET", `/api/ai/conversations/${cid}`);
    expect(conv.json.turns.map((t: { question: string }) => t.question)).toEqual(["What happened that day?", "And the screenshot?"]);
    expect((await api(svc, "GET", "/api/ai/conversations")).json.items.some((c: { id: string }) => c.id === cid)).toBe(true);
    expect((await api(svc, "DELETE", `/api/ai/conversations/${cid}`)).status).toBe(200);
    expect((await api(svc, "GET", `/api/ai/conversations/${cid}`)).status).toBe(404);
    expect((await api(svc, "POST", "/api/ai/ask", { question: "more?", conversationId: cid })).status).toBe(404);
    expect((await api(svc, "GET", "/api/bin")).json.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: "ai_conversation", id: cid })]));
    await api(svc, "POST", `/api/bin/ai_conversation/${cid}/restore`);
    expect((await api(svc, "GET", `/api/ai/conversations/${cid}`)).status).toBe(200);
  });

  it("overview (T6) of the day seeds the timeline tool and follows the same evidence rules", async () => {
    script = [(body) => {
      expect(body.messages.at(-1)!.role).toBe("tool"); // the timeline already ran locally
      return final({ answer: "A payment conversation and a receipt.", facts: [{ text: "receipt", recordIds: [shot] }], inferences: [], missing: ["No usage data that day"] });
    }];
    const r = await api(svc, "POST", "/api/ai/overview", { context: { date: DAY, tz: "UTC" } });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ kind: "overview", toolCalls: [{ name: "timeline" }] });
    expect((await api(svc, "POST", "/api/ai/overview", { context: {} })).status).toBe(400);
  });

  it("permanently deleting a record removes AI history that quoted it (B3)", async () => {
    script = [() => toolCall("get_record", { id: msgOther }), () => final({ answer: "dinner", facts: [{ text: "dinner plans", recordIds: [msgOther] }], inferences: [], missing: [] })];
    const r = await api(svc, "POST", "/api/ai/ask", { question: "dinner?" });
    expect(r.status, r.body).toBe(200);
    softDelete(svc.ctx, "message", msgOther);
    purge(svc.ctx, "message", msgOther);
    expect((await api(svc, "GET", `/api/ai/conversations/${r.json.conversationId}`)).status).toBe(404);
    expect(JSON.stringify(svc.ctx.db.prepare("SELECT transcript FROM ai_conversations").all())).not.toContain("zebra club");
  });

  it("lists models from the API with the implied defaults", async () => {
    const r = await api(svc, "GET", "/api/ai/models");
    expect(r.json).toMatchObject({ defaultModel: "gpt-5.5", defaultEmbeddingModel: "text-embedding-3-small" });
    expect(r.json.models).toContain("gpt-6-sol");
    expect(r.json.models).not.toContain("gpt-4o-audio-preview");
    await setAi({ model: "gpt-6-sol" });
    script = [() => toolCall("search", { query: "receipt" }), () => final({ answer: "a", facts: [{ text: "r", recordIds: [shot] }], inferences: [], missing: [] })];
    await api(svc, "POST", "/api/ai/ask", { question: "q" });
    expect(fake.bodies.at(-1)!.model).toBe("gpt-6-sol");
    await setAi({ model: null });
  });
});

describe("default model picking", () => {
  it("prefers the newest plain GPT-5-class id", () => {
    expect(pickDefaultChatModel(["gpt-5", "gpt-5.1", "gpt-5.10", "gpt-5.9-mini"])).toBe("gpt-5.10");
    expect(pickDefaultChatModel(["gpt-5-chat-latest", "gpt-4.1"])).toBe("gpt-5-chat-latest");
    expect(pickDefaultChatModel(["gpt-4.1"])).toBeNull();
    expect(pickDefaultEmbeddingModel(["text-embedding-3-large", "text-embedding-3-small", "text-embedding-ada-002"])).toBe("text-embedding-3-small");
  });
});

describe("embeddings and semantic search (M4, Q6)", () => {
  afterAll(async () => { await setAi({ cloudEnabled: false, embeddings: false }); });

  it("embeds message and OCR text only when enabled, and reports separate semantic matches", async () => {
    await setAi({ cloudEnabled: true, apiKey: KEY, embeddings: false });
    expect((await api(svc, "POST", "/api/ai/embeddings/run", {})).status).toBe(409);
    expect((await api(svc, "GET", "/api/search?q=invoice")).json.semantic.enabled).toBe(false);
    expect(fake.embedInputs).toHaveLength(0);

    await setAi({ embeddings: true });
    const run = await api(svc, "POST", "/api/ai/embeddings/run", {});
    expect(run.status, run.body).toBe(200);
    expect(run.json).toMatchObject({ model: "text-embedding-3-small", remaining: 0 });
    const live = (svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL").get() as { n: number }).n;
    expect(run.json.embedded).toBe(live + 1); // messages + the screenshot's OCR text
    const s = await api(svc, "GET", "/api/search?q=paid%20invoice%20yen");
    expect(s.json.semantic).toMatchObject({ enabled: true, label: "Semantic matches" });
    expect(s.json.semantic.items.length).toBeGreaterThan(0);
    expect(s.json.semantic.items[0]).toEqual(expect.objectContaining({ type: expect.any(String), id: expect.any(String), score: expect.any(Number) }));
    expect(s.json.exactTotal).toBe(0); // the exact list is separate and unchanged
    // a soft-deleted item is not offered; a purged one takes its vector with it
    softDelete(svc.ctx, "screenshot", shot);
    expect((await api(svc, "GET", "/api/search?q=receipt%20transfer")).json.semantic.items.some((i: { id: string }) => i.id === shot)).toBe(false);
    purge(svc.ctx, "screenshot", shot);
    expect(svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE item_id = ?").get(shot)).toEqual({ n: 0 });
    expect((await api(svc, "GET", "/api/ai/embeddings")).json.stored.length).toBeGreaterThan(0);
  });
});

describe("locking", () => {
  it("AI routes are 423 while locked", async () => {
    await api(svc, "POST", "/api/keystore/lock", { full: false });
    expect((await api(svc, "GET", "/api/ai/settings")).status).toBe(423);
    await api(svc, "POST", "/api/keystore/unlock", { passphrase: PASS });
  });
});
