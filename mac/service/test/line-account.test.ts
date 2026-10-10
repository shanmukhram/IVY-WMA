/**
 * The LINE settings page is served from the user's own line_account snapshot. A simulated Windows
 * device (built only with @ivy/protocol, over the s3-mock) uploads an avatar blob, a LINE
 * conversation and a line_account with a profile, two contacts (one with a picture, none blocked)
 * and a hidden chat option plus settings. The Mac serves exactly the shapes the settings page reads,
 * and a re-ingested snapshot that drops a contact removes it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { PNG_1x1, type SimDevice } from "./helpers/device.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
afterEach(async () => { await st?.cleanup(); st = undefined; });

const ACCOUNT = "bunny";

/** The full snapshot used by most assertions (two contacts, one hidden chat, two settings). */
function snapshot(avatarOid: string, contacts: Array<Record<string, unknown>>) {
  return {
    account: ACCOUNT,
    ownProfile: { mid: "u-self", displayName: "Me", userId: "uid-1", statusMessage: "hello", picturePath: avatarOid },
    contacts,
    chatOptions: [
      { chatId: "c-aki", hidden: true, notification: false, pinned: true },
      { chatId: "c-other", hidden: false },
    ],
    settings: [
      { key: "theme", value: "dark" },
      { key: "notification.enabled", value: "true" },
    ],
  };
}

async function seedLineConversation(dev: SimDevice, avatarOid: string) {
  await dev.put("message_batch", {
    platform: "line", account: ACCOUNT, convKey: "c-aki", peer: "Aki", convKind: "dm",
    sourceSession: "windows:line-desktop", coverage: "complete", cursor: "1",
    chatMeta: { title: "Aki", avatarBlobOid: avatarOid },
    messages: [{ msgId: "1", sender: "u-aki", sentAt: "2026-09-24T09:00:00.000Z", text: "hi", sourceStatus: "live", attachments: [] }],
  });
}

describe("LINE account settings views", () => {
  it("serves the account, contacts, hidden chats and settings, with a linked picture", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");

    // the avatar blob lands first so the line_account snapshot can link the picture at commit time
    const avatar = dev.blob(PNG_1x1, "avatar", 64);
    await dev.putBlob(avatar);
    await st.svc.ingester.poll();
    await st.svc.idle();

    await seedLineConversation(dev, avatar.oid);
    await dev.put("line_account", snapshot(avatar.oid, [
      { mid: "u-aki", displayName: "Aki", status: "NORMAL", type: "FRIEND", settings: 0, statusMessage: "hey there", picturePath: avatar.oid, thumbnailUrl: "https://ex/thumb" },
      { mid: "u-ken", displayName: "Ken", status: "NORMAL", type: "FRIEND", settings: 1 },
    ]));
    await st.svc.ingester.poll();
    await st.svc.idle();

    // account: profile + counts (no blocked contacts for this user)
    const acct = await api(st.svc, "GET", "/api/views/line/account");
    expect(acct.status).toBe(200);
    expect(acct.json).toMatchObject({
      account: ACCOUNT,
      profile: { mid: "u-self", displayName: "Me", userId: "uid-1", statusMessage: "hello" },
      counts: { contacts: 2, hidden: 1, blocked: 0, settings: 2 },
    });
    expect(acct.json.profile.avatarUrl).toBe(`/api/views/line/profile/avatar?account=${ACCOUNT}`);

    // contacts: all, with the raw store status/settings and blocked unknown (null)
    const all = await api(st.svc, "GET", "/api/views/line/contacts");
    expect(all.json.map((c: { mid: string }) => c.mid)).toEqual(["u-aki", "u-ken"]);
    expect(all.json[0]).toMatchObject({ mid: "u-aki", displayName: "Aki", status: "NORMAL", type: "FRIEND", settings: 0, blocked: null, statusMessage: "hey there" });
    expect(all.json[0].avatarUrl).toBe(`/api/views/line/contacts/u-aki/avatar?account=${ACCOUNT}`);
    expect(all.json[1].avatarUrl).toBe(null);

    // blocked filter: empty (nothing resolved blocked)
    expect((await api(st.svc, "GET", "/api/views/line/contacts?filter=blocked")).json).toEqual([]);

    // the contact picture serves the linked image bytes
    const pic = await api(st.svc, "GET", all.json[0].avatarUrl);
    expect(pic.status).toBe(200);
    expect(pic.headers["content-type"]).toBe("image/png");
    expect(Number(pic.headers["content-length"])).toBe(PNG_1x1.length);

    // hidden chats: one row, joined to the conversation for a title and avatar
    const hidden = await api(st.svc, "GET", "/api/views/line/hidden");
    expect(hidden.json.length).toBe(1);
    expect(hidden.json[0]).toMatchObject({ chatId: "c-aki", title: "Aki", lastAt: "2026-09-24T09:00:00.000Z" });
    expect(hidden.json[0].avatarUrl).toMatch(/^\/api\/views\/chats\/.+\/avatar$/);

    // settings: sorted by key
    expect((await api(st.svc, "GET", "/api/views/line/settings")).json).toEqual([
      { key: "notification.enabled", value: "true" },
      { key: "theme", value: "dark" },
    ]);
  });

  it("drops a contact removed from a later snapshot", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    const avatar = dev.blob(PNG_1x1, "avatar", 64);
    await dev.putBlob(avatar);
    await st.svc.ingester.poll();
    await st.svc.idle();

    await seedLineConversation(dev, avatar.oid);
    await dev.put("line_account", snapshot(avatar.oid, [
      { mid: "u-aki", displayName: "Aki", type: "FRIEND" },
      { mid: "u-ken", displayName: "Ken", type: "FRIEND" },
    ]));
    await st.svc.ingester.poll();
    await st.svc.idle();
    expect((await api(st.svc, "GET", "/api/views/line/contacts")).json.length).toBe(2);

    // a later snapshot without Ken
    await dev.put("line_account", snapshot(avatar.oid, [{ mid: "u-aki", displayName: "Aki", type: "FRIEND" }]));
    await st.svc.ingester.poll();
    await st.svc.idle();
    const after = await api(st.svc, "GET", "/api/views/line/contacts");
    expect(after.json.map((c: { mid: string }) => c.mid)).toEqual(["u-aki"]);
    expect((await api(st.svc, "GET", "/api/views/line/account")).json.counts.contacts).toBe(1);
  });

  it("is locked like every other content route", async () => {
    st = await fullStack();
    await api(st.svc, "POST", "/api/keystore/lock", { full: false });
    expect((await api(st.svc, "GET", "/api/views/line/account")).status).toBe(423);
  });
});
