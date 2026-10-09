# @ivy/fake-mac

Stands in for the Mac dashboard so the Windows app can be smoke-tested before the Mac side exists. It runs the local S3 mock (`@ivy/s3-mock`) with the four `ivy-*` buckets and scoped tokens, holds a persistent Mac identity, issues a pairing code, decrypts and checks everything the device uploads, and sends commands to the device. All crypto comes from `@ivy/protocol`.

It runs on Windows and macOS with Node 22.18+ (TypeScript runs directly through Node's type stripping, so there is no build step). `@ivy/protocol` is used through its built `dist/`. If the CLI warns that the protocol `src/` is newer than `dist/`, run `pnpm --filter @ivy/protocol build`.

## Windows smoke test (two terminals)

Both terminals are PowerShell, opened at the repo root.

**One-time setup**

```powershell
pnpm install
pnpm --filter @ivy/protocol build
```

**Terminal 1: the fake Mac**

```powershell
$env:IVY_FAKE_MAC_PASSPHRASE = "smoke-test-passphrase"
pnpm --filter @ivy/fake-mac run serve --root .fake-mac
```

It prints:

- the endpoint (`http://127.0.0.1:9000`)
- the Mac fingerprint
- the pairing string (`IVYPAIR1.…`), also saved to `.fake-mac\pairing.txt`
- a terminal QR of the same string

Then it polls `ivy-up-windows` every 5 s. Leave it running.

1. Paste the pairing string into the Windows app's pairing screen. It is easiest to copy it from `.fake-mac\pairing.txt`, because terminal line wrapping can break a copy. The code expires after 15 minutes. Restarting `serve` issues a fresh code and cancels the old one.
2. Within 5 s Terminal 1 prints `PAIRED pair/<id>/device` with the `device fingerprint` and the `mac fingerprint`. Check that both match what the Windows app shows.
3. As the app uploads, Terminal 1 prints one line per object:
   - `RECORD up/file/<oid> kind=file_meta size=… device=… {decrypted JSON}` for small records
   - `REPORT up/status/<oid> …` followed by a coverage table (collector, enabled, lastRun, cursor, queueDepth)
   - `BLOB up/blob/<oid>/manifest payloadKind=… parts=N size=… sha256=… -> received\<oid>.<ext>` for chunked blobs
   - `WAIT …` while a blob's parts are still arriving
   - `QUARANTINED` / `REJECTED` for anything that does not decrypt or validate. The raw bytes are copied to `.fake-mac\quarantine\` and the loop keeps going.

   Each object is committed to `.fake-mac\ledger.json` and then deleted from the bucket.

**Terminal 2: commands to the device**

```powershell
pnpm --filter @ivy/fake-mac run request-file --root .fake-mac --path "C:\Users\bunny\Documents\x.pdf"
pnpm --filter @ivy/fake-mac run rescan --root .fake-mac --collector files
pnpm --filter @ivy/fake-mac run config --root .fake-mac --collector usage --enabled false
pnpm --filter @ivy/fake-mac run status --root .fake-mac
pnpm --filter @ivy/fake-mac run audit --root .fake-mac
```

Each command is wrapped to the paired device's public key and written to `ivy-cmd-windows` as `cmd/<oid>`. Terminal 2 needs no passphrase. It finds the running `serve` through `.fake-mac\state.json`.

When the device posts the matching `command_status`, Terminal 1 does three things (PLAN decision 4):

- prints `STATUS … status=uploaded resultOid=…`
- deletes `cmd/<oid>`
- for a file request, writes the original to `.fake-mac\received\<resultOid>.pdf` (the extension comes from the requested path)

`status` lists paired devices, ledger counts and every command with its outcome. `audit` runs the `@ivy/audit` zero-plaintext scan over all four buckets. It uses as markers the plaintext the fake Mac has decrypted (strings from ledger records, and text runs from received files), so a pass means none of that plaintext is present in the buckets. Add `--keep` to `serve` if you want objects to stay in the bucket after commit, so the audit has the device's real ciphertext to scan.

The same commands work without pnpm, for example `node tools/fake-mac/src/cli.ts serve --root .fake-mac`. Use `pnpm … run <cmd>` rather than `pnpm … <cmd>`, because `config` and `audit` are also built-in pnpm commands. A relative `--root` resolves against the directory you ran the command from.

**Windows app on a different machine from the fake Mac:** run `serve --host 0.0.0.0`. The pairing string then advertises this machine's first LAN IPv4 address. Pass `--public-url http://<ip>:9000` to choose the address yourself, and allow the port through the firewall.

## Commands

| Command | Options |
| --- | --- |
| `serve` | `--root DIR` `[--port 9000]` `[--role windows\|android]` `[--passphrase P]` (or env `IVY_FAKE_MAC_PASSPHRASE`) `[--host 127.0.0.1]` `[--public-url URL]` `[--interval 5]` (seconds) `[--pair-ttl 15]` (minutes) `[--keep]` `[--no-qr]` |
| `request-file` | `--root DIR --path PATH` (or `--file-id ID`) `[--device ID]` |
| `rescan` | `--root DIR --collector NAME [--scope S] [--device ID]` |
| `config` | `--root DIR --collector NAME [--enabled true\|false] [--setting key=value]... [--device ID]` |
| `audit` | `--root DIR [--marker TEXT]...` |
| `status` | `--root DIR` |

If `serve` is not running, `request-file`, `rescan`, `config` and `audit` open the on-disk mock store directly. Do not run two processes on one `--root` while `serve` is up.

## What is under `--root`

| Path | Contents |
| --- | --- |
| `mac-identity.json` | Random X25519 Mac keypair. The secret is stored only as a PROTOCOL §3.3 container (Argon2id 64 MiB + AES-256-GCM) under the passphrase. |
| `state.json` | Endpoint, the three scoped tokens, pairings, paired devices, and blob-extension hints. Written by `serve`. |
| `ledger.json` | One entry per ingested object: `key, kind, status (committed\|quarantined\|rejected), ingestedAt`, plus size, ciphertext SHA-256 and the decrypted record. |
| `commands/<oid>.json` | Commands issued and their reported status. |
| `received/<oid>.<ext>` | Reassembled blob plaintext. |
| `quarantine/` | Raw bytes and the reason for every object that was rejected or could not be decrypted. |
| `pairing.txt` | The current pairing string. |
| `s3/` | The mock's bucket storage. |

Token scopes, which the mock enforces by access key id:

| Token | Scope |
| --- | --- |
| `up-<role>` | `PutObject` and the multipart writes on `ivy-up-<role>` only |
| `cmd-<role>` | `ListObjectsV2`, `GetObject` and `HeadObject` on `ivy-cmd-<role>` only |
| `mac` | Everything |

## Tests

```sh
pnpm --filter @ivy/fake-mac test
```

The test plays the Windows device using only `@ivy/protocol` and the tokens from the pairing string. It covers:

- pairing, including refusal of a second device object for the same pairing id
- `file_meta`, screenshot and chunked blob uploads, including a blob whose parts arrive across two passes
- `device_report`
- garbage and unknown-key objects (quarantined)
- a tampered blob (quarantined)
- an identical replay versus an overwrite
- `request-file` with `C:\Users\bunny\Documents\x.pdf` through `runCli` and through the plain `node src/cli.ts` entry
- `rescan` and `config` with `command_status` deleting the command
- the audit
- restart with the right and the wrong passphrase
