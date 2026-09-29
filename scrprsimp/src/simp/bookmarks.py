from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from rich.console import Console

from .config import Config
from .net import get_retry, wait_out_429
from .util import ensure_dir, polite_sleep, thread_slug_from_url

# soft_wrap: a long line stays one line in job logs (the page wraps it)
console = Console(soft_wrap=True)

_PAGE_RE = re.compile(r"[?&]page=(\d+)", re.I)
_TITLE_RE = re.compile(
    r"^(?:Post in thread|Thread)\s+['\"](.+?)['\"]\s*$",
    re.IGNORECASE,
)
_POST_ID_RE = re.compile(r"/posts/(\d+)", re.I)


@dataclass(frozen=True)
class Bookmark:
    url: str
    title: str


def clean_bookmark_title(raw: str) -> str:
    """Strip XenForo wrappers like Thread 'Name' / Post in thread 'Name'."""
    raw = (raw or "").strip()
    m = _TITLE_RE.match(raw)
    if m:
        return m.group(1).strip()
    return raw


def _normalize_thread_url(url: str) -> str | None:
    parsed = urlparse(url)
    path = parsed.path or ""
    if "/threads/" not in path:
        return None
    path = re.sub(r"/page-\d+/?$", "/", path)
    path = re.sub(r"/post-\d+/?$", "/", path)
    if not path.endswith("/"):
        path += "/"
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def _normalize_content_url(base: str, href: str) -> str | None:
    if not href:
        return None
    abs_url = urljoin(base, href)
    parsed = urlparse(abs_url)
    path = parsed.path
    if "/threads/" in path:
        return _normalize_thread_url(abs_url)
    if "/posts/" in path:
        m = _POST_ID_RE.search(path)
        if m:
            return f"{parsed.scheme}://{parsed.netloc}/posts/{m.group(1)}/"
    return None


class ResolveCache:
    """Persist post→thread mappings so we don't re-hit the forum."""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, str] = {}
        if path.is_file():
            try:
                self.data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                self.data = {}

    def get(self, post_url: str) -> str | None:
        return self.data.get(post_url)

    def put(self, post_url: str, thread_url: str) -> None:
        self.data[post_url] = thread_url

    def save(self) -> None:
        ensure_dir(self.path.parent)
        self.path.write_text(json.dumps(self.data, indent=2, sort_keys=True), encoding="utf-8")


def resolve_to_thread(
    client: httpx.Client,
    url: str,
    cache: ResolveCache | None = None,
    *,
    max_attempts: int = 5,
) -> str | None:
    """
    Map /posts/ID → /threads/slug.id/ using redirect Location only (no full page load).
    Caches results. Backs off hard on 429.
    """
    parsed = urlparse(url)
    path = parsed.path or ""

    if "/threads/" in path:
        return _normalize_thread_url(url)

    if "/posts/" not in path:
        return None

    post_url = _normalize_content_url(f"{parsed.scheme}://{parsed.netloc}", url) or url
    if cache:
        hit = cache.get(post_url)
        if hit:
            return hit

    for attempt in range(1, max_attempts + 1):
        try:
            # Do NOT follow redirects — Location already has the thread URL.
            # Avoids downloading heavy thread pages (main 429 trigger).
            r = client.get(post_url, follow_redirects=False)

            if r.status_code == 429:
                # Sometimes XF still exposes the thread in a redirect chain URL.
                maybe = _normalize_thread_url(str(r.url))
                if maybe:
                    if cache:
                        cache.put(post_url, maybe)
                    return maybe
                wait_out_429(r, attempt)
                continue

            if r.status_code in (301, 302, 303, 307, 308):
                loc = r.headers.get("Location") or r.headers.get("location")
                if loc:
                    dest = urljoin(str(r.url), loc)
                    thread = _normalize_thread_url(dest)
                    if thread:
                        if cache:
                            cache.put(post_url, thread)
                        return thread

            if r.status_code == 200:
                # Rare: post rendered inline — scrape thread link.
                soup = BeautifulSoup(r.text, "lxml")
                a = soup.select_one(
                    "h1.p-title-value a[href*='/threads/'], "
                    ".p-title-value a[href*='/threads/'], "
                    "a[href*='/threads/'][data-xf-init]"
                )
                if a and a.get("href"):
                    thread = _normalize_content_url(str(r.url), a["href"])
                    if thread and "/threads/" in thread:
                        if cache:
                            cache.put(post_url, thread)
                        return thread

            # Follow once as fallback (still cache + backoff).
            r2 = client.get(post_url, follow_redirects=True)
            if r2.status_code == 429:
                maybe = _normalize_thread_url(str(r2.url))
                if maybe:
                    if cache:
                        cache.put(post_url, maybe)
                    return maybe
                wait_out_429(r2, attempt)
                continue
            r2.raise_for_status()
            thread = _normalize_thread_url(str(r2.url))
            if thread:
                if cache:
                    cache.put(post_url, thread)
                return thread

        except httpx.HTTPStatusError as exc:
            maybe = _normalize_thread_url(str(exc.response.url))
            if maybe:
                if cache:
                    cache.put(post_url, maybe)
                return maybe
            if exc.response.status_code == 429:
                wait_out_429(exc.response, attempt)
                continue
            console.print(f"  [yellow]could not resolve post[/] {post_url} ({exc})")
            return None
        except httpx.TransportError as exc:
            console.print(f"  [yellow]resolve transport error[/] ({exc}) retry {attempt}/{max_attempts}")
            polite_sleep(2.0 * attempt, 4.0 * attempt)

    console.print(f"  [red]gave up resolving[/] {post_url}")
    return None


