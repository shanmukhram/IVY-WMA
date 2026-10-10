import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Answer, AiDrawer, AiView, type AiTurn } from "../src/views/Ai.tsx";
import { AiSettings } from "../src/views/Settings.tsx";
import { SearchView } from "../src/views/Search.tsx";
import { ApiError } from "../src/api.ts";
import { mockApi, renderWith } from "./helpers.tsx";

const rec = (over: Record<string, unknown>) => ({
  type: "message", id: "m1", deviceId: null, app: "line", eventTime: "2026-09-24T09:00:00.000Z", timeField: "sent_at", capturedAt: null,
  title: "Aki", body: "Did you pay the invoice?", person: "Aki", detail: { conversationId: "c1", platform: "line" }, ...over,
});
const turn = (over: Partial<AiTurn> = {}): AiTurn => ({
  conversationId: "conv1", model: "gpt-5.5",
  answer: "You paid the invoice on 24 September.",
  facts: [{ text: "Aki asked about the invoice", recordIds: ["m1"] }, { text: "A receipt screenshot exists", recordIds: ["s1"] }, { text: "A gone record", recordIds: ["zz123456789"] }],
  inferences: [{ text: "The receipt is for that invoice", basis: "same amount" }],
  missing: ["No bank statement in the vault"],
  records: [rec({}), rec({ type: "screenshot", id: "s1", app: null, title: "/sdcard/shot.png", body: "receipt", detail: { thumbUrl: "/api/media/s1/thumb" } })] as never,
  toolCalls: [{ name: "search", summary: 'search "invoice": 2 match(es)' }],
  ...over,
});
const ON = { cloudEnabled: true, apiKeySet: true, embeddings: false, model: null, whatIsSent: "What would be sent to the OpenAI API: your question, and the passages and records the assistant retrieves while answering." };
const OFF = { ...ON, cloudEnabled: false };

describe("answer rendering (A2)", () => {
  it("facts carry record chips that open the record in a sheet; inferences apart; missing listed", async () => {
    renderWith(<Answer t={turn()} />, mockApi({}));
    const facts = screen.getByRole("region", { name: "Facts" });
    const chips = within(facts).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual([expect.stringMatching(/^message · .*\d\d:\d\d$/), expect.stringMatching(/^screenshot · /), "record zz123456 (gone)"]);
    expect(chips[2]).toBeDisabled();
    expect(screen.queryByRole("dialog")).toBeNull();
    const u = userEvent.setup();
    await u.click(chips[0]!);
    const sheet = screen.getByRole("dialog", { name: "Opened record" });
    expect(within(sheet).getByText("Did you pay the invoice?")).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Open in place" })).toHaveAttribute("href", "/conversations?chat=c1&around=m1");
    await u.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await u.click(chips[1]!);
    expect(within(screen.getByRole("dialog", { name: "Opened record" })).getByRole("img")).toHaveAttribute("src", "/api/media/s1/thumb");
    await u.keyboard("{Escape}");

    const inf = screen.getByRole("region", { name: "Inferences" });
    expect(inf).toHaveClass("inferences");
    expect(inf).toHaveTextContent(/inference.*The receipt is for that invoice.*basis: same amount/);
    expect(facts).not.toHaveTextContent("The receipt is for that invoice");
    expect(screen.getByRole("region", { name: "Missing information" })).toHaveTextContent("No bank statement in the vault");
    expect(screen.getByText(/2 linked record\(s\)/)).toBeInTheDocument();
  });
});

