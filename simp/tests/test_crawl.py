import httpx
import pytest

import simp.net as net
import simp.thread as thread
from simp.config import Config
from simp.thread import crawl_thread

THREAD = "https://simpcity.cr/threads/model.123/"


class Forum:
    """Mock XenForo thread: `pages` pages, one image per page."""

    def __init__(self, pages: int):
        self.pages = pages
        self.hits: list[int] = []
        self.broken: dict[int, int] = {}  # page → how many more times it 500s

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        page = int(path.rsplit("page-", 1)[1]) if "page-" in path else 1
        if page > self.pages:  # XenForo sends past-the-end pages to the last one
            return httpx.Response(
                303, headers={"Location": THREAD + f"page-{self.pages}"}
            )
        self.hits.append(page)
        if self.broken.get(page):
            self.broken[page] -= 1
            return httpx.Response(500)
        nav = "".join(
            f'<a href="/threads/model.123/page-{n}">{n}</a>' for n in range(1, self.pages + 1)
        )
        html = (
            f'<div class="pageNav-main">{nav}</div>'
            f'<article class="message-body"><img class="bbImage" '
            f'src="https://jpg5.su/images/p{page}.jpg"></article>'
        )
        return httpx.Response(200, text=html)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler), follow_redirects=True)


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setattr(thread, "polite_sleep", lambda *a: None)
    monkeypatch.setattr(net, "polite_sleep", lambda *a: None)
    monkeypatch.setattr(net, "wait_out_429", lambda *a: None)
    return Config(root=tmp_path)


def _pages(links):
    return sorted(l.thread_page for l in links)


def test_incremental_crawl(cfg):
    forum = Forum(pages=3)
    with forum.client() as c:
        assert _pages(crawl_thread(c, THREAD, cfg)) == [1, 2, 3]
    assert forum.hits == [1, 2, 3]

    # Two new pages appear: only the old last page and the new ones are fetched.
    forum.pages, forum.hits = 5, []
    with forum.client() as c:
        assert _pages(crawl_thread(c, THREAD, cfg)) == [1, 2, 3, 4, 5]
    assert forum.hits == [3, 4, 5]

    # --full-crawl starts over.
    forum.hits = []
    with forum.client() as c:
        crawl_thread(c, THREAD, cfg, full=True)
    assert forum.hits == [1, 2, 3, 4, 5]


def test_failed_page_is_skipped_then_retried(cfg):
    forum = Forum(pages=3)
    forum.broken[2] = 99  # page 2 keeps failing through all retries
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg)
    assert _pages(links) == [1, 3]  # rest of the thread survives

    forum.broken.clear()
    forum.hits = []
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg)
    assert _pages(links) == [1, 2, 3]
    assert sorted(set(forum.hits)) == [2, 3]


def test_transient_error_retried(cfg):
    forum = Forum(pages=2)
    forum.broken[2] = 1  # one 500, then fine
    with forum.client() as c:
        assert _pages(crawl_thread(c, THREAD, cfg)) == [1, 2]
