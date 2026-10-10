import { describe, it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationsView, isMine, looksLikeId } from "../src/views/Conversations.tsx";
import { hashColor, initials } from "../src/components/Avatar.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const ME = "5521004";
const sources = [{ source: "windows:telegram-desktop", coverage: "complete" }, { source: "android:notification", coverage: "partial" }];
const chat = (id: string, peer: string, last: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id, platform: "telegram", account: ME, convKey: `k-${id}`, peer, kind: "group", coverage: "complete", coverageSources: sources,
  coverageText: "complete via windows:telegram-desktop; partial via android:notification",
  messageCount: 5, firstMessageAt: "2026-10-08T09:00:00.000Z", lastMessageAt: last.sentAt, lastMessage: { id: "x", text: "", ...last }, ...over,
});
const msg = (id: string, sender: string, sent: string, text: string, over: Record<string, unknown> = {}) => ({
  id, msg_key: id, sender, sent_at: sent, captured_at: "2026-10-10T00:00:00Z", text, text_quality: "full", reply_to: null, edited_at: null,
  source_status: "live", source_deleted_at: null, forwarded_from: null, media_kind: null, sources: [{ source: "windows:telegram-desktop", deletedAtSource: null }], ...over,
});

function routes() {
  return {
    "GET /api/views/chats": { total: 2, page: 1, pages: 1, items: [
      chat("c1", "Robotics lab", { sender: ME, sentAt: "2026-10-09T10:15:00.000Z", text: "See you Thursday" }),
      chat("c2", "Aiko Tanaka", { sender: "77", sentAt: "2026-10-08T08:00:00.000Z", text: "Standup moved" }, { kind: "dm" }),
    ] },
    // the view thread route serves camelCase and inline attachments; the component also reads the
    // legacy snake_case fields, so this fixture mixes both to prove the defensive mapping
    "GET /api/views/chats/c1/messages": { around: null, conversation: { ...chat("c1", "Robotics lab", {}), conv_key: "k-c1", participantCount: 14 }, messages: [
      msg("m1", "Kenji", "2026-10-08T18:00:00.000Z", "Draft is ready"),
      msg("m2", ME, "2026-10-08T18:05:00.000Z", "Great", { edited_at: "2026-10-08T18:06:00.000Z" }),
      msg("m3", "Kenji", "2026-10-09T09:31:00.000Z", "Deadline is Thursday", { reply_to: "m2" }),
      msg("m4", "Mika", "2026-10-09T09:40:00.000Z", "Budget sheet", { forwarded_from: "Finance office", attachments: [{ id: "a1", kind: "doc", filename: "budget.xlsx", status: "on_demand" }] }),
      msg("m5", "Aiko", "2026-10-09T10:00:00.000Z", "(removed)", { source_status: "deleted_at_source", sources: [{ source: "windows:telegram-desktop", deletedAtSource: null }, { source: "android:notification", deletedAtSource: "2026-10-09T10:20:00Z" }] }),
      msg("m6", "Aiko", "2026-10-09T10:05:00.000Z", "preview text", { text_quality: "preview", reply_to: "gone" }),
    ] },
    "GET /api/attachments": { items: [] },
    "GET /api/views/chats/c1/profile": {
      conversation: { ...chat("c1", "Robotics lab", {}), chatType: "supergroup", participantCount: 14 }, messages: 6, firstMessageAt: "2026-10-08T18:00:00.000Z", lastMessageAt: "2026-10-09T10:05:00.000Z",
      edited: 1, deletedAtSource: 1, previewOnly: 1, attachments: { on_demand: 1 },
      sources: [{ source: "android:notification", coverage: "partial", messages: 1, deletedThere: 1 }, { source: "windows:telegram-desktop", coverage: "complete", messages: 6, deletedThere: 0 }],
      senders: [{ sender: "Kenji", n: 2 }, { sender: ME, n: 1 }],
    },
    "GET /api/views/chats/c2/messages": { around: null, conversation: { ...chat("c2", "Aiko Tanaka", {}, { kind: "dm" }), conv_key: "k-c2" }, messages: [msg("d1", "77", "2026-10-08T08:00:00.000Z", "Standup moved")] },
    "GET /api/views/chats/c2/profile": { conversation: chat("c2", "Aiko Tanaka", {}, { kind: "dm" }), messages: 1, firstMessageAt: null, lastMessageAt: null, edited: 0, deletedAtSource: 0, attachments: {}, sources: [], senders: [] },
  };
}

