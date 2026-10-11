/**
 * Catalog browse-and-fetch-on-demand (PROTOCOL file_meta.catalogOnly; migration v9).
 *
 * The Windows catalog collector emits metadata-only file_meta (no blob, no hash) for the whole PC so
 * the Mac can browse everything and fetch any file's bytes on demand. Catalog entries are stored as
 * catalog rows (status 'catalog') and kept out of the normal files list, search and timeline until
 * they are fetched; a fetch issues a file_request, and once the original lands it caches locally,
 * persists in R2, and the file appears normally.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { iso, type SimDevice } from "./helpers/device.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let st: Stack | undefined;
afterEach(async () => { await st?.cleanup(); st = undefined; });

const db = () => st!.svc.ctx.db;

/** A catalog (metadata-only) file_meta: name/ext derived from the Windows path, no quickHash. */
async function catalog(dev: SimDevice, path: string, size: number, mtime = iso()) {
  const name = path.split("\\").pop()!;
  await dev.put("file_meta", { path, name, ext: name.split(".").pop()!, size, mtime, catalogOnly: true });
}

/** The tree used across the tests: two drives, nested folders. */
const TREE: Array<[string, number]> = [
  ["C:\\Users\\bunny\\Documents\\taxes\\2025.pdf", 1200],
  ["C:\\Users\\bunny\\Documents\\taxes\\2024.pdf", 1100],
  ["C:\\Users\\bunny\\Documents\\resume.docx", 40],
  ["C:\\Users\\bunny\\Pictures\\beach.png", 900],
  ["C:\\Program Files\\app\\readme.txt", 10],
  ["D:\\media\\clip.mp4", 5000],
  ["D:\\media\\raw\\shot.cr2", 8000],
];

async function seed(s: Stack): Promise<SimDevice> {
  const dev = await pairNew(s.svc, "windows");
  for (const [p, size] of TREE) await catalog(dev, p, size);
  await s.svc.ingester.poll();
  return dev;
}

const browse = async (s: Stack, dev: SimDevice, path?: string) =>
  (await api(s.svc, "GET", `/api/devices/${dev.deviceId}/browse${path !== undefined ? `?path=${encodeURIComponent(path)}` : ""}`)).json as
    { path: string | null; folders: Array<{ name: string; path: string; fileCount: number; totalBytes: number }>; files: Array<{ id: string; name: string; path: string; ext: string; size: number; mtime: string; cached: boolean; inR2: boolean }>; nextCursor: string | null };

describe("catalog ingest and exclusion from normal views (migration v9)", () => {
  it("stores catalogOnly file_meta as catalog rows, out of the files list, search and timeline", async () => {
    st = await fullStack();
    const dev = await seed(st);

    // every tree entry is a catalog row with no blob, no local copy, status 'catalog'
    const rows = db().prepare("SELECT status, catalog, local_path, quick_hash FROM files").all() as Array<{ status: string; catalog: number; local_path: string | null; quick_hash: string | null }>;
    expect(rows).toHaveLength(TREE.length);
    for (const r of rows) expect(r).toMatchObject({ status: "catalog", catalog: 1, local_path: null, quick_hash: null });

    // the main files list excludes catalog entries
    const list = (await api(st.svc, "GET", "/api/files")).json;
    expect(list.total).toBe(0);
    expect(list.items).toEqual([]);

    // search does not return a catalog entry by name...
    expect((await api(st.svc, "GET", "/api/search?q=resume&type=file")).json.items).toEqual([]);
    expect((await api(st.svc, "GET", "/api/search?q=2025&type=file")).json.items).toEqual([]);
    // ...and the timeline excludes them too
    const day = iso().slice(0, 10);
    const tl = (await api(st.svc, "GET", `/api/timeline?date=${day}&type=file`)).json;
    expect(tl.counts.file ?? 0).toBe(0);

    // stats and coverage count collected content only (no catalog), but report the catalog size
    expect((await api(st.svc, "GET", "/api/stats")).json.counts.files).toBe(0);
    const cov = (await api(st.svc, "GET", "/api/coverage")).json;
    const devCov = cov.devices.find((d: { deviceId: string }) => d.deviceId === dev.deviceId);
    expect(devCov.counts.files).toBe(0);
    expect(devCov.counts.catalog).toBe(TREE.length);

    const status = (await api(st.svc, "GET", "/api/ingest/status")).json;
    expect(status.catalog.count).toBe(TREE.length);
    expect(status.catalog.bytes).toBe(TREE.reduce((n, [, s]) => n + s, 0));
    expect(status.catalog.byDevice[0]).toMatchObject({ deviceId: dev.deviceId, count: TREE.length });
    dev.close();
  });
});

