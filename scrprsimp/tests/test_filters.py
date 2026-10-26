"""Per-run choices: thread pages, photos or videos, how many new files."""
import json
import threading
import time

import httpx
import pytest

import simp.cli as cli
import simp.download as download
import simp.net as net
import simp.thread as thread
from simp.config import Config
from simp.download import ModelResult, download_direct_batch, download_model, failed_path, later_model, later_path
from simp.filters import Budget, RunFilter, describe_pages, link_type, parse_thread_pages
from simp.hosts import MediaKind, MediaLink, classify_url
from simp.index import DownloadIndex, index_path
from simp.thread import crawl_cache_path, crawl_thread

from test_crawl import THREAD, Forum
from test_download import Server, server  # noqa: F401  (fixture)


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    for module in (thread, net):
        monkeypatch.setattr(module, "polite_sleep", lambda *a: None)
    monkeypatch.setattr(net, "wait_out_429", lambda *a: None)
    monkeypatch.setattr(download, "retry_after_seconds", lambda *a, **k: 0)
    monkeypatch.setattr(download, "polite_sleep", lambda *a: None)
    return Config(root=tmp_path)


# ---- the page list ----

@pytest.mark.parametrize("spec, last, pages", [
    ("1-3", 10, {1, 2, 3}),
    ("1, 3,4", 10, {1, 3, 4}),
    ("8-", 10, {8, 9, 10}),
    ("last 3", 10, {8, 9, 10}),
    ("LAST2", 10, {9, 10}),
    ("1-2,last 2", 10, {1, 2, 9, 10}),
    ("9-12", 10, {9, 10}),  # past the end: dropped
    ("last 50", 4, {1, 2, 3, 4}),
])
def test_page_lists(spec, last, pages):
    assert parse_thread_pages(spec).resolve(last) == pages


@pytest.mark.parametrize("spec", ["", "all", " ALL ", None])
def test_every_page_is_no_spec(spec):
    assert parse_thread_pages(spec) is None


@pytest.mark.parametrize("spec", ["0", "3-1", "abc", "1-3-5", "last", "last 0", "-3", "1;2"])
def test_bad_page_lists(spec):
    with pytest.raises(ValueError):
        parse_thread_pages(spec)


def test_page_list_text():
    assert describe_pages({1, 2, 3, 7, 9, 10}) == "1-3, 7, 9-10"
    assert parse_thread_pages("2-4").needs_end is False
    assert parse_thread_pages("2-").needs_end and parse_thread_pages("last 1").needs_end


# ---- crawling some pages ----

def _pages(links):
    return sorted({l.thread_page for l in links})


def _cache(cfg):
    return json.loads(crawl_cache_path(cfg, THREAD).read_text())


def test_some_pages_then_the_whole_thread(cfg):
    """Pages 1-3 of 10: only those are read. The 7 never read are saved as gaps,
    so the next whole-thread run reads them instead of taking them for done."""
    forum = Forum(pages=10)
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg, pages=parse_thread_pages("1-3"))
    assert _pages(links) == [1, 2, 3] and forum.hits == [1, 2, 3]
    saved = _cache(cfg)
    assert saved["last_page"] == 10 and saved["gaps"] == [4, 5, 6, 7, 8, 9, 10]
    assert list(saved)[:2] == ["thread", "last_page"]  # Edging Heaven reads only the head

    forum.hits = []
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg)
    assert _pages(links) == list(range(1, 11))
    assert sorted(forum.hits) == [4, 5, 6, 7, 8, 9, 10]
    assert _cache(cfg)["gaps"] == []


def test_pages_read_before_come_from_the_cache(cfg):
    forum = Forum(pages=5)
    with forum.client() as c:
        crawl_thread(c, THREAD, cfg)
    forum.hits = []
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg, pages=parse_thread_pages("1,3"))
    assert _pages(links) == [1, 3] and forum.hits == []  # no request at all

    # The cached last page may have new posts: it is read again.
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg, pages=parse_thread_pages("4-5"))
    assert _pages(links) == [4, 5] and forum.hits == [5]


