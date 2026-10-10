/**
 * IVY Mac app: a thin Electron window over @ivy/mac-service.
 * Starts the service (unless one is already healthy on the port), waits for health,
 * puts the session token into the window's cookie jar, opens the dashboard.
 * Menu: Lock (screen only / full), Reload, Quit. Quitting stops the service it started.
 */
import { app, BrowserWindow, Menu, dialog, session, shell } from "electron";
import { config, healthy, readToken, startService, stopService, waitForHealth } from "./shell.js";

const cfg = config();
let child = null;
let win = null;
let quitting = false;

async function lock(full) {
  try {
    await fetch(`${cfg.url}/api/keystore/lock`, {
      method: "POST", headers: { authorization: `Bearer ${readToken(cfg)}`, "content-type": "application/json" }, body: JSON.stringify({ full }),
    });
  } finally { win?.webContents.reload(); }
}

function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "IVY", submenu: [
      { label: "Lock screen (keep key, ingest continues)", accelerator: "CmdOrCtrl+L", click: () => void lock(false) },
      { label: "Lock fully (drop key)", accelerator: "CmdOrCtrl+Shift+L", click: () => void lock(true) },
      { type: "separator" },
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => win?.webContents.reload() },
      { type: "separator" },
      { label: "Quit IVY", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
    ] },
    { role: "editMenu" },
  ]));
}

async function boot() {
  menu();
  if (await healthy(cfg.url)) {
    console.log(`[app] using the service already running at ${cfg.url} (it keeps running after quit)`);
  } else {
    child = startService(cfg);
    child.on("exit", (code) => {
      if (!quitting) { dialog.showErrorBox("IVY service stopped", `The service exited (code ${code}).`); app.quit(); }
    });
    await waitForHealth(cfg.url, child);
  }
  await session.defaultSession.cookies.set({ url: cfg.url, name: "ivy_session", value: readToken(cfg), httpOnly: true, sameSite: "strict" });
  win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: "#0b0b0b", title: "IVY",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // same-origin links (local copies) open in a child window; anything else goes to the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(cfg.url + "/")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(cfg.url)) e.preventDefault(); });
  await win.loadURL(cfg.url + "/");
  if (process.env.IVY_APP_SMOKE === "1") {
    const h1 = await win.webContents.executeJavaScript(
      "new Promise((r) => { const t = Date.now(); const f = () => { const h = document.querySelector('h1'); if (h || Date.now() - t > 10000) r(h ? h.textContent : null); else setTimeout(f, 100); }; f(); })");
    console.log(`[app] smoke: loaded ${cfg.url} first heading: ${h1}`);
    app.quit();
  }
}

app.whenReady().then(boot).catch((e) => { dialog.showErrorBox("IVY failed to start", String(e?.stack ?? e)); app.exit(1); });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (e) => {
  if (quitting || !child) return;
  quitting = true;
  e.preventDefault();
  void stopService(child).finally(() => app.quit());
});
