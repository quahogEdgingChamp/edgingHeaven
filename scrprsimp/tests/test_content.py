from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading

import httpx
import pytest

import simp.content as content
import simp.download as download
from simp.clear import clear_target
from simp.config import Config
from simp.content import ContentIndex
from simp.download import ModelResult, direct_download_one
from simp.hosts import MediaKind, MediaLink
from simp.index import DownloadIndex


@pytest.mark.parametrize("ext,kind", [("jpg", MediaKind.IMAGE), ("mp4", MediaKind.VIDEO)])
def test_new_url_same_contents_and_later_run_needs_no_request(tmp_path, ext, kind):
    cfg = Config(root=tmp_path)
    folder = cfg.models_root() / "model"
    (folder / "old-album").mkdir(parents=True)
    old = folder / "old-album" / f"original.{ext}"
    old.write_bytes(b"complete media contents")
    calls = []

    def host(request):
        calls.append(str(request.url))
        return httpx.Response(200, content=old.read_bytes())

    link = MediaLink(f"https://host/renamed.{ext}", kind, "href")
    with httpx.Client(transport=httpx.MockTransport(host)) as client:
        for _ in range(2):
            status, _ = direct_download_one(client, link, folder, cfg, DownloadIndex.for_model(cfg, "model"))
            assert status == "skip"
    assert len(calls) == 1
    assert list(folder.rglob(f"*.{ext}")) == [old]
    assert DownloadIndex.for_model(cfg, "model").done(link.url) == old


def test_simultaneous_duplicates_keep_one_complete_file(tmp_path):
    cfg = Config(root=tmp_path)
    folder = cfg.models_root() / "model"
    index = DownloadIndex.for_model(cfg, "model")
    barrier = threading.Barrier(4)

    def host(request):
        barrier.wait(timeout=3)
        return httpx.Response(200, content=b"identical" * 1000)

    def fetch(n):
        link = MediaLink(f"https://host/{n}.mp4", MediaKind.VIDEO, "href")
        with httpx.Client(transport=httpx.MockTransport(host)) as client:
            return direct_download_one(client, link, folder, cfg, index)[0]

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(fetch, range(4)))
    assert sorted(results) == ["ok", "skip", "skip", "skip"]
    files = list(folder.iterdir())
    assert len(files) == 1 and files[0].read_bytes() == b"identical" * 1000
    assert {index.done(f"https://host/{n}.mp4") for n in range(4)} == {files[0]}


def test_cached_hash_reused_and_changed_or_deleted_file_not_trusted(tmp_path, monkeypatch):
    folder = tmp_path / "model"
    folder.mkdir()
    old = folder / "old.jpg"
    old.write_bytes(b"AAAA")
    cache = tmp_path / "state/content/model.jsonl"
    incoming = tmp_path / "incoming.part"

    def verify():
        incoming.write_bytes(b"AAAA")
        return ContentIndex(cache, folder).finish(incoming, folder / "new.jpg")

    assert verify() == (old, True)
    real_hash = content.sha256_file
    seen = []

    def count_hash(path):
        seen.append(path)
        return real_hash(path)

    monkeypatch.setattr(content, "sha256_file", count_hash)
    assert verify() == (old, True)
    assert old not in seen
    old.write_bytes(b"BBBB")  # same size, changed content
    kept, duplicate = verify()
    assert not duplicate and kept.read_bytes() == b"AAAA"
    assert old in seen and old.read_bytes() == b"BBBB"
    old.unlink()
    kept.unlink()
    assert verify()[1] is False  # a historical hash alone must never discard the only copy


def test_identical_files_in_different_models_are_kept(tmp_path):
    for model in ("a", "b"):
        incoming = tmp_path / "incoming.part"
        incoming.write_bytes(b"same media")
        folder = tmp_path / model
        kept, duplicate = ContentIndex(tmp_path / "state/content" / f"{model}.jsonl", folder).finish(incoming, folder / "photo.jpg")
        assert not duplicate and kept.read_bytes() == b"same media"


def test_existing_same_name_and_size_is_verified(tmp_path):
    cfg = Config(root=tmp_path)
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)
    (folder / "photo.jpg").write_bytes(b"AAAA")
    link = MediaLink("https://host/photo.jpg", MediaKind.IMAGE, "href")
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"BBBB"))) as client:
        assert direct_download_one(client, link, folder, cfg, DownloadIndex.for_model(cfg, "model"))[0] == "ok"
    assert sorted(p.read_bytes() for p in folder.iterdir()) == [b"AAAA", b"BBBB"]