def _max_page(soup: BeautifulSoup) -> int:
    nav = soup.select_one(".pageNav-main")
    if not nav:
        return 1
    nums: list[int] = []
    for a in nav.select("a, li"):
        text = a.get_text(strip=True)
        if text.isdigit():
            nums.append(int(text))
        href = a.get("href") if hasattr(a, "get") else None
        if href:
            m = _PAGE_RE.search(href)
            if m:
                nums.append(int(m.group(1)))
    return max(nums) if nums else 1


def _parse_bookmark_rows(soup: BeautifulSoup, base: str) -> list[tuple[str, str]]:
    """Return (href, raw_title) in page order — posts and threads."""
    found: list[tuple[str, str]] = []
    seen: set[str] = set()

    for title_el in soup.select(".contentRow-title a[href]"):
        href = title_el.get("href", "")
        url = _normalize_content_url(base, href)
        if not url:
            continue
        if "/threads/" not in url and "/posts/" not in url:
            continue
        title = title_el.get_text(" ", strip=True) or url
        if url in seen:
            continue
        seen.add(url)
        found.append((url, title))

    return found


def _should_skip(title: str, needles: list[str]) -> bool:
    low = title.lower()
    return any(n.lower() in low for n in needles if n)


def parse_page_spec(spec: str | int | None, last_page: int | None = None) -> list[int] | None:
    """
    Parse --page / --pages into a sorted unique list of 1-based page numbers.
    None / empty / 'all' → None (meaning every page).
    Accepts: 3 | "3" | "2-4" | "1,3,8" | "2-3,7"
    """
    if spec is None or spec == "" or spec == 0:
        return None
    if isinstance(spec, int):
        if spec < 1:
            raise ValueError(f"page must be >= 1, got {spec}")
        return [spec]

    text = str(spec).strip().lower()
    if not text or text == "all":
        return None

    pages: set[int] = set()
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a.strip()), int(b.strip())
            if start < 1 or end < start:
                raise ValueError(f"bad page range: {part!r}")
            pages.update(range(start, end + 1))
        else:
            n = int(part)
            if n < 1:
                raise ValueError(f"page must be >= 1, got {n}")
            pages.add(n)

    ordered = sorted(pages)
    if last_page is not None:
        too_high = [p for p in ordered if p > last_page]
        if too_high:
            console.print(
                f"  [yellow]note:[/] requested page(s) {too_high} beyond last page {last_page} — skipping those"
            )
            ordered = [p for p in ordered if p <= last_page]
    return ordered


