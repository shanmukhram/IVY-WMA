/**
 * Naming a paired device: the Devices page shows the name as the title (fingerprint beneath), Rename opens an
 * inline field that saves with Enter or Save, clears with an empty field, and shows a refused name plainly.
 * The sidebar entry, the scope chip and the Forget sheet title use the name once set; the Forget sheet still
 * asks for the fingerprint.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { act, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.tsx";
import { ApiError } from "../src/api.ts";
import { DevicesView } from "../src/views/Devices.tsx";
import { mockApi, renderWith } from "./helpers.tsx";
import { WIN, shellRoutes } from "./fixtures.ts";

const unlocked = { "GET /api/keystore": { state: "unlocked", fingerprint: "F", keyInMemory: true } };
const FP = "AAAA-BBBB-CCCC-DDDD";

/** A device list the PATCH route changes, as the service does. */
function namedRoutes() {
  const dev: { id: string; role: string; fingerprint: string; name: string | null; pairedAt: string } = { id: WIN, role: "windows", fingerprint: FP, name: null, pairedAt: "2026-10-01T00:00:00Z" };
  return {
    dev,
    routes: {
      "GET /api/devices": () => ({ macFingerprint: "MAC1-MAC2-MAC3-MAC4", devices: [{ ...dev }] }),
      [`PATCH /api/devices/${WIN}`]: (b: { name: string | null }) => {
        const v = b.name === null ? "" : b.name.trim();
        if (v.length > 60) throw new ApiError(400, "bad_value", "name must be at most 60 characters");
        dev.name = v || null;
        return { ...dev };
      },
    },
  };
}

describe("naming a device", () => {
  beforeEach(() => localStorage.clear());

  it("renaming updates the Devices title, the sidebar entry and the scope chip", async () => {
    const { routes } = namedRoutes();
    const api = mockApi({ ...shellRoutes, ...unlocked, ...routes });
    const { events } = renderWith(<App />, api, { path: `/devices?device=${WIN}` });
    const u = userEvent.setup();
    const nav = await screen.findByRole("navigation", { name: "Sidebar" });
    await u.click(within(nav).getByRole("button", { name: "Windows" }));
    const win = within(nav).getByRole("group", { name: "Windows" });

    // no name yet: the fingerprint everywhere
    expect(await screen.findByTestId(`device-title-${WIN}`)).toHaveTextContent(FP);
    expect(await within(win).findByRole("link", { name: `Windows device ${FP}` })).toBeInTheDocument();
    expect(await screen.findByTestId("scope-chip")).toHaveTextContent(`Showing: Windows · ${FP}`);

    await u.click(screen.getByRole("button", { name: `Rename ${FP}` }));
    await u.type(screen.getByLabelText("Device name"), "  Desk PC  {Enter}");
    expect(api.calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", path: `/api/devices/${WIN}`, arg: { name: "  Desk PC  " } });
    act(() => events.emit("device.renamed", { deviceId: WIN, name: "Desk PC" }));

    await waitFor(() => expect(screen.getByTestId(`device-title-${WIN}`)).toHaveTextContent("Desk PC"));
    expect(screen.getByText(FP)).toBeInTheDocument(); // the fingerprint stays beneath the name
    expect(screen.queryByLabelText("Device name")).toBeNull();
    await waitFor(() => expect(within(win).getByRole("link", { name: "Windows device Desk PC" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("scope-chip")).toHaveTextContent("Showing: Windows · Desk PC"));

    // the Forget sheet is titled with the name and still confirms with the fingerprint
    api.routes[`GET /api/devices/${WIN}/footprint`] = { deviceId: WIN, role: "windows", fingerprint: FP, name: "Desk PC", confirmWith: "fingerprint",
      counts: {}, shared: { messagesKept: 0, conversationsKept: 0 }, binRows: 0, cacheBytes: 0, leftInR2: { objects: 0, bytes: 0 } };
    await u.click(screen.getByRole("button", { name: "Forget…" }));
    const sheet = screen.getByRole("dialog", { name: "Forget device" });
    expect(sheet).toHaveTextContent("Forget Windows · Desk PC?");
    expect(await within(sheet).findByLabelText("Type the fingerprint to confirm")).toBeInTheDocument();
    expect(within(sheet).getByTestId("forget-fingerprint")).toHaveTextContent(FP);
  });

  it("Save clears the name with an empty field, and a refused name is explained", async () => {
    const { dev, routes } = namedRoutes();
    dev.name = "Desk PC";
    const api = mockApi(routes);
    renderWith(<DevicesView />, api, { path: "/devices" });
    const u = userEvent.setup();
    expect(await screen.findByTestId(`device-title-${WIN}`)).toHaveTextContent("Desk PC");

    await u.click(screen.getByRole("button", { name: "Rename Desk PC" }));
    const field = screen.getByLabelText("Device name");
    await u.clear(field);
    await u.type(field, "x".repeat(61));
    await u.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The name was not saved: name must be at most 60 characters.");
    expect(screen.getByTestId(`device-title-${WIN}`)).toHaveTextContent("Desk PC");

    await u.click(screen.getByRole("button", { name: "Clear" }));
    await u.click(screen.getByRole("button", { name: "Save" }));
    expect(api.calls.filter((c) => c.method === "PATCH").at(-1)!.arg).toEqual({ name: null });
    await waitFor(() => expect(screen.getByTestId(`device-title-${WIN}`)).toHaveTextContent(FP));
    expect(screen.queryByLabelText("Device name")).toBeNull();
  });
});