def test_last_pages_of_a_grown_thread(cfg):
    forum = Forum(pages=5)
    with forum.client() as c:
        crawl_thread(c, THREAD, cfg)
    forum.pages, forum.hits = 8, []
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg, pages=parse_thread_pages("last 2"))
    assert _pages(links) == [7, 8]
    assert sorted(forum.hits) == [7, 8]  # asked past the end, landed on 8, then 7
    # 5 (the old last page, maybe with new posts) and 6 were not read.
    assert _cache(cfg)["gaps"] == [5, 6] and _cache(cfg)["last_page"] == 8

    forum.hits = []
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg)
    assert _pages(links) == list(range(1, 9)) and sorted(forum.hits) == [5, 6, 8]


def test_pages_past_the_end_take_nothing(cfg):
    forum = Forum(pages=3)
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg, pages=parse_thread_pages("20-25"))
    assert list(links) == [] and not links.failed_pages
    # Page 3 was read on the way (the redirect), so only 1-2 are gaps.
    assert _cache(cfg)["gaps"] == [1, 2]


def test_a_failed_page_is_retried_not_lost(cfg):
    forum = Forum(pages=4)
    forum.broken[2] = 99
    with forum.client() as c:
        links = crawl_thread(c, THREAD, cfg, pages=parse_thread_pages("1-2"))
    assert links.failed_pages == (2,) and _pages(links) == [1]
    assert _cache(cfg)["failed_pages"] == [2] and _cache(cfg)["gaps"] == [3, 4]
    forum.broken.clear()
    forum.hits = []
    with forum.client() as c:
        assert _pages(crawl_thread(c, THREAD, cfg)) == [1, 2, 3, 4]
    assert sorted(set(forum.hits)) == [2, 3, 4]


# ---- photos or videos, and order ----

def _link(url, page=1):
    link = classify_url(url)
    return MediaLink(link.url, link.kind, link.source, link.prefer_cdl, page)


def test_link_types():
    assert link_type(_link("https://jpg5.su/img/abc")) == "images"  # viewer page of an image host
    assert link_type(_link("https://simpcity.cr/attachments/clip-mp4.5/")) is None  # shows when fetched
    assert link_type(_link("https://cdn.bunkr.ru/x.mp4")) == "videos"
    assert link_type(_link("https://bunkr.cr/a/album")) is None  # albums: cyberdrop-dl sorts them
    assert link_type(_link("https://turbo.cr/v/abc")) == "videos"
    assert link_type(_link("https://goonbox.cr/img/abc")) is None  # goonbox has pictures too


def test_only_videos_and_newest_first():
    links = [
        _link("https://jpg5.su/images/a.jpg", 1), _link("https://bunkr.cr/a/one", 1),
        _link("https://cdn.bunkr.ru/b.mp4", 2), _link("https://jpg5.su/images/c.jpg", 3),
        _link("https://turbo.cr/v/d", 3), _link("https://gofile.io/d/e", 3),
    ]
    chosen = RunFilter(only="videos", newest_first=True).select(links)
    assert [l.url.rsplit("/", 1)[-1] for l in chosen] == ["e", "d", "b.mp4", "one"]
    assert [l.url.rsplit("/", 1)[-1] for l in RunFilter(only="images").select(links)] == [
        "a.jpg", "one", "c.jpg", "e"]


def test_direct_files_of_the_other_type_are_skipped_not_recorded(server, cfg, tmp_path):
    """A link whose type shows only in its file name: skipped, and nothing is
    recorded, so a run without the filter still downloads it."""
    dest = tmp_path / "downloads" / "model"
    link = MediaLink(server.base + "/a/IMG.jpg", MediaKind.ATTACHMENT, "attachment")
    with httpx.Client() as client:
        res = download_direct_batch(client, [link], dest, cfg, DownloadIndex.for_model(cfg, "model"), only="videos")
    assert res.ok == 0 and res.skipped == 1 and not list(dest.iterdir())
    assert DownloadIndex.for_model(cfg, "model").done(link.url) is None
    with httpx.Client() as client:
        res = download_direct_batch(client, [link], dest, cfg, DownloadIndex.for_model(cfg, "model"))
    assert res.ok == 1


# ---- how many ----

