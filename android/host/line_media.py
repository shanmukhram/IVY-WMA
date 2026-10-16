"""Fold an externally-exported LINE media tree into the IVY archive.

The owner exported LINE's own app files to two kinds of export, each a .zip or an
extracted directory:

  - a CHAT-MEDIA export (the `line_ext` tree): plaintext chat attachment media at
    `.../files/chats/<chatId>/messages/<file>`. Each attachment is a real,
    plaintext media file (JPEG/PNG/GIF/PDF/MP4/AAC/office doc/...). Alongside each
    sit 32-byte integrity sidecars `<msgId>-hmac` / `<msgId>-hash` which are NOT
    media and are only counted and skipped. The rest of the `line_ext` tree
    (stickers, effects, themes, profile thumbnails) is LINE's own app assets, not
    the owner's conversation attachments, so it is ignored.

  - a KEEP export (the `line_export` tree): the owner's LINE Keep / saved files,
    flat (not chat-keyed): PDFs, images, documents.

What this module does (the host pipeline's read-only, verify-or-skip discipline):

  1. Read either a .zip path or an extracted directory.
  2. CHAT media: parse chatId (the `<chatId>` path segment) and msgId (the number
     in the filename). VERIFY each file's header is a true media type; skip and
     log anything that is not plaintext media (red-on-drift). Classify a kind
     (image / thumbnail / video / audio / document / other). Sidecars are counted
     and skipped, never archived.
  3. KEEP media: ingest every file as unkeyed media (chat_id / msg_id NULL), kind
     by extension, source `line_keep`.
  4. Each distinct blob is encrypted into the EXISTING content-addressed archive
     (archive.py / ivy_crypto.py), so identical thumbnails across messages dedup
     to one object automatically. A `media` row records the keys + archive_ref.

`--dry-run` (see ivy_host.py) inventories WITHOUT reading full file bodies,
encrypting, or needing a passphrase: it reads only each file's header to classify
it, and prints counts only — never file contents or the names of people.

Read-only on the export; no network anywhere.
"""
from __future__ import annotations

import os
import re
import sys
import zipfile
from collections import Counter
from dataclasses import dataclass, field

from parsers.base import log_drift
from unified import Media, UnifiedDB

PLATFORM = "line"
DEFAULT_ACCOUNT = "line"

SOURCE_CHAT = "line_chat"
SOURCE_KEEP = "line_keep"

# A chat attachment: .../files/chats/<chatId>/messages/<file>  (any leading prefix,
# so it matches whether the export was given as a zip, its `line_ext` root, or a
# sub-path). chatId is opaque (u=1:1, c=group, m=other); it carries no name.
_CHAT_RE = re.compile(r"(?:^|/)files/chats/(?P<chat>[^/]+)/messages/(?P<file>[^/]+)$")

# Integrity sidecars that sit next to a real attachment. Not media: count + skip.
_SIDECAR_SUFFIXES = ("-hmac", "-hash")

_HEADER_BYTES = 16  # enough to recognise every magic below

# Extension -> kind. `.thumb` is handled separately (always a thumbnail).
_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp",
              ".heic", ".heif", ".tif", ".tiff", ".arw"}
