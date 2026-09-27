from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from bs4 import BeautifulSoup, Tag
from rich.console import Console

from .config import Config
from .hosts import (
    MediaLink,
    classify_url,
    is_excluded_ext,
    is_wanted,
    link_to_dict,
    links_from_rows,
    with_thread_page,
)
from .net import get_retry
from .util import absolute_url, ensure_dir, polite_sleep, sanitize_filename

console = Console()

_PAGE_RE = re.compile(r"/page-(\d+)", re.I)


def _max_thread_page(soup: BeautifulSoup) -> int:
    nums: list[int] = []
    for a in soup.select(".pageNav-main a[href], .pageNav a[href]"):
        href = a.get("href", "")
        m = _PAGE_RE.search(href)
        if m:
            nums.append(int(m.group(1)))
        text = a.get_text(strip=True)
        if text.isdigit():
            nums.append(int(text))
    return max(nums) if nums else 1


def _unwrap_redirect(url: str) -> str:
    """Decode XenForo /redirect/?to=base64 links."""
    parsed = urlparse(url)
    if "/redirect" in parsed.path and "to" in parse_qs(parsed.query):
        raw = parse_qs(parsed.query).get("to", [""])[0]
        try:
            decoded = base64.b64decode(raw).decode("utf-8", "ignore")
            if decoded.startswith("http"):
                return decoded
        except Exception:
            try:
                decoded = unquote(raw)
                if decoded.startswith("http"):
                    return decoded
            except Exception:
                pass
    return url


def _fullsize_image_url(url: str) -> str:
    """Prefer original over .md/.th thumbnails on jpg*/simp CDN hosts."""
    for needle in (".md.", ".th.", ".md/", ".th/"):
        if needle in url:
            url = url.replace(".md.", ".").replace(".th.", ".")
            url = url.replace(".md/", "/").replace(".th/", "/")
    # common pattern: file.md.jpg → file.jpg
    url = re.sub(r"\.md\.(jpe?g|png|webp|gif)$", r".\1", url, flags=re.I)
    url = re.sub(r"\.th\.(jpe?g|png|webp|gif)$", r".\1", url, flags=re.I)
    return url


def extract_media_from_html(
    html: str,
    page_url: str,
    cfg: Config,
    *,
    thread_page: int = 1,
) -> list[MediaLink]:
    soup = BeautifulSoup(html, "lxml")
    found: list[MediaLink] = []
    seen: set[str] = set()

    def add(raw_url: str, source: str) -> None:
        if not raw_url:
            return
        url = absolute_url(page_url, raw_url)
        url = _unwrap_redirect(url)
        url = _fullsize_image_url(url)
        if is_excluded_ext(url, cfg.download.exclude_extensions):
            return
        link = classify_url(
            url, source=source, exclude_extensions=cfg.download.exclude_extensions
        )
        if not link:
            return
        if not is_wanted(link, cfg.download.images, cfg.download.videos):
            return
        if link.url in seen:
            return
        seen.add(link.url)
        found.append(with_thread_page(link, thread_page))

    # Restrict to post bodies — skip nav/sidebar/avatars.
    bodies: list[Tag] = list(soup.select("article.message-body, .message-userContent, .bbWrapper"))
    if not bodies:
        bodies = [soup]  # type: ignore[list-item]

    for body in bodies:
        # Native / lightbox images
        for img in body.select("img.bbImage, img[data-url], a.js-lbImage img, .bbImageWrapper img"):
            for attr in ("data-url", "data-src", "src"):
                val = img.get(attr)
                if val and not val.startswith("data:"):
                    add(val, "bbimage")
                    break
            parent = img.parent
            if parent and parent.name == "a" and parent.get("href"):
                add(parent["href"], "bbimage-link")

        # Attachment links
        for a in body.select("a[href*='/attachments/'], a.file-preview"):
            add(a.get("href", ""), "attachment")

        # External links + embeds
        for a in body.select("a[href]"):
            href = a.get("href", "")
            if not href:
                continue
            add(href, "href")

        for video in body.select("video source[src], video[src], iframe[src]"):
            add(video.get("src", ""), "embed")

        # BB media / data- attributes used by some embeds
        for el in body.select("[data-url], [data-src], [data-media-site-id]"):
            for attr in ("data-url", "data-src"):
                if el.get(attr):
                    add(el[attr], "data-attr")

    return found


