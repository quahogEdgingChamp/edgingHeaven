from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path

from .config import Config


def index_path(cfg: Config, slug: str) -> Path:
    return cfg.resolve(cfg.paths.state_dir) / "done" / f"{slug}.jsonl"


def with_url_hash(name: str, url: str) -> str:
    """foo.jpg → foo_<8 hex of url>.jpg — unique per source URL."""
    stem, ext = os.path.splitext(name)
    digest = hashlib.sha1(url.encode("utf-8", "ignore")).hexdigest()[:8]
    return f"{stem}_{digest}{ext}"


class DownloadIndex:
    """
    Per-model record of direct downloads: source URL → filename in the model folder.

    Lets re-runs skip finished URLs without any request, and keeps two different
    files that share a name (IMG_1234.jpg from two hosts) from overwriting or
    shadowing each other. Stored as append-only jsonl so a crash loses nothing.
    Thread-safe: download workers share one instance per model.
    """

    def __init__(self, path: Path, folder: Path):
        self.path = path
        self.folder = folder
        self._file_for: dict[str, str] = {}  # url → filename
        self._owner: dict[str, str] = {}  # filename → url that first wrote it
        self._in_flight: set[str] = set()  # filenames being written right now
        self._lock = threading.Lock()
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                url, name = row.get("url"), row.get("file")
                if url and name:
                    self._file_for[url] = name
                    self._owner.setdefault(name, url)

    @classmethod
    def for_model(cls, cfg: Config, slug: str) -> DownloadIndex:
        return cls(index_path(cfg, slug), cfg.models_root() / slug)

    def _size(self, name: str) -> int | None:
        try:
            size = (self.folder / name).stat().st_size
        except OSError:
            return None
        return size if size > 0 else None

    def done(self, url: str) -> Path | None:
        """File previously downloaded from url, if it is still on disk."""
        name = self._file_for.get(url)
        if name and self._size(name):
            return self.folder / name
        return None

    def claim(
        self,
        url: str,
        name: str,
        expected_size: int | None,
        *,
        reuse: bool = True,
    ) -> tuple[str, bool]:
        """
        Pick the filename to store url under. Returns (name, already_have).

        An existing file counts as this URL's content when its size matches the
        server's Content-Length (or, with no length, when nothing says otherwise).
        Anything else with the same name gets a URL-hashed name instead.
        """
        with self._lock:
            for cand in (name, with_url_hash(name, url)):
                if cand in self._in_flight:
                    continue
                size = self._size(cand)
                if size is None:
                    self._in_flight.add(cand)
                    return cand, False
                owner = self._owner.get(cand)
                if expected_size is not None:
                    same = size == expected_size
                else:
                    same = owner is None or owner == url
                if same:
                    if reuse:
                        return cand, True
                    self._in_flight.add(cand)
                    return cand, False
            # Hashed name is taken by a different-size file of this same URL
            # (partial/corrupt earlier copy) — overwrite it.
            cand = with_url_hash(name, url)
            self._in_flight.add(cand)
            return cand, False

    def record(self, name: str, *urls: str) -> None:
        """Mark name as downloaded from each of urls (page link + image URL)."""
        with self._lock:
            self._in_flight.discard(name)
            new = [u for u in urls if self._file_for.get(u) != name]
            for u in urls:
                self._file_for[u] = name
                self._owner.setdefault(name, u)
            if not new:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as fh:
                for u in new:
                    fh.write(json.dumps({"url": u, "file": name}, ensure_ascii=False) + "\n")

    def release(self, name: str) -> None:
        """Give up a claimed name after a failed download."""
        with self._lock:
            self._in_flight.discard(name)
