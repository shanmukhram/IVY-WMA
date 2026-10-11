/**
 * The conversation API carries sender identity and images: who sent each message
 * (fromMe, senderName), a bytes URL for cached image attachments, the chat avatar
 * on the list and profile, and a group roster. A simulated device sends a
 * message_batch (with fromMe/senderName and chatMeta.avatarBlobOid), an avatar blob
 * and an image-attachment blob over the s3-mock; the Mac serves exactly these shapes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { iso, PNG_1x1, type SimDevice } from "./helpers/device.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
afterEach(async () => { await st?.cleanup(); st = undefined; });

const msg = (over: Record<string, unknown>) => ({ sourceStatus: "live", attachments: [], ...over });

/** The one conversation's id, as the chat list reports it. */
async function chatId(s: Stack): Promise<string> {
  const r = await api(s.svc, "GET", "/api/views/chats?source=windows:telegram-desktop");
  return r.json.items[0].id as string;
}

describe("conversation views carry sender identity and images", () => {
  it("serves fromMe/senderName, a cached image attachment URL, the avatar and a group roster", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    const avatar = dev.blob(PNG_1x1, "avatar", 64);
    const att = dev.blob(PNG_1x1, "attachment", 64);
    await dev.putBlob(avatar);
    await dev.putBlob(att);
    await dev.put("message_batch", {
      platform: "telegram", account: "42", convKey: "-100", peer: "Robotics lab", convKind: "group",
      sourceSession: "windows:telegram-desktop", coverage: "complete", cursor: "3",
      chatMeta: { title: "Robotics lab", participantCount: 3, chatType: "supergroup", avatarBlobOid: avatar.oid },
      messages: [
        msg({ msgId: "1", sender: "7", senderName: "Kenji", sentAt: "2026-09-24T09:00:00.000Z", text: "first" }),
        msg({ msgId: "2", sender: "42", fromMe: true, senderName: "Bunny", sentAt: "2026-09-24T09:05:00.000Z", text: "mine",
          attachments: [{ attId: "a1", kind: "image", filename: "photo.png", size: PNG_1x1.length, blobOid: att.oid }] }),
      ],
    });
    await st.svc.ingester.poll();
    await st.svc.idle();

    const id = await chatId(st);

    // chat list: resolved title and an avatar URL
    const list = (await api(st.svc, "GET", "/api/views/chats?source=windows:telegram-desktop")).json.items[0];
    expect(list).toMatchObject({ title: "Robotics lab", platform: "telegram", source: "windows:telegram-desktop", messageCount: 2 });
    expect(list.avatarUrl).toBe(`/api/views/chats/${id}/avatar`);
    expect(list.lastText).toBe("mine");

    // the avatar URL serves the image bytes
    const av = await api(st.svc, "GET", list.avatarUrl);
    expect(av.status).toBe(200);
    expect(av.headers["content-type"]).toBe("image/png");
    expect(Number(av.headers["content-length"])).toBe(PNG_1x1.length);

    // thread: sender identity per message and an image URL on the cached attachment
    const thread = await api(st.svc, "GET", `/api/views/chats/${id}/messages`);
    expect(thread.status).toBe(200);
    const [m1, m2] = thread.json.messages as Array<Record<string, any>>;
    expect(m1).toMatchObject({ sender: "7", senderName: "Kenji", fromMe: false, text: "first", previewOnly: false });
    expect(m2).toMatchObject({ sender: "42", senderName: "Bunny", fromMe: true, text: "mine" });
    expect(m2.attachments[0]).toMatchObject({ kind: "image", filename: "photo.png", status: "cached" });
    expect(m2.attachments[0].imageUrl).toBe(`/api/attachments/${m2.attachments[0].id}/content`);

    const bytes = await api(st.svc, "GET", m2.attachments[0].imageUrl);
    expect(bytes.status).toBe(200);
    expect(bytes.headers["content-type"]).toBe("image/png");
    expect(Number(bytes.headers["content-length"])).toBe(PNG_1x1.length);

    // profile: the brief's fields and, for a group, a roster of distinct senders by name
    const prof = (await api(st.svc, "GET", `/api/views/chats/${id}/profile`)).json;
    expect(prof).toMatchObject({ title: "Robotics lab", platform: "telegram", account: "42", messageCount: 2 });
    expect(prof.avatarUrl).toBe(`/api/views/chats/${id}/avatar`);
    expect(prof.coverageText).toContain("windows:telegram-desktop");
    expect(prof.members).toEqual(expect.arrayContaining([{ name: "Kenji" }, { name: "Bunny" }]));
    dev.close();
  });

  it("keeps fromMe and senderName across a multi-source merge (never overwritten with null)", async () => {
    st = await fullStack();
    const win = await pairNew(st.svc, "windows");
    const and = await pairNew(st.svc, "android");
    const common = { platform: "telegram", account: "42", convKey: "u9", peer: "Aki", convKind: "dm" } as const;
    // the Windows session knows who sent it and the display name
    await win.put("message_batch", {
      ...common, sourceSession: "windows:telegram-desktop", coverage: "complete", cursor: "1",
      messages: [msg({ msgId: "m1", sender: "42", fromMe: true, senderName: "Bunny", sentAt: "2026-09-24T09:00:00.000Z", text: "hi Aki" })],
    });
    await st.svc.ingester.poll();
    // the Android database re-delivers the same message without fromMe or senderName
    await and.put("message_batch", {
      ...common, sourceSession: "android:root-db", coverage: "complete", cursor: "1",
      messages: [msg({ msgId: "m1", sender: "42", sentAt: "2026-09-24T09:00:00.000Z", text: "hi Aki" })],
    });
    await st.svc.ingester.poll();

    const id = (await api(st.svc, "GET", "/api/views/chats?platform=telegram")).json.items[0].id;
    const thread = await api(st.svc, "GET", `/api/views/chats/${id}/messages`);
    const m = thread.json.messages[0];
    expect(m).toMatchObject({ fromMe: true, senderName: "Bunny", text: "hi Aki" });
    // both sources are on the record
    expect((await api(st.svc, "GET", `/api/views/chats/${id}/profile`)).json.sources.map((s: { source: string }) => s.source))
      .toEqual(["android:root-db", "windows:telegram-desktop"]);
    win.close(); and.close();
  });

  it("serves the call object on the thread and the chat list, and a re-send fills it on an existing row", async () => {
    st = await fullStack();
    const win = await pairNew(st.svc, "windows");
    const common = { platform: "line", account: "uME", convKey: "uBOB", peer: "Bob", convKind: "dm",
      sourceSession: "windows:line-desktop", coverage: "partial" } as const;
    const sys = "LINE system call text";
    // as stored before the call field existed: mediaKind "location", no call
    await win.put("message_batch", {
      ...common, cursor: "1",
      messages: [msg({ msgId: "k1", sender: "uME", fromMe: true, sentAt: "2026-09-24T09:00:00.000Z", text: sys, mediaKind: "location" })],
    });
    await st.svc.ingester.poll();
    const id = (await api(st.svc, "GET", "/api/views/chats?platform=line")).json.items[0].id;
    expect((await api(st.svc, "GET", `/api/views/chats/${id}/messages`)).json.messages[0].call).toBeNull();

    // the one-time re-send carries the call; a new missed call arrives too
    await win.put("message_batch", {
      ...common, cursor: "2",
      messages: [
        msg({ msgId: "k1", sender: "uME", fromMe: true, sentAt: "2026-09-24T09:00:00.000Z", text: sys, mediaKind: "call",
          call: { kind: "video", outcome: "completed", durationSec: 155, direction: "outgoing" } }),
        msg({ msgId: "k2", sender: "uBOB", fromMe: false, sentAt: "2026-09-24T10:00:00.000Z", text: sys, mediaKind: "call",
          call: { kind: "audio", outcome: "missed", direction: "incoming" } }),
      ],
    });
    await st.svc.ingester.poll();

    const [k1, k2] = (await api(st.svc, "GET", `/api/views/chats/${id}/messages`)).json.messages as Array<Record<string, any>>;
    expect(k1).toMatchObject({ fromMe: true, text: sys, call: { kind: "video", outcome: "completed", durationSec: 155, direction: "outgoing" } });
    expect(k2.call).toEqual({ kind: "audio", outcome: "missed", direction: "incoming" });
    expect(st.svc.ctx.db.prepare("SELECT media_kind FROM messages WHERE msg_key = 'k1'").get()).toEqual({ media_kind: "call" });

    const list = (await api(st.svc, "GET", "/api/views/chats?platform=line")).json.items[0];
    expect(list.lastMessage).toMatchObject({ text: sys, mediaKind: "call", call: { kind: "audio", outcome: "missed", direction: "incoming" } });
    expect(list.lastMessage).not.toHaveProperty("call_kind");

    // a later copy without the call never clears it
    await win.put("message_batch", {
      ...common, cursor: "3",
      messages: [msg({ msgId: "k1", sender: "uME", fromMe: true, sentAt: "2026-09-24T09:00:00.000Z", text: sys })],
    });
    await st.svc.ingester.poll();
    expect((await api(st.svc, "GET", `/api/views/chats/${id}/messages`)).json.messages[0].call).toMatchObject({ kind: "video", durationSec: 155 });
    win.close();
  });
});
