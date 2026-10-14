"""What one run takes from each thread: thread pages, photos or videos, how many.

These are per run (command-line flags), unlike config.toml's images/videos,
which also drop links from the crawl cache. A link a filter leaves out is not
recorded anywhere, so a later run without the filter still downloads it; a file
that was downloaded and then deleted stays deleted either way.
"""
from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from .hosts import IMAGE_EXT, VIDEO_EXT, MediaKind, MediaLink, _ext

# Settings saved for single models (Edging Heaven's "Settings per model"):
# {"<model>": {"threadPages": "1-3", "only": "videos", "maxFiles": 40,
#              "order": "newest", ...}}, in the state folder.
MODEL_RULES = "model-rules.json"

# One part of a page list: 3 | 2-4 | 10- | last 5
_PART_RE = re.compile(r"(?:(\d{1,5})(?:(-)(\d{1,5})?)?|last\s*(\d{1,5}))")
ONLY_CHOICES = ("images", "videos")


@dataclass(frozen=True)
class PageSpec:
    """Thread pages to read. Ranges may run to the end (10-) or count from it
    (last 5), so the real page numbers need the thread's last page."""

    text: str
    ranges: tuple[tuple[int, int | None], ...] = ()  # (first, last or None = to the end)
    last: int = 0  # the newest N pages

    @property
    def needs_end(self) -> bool:
        """True when the pages depend on how long the thread is."""
        return bool(self.last) or any(end is None for _, end in self.ranges)

    def fixed(self) -> set[int]:
        """The pages that are known without the thread's length."""
        return {p for start, end in self.ranges if end is not None for p in range(start, end + 1)}

    def resolve(self, last_page: int) -> set[int]:
        pages = self.fixed()
        for start, end in self.ranges:
            if end is None:
                pages.update(range(start, last_page + 1))
        if self.last:
            pages.update(range(max(1, last_page - self.last + 1), last_page + 1))
        return {p for p in pages if 1 <= p <= last_page}


def parse_thread_pages(spec: str | None) -> PageSpec | None:
    """'1-3', '1,3,4', '10-', 'last 5', '1-2,last 3' → PageSpec. '' / 'all' → None
    (every page). Raises ValueError with a readable message otherwise."""
    text = " ".join(str(spec or "").lower().split())
    if not text or text == "all":
        return None
    ranges: list[tuple[int, int | None]] = []
    last = 0
    for part in text.split(","):
        part = part.strip()
        m = _PART_RE.fullmatch(part)
        if not m:
            raise ValueError(f"thread pages: {part!r} is not a page, a range (2-4, 10-) or 'last N'")
        if m.group(4):
            n = int(m.group(4))
            if n < 1:
                raise ValueError("thread pages: 'last N' needs N of 1 or more")
            last = max(last, n)
            continue
        start = int(m.group(1))
        end = None if m.group(2) and m.group(3) is None else int(m.group(3) or start)
        if start < 1 or (end is not None and end < start):
            raise ValueError(f"thread pages: bad range {part!r}")
        ranges.append((start, end))
    return PageSpec(text=text, ranges=tuple(ranges), last=last)


def describe_pages(pages: set[int]) -> str:
    """{1, 2, 3, 7} → '1-3, 7'."""
    out, run = [], []
    for p in sorted(pages):
        if run and p == run[-1] + 1:
            run.append(p)
            continue
        if run:
            out.append(f"{run[0]}-{run[-1]}" if len(run) > 1 else str(run[0]))
        run = [p]
    if run:
        out.append(f"{run[0]}-{run[-1]}" if len(run) > 1 else str(run[0]))
    return ", ".join(out)


