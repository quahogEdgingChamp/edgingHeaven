import json

import httpx
import pytest

import simp.download as download
import simp.twitter as twitter
from simp.cli import main
from simp.config import Config
from simp.twitter import TwitterError, TwitterRule, parse_handle, post_files, twitter_model, twitter_rules

JPG = b"\xff\xd8\xff\xe0" + b"J" * 996
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"M" * 1988


def post(n, *, photos=1, videos=0, author="anna", reposted=False, day=1_700_000_000):
    media = [{"type": "photo", "url": f"https://pbs.twimg.com/media/P{n}_{i}.jpg?name=small"} for i in range(photos)]
    media += [{"type": "video", "url": f"https://video.twimg.com/v{n}_{i}/low.mp4", "formats": [
        {"url": f"https://video.twimg.com/v{n}_{i}/pl.m3u8", "container": "m3u8"},
        {"url": f"https://video.twimg.com/v{n}_{i}/low.mp4", "container": "mp4", "bitrate": 100},
        {"url": f"https://video.twimg.com/v{n}_{i}/high.mp4", "container": "mp4", "bitrate": 900},
    ]} for i in range(videos)]
    return {"id": str(1000 + n), "created_timestamp": day - n * 86400, "author": {"screen_name": author},
            "reposted_by": {"screen_name": "anna"} if reposted else None, "media": {"all": media}}


class FakeTwitter:
    """api.fxtwitter.com and the twimg media hosts. pages: lists of posts."""

    def __init__(self, pages, *, flaky=0, exists=True):
        self.pages = pages
        self.flaky = flaky  # this many timeline answers are a false 404 first
        self.exists = exists
        self.api_pages: list[int] = []
        self.media: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        host, path = request.url.host, request.url.path
        assert "cookie" not in request.headers and "referer" not in request.headers
        if host == "api.fxtwitter.com":
            if path == "/2/profile/anna":
                if not self.exists:
                    return httpx.Response(404, json={"code": 404, "message": "User not found"})
                return httpx.Response(200, json={"code": 200, "user": {"screen_name": "anna", "media_count": 9}})
            assert path == "/2/profile/anna/media", path
            if self.flaky:
                self.flaky -= 1
                return httpx.Response(404, json={"code": 404})
            page = int(request.url.params.get("cursor") or 0)
            self.api_pages.append(page)
            more = page + 1 < len(self.pages)
            return httpx.Response(200, json={"code": 200, "results": self.pages[page],
                                             "cursor": {"bottom": str(page + 1) if more else None}})
        self.media.append(str(request.url))
        body, ctype = (MP4, "video/mp4") if path.endswith(".mp4") else (JPG, "image/jpeg")
        body += path.encode()  # a different file per address
        return httpx.Response(200, content=body, headers={"Content-Type": ctype, "Content-Length": str(len(body))})


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    for module in (download, twitter):
        monkeypatch.setattr(module, "polite_sleep", lambda *a: None)
    monkeypatch.setattr(download, "retry_after_seconds", lambda *a, **k: 0)
    cfg = Config(root=tmp_path)
    cfg.download.min_free_bytes = 0
    cfg.download.redownload_missing = False  # as on the server: deleted stays deleted
    return cfg


def client_for(fake):
    return httpx.Client(transport=httpx.MockTransport(fake))


def run(cfg, fake, rule=TwitterRule("anna"), model="anna"):
    # The downloader clones the client per thread: give the clones the fake too.
    real = download.ThreadClients.get

    def get(self):
        client = getattr(self._local, "client", None)
        if client is None:
            client = self._local.client = client_for(fake)
            self._all.append(client)
        return client

    download.ThreadClients.get = get
    try:
        with client_for(fake) as client:
            return twitter_model(client, cfg, model, rule)
    finally:
        download.ThreadClients.get = real


def files(cfg, model="anna"):
    folder = cfg.models_root() / model / "Twitter"
    return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []


@pytest.mark.parametrize("text, handle", [
    ("@anna_b", "anna_b"), ("anna_b", "anna_b"), ("https://x.com/anna_b", "anna_b"),
    ("https://twitter.com/anna_b/media?s=20", "anna_b"), ("x.com/anna_b/status/123", "anna_b"),
    ("https://mobile.twitter.com/anna_b", "anna_b"), ("www.x.com/@anna_b", "anna_b"),
    ("https://fxtwitter.com/anna_b", "anna_b"),
    ("https://x.com/home", None), ("https://x.com/search?q=a", None), ("https://x.com/", None),
    ("https://evil.example/anna_b", None), ("https://x.com.evil.example/anna", None), ("ftp://x.com/anna", None),
    ("anna b", None), ("a" * 16, None), ("--only=videos", None), ("", None), (None, None),
])
def test_parse_handle(text, handle):
    assert parse_handle(text) == handle


def test_post_files_types_order_reposts_and_names():
    found = post_files(post(1, photos=2, videos=1), "Anna")
    assert [(f.kind, f.key) for f in found] == [
        ("images", "https://x.com/anna/status/1001/photo/1"),
        ("images", "https://x.com/anna/status/1001/photo/2"),
        ("videos", "https://x.com/anna/status/1001/video/3"),
    ]
    assert found[0].url == "https://pbs.twimg.com/media/P1_0.jpg?name=orig"
    assert found[2].url == "https://video.twimg.com/v1_0/high.mp4"  # best mp4, never the m3u8
    assert found[0].save_as == "Twitter/2023-11-13 1001 1.jpg"
    assert found[2].save_as.endswith(" 1001 3.mp4")
    # A repost is someone else's post: only with reposts on.
    other = post(2, author="bob", reposted=True)
    assert post_files(other, "anna") == []
    assert [f.key for f in post_files(other, "anna", reposts=True)] == ["https://x.com/bob/status/1002/photo/1"]
    assert post_files({"id": "../x", "media": {"all": [{"type": "photo", "url": "https://pbs.twimg.com/a.jpg"}]}}, "a") == []


