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
    assert links.failed_pages == (2,)

    forum.broken.clear()
    forum.hits = []
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg)
    assert _pages(links) == [1, 2, 3]
    assert not links.failed_pages
    assert sorted(set(forum.hits)) == [2, 3]


def test_transient_error_retried(cfg):
    forum = Forum(pages=2)
    forum.broken[2] = 1  # one 500, then fine
    with forum.client() as c:
        assert _pages(crawl_thread(c, THREAD, cfg)) == [1, 2]


def test_parallel_pages_are_bounded_paced_and_returned_in_order(cfg, monkeypatch):
    import threading

    forum = Forum(pages=5)
    cfg.scrape.page_concurrency = 2
    barrier = threading.Barrier(2)
    lock = threading.Lock()
    active = peak = 0
    delays = []
    monkeypatch.setattr(thread, "polite_sleep", lambda *args: delays.append(args))

    def handler(request):
        nonlocal active, peak
        if "page-" in request.url.path:
            with lock:
                active += 1
                peak = max(peak, active)
            barrier.wait(timeout=3)  # proves two requests actually overlap
            with lock:
                active -= 1
        return forum.handler(request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        links = crawl_thread(client, THREAD, cfg)
    assert peak == 2
    assert [link.thread_page for link in links] == [1, 2, 3, 4, 5]
    assert delays == [(cfg.scrape.delay_min, cfg.scrape.delay_max)] * 4


def test_unreachable_cached_thread_reports_incomplete(cfg):
    forum = Forum(pages=2)
    with forum.client() as client:
        crawl_thread(client, THREAD, cfg)
        forum.broken[2] = 99
        links = crawl_thread(client, THREAD, cfg)
    assert _pages(links) == [1, 2]
    assert links.failed_pages == (2,)


def test_expired_login_does_not_replace_cache(cfg):
    forum = Forum(pages=2)
    with forum.client() as client:
        crawl_thread(client, THREAD, cfg)
    path = thread.crawl_cache_path(cfg, THREAD)
    before = path.read_bytes()
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text='You must be logged in'))) as client:
        links = crawl_thread(client, THREAD, cfg)
    assert links.failed_pages == (2,)
    assert path.read_bytes() == before


def _urls(html, cfg):
    return [l.url for l in thread.extract_media_from_html(html, THREAD, cfg)]


def test_picture_linked_to_a_cdl_host_is_fetched_once(cfg):
    # SimpCity posts a goonbox picture as its simp6 file inside a link to its
    # goonbox page: the same file, which cyberdrop-dl already downloads.
    html = (
        '<article class="message-body">'
        '<a href="https://goonbox.cr/img/AelMId">'
        '<img class="bbImage" src="https://simp6.cuckcapital.cr/images3/X-9d9c7.md.jpg" '
        'data-url="https://simp6.cuckcapital.cr/images3/X-9d9c7.jpg"></a>'
        '<a href="https://bunkr.cr/a/album1"><img class="bbImage" src="https://jpg6.su/cover.jpg"></a>'
        "</article>"
        # the same file posted again on its own is still that goonbox picture
        '<article class="message-body"><img class="bbImage" '
        'src="https://simp6.cuckcapital.cr/images3/X-9d9c7.jpg"></article>'
    )
    assert _urls(html, cfg) == ["https://goonbox.cr/img/AelMId", "https://bunkr.cr/a/album1"]


def test_picture_linked_to_itself_or_a_direct_host_is_kept(cfg):
    html = (
        '<article class="message-body">'
        # a thumbnail linked to its full size on a cyberdrop-dl host: one file
        '<a href="https://goonbox.cr/i/Y.jpg"><img class="bbImage" src="https://goonbox.cr/i/Y.md.jpg"></a>'
        # an image-host page simp resolves itself: the index keeps these apart
        '<a href="https://jpg6.su/img/Z"><img class="bbImage" src="https://jpg6.su/images/Z.jpg"></a>'
        "</article>"
    )
    assert _urls(html, cfg) == [
        "https://goonbox.cr/i/Y.jpg",
        "https://jpg6.su/images/Z.jpg",
        "https://jpg6.su/img/Z",
    ]