describe("Ask AI chat", () => {
  it("lists conversations, shows the thread as bubbles, and Enter sends a follow-up in the same conversation", async () => {
    const api = mockApi({
      "GET /api/ai/settings": ON,
      "GET /api/ai/conversations": { items: [{ id: "conv1", title: "Did I pay?", kind: "ask", turns: 1, updatedAt: "2026-09-24T10:00:00Z" }, { id: "conv2", title: "Overview of 2026-09-23", kind: "overview", turns: 1, updatedAt: "2026-09-23T10:00:00Z" }] },
      "GET /api/ai/conversations/conv1": { id: "conv1", title: "Did I pay?", context: { searchQuery: "invoice" }, turns: [{ question: "Did I pay?", result: turn() }] },
      "POST /api/ai/ask": () => turn({ answer: "Follow-up answer", facts: [], inferences: [], missing: [] }),
    });
    renderWith(<AiView />, api, { path: "/ai?c=conv1" });
    const list = await screen.findByRole("region", { name: "AI conversations" });
    expect(within(list).getByRole("link", { name: /Did I pay\?/ })).toHaveAttribute("aria-current", "true");
    expect(within(list).getByRole("link", { name: /Overview of 2026-09-23/ })).toHaveAttribute("href", "/ai?c=conv2");
    const chat = screen.getByRole("region", { name: "AI chat" });
    expect(await within(chat).findByText("You paid the invoice on 24 September.")).toBeInTheDocument();
    expect(within(chat).getByText("Did I pay?", { selector: ".bubble" })).toBeInTheDocument();
    const u = userEvent.setup();
    const box = within(chat).getByRole("textbox", { name: "Ask about your records" });
    await u.type(box, "and who sent it?{Enter}");
    expect(await within(chat).findByText("Follow-up answer")).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === "/api/ai/ask")!.arg).toMatchObject({ question: "and who sent it?", conversationId: "conv1", context: { searchQuery: "invoice" } });
    expect(box).toHaveValue("");
    expect(within(chat).getAllByTestId("ai-answer")).toHaveLength(2);
  });

  it("Shift+Enter makes a new line instead of sending", async () => {
    const api = mockApi({ "GET /api/ai/settings": ON, "GET /api/ai/conversations": { items: [] } });
    renderWith(<AiView />, api, { path: "/ai" });
    const u = userEvent.setup();
    const box = await screen.findByRole("textbox", { name: "Ask about your records" });
    await u.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect(box).toHaveValue("line one\nline two");
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("with cloud AI off: a clear state with a link to Settings, history still readable, nothing sent", async () => {
    const api = mockApi({ "GET /api/ai/settings": OFF, "GET /api/ai/conversations": { items: [] } });
    renderWith(<AiView />, api, { path: "/ai" });
    expect(await screen.findByRole("heading", { name: "Cloud AI is off" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing leaves this Mac/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Settings › AI" })).toHaveAttribute("href", "/settings?section=ai");
    expect(screen.queryByRole("textbox", { name: "Ask about your records" })).toBeNull();
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("the drawer beside search runs an overview, then follow-ups keep the conversation and context (Q7)", async () => {
    const api = mockApi({
      "GET /api/facets": { devices: [], apps: [], accounts: [], conversations: [] },
      "GET /api/search": { q: "invoice", page: 1, pages: 1, total: 0, exactTotal: 0, fuzzyTotal: 0, tookMs: 1, counts: {}, items: [], groups: [], semantic: { enabled: false, label: "", items: [] } },
      "GET /api/ai/settings": ON,
      "POST /api/ai/overview": () => turn({ answer: "Overview text" }),
      "POST /api/ai/ask": () => turn({ answer: "Follow-up answer" }),
    });
    renderWith(<SearchView />, api, { path: "/?q=invoice&app=line" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "AI overview" }));
    const drawer = screen.getByRole("complementary", { name: "AI drawer" });
    expect(screen.getByTestId("search-summary")).toBeInTheDocument(); // the results stay
    await u.click(await within(drawer).findByRole("button", { name: "Overview of these results" }));
    expect(await within(drawer).findByText("Overview text")).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === "/api/ai/overview")!.arg.context).toEqual({ searchQuery: "invoice", filters: { app: "line" } });
    await u.type(within(drawer).getByRole("textbox", { name: "Ask about your records" }), "and who sent it?");
    await u.click(within(drawer).getByRole("button", { name: "Ask" }));
    expect(await within(drawer).findByText("Follow-up answer")).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === "/api/ai/ask")!.arg).toMatchObject({ question: "and who sent it?", conversationId: "conv1", context: { searchQuery: "invoice" } });
    await u.click(within(drawer).getByRole("button", { name: "Close AI drawer" }));
    expect(screen.queryByRole("complementary", { name: "AI drawer" })).toBeNull();
    expect(screen.getByTestId("search-summary")).toBeInTheDocument();
  });

  it("shows the service's refusal instead of an answer", async () => {
    const api = mockApi({ "GET /api/ai/settings": ON, "POST /api/ai/ask": () => { throw new ApiError(502, "ai_unlinked_facts", "The model's answer was rejected twice"); } });
    renderWith(<AiDrawer open onClose={() => undefined} context={{ date: "2026-09-24", timeline: true }} />, api);
    const u = userEvent.setup();
    await u.type(await screen.findByRole("textbox", { name: "Ask about your records" }), "what happened?{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/rejected twice/);
    expect(screen.queryByTestId("ai-answer")).toBeNull();
  });
});

describe("AI settings (A3)", () => {
  it("names what is sent, never shows the key, and loads models from the API", async () => {
    const api = mockApi({
      "GET /api/ai/settings": ON,
      "GET /api/ai/models": { models: ["gpt-5.5", "gpt-6-sol"], defaultModel: "gpt-5.5", embeddingModels: [] },
      "PUT /api/ai/settings": (b: unknown) => ({ ...ON, ...(b as object) }),
    });
    renderWith(<AiSettings />, api);
    expect(await screen.findByTestId("ai-what-is-sent")).toHaveTextContent("your question, and the passages and records the assistant retrieves while answering");
    expect(screen.getByRole("switch", { name: "Allow cloud AI processing (OpenAI API)" })).toBeChecked();
    const keyInput = screen.getByLabelText("OpenAI API key") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(keyInput.type).toBe("password");
    const model = await screen.findByRole("combobox", { name: "Model" });
    await waitFor(() => expect(within(model).getAllByRole("option").map((o) => o.textContent)).toEqual(["default: gpt-5.5", "gpt-5.5", "gpt-6-sol"]));
    const u = userEvent.setup();
    await u.type(keyInput, "sk-test-123456789012345678901234");
    await u.click(screen.getByRole("button", { name: "Save key" }));
    expect(api.calls.find((c) => c.method === "PUT")!.arg).toEqual({ apiKey: "sk-test-123456789012345678901234" });
    expect(keyInput.value).toBe("");
    await u.click(screen.getByRole("switch", { name: "Allow cloud AI processing (OpenAI API)" }));
    expect(api.calls.filter((c) => c.method === "PUT").at(-1)!.arg).toEqual({ cloudEnabled: false });
  });
});
