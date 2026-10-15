# Disposable tools

Throwaway diagnostics used to investigate things on a real PC. **Not part of the product build** — nothing here is referenced by `Ivy.sln`/`Ivy.Windows.sln`, the app, or the installer. Edit freely; these exist so we don't have to re-derive the same digs.

Everything here is **read-only** against the owner's own data on the owner's own machine, and prints structure/counts (not content) unless explicitly asked. Nothing uploads.

## Contents

- **`line.md`** — the LINE data map: on-disk folders, every store's full table/column/tag schema, media on disk, the encrypt-vs-never-upload classification, the thumbnail/preview decryption investigation (§9), and deleted/unsent message recovery (§10). This is the "where to look" reference so we don't dig again.
- **`LineDiag/`** — a small console inspector for the local LINE for Windows store. It reuses the collector's verified crypto (`Ivy.Collectors.Line.LineWxCipher` / `KeyedLineUnlocker` / `LineStore`) to decrypt a snapshot copy of the store and probe it. The `Program.cs` here is whatever probe it was last pointed at (schema dump, chat list, thumbnail crack, deleted-text residue, …) — it is meant to be edited per investigation.

## Running LineDiag

```bash
cd windows/tools/disposable/LineDiag
dotnet run -c Release
```

Notes:
- It targets `net8.0-windows10.0.19041.0` and must run on the Windows PC where LINE is installed.
- It needs a key that fits the store: the DPAPI-stored LINE key at `%LocalAppData%\IVY\keys\line-key.bin`, else it reads one from the running LINE process.
- The account's chat-store filename is **hardcoded** in `Program.cs` (`qw<hex>.edb`); change it for a different account.
- It copies the store files to a temp dir and reads the copies; it never modifies `%LocalAppData%\LINE`. It deletes temp/`.plain` copies on exit.
