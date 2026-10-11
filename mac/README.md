# IVY Mac side

Four packages make up the Mac dashboard (PRD Part 2):

| Package | Path | What it is |
| --- | --- | --- |
| `@ivy/mac-service` | `mac/service` | Local Node service: key store, R2 ingest, `vault.db` with FTS5, HTTP API under `/api`, WebSocket `/events`. See `mac/service/README.md`. |
| `@ivy/mac-ocr` | `mac/ocr` | Apple Vision OCR and thumbnail helper used by the service. |
| `@ivy/mac-ui` | `mac/ui` | The dashboard web app (Vite + React). The service serves its build at `/`. |
| `@ivy/mac-app` | `mac/app` | Thin Electron shell: starts the service, waits for health, opens one window. |

## Run from source

Needs Node 25 and pnpm (macOS arm64).

```sh
pnpm install
pnpm --filter @ivy/mac-ocr run build:swift    # optional: the Vision helper; without it OCR shows as unavailable
pnpm --filter @ivy/mac-app start              # builds protocol, mac-ocr and the UI, then opens Electron
```

The app runs `node mac/service/src/main.ts --data <repo>/data --port 4777 --static mac/ui/dist` as a child process, waits for `GET /api/health`, puts the token from `data/session.token` into the window's cookie jar and loads `http://127.0.0.1:4777/`. If a service is already healthy on that port it uses that one and leaves it running on quit; otherwise the service it started is stopped (SIGTERM) when you quit. Menu: IVY > Lock screen (key stays in memory, ingest continues), Lock fully (key dropped, ingest stops), Reload, Quit.

Environment for the app: `IVY_DATA_DIR` (default `<repo>/data`), `IVY_PORT` (4777), `IVY_NODE` (node binary; set it when launching from Finder, where PATH has no Homebrew), `IVY_SERVICE_CMD` (run a packaged service executable instead of node + source), `IVY_STATIC_DIR` (default `mac/ui/dist`).

Without Electron, in a browser:

```sh
pnpm --filter @ivy/mac-ui build
cd mac/service && node src/main.ts --data ../../data --static ../ui/dist
open "http://127.0.0.1:4777/#token=$(cat ../../data/session.token)"
```

The `#token=` fragment is exchanged once for an HttpOnly session cookie and removed from the address bar. Without it the page asks for the token.

UI development with hot reload (service running on 4777, or set `IVY_SERVICE_URL`):

```sh
pnpm --filter @ivy/mac-ui dev                 # http://127.0.0.1:5173, proxies /api and /events
```

## Where data lives

Everything is under the data directory (`<repo>/data` for the app, `--data` for the service; `data/` is git-ignored):

- `vault.db` (+ WAL): the archive and its FTS5 index
- `identity.json`: identity salt, public key, fingerprint, sealed private key. **Back it up.** Re-pairing after a restore needs the same passphrase and this salt.
- `session.token`: the local API token (mode 0600)
- `media/`, `thumbs/`, `files/<oid>/`, `attachments/`: originals, thumbnails, retrieved files
- `blobs/` (transfers in progress), `quarantine/` (still-encrypted objects that failed ingest)

## First run and pairing a device

1. Open the app. Set a passphrase. Read the identity-salt note and back up `data/identity.json`.
2. Settings > Cloudflare R2: enter the account id (or endpoint), the Mac token(s) and the device tokens for each role, Save, then Check connection. Secrets are sealed under the identity key and shown masked afterwards. Saving replaces the whole configuration.
3. Devices > Start pairing: Windows (or Android). The page shows the pairing string (Copy button), a QR code of the same string, the Mac fingerprint and a 10-minute countdown.
   - Windows: paste the pairing string into the IVY Windows app.
   - Android: scan the QR code.
4. The device answers through its up-bucket; the next poll (every 5 seconds, or Check now in the pairing sheet / Sync now at the bottom of the sidebar) completes pairing. The page shows the device fingerprint; both screens must show the same Mac fingerprint.
5. Coverage shows each device and collector with a status dot, last sync, last report, queue depth, import progress and gaps; problems are pinned at the top.

Revoking a device (Devices) forgets its key; its R2 tokens stay valid until rotated in Cloudflare.

## AI and Activity Vault (optional)

- Settings > AI (cloud, OpenAI): off by default. Turning it on and saving an OpenAI API key enables Ask AI (sidebar), the "AI overview" drawer beside search results and the timeline, and optionally embeddings for "Semantic matches". The page states what is sent. With it off nothing leaves the Mac.
- Settings > Activity Vault import: point it at the Activity Vault archive (SQLite or JSON file, or its folder) and tick "Import daily", or use "Import now". The archive is read-only to IVY. Imported rows appear as "Google activity" in search and on the timeline; Coverage shows the import row.

## Tests

```sh
pnpm --filter @ivy/mac-ui test        # vitest + React Testing Library (mocked API and events)
pnpm --filter @ivy/mac-ui test:e2e    # real service + S3 mock + simulated device + Playwright chromium
pnpm --filter @ivy/mac-app test       # shell helpers: start service, wait for health, stop
pnpm --filter @ivy/mac-service test
```

The e2e test needs Playwright's chromium (`pnpm --filter @ivy/mac-ui exec playwright install chromium` once).