describe("GET /api/devices/:id/browse", () => {
  it("returns the top-level drives at the root, with subtree counts and sizes", async () => {
    st = await fullStack();
    const dev = await seed(st);
    const root = await browse(st, dev);
    expect(root.path).toBeNull();
    expect(root.folders.map((f) => f.name)).toEqual(["C:", "D:"]);
    const c = root.folders.find((f) => f.name === "C:")!;
    expect(c).toMatchObject({ path: "C:", fileCount: 5, totalBytes: 1200 + 1100 + 40 + 900 + 10 });
    const d = root.folders.find((f) => f.name === "D:")!;
    expect(d).toMatchObject({ path: "D:", fileCount: 2, totalBytes: 5000 + 8000 });
    expect(root.files).toEqual([]);
    dev.close();
  });

  it("returns immediate folders then files for a sub-path, sorted by name", async () => {
    st = await fullStack();
    const dev = await seed(st);
    const docs = await browse(st, dev, "C:\\Users\\bunny\\Documents");
    expect(docs.path).toBe("C:\\Users\\bunny\\Documents");
    // the taxes folder (2 files), then the immediate resume.docx file
    expect(docs.folders).toEqual([{ name: "taxes", path: "C:\\Users\\bunny\\Documents\\taxes", fileCount: 2, totalBytes: 2300 }]);
    expect(docs.files.map((f) => f.name)).toEqual(["resume.docx"]);
    expect(docs.files[0]).toMatchObject({ path: "C:\\Users\\bunny\\Documents\\resume.docx", ext: "docx", size: 40, cached: false, inR2: false });

    // leaf folder: two files, no subfolders
    const taxes = await browse(st, dev, "C:\\Users\\bunny\\Documents\\taxes");
    expect(taxes.folders).toEqual([]);
    expect(taxes.files.map((f) => f.name)).toEqual(["2024.pdf", "2025.pdf"]);

    // a trailing backslash is normalised to the same directory
    const taxes2 = await browse(st, dev, "C:\\Users\\bunny\\Documents\\taxes\\");
    expect(taxes2.files.map((f) => f.name)).toEqual(["2024.pdf", "2025.pdf"]);
    dev.close();
  });

  it("paginates a huge folder with a continuation cursor", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    for (let i = 0; i < 5; i++) await catalog(dev, `C:\\big\\f${String(i).padStart(2, "0")}.bin`, 10 + i);
    await st.svc.ingester.poll();
    const first = (await api(st.svc, "GET", `/api/devices/${dev.deviceId}/browse?path=${encodeURIComponent("C:\\big")}&limit=2`)).json;
    expect(first.files.map((f: { name: string }) => f.name)).toEqual(["f00.bin", "f01.bin"]);
    expect(first.nextCursor).toBe("2");
    const second = (await api(st.svc, "GET", `/api/devices/${dev.deviceId}/browse?path=${encodeURIComponent("C:\\big")}&limit=2&cursor=2`)).json;
    expect(second.files.map((f: { name: string }) => f.name)).toEqual(["f02.bin", "f03.bin"]);
    expect(second.nextCursor).toBe("4");
    dev.close();
  });

  it("filename search spans the device catalog, capped", async () => {
    st = await fullStack();
    const dev = await seed(st);
    const res = (await api(st.svc, "GET", `/api/devices/${dev.deviceId}/browse/search?q=.pdf`)).json;
    expect(res.files.map((f: { name: string }) => f.name).sort()).toEqual(["2024.pdf", "2025.pdf"]);
    expect(res.truncated).toBe(false);
    dev.close();
  });

  it("404s for an unknown device", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    expect((await api(st.svc, "GET", "/api/devices/not-a-device/browse")).status).toBe(404);
    expect((await api(st.svc, "GET", "/api/devices/not-a-device/browse/search?q=x")).status).toBe(404);
    dev.close();
  });
});