@dataclass
class RunFilter:
    pages: PageSpec | None = None
    only: str = ""  # "" both, "images", "videos"
    max_files: int = 0  # new files per model, 0 = no limit
    newest_first: bool = False

    @property
    def active(self) -> bool:
        """Anything that makes this run take less than the whole thread."""
        return bool(self.pages or self.only or self.max_files)

    def over(self, saved: RunFilter | None) -> RunFilter:
        """This run's choices, with a model's saved settings filling in what
        the run did not choose itself."""
        if saved is None:
            return self
        return RunFilter(
            pages=self.pages or saved.pages,
            only=self.only or saved.only,
            max_files=self.max_files or saved.max_files,
            newest_first=self.newest_first or saved.newest_first,
        )

    def describe(self) -> str:
        parts = []
        if self.pages:
            parts.append(f"thread pages {self.pages.text}")
        if self.only:
            parts.append(f"{self.only} only")
        if self.max_files:
            parts.append(f"at most {self.max_files} new files")
        if self.newest_first:
            parts.append("newest posts first")
        return " · ".join(parts)

    def select(self, links: list[MediaLink]) -> list[MediaLink]:
        """Drop links that are certainly the other type, then order them.
        Links whose type shows only once fetched (albums, extension-less files)
        stay: the downloaders check those."""
        kept = [link for link in links if not self.other_type(link)]
        if self.newest_first:
            # Last page first, and within a page the later posts first.
            kept = sorted(reversed(kept), key=lambda link: -(link.thread_page or 0))
        return kept

    def other_type(self, link: MediaLink) -> bool:
        if not self.only:
            return False
        kind = link_type(link)
        return kind is not None and kind != self.only

    def wrong_file(self, name: str) -> bool:
        """A downloaded file's name says it is the other type."""
        kind = name_type(name)
        return bool(self.only) and kind is not None and kind != self.only


def name_type(name: str) -> str | None:
    ext = _ext(name)
    if ext in IMAGE_EXT:
        return "images"
    if ext in VIDEO_EXT:
        return "videos"
    return None


# cyberdrop-dl hosts that only ever serve videos (goonbox also has pictures).
VIDEO_HOSTS = ("saint", "turbo", "redgifs")


def link_type(link: MediaLink) -> str | None:
    """'images' / 'videos' when the link alone says so, else None."""
    by_name = name_type(urlparse(link.url).path)
    if by_name:
        return by_name
    if link.prefer_cdl:
        host = (urlparse(link.url).hostname or "").lower()
        return "videos" if any(name in host for name in VIDEO_HOSTS) else None
    # Direct image hosts and their viewer pages are pictures.
    return "images" if link.kind == MediaKind.IMAGE else None


@dataclass
class Budget:
    """How many new files a model may still get this run (thread-safe). A
    download takes a slot before it writes and gives it back if it turns out
    to be a duplicate or fails, so direct downloads never go over."""

    left: int
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def take(self) -> bool:
        with self._lock:
            if self.left <= 0:
                return False
            self.left -= 1
            return True

    def give_back(self) -> None:
        with self._lock:
            self.left += 1

    def spent(self) -> bool:
        with self._lock:
            return self.left <= 0


def model_rules(state_dir: Path, say=print) -> dict[str, RunFilter]:
    """The saved settings per model (folder name → RunFilter). A setting that
    cannot be read is reported and left out, never guessed."""
    path = state_dir / MODEL_RULES
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        say(f"  could not read {path.name}: {exc}; no model settings used")
        return {}
    rules: dict[str, RunFilter] = {}
    for model, rule in (raw.items() if isinstance(raw, dict) else ()):
        if not isinstance(rule, dict):
            continue
        try:
            pages = parse_thread_pages(rule.get("threadPages") if isinstance(rule.get("threadPages"), str) else None)
        except ValueError as exc:
            say(f"  {model}: saved {exc}; that setting is ignored")
            pages = None
        only = rule.get("only") if rule.get("only") in ONLY_CHOICES else ""
        max_files = rule.get("maxFiles")
        max_files = max_files if isinstance(max_files, int) and not isinstance(max_files, bool) and max_files > 0 else 0
        filt = RunFilter(pages=pages, only=only, max_files=max_files, newest_first=rule.get("order") == "newest")
        if filt.active or filt.newest_first:
            rules[model] = filt
    return rules
