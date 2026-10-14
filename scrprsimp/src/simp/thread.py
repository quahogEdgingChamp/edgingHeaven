from __future__ import annotations

import base64
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from bs4 import BeautifulSoup, Tag
from rich.console import Console

from .config import Config
from .filters import PageSpec, describe_pages
from .hosts import (
    MediaLink,
    classify_url,
    is_excluded_ext,
    is_wanted,
    link_to_dict,
    links_from_rows,
    with_thread_page,
)
from .net import bounded_results, get_retry
from .util import absolute_url, ensure_dir, looks_like_login_page, polite_sleep, sanitize_filename

# soft_wrap: a long line stays one line in job logs (the page wraps it)
console = Console(soft_wrap=True)

_PAGE_RE = re.compile(r"/page-(\d+)", re.I)


class CrawlLinks(list[MediaLink]):
    """Usable links plus pages that must be retried; list-compatible for callers."""

    def __init__(self, links=(), *, failed_pages=()):
        super().__init__(links)
        self.failed_pages = tuple(sorted(set(failed_pages)))


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
    # Pictures that only preview a link cyberdrop-dl downloads (see below).
    previews: set[str] = set()

    def normalize(raw_url: str) -> str:
        return _fullsize_image_url(_unwrap_redirect(absolute_url(page_url, raw_url)))

    def resolve(raw_url: str, source: str) -> MediaLink | None:
        if not raw_url:
            return None
        url = normalize(raw_url)
        if url in previews or is_excluded_ext(url, cfg.download.exclude_extensions):
            return None
        link = classify_url(
            url, source=source, exclude_extensions=cfg.download.exclude_extensions
        )
        if not link or not is_wanted(link, cfg.download.images, cfg.download.videos):
            return None
        return link

    def add(raw_url: str, source: str) -> None:
        link = resolve(raw_url, source)
        if not link or link.url in seen:
            return
        seen.add(link.url)
        found.append(with_thread_page(link, thread_page))

    def image_src(img: Tag) -> str:
        for attr in ("data-url", "data-src", "src"):
            val = img.get(attr)
            if val and not val.startswith("data:"):
                return val
        return ""

    # Restrict to post bodies — skip nav/sidebar/avatars.
    bodies: list[Tag] = list(soup.select("article.message-body, .message-userContent, .bbWrapper"))
    if not bodies:
        bodies = [soup]  # type: ignore[list-item]

    images = "img.bbImage, img[data-url], a.js-lbImage img, .bbImageWrapper img"

    def wrapping_href(img: Tag) -> str:
        parent = img.parent
        return parent.get("href", "") if parent and parent.name == "a" else ""

    # A picture linked to a host cyberdrop-dl handles (a goonbox.cr/img page
    # around its simp6.cuckcapital.cr file, an album around its cover) is that
    # link's own file: fetching both put every picture on the drive twice, once
    # in the model folder, once in "... (GoonBox)". Only the link is kept.
    for body in bodies:
        for img in body.select(images):
            src, target = image_src(img), resolve(wrapping_href(img), "bbimage-link")
            if src and target and target.prefer_cdl and normalize(src) != target.url:
                previews.add(normalize(src))

    for body in bodies:
        # Native / lightbox images
        for img in body.select(images):
            add(image_src(img), "bbimage")
            add(wrapping_href(img), "bbimage-link")

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
    path: Path,
    thread_url: str,
    last_page: int,
    failed: list[int],
    links: list[MediaLink],
    gaps: list[int] = (),
) -> None:
    # "thread" and "last_page" first: Edging Heaven reads only the file's head.
    ensure_dir(path.parent)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(
            {
                "thread": thread_url,
                "last_page": last_page,
                "failed_pages": sorted(failed),
                # Pages up to last_page never read (a run that took only some
                # pages): the next whole-thread run reads them.
                "gaps": sorted(gaps),
                "links": [link_to_dict(l) for l in links],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    tmp.replace(path)


def _fetch_pages(
    client: httpx.Client, thread_url: str, cfg: Config, todo: list[int]
) -> tuple[dict[int, list[MediaLink]], list[int]]:
    """Read these thread pages, a few at a time: ({page: links}, failed pages)."""

    def paced_pages():
        for page in todo:
            polite_sleep(cfg.scrape.delay_min, cfg.scrape.delay_max)
            yield page

    def fetch_page(page):
        r = get_retry(client, _page_url(thread_url, page))
        if r is None or looks_like_login_page(r.text) or "/login" in str(r.url):
            return None
        return extract_media_from_html(r.text, str(r.url), cfg, thread_page=page)

    workers = max(1, min(cfg.scrape.page_concurrency, 4))
    pages: dict[int, list[MediaLink]] = {}
    failed: list[int] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for page, links in bounded_results(pool, fetch_page, paced_pages(), workers):
            if links is None:
                console.print(f"    [yellow]skipping page {page} — will retry next crawl[/]")
                failed.append(page)
            else:
                pages[page] = links
    return pages, failed


def _unique(links: list[MediaLink]) -> list[MediaLink]:
    seen: set[str] = set()
    unique: list[MediaLink] = []
    for link in links:
        if link.url not in seen:
            seen.add(link.url)
            unique.append(link)
    return unique


def _usable(response: httpx.Response | None) -> bool:
    return not (response is None or looks_like_login_page(response.text) or "/login" in str(response.url))


def crawl_thread(
    client: httpx.Client,
    thread_url: str,
    cfg: Config,
    *,
    full: bool = False,
    pages: PageSpec | None = None,
) -> CrawlLinks:
    """
    Collect media links and report pages that could not be fetched.

    Links found earlier are cached in state/crawl/; a later crawl resumes at the
    last page it saw (new posts only ever land there or after), plus any pages
    that failed or were never read. full=True ignores the cache and starts from
    page 1. pages= reads only those pages (see crawl_pages).
    """
    if pages is not None:
        return crawl_pages(client, thread_url, cfg, pages, full=full)
    cache_file = crawl_cache_path(cfg, thread_url)
    cached = None if full else _load_crawl_cache(cache_file, cfg)
    old_links: list[MediaLink] = cached["links"] if cached else []
    start = int(cached.get("last_page") or 1) if cached else 1
    retry_pages = {int(p) for p in cached.get("failed_pages", [])} if cached else set()
    gaps = {int(p) for p in cached.get("gaps", [])} if cached else set()

    if cached:
        console.print(
            f"  crawling [cyan]{thread_url}[/] from page {start} "
            f"({len(old_links)} links cached"
            + (f", {len(gaps)} pages never read" if gaps else "")
            + ")"
        )
    else:
        console.print(f"  crawling [cyan]{thread_url}[/]")

    first = get_retry(client, _page_url(thread_url, start))
    if not _usable(first):
        if cached:
            console.print("    [yellow]thread unreachable — using cached links[/]")
            return CrawlLinks(old_links, failed_pages=retry_pages | {start})
        raise RuntimeError(f"could not load {thread_url}")
    # XenForo redirects a page past the end to the real last page.
    start = _page_of(str(first.url))
    last_page = max(_max_thread_page(BeautifulSoup(first.text, "lxml")), start)

    fresh = extract_media_from_html(first.text, str(first.url), cfg, thread_page=start)
    todo = sorted(
        p for p in (set(range(start + 1, last_page + 1)) | retry_pages | gaps) - {start} if p <= last_page
    )
    found, failed = _fetch_pages(client, thread_url, cfg, todo)
    for page in sorted(found):
        fresh.extend(found[page])

    unique = _unique(old_links + fresh)
    _save_crawl_cache(cache_file, thread_url, last_page, failed, unique)
    new = len(unique) - len(old_links)
    console.print(
        f"    → {len(unique)} media URLs ({new} new, {last_page} "
        f"page{'s' if last_page != 1 else ''})"
    )
    return CrawlLinks(unique, failed_pages=failed)


# Asks XenForo for the last page: a page past the end redirects there.
_PAST_THE_END = 10**6


def crawl_pages(
    client: httpx.Client,
    thread_url: str,
    cfg: Config,
    spec: PageSpec,
    *,
    full: bool = False,
) -> CrawlLinks:
    """Links on the chosen thread pages only.

    Pages the cache already covers come from it; the rest, and the cached last
    page (new posts land there), are read. The cache keeps everything found,
    and pages it has never read are saved as gaps, so a later whole-thread run
    reads them instead of taking them for done."""
    cache_file = crawl_cache_path(cfg, thread_url)
    cached = None if full else _load_crawl_cache(cache_file, cfg)
    old_links: list[MediaLink] = cached["links"] if cached else []
    old_last = int(cached.get("last_page") or 0) if cached else 0
    old_failed = {int(p) for p in cached.get("failed_pages", [])} if cached else set()
    old_gaps = {int(p) for p in cached.get("gaps", [])} if cached else set()
    # Read before and complete: everything below the cached last page.
    covered = set(range(1, old_last)) - old_failed - old_gaps

    console.print(f"  crawling [cyan]{thread_url}[/], thread pages {spec.text}")
    if not spec.needs_end and spec.fixed() <= covered:
        # All of them read before, and none can have changed: no request.
        chosen = spec.fixed()
        links = [l for l in old_links if l.thread_page in chosen]
        console.print(f"    → {len(links)} media URLs on pages {describe_pages(chosen)} (all cached)")
        return CrawlLinks(links)

    uncovered = sorted(spec.fixed() - covered)
    probe = uncovered[0] if uncovered else _PAST_THE_END
    first = get_retry(client, _page_url(thread_url, probe))
    if not _usable(first):
        if cached:
            console.print("    [yellow]thread unreachable — using cached links[/]")
            chosen = spec.resolve(max(old_last, 1)) if spec.needs_end else spec.fixed()
            links = [l for l in old_links if l.thread_page in chosen]
            return CrawlLinks(links, failed_pages=(chosen - covered) or {probe})
        raise RuntimeError(f"could not load {thread_url}")
    landed = _page_of(str(first.url))
    last_page = max(_max_thread_page(BeautifulSoup(first.text, "lxml")), landed)
    chosen = spec.resolve(last_page)
    if not chosen:
        console.print(f"    [yellow]the thread has {last_page} pages: none of {spec.text} exist[/]")

    # The page it landed on is kept even when not chosen: it was read.
    found = {landed: extract_media_from_html(first.text, str(first.url), cfg, thread_page=landed)}
    todo = sorted(chosen - covered - {landed})
    more, failed = _fetch_pages(client, thread_url, cfg, todo)
    found.update(more)

    fresh = [link for page in sorted(found) for link in found[page]]
    read = set(found)
    new_last = max(old_last, last_page)
    unread = set(range(max(old_last, 1), new_last + 1)) if last_page > old_last else set()
    gaps = (old_gaps | unread) - read - set(failed)
    failed_pages = (old_failed - read) | set(failed)
    unique = _unique(old_links + fresh)
    _save_crawl_cache(cache_file, thread_url, new_last, sorted(failed_pages), unique, sorted(gaps))

    links = [l for l in unique if l.thread_page in chosen]
    console.print(
        f"    → {len(links)} media URLs on pages {describe_pages(chosen) or 'none'} "
        f"of {last_page} ({len(read)} read, {len(chosen & covered)} cached)"
    )
    return CrawlLinks(links, failed_pages=failed)
