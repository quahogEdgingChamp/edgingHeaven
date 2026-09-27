from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

import httpx
from rich.console import Console
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn

from .config import Config
from .hosts import MediaKind, MediaLink
from .index import DownloadIndex
from .net import MEDIA_ACCEPT, ThreadClients
from .util import thread_slug_from_url

console = Console()


@dataclass
class SizeEstimate:
    known_bytes: int = 0
    known_files: int = 0
    unknown_files: int = 0  # HEAD failed / no Content-Length
    album_links: int = 0  # bunkr/gofile/etc — size TBD until CDL scrapes
    already_done: int = 0  # in the download index — not probed
    probed: int = 0

    @property
    def total_links(self) -> int:
        return self.known_files + self.unknown_files + self.album_links


def format_bytes(n: int) -> str:
    if n < 0:
        n = 0
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(n)
    for unit in units:
        if size < 1024.0 or unit == units[-1]:
            if unit == "B":
                return f"{int(size)} {unit}"
            return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{n} B"


def _head_size(client: httpx.Client, url: str) -> int | None:
    """Return Content-Length if available. None = unknown."""
    try:
        r = client.head(
            url, headers={"Accept": MEDIA_ACCEPT}, follow_redirects=True, timeout=20.0
        )
        if r.status_code >= 400:
            # Some CDNs dislike HEAD — try a ranged GET.
            r = client.get(
                url,
                headers={"Range": "bytes=0-0", "Accept": MEDIA_ACCEPT},
                follow_redirects=True,
                timeout=20.0,
            )
        cl = r.headers.get("content-length")
        if cl and cl.isdigit():
            return int(cl)
        cr = r.headers.get("content-range")  # bytes 0-0/12345
        if cr and "/" in cr:
            total = cr.rsplit("/", 1)[-1]
            if total.isdigit():
                return int(total)
    except Exception:
        return None
    return None


def estimate_links(
    client: httpx.Client,
    links: list[MediaLink],
    cfg: Config,
    est: SizeEstimate | None = None,
) -> SizeEstimate:
    est = est or SizeEstimate()
    probe: list[MediaLink] = []
    for link in links:
        if link.prefer_cdl or link.kind == MediaKind.ALBUM:
            est.album_links += 1
        else:
            probe.append(link)

    if not probe:
        return est

    workers = max(1, min(cfg.scrape.concurrency, 6))
    with ThreadClients(client, httpx.Timeout(20.0, connect=10.0)) as clients, Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total}"),
        TimeElapsedColumn(),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task("estimating sizes", total=len(probe))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(lambda l: _head_size(clients.get(), l.url), l) for l in probe]
            for fut in as_completed(futures):
                est.probed += 1
                size = fut.result()
                if size is not None and size > 0:
                    est.known_bytes += size
                    est.known_files += 1
                else:
                    est.unknown_files += 1
                progress.advance(task)

    return est


def print_estimate(est: SizeEstimate, *, label: str = "Estimate") -> None:
    known = format_bytes(est.known_bytes)
    console.print(
        f"[bold cyan]{label}:[/] ~{known} known across {est.known_files} file(s)"
        f" · {est.album_links} album/host link(s) (size TBD)"
        f" · {est.unknown_files} unknown"
        f" · {est.already_done} already downloaded"
    )
    if est.album_links:
        console.print(
            "  [dim]album/host totals appear only after cyberdrop-dl scrapes them[/]"
        )


def estimate_models(
    client: httpx.Client,
    models: list[tuple[str, list[MediaLink]]],
    cfg: Config,
) -> SizeEstimate:
    """Estimate what's left to fetch across (thread_url, links) pairs; print the total.

    Links already in a model's download index are counted, not probed.
    """
    console.print("[bold]Estimating download size…[/]")
    est = SizeEstimate()
    pending: list[MediaLink] = []
    for thread_url, links in models:
        index = DownloadIndex.for_model(cfg, thread_slug_from_url(thread_url))
        for link in links:
            if index.done(link.url):
                est.already_done += 1
            else:
                pending.append(link)
    estimate_links(client, pending, cfg, est)
    print_estimate(est)
    return est
