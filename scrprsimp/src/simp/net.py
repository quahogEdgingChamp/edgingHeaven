from __future__ import annotations

import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from collections.abc import Callable, Iterable, Iterator
from typing import TypeVar

import httpx
from rich.console import Console

from .util import polite_sleep

# soft_wrap: a long line stays one line in job logs (the page wraps it)
console = Console(soft_wrap=True)
T = TypeVar("T")
R = TypeVar("R")


def bounded_results(
    pool: ThreadPoolExecutor, fn: Callable[[T], R], items: Iterable[T], limit: int,
) -> Iterator[tuple[T, R]]:
    """Keep only `limit` futures in memory; replenish as workers finish."""
    iterator = iter(items)
    pending = {}
    try:
        while True:
            while len(pending) < limit:
                try:
                    item = next(iterator)
                except StopIteration:
                    break
                pending[pool.submit(fn, item)] = item
            if not pending:
                return
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                yield pending.pop(future), future.result()
    finally:
        for future in pending:
            future.cancel()


# The forum client asks for HTML first (like a browser loading a page). Some hosts
# (GIPHY) honour that and serve their web page instead of the file, so media
# requests ask for media first.
MEDIA_ACCEPT = "image/avif,image/webp,image/*,video/*,*/*;q=0.8"


def retry_after_seconds(
    response: httpx.Response | None,
    attempt: int,
    *,
    base: float = 30.0,
    cap: float = 180.0,
) -> float:
    """Backoff for 429/5xx: base * attempt, or Retry-After if longer, capped."""
    delay = base * attempt
    ra = response.headers.get("Retry-After") if response is not None else None
    if ra:
        try:
            delay = max(delay, float(ra))
        except ValueError:
            pass
    return min(delay, cap)


def wait_out_429(response: httpx.Response | None, attempt: int) -> None:
    delay = retry_after_seconds(response, attempt)
    console.print(f"  [yellow]rate limited (429) — sleeping {delay:.0f}s[/]")
    time.sleep(delay)


def get_retry(
    client: httpx.Client,
    url: str,
    *,
    params: dict | None = None,
    attempts: int = 6,
) -> httpx.Response | None:
    """GET with backoff on 429 / 5xx / transport errors. None if it never succeeds.

    Other 4xx (404, 403, …) won't fix themselves, so they fail immediately.
    """
    last = ""
    for attempt in range(1, attempts + 1):
        try:
            r = client.get(url, params=params)
        except httpx.TransportError as exc:
            last = exc.__class__.__name__
            console.print(f"  [yellow]retry[/] {url} ({last}) {attempt}/{attempts}")
            polite_sleep(2.0 * attempt, 4.0 * attempt)
            continue
        if r.status_code == 429:
            last = "HTTP 429"
            wait_out_429(r, attempt)
            continue
        if r.status_code >= 500:
            last = f"HTTP {r.status_code}"
            console.print(f"  [yellow]{last}[/] {r.url} (attempt {attempt}/{attempts})")
            polite_sleep(2.0 * attempt, 4.0 * attempt)
            continue
        if r.status_code >= 400:
            console.print(f"  [red]HTTP {r.status_code}[/] {r.url}")
            return None
        return r
    console.print(f"  [red]giving up on[/] {url} ({last})")
    return None


class ThreadClients:
    """One httpx.Client per worker thread, cloned from a template client.

    Reusing a client keeps connections alive between files instead of paying
    a new TLS handshake per download.
    """

    def __init__(self, template: httpx.Client, timeout: httpx.Timeout):
        self._cookies = template.cookies
        self._headers = dict(template.headers)
        self._timeout = timeout
        self._local = threading.local()
        self._all: list[httpx.Client] = []
        self._lock = threading.Lock()

    def get(self) -> httpx.Client:
        client = getattr(self._local, "client", None)
        if client is None:
            client = httpx.Client(
                cookies=self._cookies,
                headers=self._headers,
                follow_redirects=True,
                timeout=self._timeout,
                http2=True,
            )
            self._local.client = client
            with self._lock:
                self._all.append(client)
        return client

    def __enter__(self) -> ThreadClients:
        return self

    def __exit__(self, *exc: object) -> None:
        for client in self._all:
            client.close()
