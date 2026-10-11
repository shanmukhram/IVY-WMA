import { describe, it, expect } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowseView, crumbs, splitPath, fileStatus } from "../src/views/Browse.tsx";
import { mockApi, renderWith } from "./helpers.tsx";
import { WIN, now } from "./fixtures.ts";

const BROWSE = `GET /api/devices/${WIN}/browse`;
const SEARCH = `GET /api/devices/${WIN}/browse/search`;
const devices = { macFingerprint: "MAC", devices: [{ id: WIN, role: "windows" }] };

const file = (over: Record<string, unknown>) => ({ id: "f1", name: "boot.ini", path: "C:\\boot.ini", ext: "ini", size: 120, mtime: now, cached: false, inR2: false, ...over });

/** One browse tree keyed by the path the catalogue reports. */
const catalogue: Record<string, any> = {
  "": { folders: [{ name: "C:", path: "C:\\", fileCount: 3, totalBytes: 4096 }], files: [] },
  "C:\\": {
    folders: [{ name: "Users", path: "C:\\Users", fileCount: 2, totalBytes: 2048 }],
    files: [file({ id: "f1", name: "boot.ini", path: "C:\\boot.ini" })],
  },
  "C:\\Users": {
    folders: [],
    files: [
      file({ id: "f2", name: "notes.txt", path: "C:\\Users\\notes.txt", ext: "txt", cached: true }),
      file({ id: "f3", name: "photo.jpg", path: "C:\\Users\\photo.jpg", ext: "jpg", inR2: true }),
    ],
  },
};
const browse = (q: any) => catalogue[q.path ?? ""] ?? { folders: [], files: [] };

describe("browse PC: path helpers", () => {
  it("splits and rebuilds windows and unix paths", () => {
    expect(splitPath("C:\\Users\\bunny").sep).toBe("\\");
    expect(crumbs("C:\\Users\\bunny")).toEqual([
      { name: "C:", path: "C:\\" }, { name: "Users", path: "C:\\Users" }, { name: "bunny", path: "C:\\Users\\bunny" },
    ]);
    expect(crumbs("/home/bunny")).toEqual([{ name: "home", path: "/home" }, { name: "bunny", path: "/home/bunny" }]);
  });
  it("maps the catalogue flags to a status chip", () => {
    expect(fileStatus(file({ cached: false, inR2: false }), false).label).toBe("Not fetched");
    expect(fileStatus(file({ inR2: true }), false)).toEqual({ label: "In R2", tone: "blue" });
    expect(fileStatus(file({}), true)).toEqual({ label: "Cached", tone: "green" });
  });
});