_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".3gp", ".3gpp", ".webm", ".mkv", ".avi"}
_AUDIO_EXT = {".aac", ".m4a", ".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".amr"}
_DOC_EXT = {".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt",
            ".rtf", ".csv", ".odt", ".ods", ".odp", ".eml", ".pages", ".numbers",
            ".key"}


def sniff_family(header: bytes) -> str | None:
    """Return a media-family label for a file header, or None if it is not a
    recognised plaintext media type. Used to reject encrypted/garbage files
    (red-on-drift) rather than guess them into the archive."""
    h = header
    if h[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if h[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if h[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if h[:4] == b"%PDF":
        return "pdf"
    if h[4:8] == b"ftyp":
        return "isobmff"  # mp4/mov/m4a/aac-in-mp4/3gp/heic container
    if h[:3] == b"ID3":
        return "id3"
    if h[:4] == b"RIFF":
        return "riff"  # wav / avi / webp
    if h[:4] == b"PK\x03\x04":
        return "zip"  # docx/pptx/xlsx/odt/zip
    if h[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        return "ole"  # legacy doc/xls/ppt
    if h[:4] == b"\x1aE\xdf\xa3":
        return "matroska"  # mkv / webm
    if h[:4] == b"OggS":
        return "ogg"
    if h[:4] == b"fLaC":
        return "flac"
    if h[:2] == b"BM":
        return "bmp"
    if h[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if len(h) >= 2 and h[0] == 0xFF and (h[1] & 0xE0) == 0xE0:
        return "mpeg"  # MPEG audio frame sync (mp3 / adts aac)
    return None


def classify_kind(ext: str, family: str | None) -> str:
    """image | thumbnail | video | audio | document | other, by extension first
    (the author's intent), then by the sniffed header family."""
    e = ext.lower()
    if e == ".thumb":
        return "thumbnail"
    if e in _IMAGE_EXT:
        return "image"
    if e in _VIDEO_EXT:
        return "video"
    if e in _AUDIO_EXT:
        return "audio"
    if e in _DOC_EXT:
        return "document"
    # Unknown extension: fall back to the header family.
    if family in ("jpeg", "png", "gif", "bmp", "tiff"):
        return "image"
    if family in ("isobmff", "matroska"):
        return "video"
    if family in ("id3", "mpeg", "ogg", "flac"):
        return "audio"
    if family in ("pdf", "zip", "ole"):
        return "document"
    return "other"  # recognised media (e.g. RIFF) we can't pin to one kind


def _is_sidecar(basename: str) -> bool:
    return any(basename.endswith(s) for s in _SIDECAR_SUFFIXES)


def _extract_msg_id(stem: str) -> str | None:
    """msgId = the leading number of the filename (e.g. `5012.thumb` -> 5012).
    Voice notes are named `voice_<n>.aac`, so fall back to the first digit run."""
    m = re.match(r"(\d+)", stem) or re.search(r"(\d+)", stem)
    return m.group(1) if m else None


# --- export sources (zip or directory), read-only ------------------------

class _Source:
    """Common interface: list entries (posix path + size), read a header prefix,
    read full bytes. Implemented over a .zip or an extracted directory."""

    def entries(self):  # -> iterable[tuple[str, int]]
        raise NotImplementedError

    def read_prefix(self, name: str, n: int) -> bytes:
        raise NotImplementedError

    def read_bytes(self, name: str) -> bytes:
        raise NotImplementedError

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class _ZipSource(_Source):
    def __init__(self, path: str):
        self.z = zipfile.ZipFile(path)

    def entries(self):
        for info in self.z.infolist():
            if not info.is_dir():
                yield info.filename.replace("\\", "/"), info.file_size

    def read_prefix(self, name: str, n: int) -> bytes:
        with self.z.open(name) as f:
            return f.read(n)

    def read_bytes(self, name: str) -> bytes:
        with self.z.open(name) as f:
            return f.read()

    def close(self) -> None:
        self.z.close()


class _DirSource(_Source):
    def __init__(self, root: str):
        self.root = os.path.abspath(root)

    def entries(self):
        for dp, _dn, fn in os.walk(self.root):
            for f in fn:
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, self.root).replace(os.sep, "/")
                yield rel, os.path.getsize(full)

    def _full(self, name: str) -> str:
        return os.path.join(self.root, name.replace("/", os.sep))

    def read_prefix(self, name: str, n: int) -> bytes:
        with open(self._full(name), "rb") as f:
            return f.read(n)

    def read_bytes(self, name: str) -> bytes:
        with open(self._full(name), "rb") as f:
            return f.read()


def open_source(path: str) -> _Source:
    """Open a LINE export given as a .zip file or an extracted directory."""
    if os.path.isdir(path):
        return _DirSource(path)
    if zipfile.is_zipfile(path):
        return _ZipSource(path)
    raise ValueError(f"not a directory or zip export: {path}")


# --- scanning (header-only; no full reads, no hashing) -------------------

@dataclass
class Item:
    """One ingestible media file located in the export."""

    relpath: str
    source: str
    kind: str
    orig_name: str
    ext: str
    family: str | None
    size: int
    chat_id: str | None = None
    msg_id: str | None = None


@dataclass
class Inventory:
    mode: str  # "chat" | "keep"
    items: list = field(default_factory=list)
    chats: set = field(default_factory=set)
    sidecars_skipped: int = 0
    nonmedia_skipped: int = 0
    nonmedia_by_ext: Counter = field(default_factory=Counter)
    assets_ignored: int = 0  # LINE app assets in a chat export (not attachments)
    kind_counts: Counter = field(default_factory=Counter)

    @property
    def keyed(self) -> int:
        return sum(1 for i in self.items if i.chat_id and i.msg_id)

    @property
    def unkeyed(self) -> int:
        return len(self.items) - self.keyed


def scan(source: _Source, log_drift_items: bool = False) -> Inventory:
    """Walk an export and classify every entry WITHOUT reading full bodies.

    Reads only each file's header to verify it is plaintext media. A tree that has
    any `files/chats/<id>/messages/` entries is a chat-media export; otherwise it
    is treated as a Keep export (flat saved files)."""
    all_entries = list(source.entries())
    chat_hits = [(n, sz, m) for (n, sz) in all_entries
                 if (m := _CHAT_RE.search(n))]

    if chat_hits:
        inv = Inventory(mode="chat")
        inv.assets_ignored = len(all_entries) - len(chat_hits)
        for name, size, m in chat_hits:
            chat_id = m.group("chat")
            base = m.group("file")
            inv.chats.add(chat_id)
            if _is_sidecar(base):
                inv.sidecars_skipped += 1
                continue
            stem, ext = os.path.splitext(base)
            header = source.read_prefix(name, _HEADER_BYTES)
            family = sniff_family(header)
            if family is None:
                inv.nonmedia_skipped += 1
                inv.nonmedia_by_ext[ext.lower() or "(none)"] += 1
                if log_drift_items:
                    log_drift(
                        "line chat media",
                        f"not a recognized media header (msg={_extract_msg_id(stem)}, "
                        f"ext={ext.lower() or '(none)'}) - skipped",
                    )
                continue
            kind = classify_kind(ext, family)
            inv.kind_counts[kind] += 1
            inv.items.append(Item(
                relpath=name, source=SOURCE_CHAT, kind=kind, orig_name=base,
                ext=ext, family=family, size=size,
                chat_id=chat_id, msg_id=_extract_msg_id(stem),
            ))
        return inv

    # Keep export: ingest every file as unkeyed media, kind by extension.
    inv = Inventory(mode="keep")
    for name, size in all_entries:
        base = os.path.basename(name)
        if base == ".nomedia" or _is_sidecar(base):
            inv.sidecars_skipped += 1
            continue
        stem, ext = os.path.splitext(base)
        header = source.read_prefix(name, _HEADER_BYTES)
        family = sniff_family(header)
        kind = classify_kind(ext, family)
        inv.kind_counts[kind] += 1
        inv.items.append(Item(
            relpath=name, source=SOURCE_KEEP, kind=kind, orig_name=base,
            ext=ext, family=family, size=size,
        ))
    return inv


def scan_path(path: str) -> Inventory:
    with open_source(path) as src:
        return scan(src)


# --- ingest (reads full bytes, archives, records rows) -------------------

@dataclass
class IngestResult:
    inventory: Inventory
    rows_added: int = 0
    rows_existing: int = 0
    blobs_stored: int = 0  # distinct archive objects touched this run


def ingest_export(path: str, udb: UnifiedDB, archive, account: str = DEFAULT_ACCOUNT):
    """Fold a LINE export into the unified db + encrypted archive.

    Each distinct blob is stored content-addressed (identical bytes dedup to one
    object); a media row records its keys and archive_ref. Idempotent: re-ingest
    adds no new rows. Returns an IngestResult."""
    with open_source(path) as src:
        inv = scan(src, log_drift_items=True)
        res = IngestResult(inventory=inv)
        seen_blobs: set[str] = set()
        for item in inv.items:
            data = src.read_bytes(item.relpath)
            h = archive.put_bytes(data)  # sha256 hex == archive object id
            if h not in seen_blobs:
                seen_blobs.add(h)
                res.blobs_stored += 1
            added = udb.merge_media(Media(
                platform=PLATFORM, account=account,
                sha256=h, archive_ref=h,
                chat_id=item.chat_id, msg_id=item.msg_id,
                kind=item.kind, orig_name=item.orig_name, ext=item.ext,
                bytes=item.size, source=item.source,
            ))
            if added:
                res.rows_added += 1
            else:
                res.rows_existing += 1
        udb.con.commit()
    return res


def print_inventory(inv: Inventory, out=None) -> None:
    """Counts only. Never prints file contents or the names of people."""
    if out is None:
        out = sys.stdout
    mode_label = "chat-media export (line_ext)" if inv.mode == "chat" \
        else "Keep export (line_export)"
    p = lambda s: print(s, file=out)
    p(f"mode: {mode_label}")
    if inv.mode == "chat":
        p(f"distinct chats: {len(inv.chats)}")
    p(f"ingestible media files: {len(inv.items)}")
    p(f"  keyed (chat+msg): {inv.keyed}")
    p(f"  unkeyed:          {inv.unkeyed}")
    if inv.kind_counts:
        by_kind = ", ".join(f"{k}={inv.kind_counts[k]}"
                            for k in sorted(inv.kind_counts))
        p(f"  by kind: {by_kind}")
    p(f"sidecars skipped (-hmac/-hash): {inv.sidecars_skipped}")
    nm = f"non-media skipped: {inv.nonmedia_skipped}"
    if inv.nonmedia_by_ext:
        nm += " (by ext: " + ", ".join(
            f"{e}={inv.nonmedia_by_ext[e]}" for e in sorted(inv.nonmedia_by_ext)
        ) + ")"
    p(nm)
    if inv.mode == "chat":
        p(f"non-chat app assets ignored: {inv.assets_ignored}")
    p("(counts only; no file contents or personal names are read or printed)")