def test_cdl_verifies_against_existing_files_and_recovers_staging(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    from server import MediaLibrary

    cfg = Config(root=tmp_path)
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)
    (folder / "old.mp4").write_bytes(b"same video")
    library = MediaLibrary(cfg.models_root(), tmp_path / "web/state.json")
    staging = cfg.models_root().parent / ".downloads.simp-incoming/model"
    staging.mkdir(parents=True)
    (staging / "recovered.jpg").write_bytes(b"previous interrupted run")
    (staging / "unfinished.mp4.part").write_bytes(b"partial")

    def run(cfg, urls, out):
        assert not out.is_relative_to(cfg.models_root())
        assert (folder / "recovered.jpg").is_file()
        (out / "album").mkdir()
        (out / "album/renamed.mp4").write_bytes(b"same video")
        (out / "album/new.mp4").write_bytes(b"new video")
        assert not (folder / "album/new.mp4").exists()  # app sees only verified files
        library.scan()
        assert {row["path"] for row in library.catalog["videos"]} == {"model/old.mp4"}
        return 0

    monkeypatch.setattr(download, "run_cyberdrop_dl", run)
    result = ModelResult("model")
    download._run_cdl(cfg, tmp_path / "urls", folder, result)
    assert result.ok == 2 and result.skipped == 1 and result.cdl_exit == 0
    assert not (folder / "album/renamed.mp4").exists()
    assert (folder / "album/new.mp4").read_bytes() == b"new video"
    assert list(staging.rglob("*.part")) == [staging / "unfinished.mp4.part"]
    assert not list(staging.rglob("*.mp4"))
    added = library.add_new_files([str(folder)])
    assert [row["path"] for row in added] == ["model/album/new.mp4"]


def test_cdl_rejects_staging_inside_library(tmp_path):
    cfg = Config(root=tmp_path)
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)
    cfg.paths.cdl_staging_dir = str(folder / "incoming")
    with pytest.raises(RuntimeError, match="outside the media library"):
        download._run_cdl(cfg, tmp_path / "urls", folder, ModelResult("model"))


def test_symlinks_and_partial_files_are_not_duplicate_candidates(tmp_path):
    folder = tmp_path / "model"
    folder.mkdir()
    external = tmp_path / "external.jpg"
    external.write_bytes(b"same")
    (folder / "link.jpg").symlink_to(external)
    (folder / "old.jpg.part").write_bytes(b"same")
    incoming = tmp_path / "incoming.part"
    incoming.write_bytes(b"same")
    index = ContentIndex(tmp_path / "state/content/model.jsonl", folder)
    assert index.finish(incoming, folder / "new.jpg")[1] is False
    assert external.read_bytes() == b"same"


def test_cdl_complete_files_survive_interruption(tmp_path, monkeypatch):
    cfg = Config(root=tmp_path)
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)

    def run(cfg, urls, out):
        (out / "finished.mp4").write_bytes(b"complete")
        raise KeyboardInterrupt

    monkeypatch.setattr(download, "run_cyberdrop_dl", run)
    with pytest.raises(KeyboardInterrupt):
        download._run_cdl(cfg, tmp_path / "urls", folder, ModelResult("model"))
    assert (folder / "finished.mp4").read_bytes() == b"complete"


def test_disabled_verification_keeps_separate_copies(tmp_path):
    cfg = Config(root=tmp_path)
    cfg.download.deduplicate = False
    folder = cfg.models_root() / "model"
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"same"))) as client:
        index = DownloadIndex.for_model(cfg, "model")
        for name in ("one.jpg", "two.jpg"):
            link = MediaLink(f"https://host/{name}", MediaKind.IMAGE, "href")
            assert direct_download_one(client, link, folder, cfg, index)[0] == "ok"
    assert len(list(folder.iterdir())) == 2


def test_clear_history_removes_content_cache(tmp_path):
    cfg = Config(root=tmp_path)
    cache = tmp_path / "state/content/model.jsonl"
    cache.parent.mkdir(parents=True)
    cache.write_text("{}\n")
    clear_target(cfg, "history")
    assert not cache.exists()


def test_cdl_files_move_in_while_it_runs(tmp_path, monkeypatch):
    import time

    cfg = Config(root=tmp_path)
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)
    monkeypatch.setattr(download, "CDL_PUBLISH_EVERY", 0.05)
    monkeypatch.setattr(download, "CDL_SETTLED_SECONDS", 0.3)

    def run(cfg, urls, out):
        (out / "first.mp4").write_bytes(b"first video")
        deadline = time.time() + 5
        while not (folder / "first.mp4").exists() and time.time() < deadline:
            time.sleep(0.02)
        assert (folder / "first.mp4").read_bytes() == b"first video"  # before the run ends
        (out / "last.mp4").write_bytes(b"last video")  # just written: waits to settle
        time.sleep(0.1)
        assert not (folder / "last.mp4").exists()
        return 0

    monkeypatch.setattr(download, "run_cyberdrop_dl", run)
    result = ModelResult("model")
    download._run_cdl(cfg, tmp_path / "urls", folder, result)
    assert result.ok == 2 and result.cdl_exit == 0
    assert (folder / "last.mp4").read_bytes() == b"last video"  # the final sweep takes it
