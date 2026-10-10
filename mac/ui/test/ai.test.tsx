import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiDrawer, AiPanel, Answer, type AiTurn } from "../src/views/Ai.tsx";
import { AiSettings, ImportsCoverage } from "../src/views/AiSettings.tsx";
import { SearchView } from "../src/views/Search.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const rec = (over: Record<string, unknown>) => ({
  type: "message", id: "m1", deviceId: null, app: "line", eventTime: "2026-09-24T09:00:00.000Z", timeField: "sent_at", capturedAt: null,
  title: "Aki", body: "Did you pay the invoice?", person: "Aki", detail: { conversationId: "c1", platform: "line" }, ...over,
});
const turn = (over: Partial<AiTurn> = {}): AiTurn => ({
  conversationId: "conv1", model: "gpt-5.5",
  answer: "You paid the invoice on 24 September.",
  facts: [{ text: "Aki asked about the invoice", recordIds: ["m1"] }, { text: "A receipt screenshot exists", recordIds: ["s1"] }],
  inferences: [{ text: "The receipt is for that invoice", basis: "same amount" }],
  missing: ["No bank statement in the vault"],
  records: [rec({}), rec({ type: "screenshot", id: "s1", app: null, title: "/sdcard/shot.png", body: "receipt", detail: {} })] as never,
  toolCalls: [{ name: "search", summary: 'search "invoice": 2 match(es)' }],
  ...over,
});
const ON = { cloudEnabled: true, apiKeySet: true, embeddings: false, model: null, whatIsSent: "What would be sent to the OpenAI API: your question, and the passages and records the assistant retrieves while answering." };
const OFF = { ...ON, cloudEnabled: false };

describe("answer rendering (A2)", () => {
  it("facts carry record chips that open the record; inferences are separate; missing is listed", async () => {
    renderWith(<Answer t={turn()} question="Did I pay?" />, mockApi({}));
    const facts = screen.getByRole("region", { name: "Facts" });
    const chips = within(facts).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual([expect.stringMatching(/^message · 2026-09-24/), expect.stringMatching(/^screenshot · 2026-09-24/)]);
    expect(screen.queryByLabelText("Opened record")).toBeNull();
    await userEvent.setup().click(chips[0]!);
    const opened = screen.getByLabelText("Opened record");
    expect(within(opened).getByRole("link", { name: /Open thread at this message/ })).toHaveAttribute("href", "/conversations/c1?around=m1");
    const inf = screen.getByRole("region", { name: "Inferences" });
    expect(inf).toHaveTextContent(/inference.*The receipt is for that invoice.*basis: same amount/);
    expect(facts).not.toHaveTextContent("The receipt is for that invoice");
    expect(screen.getByRole("region", { name: "Missing information" })).toHaveTextContent("No bank statement in the vault");
    expect(screen.getByText(/2 linked record\(s\)/)).toBeInTheDocument();
  });
});

describe("AI panel", () => {
  it("with cloud AI off says nothing leaves the Mac and sends nothing", async () => {
    const api = mockApi({ "GET /api/ai/settings": OFF });
    renderWith(<AiPanel context={{ searchQuery: "invoice" }} overview />, api);
    expect(await screen.findByText(/Cloud AI is off/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing leaves this Mac/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Overview/ })).toBeNull();
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
    const ov = api.calls.find((c) => c.path === "/api/ai/overview")!;
    expect(ov.arg.context).toEqual({ searchQuery: "invoice", filters: { app: "line" } });
    await u.type(within(drawer).getByRole("textbox", { name: "Ask about your records" }), "and who sent it?");
    await u.click(within(drawer).getByRole("button", { name: "Ask" }));
    expect(await within(drawer).findByText("Follow-up answer")).toBeInTheDocument();
    const ask = api.calls.find((c) => c.path === "/api/ai/ask")!;
    expect(ask.arg).toMatchObject({ question: "and who sent it?", conversationId: "conv1", context: { searchQuery: "invoice" } });
    await u.click(within(drawer).getByRole("button", { name: "Close AI drawer" }));
    expect(screen.queryByRole("complementary", { name: "AI drawer" })).toBeNull();
    expect(screen.getByTestId("search-summary")).toBeInTheDocument();
  });

  it("shows the service's refusal instead of an answer", async () => {
    const { ApiError } = await import("../src/api.ts");
    const api = mockApi({ "GET /api/ai/settings": ON, "POST /api/ai/ask": () => { throw new ApiError(502, "ai_unlinked_facts", "The model's answer was rejected twice"); } });
    renderWith(<AiDrawer context={{ date: "2026-09-24", timeline: true }} />, api);
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "AI overview" }));
    await u.type(await screen.findByRole("textbox", { name: "Ask about your records" }), "what happened?");
    await u.click(screen.getByRole("button", { name: "Ask" }));
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
    expect(screen.getByText(/semantic search exists only through OpenAI|Compute embeddings/)).toBeInTheDocument();
  });
});

describe("coverage: imports row (S7)", () => {
  it("labels source-reported gaps apart from unknown days", () => {
    renderWith(<ImportsCoverage imports={[{
      name: "Activity Vault import", source: "activity_vault", status: "green", statusReason: "imported", location: "/av", lastRunAt: "2026-10-09T00:00:00Z", lastSuccessAt: "2026-10-09T00:00:01Z",
      rowsTotal: 5, lastRowsAdded: 2, gapWindowDays: 14, firstRowAt: "2026-10-01T00:00:00Z", captureReported: { healthy: null },
      gaps: [{ date: "2026-10-07", state: "gap", rows: 0, note: "the source reported a capture gap" }, { date: "2026-10-06", state: "unknown", rows: 0, note: "no rows; the source did not report on this day" }],
      captures: "Google activity",
    }]} />, mockApi({}));
    const row = screen.getByTestId("import-activity_vault");
    expect(row).toHaveTextContent(/2026-10-07 gap · the source reported a capture gap/);
    expect(row).toHaveTextContent(/2026-10-06 unknown · no rows/);
  });
});
