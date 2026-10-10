import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchView } from "../src/views/Search.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const WIN = "11111111-2222-3333-4444-555555555555";
const item = (over: Record<string, unknown>) => ({
  type: "file", id: "f1", deviceId: WIN, app: null, eventTime: "2026-09-23T09:00:00.000Z", timeField: "mtime", capturedAt: "2026-10-01T10:00:00.000Z",
  title: "Robotics Collaboration Offer.pdf", body: "C:\\Docs\\Robotics Collaboration Offer.pdf", person: null, match: "exact", typos: 0,
  snippetHtml: "C:\\Docs\\Robotics <mark>Collab</mark>oration Offer.pdf", detail: { availability: "reference", size: 10, name: "Robotics Collaboration Offer.pdf" }, ...over,
});
function result(page: number, semantic = false) {
  return {
    q: "collab", page, pageSize: 25, pages: 3, total: 60, exactTotal: 58, fuzzyTotal: 2, tookMs: 3,
    counts: { file: { exact: 1, fuzzy: 0 }, message: { exact: 57, fuzzy: 2 } },
    items: [
      item({}),
      item({ type: "message", id: "m1", app: "line", title: "Aki", person: "Aki", eventTime: "2026-09-24T09:00:00.000Z", timeField: "sent_at",
        snippetHtml: "the <mark>collab</mark> offer", detail: { conversationId: "c1", platform: "line", account: "bunny@line", attachments: 0 } }),
      item({ type: "message", id: "m2", match: "fuzzy", typos: 1, app: "telegram", title: "Ben", snippetHtml: "<mark>colab</mark>", detail: { conversationId: "c2", platform: "telegram", account: "@bunny" } }),
    ],
    groups: [], semantic: semantic ? { enabled: true, label: "Semantic matches", items: [] } : { enabled: false, label: "Semantic matches (not enabled)", items: [] },
  };
}

describe("search", () => {
  it("renders passages with highlights and source chips, exact first, close matches after a divider, no semantic divider while off", async () => {
    const api = mockApi({
      "GET /api/facets": { devices: [{ id: WIN, role: "windows" }], apps: ["line"], accounts: ["bunny@line"], conversations: [] },
      "GET /api/search": (q: any) => result(Number(q.page)),
    });
    const { container } = renderWith(<SearchView />, api, { path: "/?q=collab" });
    expect(await screen.findByTestId("search-summary")).toHaveTextContent("60 matches · 58 exact · 2 close");
    const marks = container.querySelectorAll("mark");
    expect([...marks].map((m) => m.textContent)).toEqual(["Collab", "collab", "colab"]);
    const rows = screen.getAllByRole("article");
    expect(rows[0]).toHaveAttribute("data-type", "file");
    expect(within(rows[0]!).getByText(/^windows 11111111/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/reference only/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("line")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("bunny@line")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("link", { name: /Open thread/ })).toHaveAttribute("href", "/conversations/c1?around=m1");
    const divider = screen.getByRole("heading", { name: /Close matches/ });
    expect(divider.compareDocumentPosition(rows[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(rows[1]!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Semantic matches/ })).toBeNull();
    // original time shown, capture time on hover
    expect(rows[0]!.querySelector("time")!.getAttribute("title")).toMatch(/original time \(mtime\)[\s\S]*captured/);

    await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/search").at(-1)!.arg.page).toBe(2));
  });

  it("shows the semantic divider only when the API reports semantic support", async () => {
    const api = mockApi({ "GET /api/facets": { devices: [], apps: [], accounts: [], conversations: [] }, "GET /api/search": () => result(1, true) });
    renderWith(<SearchView />, api, { path: "/?q=collab" });
    expect(await screen.findByRole("heading", { name: "Semantic matches" })).toBeInTheDocument();
  });

  it("filters go to the API", async () => {
    const api = mockApi({ "GET /api/facets": { devices: [], apps: [], accounts: [], conversations: [] }, "GET /api/search": () => result(1) });
    renderWith(<SearchView />, api, { path: "/?q=collab" });
    await screen.findByTestId("search-summary");
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText("Device"), "android");
    await u.click(screen.getByRole("checkbox", { name: /photo/ }));
    await waitFor(() => expect(api.calls.at(-1)!.arg).toMatchObject({ q: "collab", device: "android", type: "photo" }));
  });
});
