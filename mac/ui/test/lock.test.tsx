import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.tsx";
import { ApiError } from "../src/api.ts";
import { mockApi, renderWith } from "./helpers.tsx";

const shellRoutes = {
  "GET /api/stats": { counts: { messages: 0, notifications: 0, media: 0, files: 0, usage: 0, calls: 0 }, lastSync: [] },
  "GET /api/activity": { events: [] },
  "GET /api/facets": { devices: [], apps: [], accounts: [], conversations: [] },
};

describe("lock flow", () => {
  it("uninitialized: set passphrase, shows the salt backup note, then the dashboard", async () => {
    let state = "uninitialized";
    const api = mockApi({
      ...shellRoutes,
      "GET /api/keystore": () => ({ state, fingerprint: null, saltBackup: "Back up data/identity.json (it holds the identity salt)." }),
      "POST /api/keystore/initialize": (b: any) => { expect(b.passphrase).toBe("a long enough passphrase"); state = "unlocked"; return { fingerprint: "ABCD-EF01-2345-6789", saltBackup: "Back up data/identity.json now." }; },
    });
    renderWith(<App />, api);
    expect(await screen.findByRole("heading", { name: "Set a passphrase" })).toBeInTheDocument();
    expect(screen.getByText(/Back up data\/identity.json/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    const u = userEvent.setup();
    const [p1, p2] = screen.getAllByLabelText(/passphrase/i).filter((x) => x.tagName === "INPUT" && (x as HTMLInputElement).type === "password");
    await u.type(p1!, "a long enough passphrase");
    await u.type(p2!, "a different one");
    await u.click(screen.getByRole("button", { name: "Set passphrase" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("differ");
    await u.clear(p2!); await u.type(p2!, "a long enough passphrase");
    await u.click(screen.getByRole("button", { name: "Set passphrase" }));
    expect(await screen.findByText("ABCD-EF01-2345-6789")).toBeInTheDocument();
    expect(screen.getByText("Back up data/identity.json now.")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("navigation")).toBeInTheDocument();
  });

  it("locked: nothing but the passphrase field until unlocked; wrong passphrase shows the error", async () => {
    let state = "locked";
    const api = mockApi({
      ...shellRoutes,
      "GET /api/keystore": () => ({ state, fingerprint: "F", keyInMemory: false }),
      "POST /api/keystore/unlock": (b: any) => { if (b.passphrase !== "right one") throw new ApiError(401, "wrong_passphrase", "wrong passphrase"); state = "unlocked"; return { state }; },
    });
    renderWith(<App />, api);
    const field = await screen.findByLabelText("Passphrase");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("search")).toBeNull();
    const u = userEvent.setup();
    await u.type(field, "nope");
    await u.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("wrong passphrase");
    await u.clear(field); await u.type(field, "right one");
    await u.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("navigation")).toBeInTheDocument();
    expect(screen.getByRole("search")).toBeInTheDocument();
  });

  it("Lock offers screen-only and full; each sends the matching full flag", async () => {
    let state = "unlocked";
    const api = mockApi({
      ...shellRoutes,
      "GET /api/keystore": () => ({ state, fingerprint: "F", keyInMemory: true }),
      "POST /api/keystore/lock": () => { state = "locked"; return { state }; },
      "POST /api/keystore/unlock": () => { state = "unlocked"; return { state }; },
    });
    renderWith(<App />, api);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Lock" }));
    expect(screen.getByRole("menuitem", { name: /screen only/ })).toBeInTheDocument();
    await u.click(screen.getByRole("menuitem", { name: /Lock fully/ }));
    expect(await screen.findByRole("heading", { name: "IVY is locked" })).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === "/api/keystore/lock")!.arg).toEqual({ full: true });
    await u.type(screen.getByLabelText("Passphrase"), "x");
    await u.click(screen.getByRole("button", { name: "Unlock" }));
    await u.click(await screen.findByRole("button", { name: "Lock" }));
    await u.click(screen.getByRole("menuitem", { name: /screen only/ }));
    await screen.findByRole("heading", { name: "IVY is locked" });
    expect(api.calls.filter((c) => c.path === "/api/keystore/lock").map((c) => c.arg)).toEqual([{ full: true }, { full: false }]);
  });

  it("asks for the session token when the service answers 401", async () => {
    let authed = false;
    const api = mockApi({
      ...shellRoutes,
      "GET /api/keystore": () => { if (!authed) throw new ApiError(401, "unauthorized", "missing token"); return { state: "locked", fingerprint: "F" }; },
      "POST /api/session": (b: any) => { authed = b.token === "t0k"; return { ok: true }; },
    });
    renderWith(<App />, api);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Session token"), "t0k");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "IVY is locked" })).toBeInTheDocument());
  });
});
