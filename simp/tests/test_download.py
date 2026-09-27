import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

import simp.download as download
from simp.config import Config
from simp.download import (
    cdl_exclude_regex,
    download_direct_batch,
    download_model,
    failed_path,
    image_from_page,
    retry_model,
)
from simp.hosts import MediaKind, MediaLink, is_excluded_ext
from simp.index import DownloadIndex
from simp.util import sanitize_filename

A = b"A" * 1000
B = b"B" * 2000
FULL = b"F" * 3000


class Server:
    """Tiny image host: records every request path."""

    def __init__(self):
        self.hits: list[str] = []
        self.flaky_left = 1
        self.fixed = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                outer.hits.append(self.path)
                routes = {
                    "/a/IMG.jpg": ("image/jpeg", A),
                    "/b/IMG.jpg": ("image/jpeg", B),
                    "/img/full.jpg": ("image/jpeg", FULL),
                    "/page/1": (
                        "text/html",
                        b'<html><head><meta property="og:image" content="/img/full.jpg"></head></html>',
                    ),
                    "/page/2": (
                        "text/html",
                        b'<html><head><meta property="og:image" content="/img/full.jpg"></head></html>',
                    ),
                    "/page/empty": ("text/html", b"<html>nothing here</html>"),
                    "/video.mp4": (  # video viewer page whose og:image is a thumbnail
                        "text/html",
                        b'<html><head><meta property="og:image" content="/img/full.jpg"></head></html>',
                    ),
                }
                if self.path == "/flaky.jpg":
                    if outer.flaky_left:
                        outer.flaky_left -= 1
                        self.send_response(503)
                        self.end_headers()
                        return
                    routes[self.path] = ("image/jpeg", A)
                if self.path == "/later.jpg" and outer.fixed:
                    routes[self.path] = ("image/jpeg", B)
                if self.path == "/giphy.gif":  # serves its web page to HTML-first Accept
                    if self.headers.get("Accept", "").startswith("text/html"):
                        routes[self.path] = ("text/html", b"<html>gif page</html>")
                    else:
                        routes[self.path] = ("image/gif", B)
                if self.path not in routes:
                    self.send_response(404)
                    self.end_headers()
                    return
                ctype, body = routes[self.path]
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def link(self, path: str) -> MediaLink:
        return MediaLink(url=self.base + path, kind=MediaKind.IMAGE, source="href")


@pytest.fixture
def server():
    s = Server()
    yield s
    s.httpd.shutdown()


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setattr(download, "retry_after_seconds", lambda *a, **k: 0)
    monkeypatch.setattr(download, "polite_sleep", lambda *a: None)
    return Config(root=tmp_path)


def test_batch_collisions_pages_retries(server, cfg, tmp_path):
    links = [
        server.link("/a/IMG.jpg"),
        server.link("/b/IMG.jpg"),  # same name, different file
        server.link("/img/full.jpg"),
        server.link("/page/1"),  # viewer page showing /img/full.jpg
        server.link("/page/2"),  # another page showing the same image
        server.link("/flaky.jpg"),  # 503 once, then fine
        server.link("/missing.jpg"),  # 404
        server.link("/page/empty"),  # HTML, no image
    ]
    dest = tmp_path / "downloads" / "model"
    index = DownloadIndex.for_model(cfg, "model")
    with httpx.Client() as client:
        res = download_direct_batch(client, links, dest, cfg, index)

    files = sorted(p.name for p in dest.iterdir())
    assert len(files) == 4, files  # IMG.jpg, IMG_<hash>.jpg, full.jpg, flaky.jpg
    assert not any(f.endswith(".part") for f in files)
    sizes = sorted(p.stat().st_size for p in dest.iterdir())
    assert sizes == [1000, 1000, 2000, 3000]
    assert res.ok == 4
    assert res.skipped == 2  # both pages resolve to the already-downloaded full.jpg
    assert sorted(l.url.rsplit("/", 1)[-1] for l, _ in res.failed) == ["empty", "missing.jpg"]

    # Second run: everything finished is skipped without any request.
    server.hits.clear()
    index = DownloadIndex.for_model(cfg, "model")
    with httpx.Client() as client:
        res2 = download_direct_batch(client, links, dest, cfg, index)
    assert sorted(server.hits) == ["/missing.jpg", "/page/empty"]
    assert res2.ok == 0 and res2.skipped == 6


def test_legacy_file_same_size_is_reused(server, cfg, tmp_path):
    dest = tmp_path / "downloads" / "model"
    dest.mkdir(parents=True)
    (dest / "IMG.jpg").write_bytes(B)  # from before the index existed
    index = DownloadIndex.for_model(cfg, "model")
    with httpx.Client() as client:
        res = download_direct_batch(
            client, [server.link("/a/IMG.jpg"), server.link("/b/IMG.jpg")], dest, cfg, index
        )
    # /b matches the old file by size → reused; /a is different → saved under a new name
    assert res.ok == 1 and res.skipped == 1
    assert (dest / "IMG.jpg").read_bytes() == B
    assert len(list(dest.iterdir())) == 2


def test_failures_recorded_and_retried(server, cfg, tmp_path):
    cfg.download.use_cyberdrop_dl = False
    thread = "https://simpcity.cr/threads/model.123/"
    with httpx.Client() as client:
        r = download_model(client, thread, "", [server.link("/a/IMG.jpg"), server.link("/later.jpg")], cfg)
        assert len(r.failed) == 1
        assert failed_path(cfg, "model").is_file()

        server.fixed = True
        r2 = retry_model(client, cfg, "model")
    assert r2.ok == 1 and not r2.failed
    assert not failed_path(cfg, "model").exists()


def test_image_from_page():
    base = "https://host/x"
    assert image_from_page('<img id="img" src="https://i/o.jpg">', base) == "https://i/o.jpg"
    assert image_from_page('<img id="image" src="/full.jpg">', base) == "https://host/full.jpg"
    assert image_from_page('<meta property="og:image" content="https://j/a.jpg">', base) == "https://j/a.jpg"
    assert image_from_page("<p>no</p>", base) is None


def test_exclude_list_empty_means_keep_all():
    assert is_excluded_ext("https://x/a.zip")  # defaults
    assert not is_excluded_ext("https://x/a.zip", [])
    assert cdl_exclude_regex([]) is None
    assert cdl_exclude_regex([".zip", "rar"]) == r"(?i)\.(rar|zip)(\.|$)"


def test_long_filename_keeps_extension():
    name = sanitize_filename("a" * 300 + ".jpg")
    assert name.endswith(".jpg") and len(name) <= 180


def test_media_accept_header(server, cfg, tmp_path):
    dest = tmp_path / "downloads" / "model"
    index = DownloadIndex.for_model(cfg, "model")
    # Same Accept header the forum client sends
    with httpx.Client(headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}) as client:
        res = download_direct_batch(client, [server.link("/giphy.gif")], dest, cfg, index)
    assert res.ok == 1
    assert (dest / "giphy.gif").read_bytes() == B


def test_video_page_is_not_replaced_by_thumbnail(server, cfg, tmp_path):
    dest = tmp_path / "downloads" / "model"
    index = DownloadIndex.for_model(cfg, "model")
    video = MediaLink(url=server.base + "/video.mp4", kind=MediaKind.VIDEO, source="href")
    with httpx.Client() as client:
        res = download_direct_batch(client, [video], dest, cfg, index)
    assert res.ok == 0 and len(res.failed) == 1
    assert list(dest.iterdir()) == []
