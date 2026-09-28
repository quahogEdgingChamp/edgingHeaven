"""Exact content verification, scoped to one model and safe across its workers."""
from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def complete_files(folder: Path):
    """Do not follow symlinks, hidden directories, or unfinished downloads."""
    for directory, dirs, names in os.walk(folder, followlinks=False):
        dirs[:] = [n for n in dirs if not n.startswith(".") and not (Path(directory) / n).is_symlink()]
        for name in sorted(names):
            path = Path(directory) / name
            if not name.startswith(".") and not name.endswith((".part", ".tmp")) and not path.is_symlink() and path.is_file():
                yield path


class ContentIndex:
    def __init__(self, path: Path, folder: Path):
        self.path, self.folder = path, folder
        self._lock = threading.Lock()
        self._sizes: dict[int, set[Path]] | None = None
        self._cache: dict[str, dict] = {}
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    row = json.loads(line)
                    if isinstance(row, dict) and isinstance(row.get("file"), str):
                        self._cache[row["file"]] = row
                except ValueError:
                    continue

    @staticmethod
    def _stamp(path: Path) -> list[int]:
        stat = path.stat()
        return [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino]

    def _remember(self, path: Path, digest: str, stamp: list[int]) -> None:
        name = path.relative_to(self.folder).as_posix()
        row = {"file": name, "stamp": stamp, "sha256": digest}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row) + "\n")
        self._cache[name] = row

    def _hash(self, path: Path) -> str | None:
        stamp = self._stamp(path)
        row = self._cache.get(path.relative_to(self.folder).as_posix(), {})
        if row.get("stamp") == stamp and isinstance(row.get("sha256"), str):
            return row["sha256"]
        digest = sha256_file(path)
        if self._stamp(path) != stamp:
            return None  # changed while being read: never remove a copy on this basis
        self._remember(path, digest, stamp)
        return digest

    def finish(self, incoming: Path, dest: Path, digest: str | None = None) -> tuple[Path, bool]:
        """Publish a complete file, or remove only its new duplicate. Atomic per model."""
        if not dest.resolve().is_relative_to(self.folder.resolve()):
            raise RuntimeError(f"Destination escapes the model folder: {dest}")
        digest = digest or sha256_file(incoming)
        size = incoming.stat().st_size
        with self._lock:
            if self._sizes is None:
                self._sizes = {}
                for path in complete_files(self.folder):
                    self._sizes.setdefault(path.stat().st_size, set()).add(path)
            for other in sorted(self._sizes.get(size, ())):
                try:
                    if other.is_symlink() or other.stat().st_size != size:
                        continue
                    if self._hash(other) == digest and other.is_file():
                        incoming.unlink()
                        return other, True
                except FileNotFoundError:
                    continue
            # Never overwrite an existing file, even when its name and size match.
            original = dest
            counter = 0
            while dest.exists():
                counter += 1
                dest = original.with_name(f"{original.stem}_{digest[:12]}_{counter}{original.suffix}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            incoming.replace(dest)
            self._sizes.setdefault(size, set()).add(dest)
            self._remember(dest, digest, self._stamp(dest))
            return dest, False
