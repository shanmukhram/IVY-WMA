"""Content-addressed, encrypted-at-rest blob store for the host-side archive.

Each object is stored under its SHA-256 (of the plaintext). Each object is
AES-256-GCM encrypted at rest with a key derived from the owner's passphrase via
Argon2id (see ivy_crypto.py; matches docs/PROTOCOL.md). A manifest (archive.json)
records every object's hash and plaintext size, plus named refs (e.g. "unified.db"
-> hash) so a reader can find the current unified database.

Layout (generic names; no network anywhere):

    <archive>/
      archive.json                    # kdf spec, refs, objects {hash: {size}}
      objects/<hh>/<sha256>           # nonce(12) || ciphertext || tag(16)

The object name (sha256 hex) is bound into the AES-GCM AAD, so an object cannot be
moved to another name without authentication failing. Idempotent: putting the same
bytes twice yields the same hash and is a no-op. Append-only by nature; the caller
(unified ingest) decides what content goes in.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

import ivy_crypto as C

ARCHIVE_JSON = "archive.json"
OBJECTS_DIR = "objects"
ARCHIVE_VERSION = 1


@dataclass
class ArchiveMeta:
    version: int
    kdf: C.KdfSpec
    objects: dict  # sha256_hex -> {"size": int}
    refs: dict  # name -> sha256_hex

    def to_json(self) -> dict:
        return {
            "version": self.version,
            "kdf": self.kdf.to_json(),
            "objects": self.objects,
            "refs": self.refs,
        }

    @staticmethod
    def from_json(d: dict) -> "ArchiveMeta":
        return ArchiveMeta(
            version=d.get("version", ARCHIVE_VERSION),
            kdf=C.KdfSpec.from_json(d["kdf"]),
            objects=d.get("objects", {}),
            refs=d.get("refs", {}),
        )


class Archive:
    """An encrypted content-addressed store rooted at a directory.

    Open an existing archive with `Archive.open`, or create one with
    `Archive.create`. The passphrase is held only for the lifetime of the object
    (as a derived key); nothing writes the passphrase or the derived key to disk.
    """

    def __init__(self, root: str, passphrase: str, meta: ArchiveMeta):
        self.root = os.path.abspath(root)
        self._meta = meta
        self._key = C.derive_key(passphrase, meta.kdf)

    # --- lifecycle -------------------------------------------------------

    @classmethod
    def create(cls, root: str, passphrase: str, prefer_argon2: bool = True) -> "Archive":
        root = os.path.abspath(root)
        if os.path.exists(os.path.join(root, ARCHIVE_JSON)):
            raise FileExistsError(f"archive already exists at {root}")
        os.makedirs(os.path.join(root, OBJECTS_DIR), exist_ok=True)
        meta = ArchiveMeta(
            version=ARCHIVE_VERSION,
            kdf=C.new_kdf_spec(prefer_argon2=prefer_argon2),
            objects={},
            refs={},
        )
        arc = cls(root, passphrase, meta)
        arc._save_meta()
        return arc

    @classmethod
    def open(cls, root: str, passphrase: str) -> "Archive":
        path = os.path.join(os.path.abspath(root), ARCHIVE_JSON)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"no archive at {root}")
        with open(path, encoding="utf-8") as f:
            meta = ArchiveMeta.from_json(json.load(f))
        return cls(root, passphrase, meta)

    @classmethod
    def open_or_create(cls, root: str, passphrase: str, prefer_argon2: bool = True) -> "Archive":
        if os.path.isfile(os.path.join(os.path.abspath(root), ARCHIVE_JSON)):
            return cls.open(root, passphrase)
        return cls.create(root, passphrase, prefer_argon2=prefer_argon2)

    @property
    def kdf(self) -> C.KdfSpec:
        return self._meta.kdf

    def uses_fallback_kdf(self) -> bool:
        return C.using_fallback_kdf(self._meta.kdf)

    # --- objects ---------------------------------------------------------

    def _object_path(self, h: str) -> str:
        return os.path.join(self.root, OBJECTS_DIR, h[:2], h)

    def put_bytes(self, data: bytes) -> str:
        """Store plaintext bytes; returns the sha256 hex. Idempotent."""
        h = C.sha256_hex(data)
        p = self._object_path(h)
        if h not in self._meta.objects or not os.path.isfile(p):
            os.makedirs(os.path.dirname(p), exist_ok=True)
            blob = C.encrypt(self._key, data, aad=h.encode("ascii"))
            tmp = p + ".tmp"
            with open(tmp, "wb") as f:
                f.write(blob)
            os.replace(tmp, p)
            self._meta.objects[h] = {"size": len(data)}
            self._save_meta()
        return h

    def put_file(self, path: str) -> str:
        with open(path, "rb") as f:
            return self.put_bytes(f.read())

    def get_bytes(self, h: str) -> bytes:
        """Fetch and decrypt the object named by sha256 hex; verifies integrity."""
        p = self._object_path(h)
        if not os.path.isfile(p):
            raise KeyError(f"object {h} not in archive")
        with open(p, "rb") as f:
            blob = f.read()
        data = C.decrypt(self._key, blob, aad=h.encode("ascii"))
        got = C.sha256_hex(data)
        if got != h:
            raise ValueError(f"object hash mismatch: expected {h}, got {got}")
        return data

    def has(self, h: str) -> bool:
        return h in self._meta.objects and os.path.isfile(self._object_path(h))

    # --- named refs ------------------------------------------------------

    def set_ref(self, name: str, h: str) -> None:
        self._meta.refs[name] = h
        self._save_meta()

    def get_ref(self, name: str) -> str | None:
        return self._meta.refs.get(name)

    def put_ref_bytes(self, name: str, data: bytes) -> str:
        h = self.put_bytes(data)
        self.set_ref(name, h)
        return h

    def get_ref_bytes(self, name: str) -> bytes | None:
        h = self.get_ref(name)
        return None if h is None else self.get_bytes(h)

    # --- persistence -----------------------------------------------------

    def _save_meta(self) -> None:
        path = os.path.join(self.root, ARCHIVE_JSON)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._meta.to_json(), f, indent=2, sort_keys=True)
        os.replace(tmp, path)

    def manifest(self) -> dict:
        return self._meta.to_json()