def test_at_most_n_new_files(server, cfg, tmp_path):
    """Files already here don't count; once N are new the rest waits, unrecorded."""
    dest = tmp_path / "downloads" / "model"
    links = [server.link(p) for p in ("/a/IMG.jpg", "/b/IMG.jpg", "/img/full.jpg")]
    cfg.scrape.concurrency = 1
    with httpx.Client() as client:
        res = download_direct_batch(client, links[:1], dest, cfg, DownloadIndex.for_model(cfg, "model"))
        assert res.ok == 1
        budget = Budget(1)
        res = download_direct_batch(client, links, dest, cfg, DownloadIndex.for_model(cfg, "model"), budget=budget)
    assert res.ok == 1 and res.skipped == 1 and budget.spent()
    index = DownloadIndex.for_model(cfg, "model")
    assert [index.done(l.url) is not None for l in links] == [True, True, False]
    with httpx.Client() as client:
        res = download_direct_batch(client, links, dest, cfg, DownloadIndex.for_model(cfg, "model"))
    assert res.ok == 1 and res.skipped == 2


def test_parallel_downloads_never_go_over(server, cfg, tmp_path):
    dest = tmp_path / "downloads" / "model"
    links = [server.link(p) for p in ("/a/IMG.jpg", "/b/IMG.jpg", "/img/full.jpg")]
    cfg.scrape.concurrency = 4
    with httpx.Client() as client:
        res = download_direct_batch(client, links, dest, cfg, DownloadIndex.for_model(cfg, "model"), budget=Budget(2))
    assert res.ok == 2 and len(list(dest.iterdir())) == 2


def test_cyberdrop_dl_stops_once_enough_files_landed(cfg, tmp_path, monkeypatch):
    monkeypatch.setattr(download, "CDL_COUNT_EVERY", 0.05)
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)
    calls = []

    def run(cfg, urls, out, only="", stop=None, parallel=0, **kw):
        calls.append((only, parallel))
        for n in range(20):
            if stop.is_set():
                return 0
            (out / f"clip{n}.mp4").write_bytes(b"video %d" % n)
            time.sleep(0.05)
        return 0

    monkeypatch.setattr(download, "run_cyberdrop_dl", run)
    result, budget = ModelResult("model"), Budget(3)
    download._run_cdl(cfg, tmp_path / "urls", folder, result, only="videos", budget=budget)
    assert calls == [("videos", 3)]  # no more at once than may still come
    assert result.ok == 3 and budget.spent() and len(list(folder.iterdir())) == 3


def test_files_past_the_limit_wait_for_the_next_download(cfg, tmp_path, monkeypatch):
    """cyberdrop-dl finished more small files than allowed before it stopped:
    the extra ones stay staged, and the next download brings them in first."""
    monkeypatch.setattr(download, "CDL_COUNT_EVERY", 0.05)
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)

    def burst(cfg, urls, out, **kw):
        for n in range(5):
            (out / f"p{n}.jpg").write_bytes(b"photo %d" % n)
        return 0

    monkeypatch.setattr(download, "run_cyberdrop_dl", burst)
    result = ModelResult("model")
    download._run_cdl(cfg, tmp_path / "urls", folder, result, budget=Budget(2))
    assert result.ok == 2 and len(list(folder.iterdir())) == 2

    monkeypatch.setattr(download, "run_cyberdrop_dl", lambda cfg, urls, out, **kw: 0)
    result = ModelResult("model")
    download._run_cdl(cfg, tmp_path / "urls", folder, result)
    assert result.ok == 3 and len(list(folder.iterdir())) == 5


def test_cyberdrop_dl_type_flags(cfg, tmp_path, monkeypatch):
    calls = []

    class FakePopen:
        def __init__(self, cmd, **kw):
            calls.append(cmd)

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(download.shutil, "which", lambda name: "/opt/cyberdrop-dl")
    monkeypatch.setattr(download.subprocess, "Popen", FakePopen)
    urls = tmp_path / "urls.txt"
    urls.write_text("https://bunkr.si/a/x\n")
    for only in ("", "images", "videos"):
        download.run_cyberdrop_dl(cfg, urls, tmp_path / "out", only=only)
    assert [("--no-videos" in c, "--no-images" in c) for c in calls] == [(False, False), (True, False), (False, True)]
    assert "--downloads" not in calls[0]
    download.run_cyberdrop_dl(cfg, urls, tmp_path / "out", parallel=40)
    assert calls[-1][calls[-1].index("--downloads") + 1] == "15"


