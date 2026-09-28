import errno
import json

import httpx
import pytest
from test_download import Server  # noqa: F401  (the tiny image host)

import simp.download as download
import simp.space as space
from simp.config import Config
from simp.download import adopt_existing, direct_download_one, download_direct_batch, download_model, failed_path, retry_model
from simp.hosts import MediaKind, MediaLink
from simp.index import DownloadIndex, index_path
from simp.space import DriveFull

THREAD = "https://simpcity.cr/threads/model.123/"


@pytest.fixture
def server():
    s = Server()
    yield s
    s.httpd.shutdown()


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setattr(download, "retry_after_seconds", lambda *a, **k: 0)
    monkeypatch.setattr(download, "polite_sleep", lambda *a: None)
    config = Config(root=tmp_path)
    config.scrape.concurrency = 1  # one file at a time: a predictable order
    config.download.use_cyberdrop_dl = False
    return config


def drive(monkeypatch, dest, total):
    """A pretend drive with `total` bytes free before anything is downloaded."""
    def free(path):
        used = sum(p.stat().st_size for p in dest.rglob("*") if p.is_file()) if dest.exists() else 0
        return total - used
    monkeypatch.setattr(space, "free_bytes", free)


def link(server, path, page=None):
    return MediaLink(url=server.base + path, kind=MediaKind.IMAGE, source="href", thread_page=page)


def test_reserve_stops_the_batch_cleanly(server, cfg, tmp_path, monkeypatch):
    dest = tmp_path / "downloads" / "model"
    cfg.download.min_free_bytes = 5000
    drive(monkeypatch, dest, 9000)
    links = [link(server, "/a/IMG.jpg"), link(server, "/img/full.jpg"), link(server, "/b/IMG.jpg"), link(server, "/flaky.jpg")]
    with httpx.Client() as client:
        res = download_direct_batch(client, links, dest, cfg, DownloadIndex.for_model(cfg, "model"))
    # 1000 + 3000 fit (5000 left); the 2000-byte file would cross the line.
    assert res.full.startswith("Drive nearly full")
    assert sorted(p.name for p in dest.iterdir()) == ["IMG.jpg", "full.jpg"]
    assert res.ok == 2 and not res.failed
    assert "/flaky.jpg" not in server.hits  # nothing after the stop is even asked for


def test_model_stop_records_no_failures_and_resumes(server, cfg, tmp_path, monkeypatch):
    dest = tmp_path / "downloads" / "model"
    cfg.download.min_free_bytes = 5000
    drive(monkeypatch, dest, 7500)
    links = [link(server, "/a/IMG.jpg"), link(server, "/img/full.jpg")]
    with httpx.Client() as client:
        with pytest.raises(DriveFull):
            download_model(client, THREAD, "", links, cfg)
    assert not failed_path(cfg, "model").exists()
    assert [p.name for p in dest.iterdir()] == ["IMG.jpg"]

    # More room: the same run again fetches only what is missing.
    drive(monkeypatch, dest, 50_000)
    server.hits.clear()
    with httpx.Client() as client:
        result = download_model(client, THREAD, "", links, cfg)
    assert result.ok == 1 and result.skipped == 1
    assert server.hits == ["/img/full.jpg"]


def test_full_drive_stops_before_starting_a_model_or_a_retry(server, cfg, tmp_path, monkeypatch):
    cfg.download.min_free_bytes = 5000
    monkeypatch.setattr(space, "free_bytes", lambda path: 4000)
    with httpx.Client() as client:
        with pytest.raises(DriveFull):
            download_model(client, THREAD, "", [link(server, "/a/IMG.jpg")], cfg)
    assert server.hits == []
    rows = '{"via": "direct", "thread": "%s", "url": "%s/a/IMG.jpg"}\n' % (THREAD, server.base)
    failed_path(cfg, "model").parent.mkdir(parents=True)
    failed_path(cfg, "model").write_text(rows)
    with httpx.Client() as client:
        with pytest.raises(DriveFull):
            retry_model(client, cfg, "model")
    assert failed_path(cfg, "model").read_text() == rows  # still listed for the next retry


def test_no_space_left_is_a_clean_stop(cfg, tmp_path, monkeypatch):
    big = b"x" * (9 * 1024 * 1024)

    def host(request):
        return httpx.Response(200, content=big, headers={"content-type": "video/mp4"})

    calls = []

    def check(cfg_, path, need=0):
        calls.append(need)
        if len(calls) > 1:  # the check while writing: the disk filled up underneath
            raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(download, "check_space", check)
    dest = tmp_path / "downloads" / "model"
    index = DownloadIndex.for_model(cfg, "model")
    clip = MediaLink(url="https://host/clip.mp4", kind=MediaKind.VIDEO, source="href")
    with httpx.Client(transport=httpx.MockTransport(host)) as client:
        with pytest.raises(DriveFull):
            direct_download_one(client, clip, dest, cfg, index)
    assert list(dest.iterdir()) == []  # the half-written .part is gone


def test_adopting_a_model_downloaded_before_the_index(server, cfg, tmp_path, monkeypatch):
    cfg.download.redownload_missing = False
    dest = tmp_path / "downloads" / "model"
    (dest / "sub").mkdir(parents=True)
    (dest / "sub" / "FULL.JPG").write_bytes(b"F" * 3000)  # found case-insensitively, in a subfolder
    (dest / "clip.mp4").write_bytes(b"v")  # a cyberdrop-dl file
    state = cfg.resolve(cfg.paths.state_dir)
    state.mkdir(parents=True)
    # The earlier run's cyberdrop-dl list says it read the thread up to page 3.
    (state / "cdl_model.jsonl").write_text(json.dumps({"thread_page": 3, "url": "https://bunkr.si/a/x"}) + "\n")
    links = [
        link(server, "/img/full.jpg", page=1),  # on disk: recorded
        link(server, "/a/IMG.jpg", page=2),  # covered but not on disk: deleted, stays gone
        link(server, "/b/IMG.jpg", page=4),  # newer than that run: downloaded
    ]
    adopt_existing(cfg, "model", dest, links)
    index = DownloadIndex.for_model(cfg, "model")
    assert index.done(links[0].url) is None  # filename alone cannot prove identity
    assert index.is_gone(links[1].url) and not index.is_gone(links[2].url)

    with httpx.Client() as client:
        res = download_direct_batch(client, links, dest, cfg, DownloadIndex.for_model(cfg, "model"))
    assert server.hits == ["/img/full.jpg", "/b/IMG.jpg"]
    assert res.ok == 1 and res.skipped == 2
    assert DownloadIndex.for_model(cfg, "model").done(links[0].url) == dest / "sub" / "FULL.JPG"

    # Once adopted, never again; and without a trusted index the deleted one comes back.
    before = index_path(cfg, "model").read_text()
    adopt_existing(cfg, "model", dest, links)
    assert index_path(cfg, "model").read_text() == before
    cfg.download.redownload_missing = True
    with httpx.Client() as client:
        download_direct_batch(client, links, dest, cfg, DownloadIndex.for_model(cfg, "model"))
    assert "/a/IMG.jpg" in server.hits


def test_attachment_names_are_guessed():
    assert download.guess_filename("https://simpcity.cr/attachments/my-photo-jpg.12345/") == "my-photo.jpg"
    assert download.guess_filename("https://jpg5.su/images/abc%20d.jpg") == "abc d.jpg"
    assert download.guess_filename("https://pixeldrain.com/u/AbC12") is None  # no extension: no guess