describe("catalog deletion and fetch-on-demand", () => {
  it("a catalogOnly deleted=true removes the entry from the catalog and the browse view", async () => {
    st = await fullStack();
    const dev = await seed(st);
    const path = "C:\\Program Files\\app\\readme.txt";
    expect(db().prepare("SELECT COUNT(*) AS n FROM files WHERE path = ?").get(path)).toEqual({ n: 1 });
    await dev.put("file_meta", { path, name: "readme.txt", ext: "txt", catalogOnly: true, deleted: true });
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT COUNT(*) AS n FROM files WHERE path = ?").get(path)).toEqual({ n: 0 });
    // its parent folder no longer appears under Program Files
    const pf = await browse(st, dev, "C:\\Program Files");
    expect(pf.folders).toEqual([]);
    expect(pf.files).toEqual([]);
    dev.close();
  });

  it("fetching a catalog entry issues a file_request; the original caches, archives in R2, and the file appears normally", async () => {
    st = await fullStack();
    const dev = await seed(st);
    const path = "C:\\Users\\bunny\\Documents\\resume.docx";
    const fileId = (db().prepare("SELECT id FROM files WHERE path = ?").get(path) as { id: string }).id;

    // fetch on demand through the existing file request route
    const req = (await api(st.svc, "POST", `/api/files/${fileId}/request`, {})).json;
    expect(req.command.type).toBe("file_request");
    const sent = (await dev.commands()).find((c) => c.record.commandId === req.command.id)!;
    expect(sent.record.params).toEqual({ type: "file_request", path });

    // the device returns the original; it caches locally and the command completes
    const original = new Uint8Array(randomBytes(40));
    const blob = dev.blob(original, "file_original", 256, { commandId: req.command.id });
    await dev.putBlob(blob);
    await dev.put("command_status", { commandId: req.command.id, status: "uploaded", resultOid: blob.oid, reportedAt: iso() });
    await st.svc.ingester.poll();
    await st.svc.idle();

    const f = db().prepare("SELECT status, local_path, original_blob_oid, catalog FROM files WHERE id = ?").get(fileId) as
      { status: string; local_path: string; original_blob_oid: string; catalog: number };
    expect(f.status).toBe("cached");
    expect(f.original_blob_oid).toBe(blob.oid);
    expect(sha(readFileSync(f.local_path))).toBe(sha(original));

    // it is archived in R2 (media_archive) and re-fetchable; the browse row now shows cached + inR2
    expect(db().prepare("SELECT COUNT(*) AS n FROM media_archive WHERE oid = ?").get(blob.oid)).toEqual({ n: 1 });
    const docs = await browse(st, dev, "C:\\Users\\bunny\\Documents");
    const row = docs.files.find((x) => x.name === "resume.docx")!;
    expect(row).toMatchObject({ cached: true, inR2: true });

    // the fetched file now appears in the normal files list and in search
    const list = (await api(st.svc, "GET", "/api/files")).json;
    expect(list.items.map((i: { id: string }) => i.id)).toContain(fileId);
    expect((await api(st.svc, "GET", "/api/search?q=resume&type=file")).json.items.map((i: { id: string }) => i.id)).toContain(fileId);
    dev.close();
  });
});

describe("file_catalog batch ingest", () => {
  it("ingests a batch of entries (and deletions) as catalog rows, same as single catalogOnly file_meta", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    const entries = [
      { path: "C:\\Users\\bunny\\Notes\\a.md", name: "a.md", ext: "md", size: 11, mtime: iso() },
      { path: "C:\\Users\\bunny\\Notes\\b.md", name: "b.md", ext: "md", size: 22, mtime: iso() },
      { path: "C:\\Users\\bunny\\Notes\\sub\\c.txt", name: "c.txt", ext: "txt", size: 33, mtime: iso() },
    ];
    await dev.put("file_catalog", { root: "C:\\Users\\bunny", entries, deletions: [] });
    await st.svc.ingester.poll();

    // all three are browse-only catalog rows, excluded from the normal files list
    expect(db().prepare("SELECT COUNT(*) AS n FROM files WHERE catalog = 1").get()).toEqual({ n: 3 });
    expect((await api(st.svc, "GET", "/api/files")).json.items.length).toBe(0);

    // they browse like any catalogued files
    const notes = await browse(st, dev, "C:\\Users\\bunny\\Notes");
    expect(notes.files.map((f) => f.name).sort()).toEqual(["a.md", "b.md"]);
    expect(notes.folders.map((f) => f.name)).toContain("sub");

    // a later batch deletes one entry
    await dev.put("file_catalog", { root: "C:\\Users\\bunny", entries: [], deletions: ["C:\\Users\\bunny\\Notes\\b.md"] });
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT COUNT(*) AS n FROM files WHERE catalog = 1").get()).toEqual({ n: 2 });
    const after = await browse(st, dev, "C:\\Users\\bunny\\Notes");
    expect(after.files.map((f) => f.name)).toEqual(["a.md"]);
    dev.close();
  });
});