describe("conversations: two panes, profile on demand", () => {
  it("chats with avatars and previews | the chat in bubbles with sides | the profile behind a click", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());
    const { container } = renderWith(<ConversationsView />, api, { path: "/conversations?source=windows:telegram-desktop&platform=telegram" });
    await waitFor(() => expect(api.calls[0]).toMatchObject({ path: "/api/views/chats", arg: { source: "windows:telegram-desktop", platform: "telegram" } }));

    // the Telegram accent is applied around the open conversation only
    await waitFor(() => expect(container.querySelector(".panes")!.className).toContain("conv-telegram"));

    // pane 1: chats
    const chats = await screen.findByRole("region", { name: "Chats" });
    expect(within(chats).getByRole("heading", { name: "Telegram · Windows" })).toBeInTheDocument();
    const items = await within(chats).findAllByTestId("chat-item");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("aria-current", "true"); // the newest chat opens first
    expect(items[0]!.querySelector(".avatar")!.textContent).toBe("RL");
    expect(items[0]).toHaveTextContent("You: See you Thursday");
    expect(items[1]!.querySelector(".avatar")!.textContent).toBe("AT");
    expect(items[1]).toHaveTextContent("Standup moved");

    // pane 2: bubbles, mine on the right and theirs on the left
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("Draft is ready");
    const bubbles = within(log).getAllByTestId("message");
    expect(bubbles.map((b) => b.getAttribute("data-mine"))).toEqual(["false", "true", "false", "false", "false", "false"]);
    expect(bubbles[1]).toHaveClass("mine");
    expect(bubbles[0]).toHaveClass("theirs");
    expect(within(log).getAllByRole("separator")).toHaveLength(2); // one date separator per day
    expect(within(bubbles[1]!).getByText("edited")).toBeInTheDocument();
    expect(within(bubbles[2]!).getByTestId("reply-quote")).toHaveTextContent("YouGreat"); // quoting my message
    expect(within(bubbles[3]!).getByText(/Forwarded from Finance office/)).toBeInTheDocument();
    expect(await within(bubbles[3]!).findByTestId("attachment")).toHaveTextContent(/budget.xlsx.*on device \(on demand\)/);
    expect(within(bubbles[4]!).getByText("deleted at source (kept in vault)")).toBeInTheDocument();
    expect(within(bubbles[4]!).getByText(/via windows:telegram-desktop, android:notification \(deleted there\)/)).toBeInTheDocument();
    expect(within(bubbles[5]!).getByText("notification preview only")).toBeInTheDocument();
    expect(within(bubbles[5]!).getByTestId("reply-quote")).toHaveTextContent("Reply to an earlier message");
    // sent and capture time on hover
    expect(bubbles[0]!.querySelector("time")!.getAttribute("title")).toMatch(/sent: .*\ncaptured: /);
    // group senders are named over their bubbles
    expect(within(bubbles[0]!).getByRole("button", { name: "Kenji" })).toBeInTheDocument();
    // coverage badge with every source's claim
    expect(screen.getByTestId("coverage-sources")).toHaveAttribute("title", "complete via windows:telegram-desktop; partial via android:notification");

    // the profile is not a permanent pane
    expect(screen.queryByRole("complementary", { name: "Profile" })).toBeNull();

    // pane 3: the profile opens from the header, as a slide-over
    await user.click(screen.getByRole("button", { name: "About Robotics lab" }));
    const profile = await screen.findByRole("complementary", { name: "Profile" });
    expect(await within(profile).findByRole("heading", { name: "Robotics lab" })).toBeInTheDocument();
    expect(profile).toHaveTextContent("Telegram · group · 14 members");
    const perSource = within(profile).getAllByTestId("profile-source");
    expect(perSource.map((p) => p.textContent)).toEqual([
      expect.stringMatching(/Android · Notification.*Partial.*1 message\(s\) · 1 deleted there/),
      expect.stringMatching(/Windows · Telegram Desktop.*Complete.*6 message\(s\)/),
    ]);
    expect(profile).toHaveTextContent(/Messages\s*6/);
    expect(profile).toHaveTextContent(`${ME} (you)`);

    // Esc closes the profile
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Profile" })).toBeNull());

    // another chat
    await user.click(items[1]!);
    expect(await within(await screen.findByRole("log", { name: "Messages" })).findByText("Standup moved")).toBeInTheDocument();
    expect(location.search).toContain("chat=c2");
  });

  it("uses the API's own names, sides, avatars and inline images when present", async () => {
    const user = userEvent.setup();
    const lineSources = [{ source: "windows:line-desktop", coverage: "partial" }];
    const lineChat = {
      id: "n1", platform: "line", account: ME, convKey: "k-n1", peer: null, title: "Beach trip", avatarUrl: "https://ex/room.png",
      kind: "group", coverage: "partial", coverageSources: lineSources, coverageText: "partial via windows:line-desktop", source: "windows:line-desktop",
      messageCount: 3, lastText: "Kenji: sent a photo", lastAt: "2026-10-09T10:00:00.000Z", lastMessageAt: "2026-10-09T10:00:00.000Z", lastMessage: null,
    };
    const nmsg = (id: string, sender: string, text: string, over: Record<string, unknown> = {}) =>
      msg(id, sender, "2026-10-09T10:00:00.000Z", text, { sentAt: "2026-10-09T10:00:00.000Z", sources: [{ source: "windows:line-desktop", deletedAtSource: null }], ...over });
    const api = mockApi({
      "GET /api/views/chats": { total: 1, page: 1, pages: 1, items: [lineChat] },
      "GET /api/views/chats/n1/messages": { around: null, conversation: { ...lineChat, conv_key: "k-n1", participantCount: 3 }, messages: [
        nmsg("x1", "someone-else", "I'll bring the cooler", { fromMe: true, senderName: "Me" }),
        nmsg("x2", "u15614381002", "Who else is in?", { senderAvatarUrl: "https://ex/u2.png" }),
        nmsg("x3", "u15614381003", "", { senderName: "Kenji" }),
      ] },
      "GET /api/attachments": { items: [
        { id: "im1", messageId: "x3", kind: "image", filename: "beach.jpg", imageUrl: "https://ex/beach.jpg", status: "cached" },
        { id: "doc1", messageId: "x3", kind: "doc", filename: "plan.pdf", status: "indexed" },
      ] },
      "GET /api/views/chats/n1/profile": { conversation: { ...lineChat, participantCount: 3 }, title: "Beach trip", avatarUrl: "https://ex/room.png",
        messageCount: 3, firstAt: "2026-10-09T09:00:00.000Z", lastAt: "2026-10-09T10:00:00.000Z", edited: 0, deletedAtSource: 0, attachments: { cached: 1 },
        members: [{ id: "u15614381002", name: "Aiko", avatarUrl: "https://ex/u2.png" }, { id: "u15614381003", name: "Kenji" }],
        sources: [{ source: "windows:line-desktop", coverage: "partial", messages: 3, deletedThere: 0 }], senders: [] },
    });
    const { container } = renderWith(<ConversationsView />, api, { path: "/conversations?source=windows:line-desktop&platform=line" });

    // LINE accent around the open conversation
    await waitFor(() => expect(container.querySelector(".panes")!.className).toContain("conv-line"));

    const log = await screen.findByRole("log", { name: "Messages" });
    const bubbles = await within(log).findAllByTestId("message");
    // an explicit fromMe flag puts a message on the right even when the sender is not the account id
    expect(bubbles[0]!.getAttribute("data-mine")).toBe("true");
    expect(bubbles[1]!.getAttribute("data-mine")).toBe("false");
    // a raw id shows muted; a real display name shows plainly
    const idSender = within(bubbles[1]!).getByRole("button", { name: "u15614381002" });
    expect(idSender).toHaveClass("is-id");
    expect(within(bubbles[2]!).getByRole("button", { name: "Kenji" })).not.toHaveClass("is-id");

    // an inline image opens a lightbox; a non-image attachment stays a chip
    const thumb = await within(bubbles[2]!).findByTestId("attachment-image");
    expect(within(thumb).getByRole("img", { name: "beach.jpg" })).toBeInTheDocument();
    expect(within(bubbles[2]!).getByTestId("attachment")).toHaveTextContent("plan.pdf");
    await user.click(thumb);
    const viewer = await screen.findByRole("dialog", { name: "Image: beach.jpg" });
    expect(within(viewer).getByRole("img", { name: "beach.jpg" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Image: beach.jpg" })).toBeNull());

    // the chat list and header carry the room's avatar image
    const chats = screen.getByRole("region", { name: "Chats" });
    expect(within(chats).getByRole("button", { name: /Beach trip/ }).querySelector("img.avatar")).toHaveAttribute("src", "https://ex/room.png");

    // the profile lists named members with their photos
    await user.click(screen.getByRole("button", { name: "About Beach trip" }));
    const profile = await screen.findByRole("complementary", { name: "Profile" });
    expect(within(profile).getByRole("img", { name: "Beach trip avatar" })).toHaveAttribute("src", "https://ex/room.png");
    expect(within(profile).getByText("Members")).toBeInTheDocument();
    expect(within(profile).getByText("Aiko")).toBeInTheDocument();
    expect(within(profile).getByText("Kenji")).toBeInTheDocument();
  });

  it("opens a chat at a message from search", async () => {
    const r = routes();
    const api = mockApi({ ...r, "GET /api/views/chats/c1/messages": (q: any) => ({ ...r["GET /api/views/chats/c1/messages"], around: q.around }) });
    renderWith(<ConversationsView />, api, { path: "/conversations?chat=c1&around=m3" });
    expect(await screen.findByTestId("thread-hit")).toHaveTextContent("Deadline is Thursday");
    expect(api.calls.find((c) => c.path === "/api/views/chats/c1/messages")!.arg).toMatchObject({ around: "m3" });
  });

  it("an empty source says what will fill it", async () => {
    renderWith(<ConversationsView />, mockApi({ "GET /api/views/chats": { total: 0, page: 1, pages: 1, items: [] } }), { path: "/conversations" });
    expect(await screen.findByText(/Conversation history comes from the Windows app/)).toBeInTheDocument();
    expect(screen.getByText("No chat selected")).toBeInTheDocument();
  });

  it("helpers: mine, ids, initials, stable colors", () => {
    expect(isMine(ME, ME)).toBe(true);
    expect(isMine("Me", "bunny")).toBe(true);
    expect(isMine("Kenji", ME)).toBe(false);
    expect(looksLikeId("u15614381002")).toBe(true);
    expect(looksLikeId("5521004")).toBe(true);
    expect(looksLikeId("Kenji")).toBe(false);
    expect(initials("Robotics lab")).toBe("RL");
    expect(initials("Aki")).toBe("A");
    expect(initials("🙂")).toBe("#");
    expect(hashColor("Aki")).toBe(hashColor("Aki"));
  });
});