describe("browse PC: tree and files", () => {
  it("lists drives at the root and prompts to pick a folder", async () => {
    renderWith(<BrowseView />, mockApi({ "GET /api/devices": devices, [BROWSE]: browse }), { path: "/device/windows/browse" });
    const tree = await screen.findByRole("tree", { name: "Folder tree" });
    expect(await within(tree).findByRole("button", { name: "C:" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pick a folder" })).toBeInTheDocument();
  });

  it("opening a folder lazily loads its children and files", async () => {
    const api = mockApi({ "GET /api/devices": devices, [BROWSE]: browse });
    renderWith(<BrowseView />, api, { path: "/device/windows/browse" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "C:" }));
    // right pane shows the files of C:\, the tree now shows the Users subfolder
    expect(await screen.findByText("boot.ini")).toBeInTheDocument();
    const tree = screen.getByRole("tree", { name: "Folder tree" });
    expect(within(tree).getByRole("button", { name: "Users" })).toBeInTheDocument();
    // the browse call carried the folder's exact path
    await waitFor(() => expect(api.calls.some((c) => c.path === `/api/devices/${WIN}/browse` && c.arg.path === "C:\\")).toBe(true));
    // breadcrumb reflects the current folder
    expect(within(screen.getByRole("navigation", { name: "Current folder" })).getByRole("button", { name: "C:" })).toBeInTheDocument();
  });

  it("shows the right status chip per file from the catalogue flags", async () => {
    const api = mockApi({ "GET /api/devices": devices, [BROWSE]: browse });
    renderWith(<BrowseView />, api, { path: "/device/windows/browse" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "C:" }));
    await u.click(await screen.findByRole("button", { name: "Users" }));
    const list = await screen.findByRole("list", { name: "Files" });
    expect(within(within(list).getByTestId("browse-file-f2")).getByText("Cached")).toBeInTheDocument();
    expect(within(within(list).getByTestId("browse-file-f3")).getByText("In R2")).toBeInTheDocument();
  });

  it("Fetch requests the original and the row flips to Cached with an Open link", async () => {
    const cmd = { id: "c1", fileId: "f1", status: "queued", display: "queued", waitingOn: "mac", detail: null, resultOid: null, progress: null };
    const api = mockApi({ "GET /api/devices": devices, [BROWSE]: browse, "POST /api/files/f1/request": { command: cmd } });
    const { events } = renderWith(<BrowseView />, api, { path: "/device/windows/browse" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "C:" }));
    const rowFetch = within(await screen.findByTestId("browse-file-f1")).getByRole("button", { name: "Fetch" });
    await u.click(rowFetch);
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/api/files/f1/request")).toBe(true);
    expect(await screen.findByTestId("browse-status-f1")).toHaveTextContent("queued on the Mac");
    act(() => events.emit("file.cached", { fileId: "f1", commandId: "c1" }));
    const row = screen.getByTestId("browse-file-f1");
    expect(within(row).getByText("Cached")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/api/files/f1/content");
  });

  it("Fetch folder confirms with count and size before requesting anything", async () => {
    const mk = (id: string) => ({ id, fileId: id, status: "queued", display: "queued", waitingOn: "mac", detail: null, resultOid: null, progress: null });
    const api = mockApi({
      "GET /api/devices": devices, [BROWSE]: browse,
      "POST /api/files/f2/request": { alreadyCached: true },
      "POST /api/files/f3/request": { command: mk("c3") },
    });
    renderWith(<BrowseView />, api, { path: "/device/windows/browse" });
    const u = userEvent.setup();
    // expand into Users so its folder entry is visible in C:
    await u.click(await screen.findByRole("button", { name: "C:" }));
    const tree = screen.getByRole("tree", { name: "Folder tree" });
    const usersRow = within(tree).getByRole("treeitem", { name: "Users" });
    await u.click(within(usersRow).getByRole("button", { name: "Fetch folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm fetch folder" });
    expect(dialog).toHaveTextContent(/2 file\(s\), 2.0 KB in total/);
    // nothing requested until confirmed
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    await u.click(within(dialog).getByRole("button", { name: /Fetch 2 file\(s\)/ }));
    // only the not-yet-cached file is requested (f3); the cached one (f2) is skipped
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/files/f3/request")).toBe(true));
    expect(api.calls.some((c) => c.path === "/api/files/f2/request")).toBe(false);
  });

  it("search uses the search endpoint and renders the hits", async () => {
    const api = mockApi({
      "GET /api/devices": devices, [BROWSE]: browse,
      [SEARCH]: (q: any) => ({ folders: [], files: q.q === "notes" ? [file({ id: "f2", name: "notes.txt", path: "C:\\Users\\notes.txt", cached: true })] : [] }),
    });
    renderWith(<BrowseView />, api, { path: "/device/windows/browse" });
    const u = userEvent.setup();
    await u.type(await screen.findByRole("searchbox", { name: "Search file names" }), "notes{Enter}");
    await waitFor(() => expect(api.calls.some((c) => c.path === `/api/devices/${WIN}/browse/search` && c.arg.q === "notes")).toBe(true));
    const results = await screen.findByRole("list", { name: "Search results" });
    expect(within(results).getByText("notes.txt")).toBeInTheDocument();
  });
});
