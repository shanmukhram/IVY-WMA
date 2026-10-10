# Telegram Desktop tdata layout, captured on the PC

Date: 2026-10-10. This is the on-disk layout of a real, signed-in Telegram Desktop install on the Windows PC, captured so the `tdata` reader can be matched to it. It is the Telegram counterpart of the LINE probe report: the reader was written and tested against a generated fixture, and `windows/Ivy.App/README.md` and the reader's own comments flag the real layout as something to confirm on a PC. It differs from the fixture, which is why the Telegram row reports "No usable accounts in tdata (no MTProto authorization found)".

No account contents are in this report: only file names, sizes and the four-byte container tag.

## Install

- Telegram Desktop, signed in, one account.
- Folder: `%APPDATA%\Telegram Desktop\tdata` (the standard location the reader already resolves).

## The files that matter (account layout)

| Path under tdata | Size (bytes) | Tag |
| --- | --- | --- |
| `key_datas` | 388 | `TDF$` |
| `D877F783D5D3EF8Cs` | 1132 | `TDF$` |
| `D877F783D5D3EF8C/` (folder) | — | — |
| `D877F783D5D3EF8C/maps` | 260 | `TDF$` |
| `D877F783D5D3EF8C/configs` | 1868 | `TDF$` |
| `D877F783D5D3EF8C/47E1CD81B0193D7Fs` | 92 | `TDF$` |
| `D877F783D5D3EF8C/65DDEE1DA7445FA5s` | 252 | `TDF$` |
| `3122FBF5F29D5A61s` | 664540 | `TDF$` |
| `D2EC858A6543675Fs` | 140 | `TDF$` |

Every container begins with the `TDF$` tag the reader already understands. `D877F783D5D3EF8C` is exactly what the reader's own name computation produces for account index 0 (`ComputeDataNameKey("data")` then `ToFilePart`), so the naming math is correct.

## The three gaps between the reader and this layout

1. **The trailing `s`.** Every real file ends with tdesktop's one-character version marker, `s` (`D877F783D5D3EF8Cs`, `47E1CD81B0193D7Fs`, and so on). The reader's computed paths omit it, so the files it opens are not the ones on disk.

2. **Folder, not a same-named file.** `TdataLayout.AccountDataFile` builds `tdata/<part>/<part>` (a file named like its folder). On disk, `tdata/<part>/` is a folder that holds a `maps` file plus data files whose names are different computed values with the `s` marker (`47E1CD81B0193D7Fs`, `65DDEE1DA7445FA5s`). There is also a root-level index file `tdata/<part>s`. So the account's data is reached through the `maps` file in the folder, not a single `<part>/<part>` file. `File.Exists` on the computed path fails first, every account comes back empty, and that is the "no usable accounts" message.

3. **The authorization block shape.** `TdataReader.ParseMtpAuthorization` reads the simplified shape the test writer produces and says so in its own comment. The real block is tdesktop's own serialization inside one of the `maps`-indexed files, and has to be mapped onto the domain type.

## What a fix needs (reader change, best done where the tests and fixtures live)

- Append the `s` marker to computed file names (and handle tdesktop's safe-write pair where a file can also end in `0`/`1`, newest wins).
- Treat `tdata/<part>/` as a folder: read its `maps` container to find which data file holds the account's MTProto block, instead of opening `tdata/<part>/<part>`.
- Map the real serialization of the authorization block onto `TelegramAccount`, and update the test fixture (`TdataWriter`) to emit this real layout so the unit tests cover it.

This cannot be verified end to end on the PC without a full connect, and the current unit tests encode the older shape, so the change belongs with the reader's tests and a tdesktop-source cross-check rather than being inferred from one profile. The error chain today is honest: the row says it found no usable account, which is true for this layout.
