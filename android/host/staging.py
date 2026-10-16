"""Read a pulled `out/` staging dir (produced by android/scripts/stack.sh).

The staging manifest (out/manifest.tsv) has columns, tab-separated, with a header:

    source   staged   bytes   sha256   type

  - source : the on-device path the file was copied FROM (e.g.
             /data/data/com.whatsapp/databases/msgstore.db)
  - staged : the path RELATIVE to the out/ dir (e.g.
             com.whatsapp/databases/msgstore.db)
  - bytes  : size
  - sha256 : hash of the staged copy
  - type   : sqlite-plain | encrypted-or-other | inventory-only

This module is read-only on the staging dir. It never modifies inputs.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class StagedEntry:
    source: str
    staged: str
    bytes: str
    sha256: str
    type: str

    def abspath(self, out_dir: str) -> str:
        return os.path.join(out_dir, self.staged.replace("/", os.sep))


class Staging:
    def __init__(self, out_dir: str):
        self.out_dir = os.path.abspath(out_dir)
        self.manifest_path = os.path.join(self.out_dir, "manifest.tsv")
        if not os.path.isfile(self.manifest_path):
            raise FileNotFoundError(f"no manifest.tsv in {self.out_dir}")
        self.entries: list[StagedEntry] = []
        with open(self.manifest_path, encoding="utf-8") as f:
            f.readline()  # header
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) == 5:
                    self.entries.append(StagedEntry(*parts))

    def find_by_source_suffix(self, suffix: str) -> list[StagedEntry]:
        """Entries whose on-device source path ends with `suffix`
        (e.g. 'com.whatsapp/databases/msgstore.db')."""
        suffix = suffix.replace("\\", "/")
        return [e for e in self.entries if e.source.replace("\\", "/").endswith(suffix)]

    def find_one(self, suffix: str) -> StagedEntry | None:
        hits = self.find_by_source_suffix(suffix)
        return hits[0] if hits else None

    def find_by_basename(self, basename: str) -> list[StagedEntry]:
        return [e for e in self.entries if os.path.basename(e.source) == basename]