def test_rules_file(cfg):
    state = cfg.resolve(cfg.paths.state_dir)
    state.mkdir(parents=True)
    (state / "twitter.json").write_text(json.dumps({
        "anna": {"handle": "anna", "only": "videos", "maxFiles": 40, "reposts": True},
        "bob": {"handle": "https://x.com/bob_x"},
        "bad": {"handle": "not a handle"},
        "../up": {"handle": "up"},
        "odd": {"handle": "odd", "only": "audio", "maxFiles": True},
    }), encoding="utf-8")
    said = []
    rules = twitter_rules(state, say=said.append)
    assert rules == {
        "anna": TwitterRule("anna", "videos", 40, True),
        "bob": TwitterRule("bob_x"),
        "odd": TwitterRule("odd"),
    }
    assert any("bad" in line for line in said)


def test_downloads_new_files_and_deleted_stay_deleted(cfg):
    fake = FakeTwitter([[post(1, photos=2), post(2, photos=0, videos=1)], [post(3), post(4, author="bob", reposted=True)]])
    result = run(cfg, fake)
    assert (result.ok, len(result.failed)) == (4, 0)
    assert len(files(cfg)) == 4 and any(name.endswith(".mp4") for name in files(cfg))
    assert not any(url.endswith("P4_0.jpg?name=orig") for url in fake.media)  # the repost
    # Delete one in Edging Heaven, run again: nothing is fetched again.
    (cfg.models_root() / "anna" / "Twitter" / files(cfg)[0]).unlink()
    fake.media.clear()
    again = run(cfg, fake)
    assert again.ok == 0 and fake.media == [] and len(files(cfg)) == 3


def test_only_and_limit_take_the_newest(cfg):
    fake = FakeTwitter([[post(1, photos=1, videos=1), post(2, photos=1, videos=1)], [post(3, photos=0, videos=1)]])
    result = run(cfg, fake, TwitterRule("anna", only="videos", max_files=2))
    assert result.ok == 2
    assert all(name.endswith(".mp4") for name in files(cfg))
    assert fake.api_pages == [0]  # enough on the first page: the second is never read
    state = json.loads((cfg.resolve(cfg.paths.state_dir) / "twitter" / "anna.json").read_text())
    assert state["reachedEnd"] is False  # cut short: the next run reads every page
    # The photos a videos-only run left are not marked: a run of everything gets them.
    rest = run(cfg, fake)
    assert rest.ok == 3 and len(files(cfg)) == 5


def test_stops_early_only_after_a_complete_run(cfg):
    pages = [[post(n)] for n in range(1, 7)]
    fake = FakeTwitter(pages)
    run(cfg, fake)
    assert fake.api_pages == [0, 1, 2, 3, 4, 5]
    # One new post on top: the run stops after two pages with nothing new.
    pages.insert(0, [post(0)])
    fake.api_pages.clear()
    assert run(cfg, fake).ok == 1
    assert fake.api_pages == [0, 1, 2]
    # Asking for reposts too reads everything again (none were taken before).
    fake.api_pages.clear()
    run(cfg, fake, TwitterRule("anna", reposts=True))
    assert fake.api_pages == list(range(7))


def test_videos_after_photos_is_not_stopped_by_photo_pages(cfg):
    pages = [[post(1)], [post(2)], [post(3)], [post(4, photos=0, videos=1)]]
    fake = FakeTwitter(pages)
    run(cfg, fake, TwitterRule("anna", only="images"))
    fake.api_pages.clear()
    assert run(cfg, fake, TwitterRule("anna", only="videos")).ok == 1
    assert fake.api_pages == [0, 1, 2, 3]


def test_false_404s_are_asked_again(cfg):
    fake = FakeTwitter([[post(1)]], flaky=3)
    assert run(cfg, fake).ok == 1


def test_missing_account(cfg):
    with pytest.raises(TwitterError, match="does not exist"):
        run(cfg, FakeTwitter([[]], exists=False))


def test_duplicate_of_a_file_the_model_has(cfg):
    folder = cfg.models_root() / "anna"
    folder.mkdir(parents=True)
    (folder / "from-simpcity.jpg").write_bytes(JPG + b"/media/P1_0.jpg")  # what the post's photo is
    result = run(cfg, FakeTwitter([[post(1)]]))
    assert result.ok == 0 and result.skipped == 1 and files(cfg) == []


def test_cli_twitter_needs_a_saved_account(cfg, tmp_path, monkeypatch, capsys):
    (tmp_path / "config.toml").write_text("", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as end:
        main(["-c", str(tmp_path / "config.toml"), "twitter", "nobody"])
    assert end.value.code == 1
    assert "no Twitter account saved for: nobody" in capsys.readouterr().out
    with pytest.raises(SystemExit) as end:
        main(["-c", str(tmp_path / "config.toml"), "twitter", "a", "b", "--handle", "anna"])
    assert end.value.code == 2