def test_real_cyberdrop_accepts_type_flags(cfg, tmp_path, monkeypatch):
    import shutil
    import sys
    from pathlib import Path

    exe = shutil.which("cyberdrop-dl") or str(Path(sys.executable).with_name("cyberdrop-dl"))
    if not Path(exe).is_file():
        pytest.skip("cyberdrop-dl not installed")
    monkeypatch.setattr(download.shutil, "which", lambda name: exe)
    monkeypatch.delenv("CDL_APPDATA_FOLDER", raising=False)
    urls = tmp_path / "urls.txt"
    urls.write_text("https://example.invalid/unsupported\n")  # no crawler: no request
    for only in ("images", "videos"):
        assert download.run_cyberdrop_dl(cfg, urls, tmp_path / "out", only=only, parallel=2) == 0


# ---- what a filtered run leaves behind ----

THREAD_URL = "https://simpcity.cr/threads/model.123/"


def test_a_filtered_run_never_marks_the_rest_deleted(server, cfg, tmp_path, monkeypatch):
    """A videos-only first run downloads only through cyberdrop-dl. The next
    run must not take that folder for a pre-index download and mark the
    thread's photos deleted (adopt_existing)."""
    cfg.download.redownload_missing = False
    monkeypatch.setattr(download, "run_cyberdrop_dl", lambda cfg, urls, out, **kw: (out / "v.mp4").write_bytes(b"v") and 0)
    album = MediaLink("https://gofile.io/d/zz", MediaKind.ALBUM, "href", prefer_cdl=True, thread_page=3)
    photo = MediaLink(server.base + "/a/IMG.jpg", MediaKind.IMAGE, "href", thread_page=1)
    filt = RunFilter(only="videos")
    with httpx.Client() as client:
        download_model(client, THREAD_URL, "", filt.select([photo, album]), cfg, filt=filt)
        assert index_path(cfg, "model").exists()
        result = download_model(client, THREAD_URL, "", [photo, album], cfg)
    assert result.ok >= 1 and "/a/IMG.jpg" in server.hits


def test_bunkr_saved_for_later_keeps_the_type(cfg, monkeypatch):
    runs = []
    monkeypatch.setattr(download, "run_cyberdrop_dl", lambda cfg, urls, out, **kw: runs.append(kw.get("only")) or 0)
    bunkr = [MediaLink(f"https://bunkr.cr/a/{n}", MediaKind.ALBUM, "href", prefer_cdl=True) for n in "ab"]
    filt = RunFilter(pages=parse_thread_pages("1"), only="images")
    with httpx.Client() as client:
        download_model(client, THREAD_URL, "", bunkr[:1], cfg, slow_later=True, filt=filt)
        # Another page, same type: added to the list, not replacing it.
        download_model(client, THREAD_URL, "", bunkr[1:], cfg, slow_later=True, filt=filt)
    assert later_path(cfg, "model").read_text().split() == [l.url for l in bunkr]
    later_model(cfg, "model")
    assert runs == ["images"] and not later_path(cfg, "model").exists()
    assert not later_path(cfg, "model").with_suffix(".only").exists()


def test_with_a_file_limit_bunkr_runs_now(cfg, monkeypatch):
    runs = []
    monkeypatch.setattr(download, "run_cyberdrop_dl", lambda cfg, urls, out, **kw: runs.append(urls.read_text().split()) or 0)
    bunkr = MediaLink("https://bunkr.cr/a/x", MediaKind.ALBUM, "href", prefer_cdl=True)
    with httpx.Client() as client:
        download_model(client, THREAD_URL, "", [bunkr], cfg, slow_later=True, filt=RunFilter(max_files=5))
    assert runs == [[bunkr.url]] and not later_path(cfg, "model").exists()


def test_failures_outside_a_partial_run_stay_listed(server, cfg, tmp_path):
    missing = MediaLink(server.base + "/missing.jpg", MediaKind.IMAGE, "href", thread_page=1)
    other = MediaLink(server.base + "/a/IMG.jpg", MediaKind.IMAGE, "href", thread_page=2)
    with httpx.Client() as client:
        download_model(client, THREAD_URL, "", [missing], cfg)
        assert failed_path(cfg, "model").is_file()
        download_model(client, THREAD_URL, "", [other], cfg, filt=RunFilter(pages=parse_thread_pages("2")))
    rows = [json.loads(l) for l in failed_path(cfg, "model").read_text().splitlines()]
    assert [r["url"] for r in rows] == [missing.url]


# ---- the command line ----

