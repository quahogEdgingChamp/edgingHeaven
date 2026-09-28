import json

import httpx
import pytest

import simp.net as net
import simp.previews as previews
from simp.bookmarks import Bookmark
from simp.config import Config
from simp.previews import bookmarks_path, preview_urls, save_bookmarks

JPEG = b"\xff\xd8\xff" + b"j" * 500
PNG = b"\x89PNG" + b"p" * 500

THREAD = """
<div class="p-body-header"><img class="avatar" src="/data/avatars/m/1/1.jpg"></div>
<article class="message-body"><div class="bbWrapper">
  <img src="/styles/default/xenforo/smilies/smile.png" class="smilie">
  <img src="https://img.host/a.md.jpg" data-url="https://img.host/a.jpg" class="bbImage">
  <img src="data:image/gif;base64,R0lGOD" data-src="https://img.host/b.md.jpg" class="bbImage">
  <img src="https://img.host/a.md.jpg" class="bbImage">
  <img src="https://img.host/page.md.jpg" class="bbImage">
  <img src="https://img.host/big.md.jpg" class="bbImage">
  <img src="https://img.host/c.md.png" class="bbImage">
  <img src="https://img.host/d.md.jpg" class="bbImage">
</div></article>
"""


class Site:
    def __init__(self):
        self.hits: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.hits.append(request.url.host + request.url.path)
        path = request.url.path
        if request.url.host == "simpcity.cr":
            return httpx.Response(200, text=THREAD)
        if path == "/page.md.jpg":  # an image link that answers with a web page
            return httpx.Response(200, text="<html></html>", headers={"content-type": "text/html"})
        if path == "/big.md.jpg":
            return httpx.Response(200, content=JPEG * 10, headers={"content-type": "image/jpeg"})
        if path.endswith(".png"):
            return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
        return httpx.Response(200, content=JPEG, headers={"content-type": "image/jpeg"})

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler), follow_redirects=True)


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setattr(previews, "polite_sleep", lambda *a: None)
    monkeypatch.setattr(net, "polite_sleep", lambda *a: None)
    monkeypatch.setattr(previews, "PREVIEW_MAX_BYTES", 2000)
    (tmp_path / "whereto.txt").write_text(str(tmp_path / "media") + "\n")
    config = Config(root=tmp_path)
    config.paths.models_subdir = ""
    return config


def test_preview_urls_keep_thumbnails_and_skip_chrome():
    urls = preview_urls(THREAD, "https://simpcity.cr/threads/m.1/", 9)
    assert urls == [
        "https://img.host/a.md.jpg",
        "https://img.host/b.md.jpg",  # lazy image: data-src, not the placeholder
        "https://img.host/page.md.jpg",
        "https://img.host/big.md.jpg",
        "https://img.host/c.md.png",
        "https://img.host/d.md.jpg",
    ]
    assert preview_urls(THREAD, "https://simpcity.cr/threads/m.1/", 2) == urls[:2]


def test_save_bookmarks(cfg, tmp_path):
    (tmp_path / "media" / "have-it" / "sub").mkdir(parents=True)
    (tmp_path / "media" / "have-it" / "sub" / "x.jpg").write_bytes(JPEG)
    old = previews.previews_dir(cfg)
    (old / "seen-before").mkdir(parents=True)
    (old / "seen-before" / "0.jpg").write_bytes(JPEG)
    (old / "unbookmarked").mkdir()
    (old / "unbookmarked" / "0.jpg").write_bytes(JPEG)

    marks = [
        Bookmark(url="https://simpcity.cr/threads/new-one.1/", title="New One"),
        Bookmark(url="https://simpcity.cr/threads/have-it.2/", title="Have It"),
        Bookmark(url="https://simpcity.cr/threads/seen-before.3/", title="Seen Before"),
    ]
    site = Site()
    with site.client() as client:
        rows = save_bookmarks(client, cfg, marks, limit=3)

    # Only the model with neither files nor previews cost any requests: its
    # thread page, then thumbnails until three were real, small images.
    assert site.hits == ["simpcity.cr/threads/new-one.1/", "img.host/a.md.jpg", "img.host/b.md.jpg",
                         "img.host/page.md.jpg", "img.host/big.md.jpg", "img.host/c.md.png"]
    assert [(r["model"], r["downloaded"], r["previews"]) for r in rows] == [
        ("new-one", False, ["0.jpg", "1.jpg", "2.png"]),
        ("have-it", True, []),
        ("seen-before", False, ["0.jpg"]),
    ]
    saved = json.loads(bookmarks_path(cfg).read_text())
    assert saved["complete"] is True and saved["bookmarks"] == rows
    assert saved["bookmarks"][0]["title"] == "New One"
    assert (old / "new-one" / "2.png").read_bytes() == PNG
    assert not (old / "unbookmarked").exists()  # no longer bookmarked
    assert not list(old.rglob("*.part"))
