"""Bookmarks with preview pictures, for Edging Heaven's Bookmarks page.

`simp bookmarks --save` writes state/bookmarks.json: every bookmarked model
thread in site order. Models not downloaded yet also get a few small preview
pictures from the thread's first page, saved in state/previews/<model>/.
Models whose folder already has files get none: Edging Heaven shows their own
files instead, and those need no request at all.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import httpx
from bs4 import BeautifulSoup
from rich.console import Console

from .bookmarks import Bookmark
from .config import Config
from .net import MEDIA_ACCEPT, get_retry
from .util import absolute_url, ensure_dir, polite_sleep, thread_slug_from_url

# soft_wrap: a long line stays one line in job logs (the page wraps it)
console = Console(soft_wrap=True)

PREVIEW_MAX_BYTES = 1_500_000
PREVIEW_TYPES = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
}
# Pictures in a post that are not the model: forum chrome, smilies, avatars.
_NOT_PREVIEWS = ("/styles/", "smilie", "/avatars/", "/data/avatars", "emoji")


def bookmarks_path(cfg: Config) -> Path:
    return cfg.resolve(cfg.paths.state_dir) / "bookmarks.json"


def previews_dir(cfg: Config) -> Path:
    return cfg.resolve(cfg.paths.state_dir) / "previews"


def preview_urls(html: str, page_url: str, limit: int) -> list[str]:
    """The first pictures in a thread page's posts, as shown (the thumbnail,
    not the full-size image it links to)."""
    soup = BeautifulSoup(html, "lxml")
    bodies = soup.select("article.message-body, .message-userContent, .bbWrapper") or [soup]
    found: list[str] = []
    for body in bodies:
        for img in body.select("img.bbImage, .bbImageWrapper img, a.js-lbImage img, .file-preview img, .attachment img"):
            src = next(
                (img.get(attr) for attr in ("src", "data-src", "data-url")
                 if img.get(attr) and not img.get(attr).startswith("data:")),
                None,
            )
            if not src:
                continue
            url = absolute_url(page_url, src)
            if url in found or any(part in url.lower() for part in _NOT_PREVIEWS):
                continue
            found.append(url)
            if len(found) >= limit:
                return found
    return found


def _save_picture(client: httpx.Client, url: str, dest: Path) -> Path | None:
    """One preview picture, or None if it is not a small image."""
    try:
        with client.stream("GET", url, headers={"Accept": MEDIA_ACCEPT}, follow_redirects=True, timeout=30.0) as r:
            ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
            ext = PREVIEW_TYPES.get(ctype)
            if r.status_code >= 400 or ext is None:
                return None
            data = b""
            for chunk in r.iter_bytes(64 * 1024):
                data += chunk
                if len(data) > PREVIEW_MAX_BYTES:
                    return None
    except (httpx.HTTPError, OSError):
        return None
    if not data:
        return None
    target = dest.with_suffix(ext)
    tmp = target.with_name(target.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(target)
    return target


def fetch_previews(client: httpx.Client, thread_url: str, folder: Path, limit: int) -> list[str]:
    """Save up to `limit` pictures from the thread's first page into folder."""
    r = get_retry(client, thread_url)
    if r is None:
        return []
    names: list[str] = []
    # A few spares, for thumbnails that fail or turn out not to be images.
    for url in preview_urls(r.text, str(r.url), limit * 3):
        saved = _save_picture(client, url, ensure_dir(folder) / str(len(names)))
        if saved:
            names.append(saved.name)
            if len(names) >= limit:
                break
    return names


def _has_files(folder: Path) -> bool:
    try:
        return any(p.is_file() for p in folder.rglob("*"))
    except OSError:
        return False


def _write(cfg: Config, rows: list[dict], complete: bool) -> None:
    path = bookmarks_path(cfg)
    ensure_dir(path.parent)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(
            {"updatedAt": datetime.now(timezone.utc).isoformat(), "complete": complete, "bookmarks": rows},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    tmp.replace(path)


def save_bookmarks(client: httpx.Client, cfg: Config, bookmarks: list[Bookmark], limit: int = 3) -> list[dict]:
    """Write state/bookmarks.json, fetching previews where needed.

    Saved every ten models with "complete": false, so a run that is cancelled
    halfway still leaves what it had; previews of models no longer
    bookmarked are removed at the end of a full run."""
    root = previews_dir(cfg)
    rows: list[dict] = []
    fetched = 0
    for i, bm in enumerate(bookmarks, 1):
        model = thread_slug_from_url(bm.url)
        folder = root / model
        downloaded = _has_files(cfg.models_root() / model)
        previews = sorted(p.name for p in folder.glob("*") if p.is_file() and not p.name.endswith(".part")) if folder.is_dir() else []
        if not downloaded and not previews and limit > 0:
            if fetched:
                polite_sleep(cfg.scrape.delay_min, cfg.scrape.delay_max)
            previews = fetch_previews(client, bm.url, folder, limit)
            fetched += 1
            console.print(f"  previews ({i}/{len(bookmarks)}) {model}: {len(previews)}")
        rows.append({"url": bm.url, "title": bm.title, "model": model, "downloaded": downloaded, "previews": previews})
        if i % 10 == 0:
            _write(cfg, rows, complete=False)
    _write(cfg, rows, complete=True)

    keep = {row["model"] for row in rows}
    if root.is_dir():
        for stale in root.iterdir():
            if stale.is_dir() and stale.name not in keep:
                shutil.rmtree(stale)
    have = sum(row["downloaded"] for row in rows)
    console.print(
        f"[green]Saved {len(rows)} bookmarks[/] → {bookmarks_path(cfg)} "
        f"({have} already downloaded, {fetched} previewed now)"
    )
    return rows