def test_thread_command_flags():
    args = cli._parser().parse_args(
        ["thread", "--thread-pages=1-3,last 2", "--only=videos", "--max-files=40", "--newest-first", THREAD_URL])
    filt = cli._run_filter(args)
    assert filt.pages.resolve(10) == {1, 2, 3, 9, 10}
    assert (filt.only, filt.max_files, filt.newest_first) == ("videos", 40, True)
    assert filt.describe() == "thread pages 1-3,last 2 · videos only · at most 40 new files · newest posts first"
    assert not cli._run_filter(cli._parser().parse_args(["thread", THREAD_URL])).active
    for bad in (["--thread-pages=0"], ["--only=gifs"], ["--max-files=-1"]):
        with pytest.raises(SystemExit):
            cli._parser().parse_args(["thread", *bad, THREAD_URL])


def test_thread_command_crawls_only_the_pages_and_filters(cfg, monkeypatch):
    seen = {}

    def crawl(client, url, cfg, full=False, pages=None):
        seen["pages"] = pages
        return thread.CrawlLinks([_link("https://jpg5.su/images/a.jpg", 1), _link("https://cdn.bunkr.ru/b.mp4", 2)])

    def model(client, url, title, links, cfg, slow_later=False, filt=None):
        seen["links"], seen["filt"] = [l.url for l in links], filt
        return ModelResult("model")

    monkeypatch.setattr(cli, "build_client", lambda cfg: httpx.Client())
    monkeypatch.setattr(cli, "assert_logged_in", lambda *a: None)
    monkeypatch.setattr(cli, "crawl_thread", crawl)
    monkeypatch.setattr(cli, "download_model", model)
    monkeypatch.setattr(cli, "check_space", lambda *a, **k: None)
    args = cli._parser().parse_args(["thread", "--no-estimate", "--thread-pages=1-2", "--only=videos", THREAD_URL])
    assert args.func(args, cfg) == 0
    assert seen["pages"].text == "1-2"
    assert seen["links"] == ["https://cdn.bunkr.ru/b.mp4"] and seen["filt"].only == "videos"


# ---- settings saved for one model ----

def test_saved_settings_apply_to_that_model_only(cfg, monkeypatch, tmp_path):
    from simp.filters import model_rules

    state = cfg.resolve(cfg.paths.state_dir)
    state.mkdir(parents=True)
    (state / "model-rules.json").write_text(json.dumps({
        "anna": {"only": "videos", "threadPages": "1-2", "url": "https://simpcity.cr/threads/anna.5/"},
        "bad": {"threadPages": "0", "only": "images"},  # an unreadable part is left out, the rest stays
    }))
    rules = model_rules(state, say=lambda *a: None)
    assert rules["anna"].only == "videos" and rules["anna"].pages.text == "1-2"
    assert rules["bad"].pages is None and rules["bad"].only == "images"

    seen = []

    def crawl(client, url, cfg, full=False, pages=None):
        seen.append((url.split("/")[-2], pages.text if pages else None))
        return thread.CrawlLinks([_link("https://jpg5.su/images/a.jpg", 1), _link("https://cdn.bunkr.ru/b.mp4", 2)])

    def model(client, url, title, links, cfg, slow_later=False, filt=None):
        seen.append([l.url.rsplit("/", 1)[-1] for l in links])
        return ModelResult("x")

    monkeypatch.setattr(cli, "build_client", lambda cfg: httpx.Client())
    monkeypatch.setattr(cli, "assert_logged_in", lambda *a: None)
    monkeypatch.setattr(cli, "crawl_thread", crawl)
    monkeypatch.setattr(cli, "download_model", model)
    monkeypatch.setattr(cli, "check_space", lambda *a, **k: None)
    args = cli._parser().parse_args(["thread", "--no-estimate", "https://simpcity.cr/threads/anna.5/",
                                     "https://simpcity.cr/threads/bob.6/"])
    assert args.func(args, cfg) == 0
    assert seen == [("anna.5", "1-2"), ["b.mp4"], ("bob.6", None), ["a.jpg", "b.mp4"]]

    # A choice made for the run wins over the saved one; the rest still applies.
    seen.clear()
    args = cli._parser().parse_args(["thread", "--no-estimate", "--only=images", "https://simpcity.cr/threads/anna.5/"])
    args.func(args, cfg)
    assert seen == [("anna.5", "1-2"), ["a.jpg"]]


def test_no_settings_file_is_no_settings(tmp_path):
    from simp.filters import model_rules

    assert model_rules(tmp_path) == {}
    (tmp_path / "model-rules.json").write_text("{not json")
    told = []
    assert model_rules(tmp_path, say=told.append) == {} and told