def fetch_bookmarks(
    client: httpx.Client,
    cfg: Config,
    limit: int = 0,
    pages: str | int | None = None,
) -> list[Bookmark]:
    """
    Paginate /account/bookmarks in site order.

    Post bookmarks resolve via redirect Location (cached). Deduped by thread URL.
    `pages` selects bookmark list pages (e.g. 3 or "2-4" or "1,8").
    """
    base = cfg.site.base_url.rstrip("/")
    skip = cfg.scrape.skip_title_contains
    want = limit if limit and limit > 0 else 0
    cache = ResolveCache(cfg.resolve(cfg.paths.state_dir) / "post_resolve_cache.json")

    # Resolve pacing — slower than page fetches to stay under rate limits.
    resolve_lo = max(cfg.scrape.delay_min, 1.5)
    resolve_hi = max(cfg.scrape.delay_max, resolve_lo + 1.0)

    console.print("[bold cyan]Fetching bookmarks…[/]")
    # Always hit page 1 first to learn last_page (and maybe use its rows).
    first = get_retry(client, "/account/bookmarks", params={"difference": 0})
    if first is None:
        raise RuntimeError("Could not load /account/bookmarks after retries.")
    soup = BeautifulSoup(first.text, "lxml")
    last_page = _max_page(soup)
    selected = parse_page_spec(pages, last_page=last_page)
    if selected is None:
        selected = list(range(1, last_page + 1))
    console.print(
        f"  bookmark pages: {', '.join(str(p) for p in selected)}  "
        f"(site has {last_page})"
    )

    all_bm: list[Bookmark] = []
    seen_threads: set[str] = set()

    def absorb_raw(rows: list[tuple[str, str]]) -> bool:
        for raw_url, raw_title in rows:
            title = clean_bookmark_title(raw_title)
            if _should_skip(title, skip) or _should_skip(raw_title, skip):
                continue

            needs_resolve = "/posts/" in raw_url
            thread_url = resolve_to_thread(client, raw_url, cache)
            if not thread_url:
                continue
            if thread_url in seen_threads:
                continue
            seen_threads.add(thread_url)

            slug = thread_slug_from_url(thread_url)
            label = title or slug
            all_bm.append(Bookmark(url=thread_url, title=label))
            console.print(f"    + {slug}  ({label})")

            if want and len(all_bm) >= want:
                return True

            if needs_resolve:
                polite_sleep(resolve_lo, resolve_hi)
        return False

    def load_page(page: int) -> BeautifulSoup | None:
        if page == 1:
            return BeautifulSoup(first.text, "lxml")
        polite_sleep(cfg.scrape.delay_min, cfg.scrape.delay_max)
        r = get_retry(
            client,
            "/account/bookmarks",
            params={"difference": 0, "page": page},
        )
        if r is None:
            console.print(f"  [yellow]skipping page {page} after failures[/]")
            return None
        return BeautifulSoup(r.text, "lxml")

    try:
        for page in selected:
            soup = load_page(page)
            if soup is None:
                continue
            if absorb_raw(_parse_bookmark_rows(soup, base)):
                console.print(f"  [dim]hit --limit {want}, stopping bookmark crawl early[/]")
                return all_bm[:want]
            console.print(
                f"  page {page}/{last_page} → {len(all_bm)} model threads so far"
            )
    finally:
        cache.save()
        console.print(f"  [dim]resolve cache saved ({len(cache.data)} entries)[/]")

    return all_bm[:want] if want else all_bm


def fetch_watched(
    client: httpx.Client,
    cfg: Config,
    limit: int = 0,
) -> list[Bookmark]:
    base = cfg.site.base_url.rstrip("/")
    skip = cfg.scrape.skip_title_contains
    want = limit if limit and limit > 0 else 0

    console.print("[bold cyan]Fetching watched threads…[/]")
    first = get_retry(client, "/watched/threads")
    if first is None:
        raise RuntimeError("Could not load /watched/threads after retries.")
    soup = BeautifulSoup(first.text, "lxml")
    last_page = _max_page(soup)

    all_bm: list[Bookmark] = []
    seen: set[str] = set()

    def parse_watched(s: BeautifulSoup) -> list[Bookmark]:
        rows: list[Bookmark] = []
        for a in s.select(".structItem-title a[href*='/threads/']"):
            href = a.get("href", "")
            url = _normalize_content_url(base, href) if href else None
            if not url or "/threads/" not in url:
                continue
            title = clean_bookmark_title(a.get_text(" ", strip=True)) or thread_slug_from_url(url)
            if _should_skip(title, skip):
                continue
            rows.append(Bookmark(url=url, title=title))
        return rows

    def absorb(rows: list[Bookmark]) -> bool:
        for b in rows:
            if b.url in seen:
                continue
            seen.add(b.url)
            all_bm.append(b)
            if want and len(all_bm) >= want:
                return True
        return False

    if absorb(parse_watched(soup)):
        return all_bm[:want]
    console.print(f"  page 1/{last_page} → {len(all_bm)} watched so far")

    for page in range(2, last_page + 1):
        polite_sleep(cfg.scrape.delay_min, cfg.scrape.delay_max)
        r = get_retry(client, "/watched/threads", params={"page": page})
        if r is None:
            console.print(f"  [yellow]skipping watched page {page}[/]")
            continue
        if absorb(parse_watched(BeautifulSoup(r.text, "lxml"))):
            return all_bm[:want]
        console.print(f"  page {page}/{last_page} → {len(all_bm)} watched so far")

    return all_bm[:want] if want else all_bm


def collect_targets(
    client: httpx.Client,
    cfg: Config,
    limit: int = 0,
    pages: str | int | None = None,
) -> list[Bookmark]:
    bookmarks = fetch_bookmarks(client, cfg, limit=limit, pages=pages)
    if cfg.scrape.include_watched:
        remaining = 0
        if limit and limit > 0:
            remaining = max(0, limit - len(bookmarks))
            if remaining == 0:
                console.print(f"[green]Collected {len(bookmarks)} model threads[/]")
                return bookmarks
        watched = fetch_watched(client, cfg, limit=remaining or 0)
        seen = {b.url for b in bookmarks}
        for w in watched:
            if w.url not in seen:
                bookmarks.append(w)
                seen.add(w.url)
            if limit and limit > 0 and len(bookmarks) >= limit:
                break
    if limit and limit > 0:
        bookmarks = bookmarks[:limit]
    console.print(f"[green]Collected {len(bookmarks)} model threads[/]")
    return bookmarks