def _page_url(thread_url: str, page: int) -> str:
    return thread_url if page <= 1 else thread_url.rstrip("/") + f"/page-{page}"


def _page_of(url: str) -> int:
    m = _PAGE_RE.search(urlparse(url).path)
    return int(m.group(1)) if m else 1


def crawl_cache_path(cfg: Config, thread_url: str) -> Path:
    """state/crawl/<host>_<slug.id>.json — host included so a mirror switch recrawls."""
    parsed = urlparse(thread_url)
    key = parsed.path.rstrip("/").rsplit("/", 1)[-1]
    return (
        cfg.resolve(cfg.paths.state_dir)
        / "crawl"
        / f"{sanitize_filename(parsed.hostname or 'forum')}_{sanitize_filename(key)}.json"
    )


def _load_crawl_cache(path: Path, cfg: Config) -> dict | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None
    links = links_from_rows(
        data.get("links", []), exclude_extensions=cfg.download.exclude_extensions
    )
    data["links"] = [
        l for l in links if is_wanted(l, cfg.download.images, cfg.download.videos)
    ]
    return data


def _save_crawl_cache(
    path: Path, thread_url: str, last_page: int, failed: list[int], links: list[MediaLink]
) -> None:
    ensure_dir(path.parent)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(
            {
                "thread": thread_url,
                "last_page": last_page,
                "failed_pages": failed,
                "links": [link_to_dict(l) for l in links],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    tmp.replace(path)


def crawl_thread(
    client: httpx.Client,
    thread_url: str,
    cfg: Config,
    *,
    full: bool = False,
) -> list[MediaLink]:
    """
    Collect media links from every page of a model thread.

    Links found earlier are cached in state/crawl/; a later crawl resumes at the
    last page it saw (new posts only ever land there or after), plus any pages
    that failed. full=True ignores the cache and starts from page 1.
    """
    cache_file = crawl_cache_path(cfg, thread_url)
    cached = None if full else _load_crawl_cache(cache_file, cfg)
    old_links: list[MediaLink] = cached["links"] if cached else []
    start = int(cached.get("last_page") or 1) if cached else 1
    retry_pages = {int(p) for p in cached.get("failed_pages", [])} if cached else set()

    if cached:
        console.print(
            f"  crawling [cyan]{thread_url}[/] from page {start} "
            f"({len(old_links)} links cached)"
        )
    else:
        console.print(f"  crawling [cyan]{thread_url}[/]")

    first = get_retry(client, _page_url(thread_url, start))
    if first is None:
        if cached:
            console.print("    [yellow]thread unreachable — using cached links[/]")
            return old_links
        raise RuntimeError(f"could not load {thread_url}")
    # XenForo redirects a page past the end to the real last page.
    start = _page_of(str(first.url))
    last_page = max(_max_thread_page(BeautifulSoup(first.text, "lxml")), start)

    fresh = extract_media_from_html(first.text, str(first.url), cfg, thread_page=start)
    failed: list[int] = []
    todo = sorted(
        (set(range(start + 1, last_page + 1)) | retry_pages) - {start}
    )
    for page in (p for p in todo if p <= last_page):
        polite_sleep(cfg.scrape.delay_min, cfg.scrape.delay_max)
        r = get_retry(client, _page_url(thread_url, page))
        if r is None:
            console.print(f"    [yellow]skipping page {page} — will retry next crawl[/]")
            failed.append(page)
            continue
        fresh.extend(
            extract_media_from_html(r.text, str(r.url), cfg, thread_page=page)
        )

    # De-dupe preserving order
    seen: set[str] = set()
    unique: list[MediaLink] = []
    for link in old_links + fresh:
        if link.url in seen:
            continue
        seen.add(link.url)
        unique.append(link)

    _save_crawl_cache(cache_file, thread_url, last_page, failed, unique)
    new = len(unique) - len(old_links)
    console.print(
        f"    → {len(unique)} media URLs ({new} new, {last_page} "
        f"page{'s' if last_page != 1 else ''})"
    )
    return unique
