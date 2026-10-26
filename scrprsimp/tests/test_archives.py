"""Unpacking archives safely: only photos and videos come out, nothing escapes
the folder it is unpacked into, and bombs, links, fakes and damage stop
cleanly. The archives are built here, by hand where Python cannot write the
format (RAR); .7z needs the 7z program and .rar/.7z need libarchive."""
import io
import os
import re
import shutil
import stat
import struct
import zipfile
import zlib
from pathlib import Path

import pytest

import simp.archives as archives
import simp.download as download
from simp import unpack_worker
from simp.config import Config
from simp.download import ModelResult, cdl_exclude_regex, run_cyberdrop_dl
from simp.hosts import IMAGE_EXT, VIDEO_EXT

JPG = b"\xff\xd8\xff\xe0" + os.urandom(3000)
MP4 = b"\x00\x00\x00\x18ftypisom" + os.urandom(5000)
EXE = b"MZ\x90\x00" + os.urandom(2000)


@pytest.fixture
def cfg(tmp_path):
    cfg = Config(root=tmp_path)
    cfg.archives.unpack = True
    return cfg


@pytest.fixture(params=[True, False], ids=["sandbox", "no-sandbox"])
def sandboxed(request, cfg):
    if request.param and not archives.sandbox_works():
        pytest.skip("bwrap does not work here")
    cfg.archives.sandbox = request.param
    return cfg


def make_zip(path: Path, entries) -> Path:
    """entries: (name, data) or (ZipInfo, data)."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            zf.writestr(name, data)
    return path


def flag_encrypted(path: Path, name: str) -> None:
    """Set the 'encrypted' bit of one entry (zipfile clears it when writing)."""
    data = bytearray(path.read_bytes())
    raw = name.encode()
    for signature, flags_at, name_at in ((b"PK\x03\x04", 6, 30), (b"PK\x01\x02", 8, 46)):
        start = 0
        while (start := data.find(signature, start)) != -1:
            if data[start + name_at:start + name_at + len(raw)] == raw:
                data[start + flags_at] |= 0x1
            start += 4
    path.write_bytes(bytes(data))


def unpack(cfg, archive: Path, tmp_path: Path, only: str = ""):
    staging = tmp_path / "staging"
    staging.mkdir(exist_ok=True)
    moved = staging / archive.name
    archive.replace(moved)
    result = archives.unpack_into(cfg, moved, staging, tmp_path / ".unpack" / "m", only=only)
    return result, staging, sorted(p.name for p in staging.iterdir())


def rar4(entries) -> bytes:
    """A RAR 4 archive with stored (uncompressed) files: (name, data, flags,
    host_os, attributes). Enough of the format to hand libarchive hostile
    names, links and flags."""
    def block(kind, flags, body):
        head = struct.pack("<BHH", kind, flags, 7 + len(body)) + body
        return struct.pack("<H", zlib.crc32(head) & 0xFFFF) + head

    out = b"Rar!\x1a\x07\x00" + block(0x73, 0, b"\0" * 6)
    for name, data, flags, host_os, attr in entries:
        raw = name.encode()
        body = struct.pack("<IIBIIBBHI", len(data), len(data), host_os, zlib.crc32(data), 0x5A210000,
                           20, 0x30, len(raw), attr) + raw
        out += block(0x74, 0x8000 | flags, body) + data
    return out + block(0x7B, 0x4000, b"")


def need_libarchive():
    if archives.libarchive() is None:
        pytest.skip("libarchive / libarchive-c missing")


# ---- the pieces


def test_worker_media_types_match_simp():
    assert unpack_worker.IMAGE_EXT == IMAGE_EXT and unpack_worker.VIDEO_EXT == VIDEO_EXT


@pytest.mark.parametrize("raw,name", [
    ("photo.JPG", "photo.jpg"),
    ("../../etc/cron.d/evil.jpg", "evil.jpg"),
    ("/home/qwerty/.bashrc.mp4", "bashrc.mp4"),
    ("C:\\Windows\\a\\b.png", "b.png"),
    ("..", ""),
    ("dir/", ""),
    (".hidden", ""),
    ("noext", ""),
    ("a\x00b<c>.gif", "a_b_c_.gif"),
    (b"bytes\xff.webp", "bytes\ufffd.webp"),
    (None, ""),
])
def test_safe_name_keeps_only_the_last_part(raw, name):
    assert unpack_worker.safe_name(raw) == name


@pytest.mark.parametrize("ext,head,ok", [
    (".jpg", JPG, True), (".jpg", EXE, False), (".mp4", MP4, True), (".mov", MP4, True),
    (".png", b"\x89PNG\r\n\x1a\n....", True), (".gif", b"GIF89a..", True),
    (".webp", b"RIFF\0\0\0\0WEBPVP8 ", True), (".avi", b"RIFF\0\0\0\0WEBPVP8 ", False),
    (".mkv", b"\x1a\x45\xdf\xa3....", True), (".ts", b"\x47" + b"\0" * 187 + b"\x47", True),
    (".ts", b"\x47" * 10, False), (".exe", EXE, False), (".jpg", b"", False),
])
def test_looks_like_reads_the_first_bytes(ext, head, ok):
    assert unpack_worker.looks_like(ext, head) is ok


def test_cdl_regex_lets_only_media_and_unpacked_archives_through():
    keep = frozenset({".zip", ".rar", ".7z"})
    rx = re.compile(cdl_exclude_regex(None, keep))  # the default exclusions, archives let through
    for name in ("a.jpg", "b.MP4", "pack.zip", "pack.RAR", "x.7z", "song.mp3", "p.avif"):
        assert not rx.search(name), name
    for name in ("setup.exe", "readme.txt", "page.html", "pack.part2.rar", "pack.7z.001", "a.tar", "disk.iso", "noext"):
        assert rx.search(name), name
    # Archives off: the old rule, every excluded extension and nothing more.
    old = re.compile(cdl_exclude_regex([".zip", ".rar"]))
    assert old.search("a.zip") and old.search("a.rar.001") and not old.search("readme.txt")


def test_cdl_media_list_covers_cyberdrop_dl():
    constants = pytest.importorskip("cyberdrop_dl.constants")
    assert constants.FileExt.MEDIA <= download.CDL_MEDIA_EXT


def test_link_excludes_drop_only_what_is_unpacked(cfg, monkeypatch):
    cfg.download.exclude_extensions = [".zip", ".rar", ".7z", ".iso"]
    monkeypatch.setattr(archives, "supported", lambda cfg: frozenset({".zip"}))
    assert archives.link_excludes(cfg) == [".rar", ".7z", ".iso"]
    cfg.archives.unpack = False
    monkeypatch.setattr(archives, "supported", lambda cfg: frozenset())
    assert archives.link_excludes(cfg) == [".zip", ".rar", ".7z", ".iso"]


def test_supported_needs_a_working_sandbox(cfg, monkeypatch):
    monkeypatch.setattr(archives, "sandbox_works", lambda: False)
    assert archives.supported(cfg) == frozenset()
    cfg.archives.sandbox = False
    assert ".zip" in archives.supported(cfg)
    cfg.archives.unpack = False
    assert archives.supported(cfg) == frozenset()


def test_cdl_command_takes_archives_only_into_staging(cfg, tmp_path, monkeypatch):
    calls = []

    class FakePopen:
        def __init__(self, cmd, **kw):
            calls.append(cmd)

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(archives, "supported", lambda cfg: frozenset({".zip", ".rar", ".7z"}))
    monkeypatch.setattr(download.shutil, "which", lambda name: "/opt/cyberdrop-dl")
    monkeypatch.setattr(download.subprocess, "Popen", FakePopen)
    urls = tmp_path / "urls.txt"
    urls.write_text("https://bunkr.si/a/x\n")
    run_cyberdrop_dl(cfg, urls, tmp_path / "out", staging=True)
    run_cyberdrop_dl(cfg, urls, tmp_path / "out")
    staged, straight = calls
    assert "--no-non-media" not in staged
    assert re.compile(staged[staged.index("--filename-regex-exclude") + 1]).search("x.exe")
    assert "--no-non-media" in straight
    assert re.compile(straight[straight.index("--filename-regex-exclude") + 1]).search("x.zip")


def test_real_cyberdrop_accepts_the_archive_command(cfg, tmp_path, monkeypatch):
    """The installed cyberdrop-dl must parse the archive regex (a bad option exits 1 at once)."""
    import sys

    exe = shutil.which("cyberdrop-dl") or str(Path(sys.executable).with_name("cyberdrop-dl"))
    if not Path(exe).is_file():
        pytest.skip("cyberdrop-dl not installed")
    monkeypatch.setattr(archives, "supported", lambda cfg: frozenset({".zip", ".rar", ".7z"}))
    monkeypatch.setattr(download.shutil, "which", lambda name: exe)
    monkeypatch.delenv("CDL_APPDATA_FOLDER", raising=False)
    urls = tmp_path / "urls.txt"
    urls.write_text("https://example.invalid/unsupported\n")  # no crawler: no request
    assert run_cyberdrop_dl(cfg, urls, tmp_path / "out", staging=True) == 0


# ---- zip, in and out of the sandbox


def test_zip_gives_only_real_photos_and_videos(sandboxed, tmp_path):
    inner = make_zip(tmp_path / "inner.zip", [("deep.jpg", JPG)]).read_bytes()
    archive = make_zip(tmp_path / "Pack 1.zip", [
        ("set/a.jpg", JPG),
        ("set/b.mp4", MP4),
        ("other/a.jpg", JPG + b"x"),          # same name, other folder
        ("virus.exe", EXE),
        ("virus.jpg", EXE),                   # an exe in disguise
        ("readme.txt", b"hello"),
        ("nested.zip", inner),                # never unpacked
        ("empty/", b""),
    ])
    result, staging, names = unpack(sandboxed, archive, tmp_path)
    assert names == ["Pack 1 - a (2).jpg", "Pack 1 - a.jpg", "Pack 1 - b.mp4"]
    assert (staging / "Pack 1 - b.mp4").read_bytes() == MP4
    assert result.skipped == {"not a photo or video": 3, "not really a .jpg file": 1}
    assert not result.stopped
    assert not (tmp_path / ".unpack" / "m").exists()  # work folder gone
    assert not list(tmp_path.rglob("deep.jpg"))


def test_zip_slip_and_absolute_names_stay_inside(sandboxed, tmp_path):
    victim = tmp_path / "victim.jpg"
    archive = make_zip(tmp_path / "evil.zip", [
        ("../victim.jpg", JPG),
        ("../../../../../../tmp/escaped.jpg", JPG),
        (str(tmp_path / "abs.jpg"), JPG),
    ])
    _, staging, names = unpack(sandboxed, archive, tmp_path)
    assert not victim.exists() and not (tmp_path / "abs.jpg").exists()
    assert names == ["evil - abs.jpg", "evil - escaped.jpg", "evil - victim.jpg"]


def test_zip_links_and_password_entries_are_skipped(sandboxed, tmp_path):
    link = zipfile.ZipInfo("link.jpg")
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    fifo = zipfile.ZipInfo("pipe.jpg")
    fifo.external_attr = (stat.S_IFIFO | 0o644) << 16
    secret = zipfile.ZipInfo("secret.jpg")
    plain = zipfile.ZipInfo("perms-only.jpg")
    plain.external_attr = 0o644 << 16  # no file type bits: a plain file
    archive = make_zip(tmp_path / "links.zip", [(link, b"/etc/passwd"), (fifo, JPG), (secret, JPG), (plain, JPG)])
    flag_encrypted(archive, "secret.jpg")
    result, _, names = unpack(sandboxed, archive, tmp_path)
    assert names == ["links - perms-only.jpg"]
    assert result.skipped == {"a link or special file": 2, "password-protected": 1}


def test_zip_bomb_entries_are_refused(sandboxed, tmp_path):
    archive = make_zip(tmp_path / "bomb.zip", [
        ("ok.jpg", JPG),
        ("zeros.mp4", MP4[:16] + b"\0" * (64 * 1024 * 1024)),  # ~1000x
    ])
    assert archive.stat().st_size < 1024 * 1024
    result, _, names = unpack(sandboxed, archive, tmp_path)
    assert names == ["bomb - ok.jpg"]
    assert result.skipped == {"compressed too well to be a photo or video": 1}


def test_many_well_compressed_entries_stop_the_archive(sandboxed, tmp_path):
    # Each entry alone is under the per-entry ratio; together they unpack to
    # far more than max_ratio times the archive.
    body = MP4[:16] + (os.urandom(1024) + b"\0" * 40 * 1024) * 25
    archive = make_zip(tmp_path / "slow bomb.zip", [(f"v{n}.mp4", body) for n in range(40)])
    size = archive.stat().st_size
    sandboxed.archives.max_ratio = 5
    result, _, names = unpack(sandboxed, archive, tmp_path)
    assert "zip bomb" in result.stopped
    total = sum((tmp_path / "staging" / n).stat().st_size for n in names)
    assert total <= size * 5 + 4 * 1024 * 1024 and len(names) < 40


def test_limits_on_count_and_size(sandboxed, tmp_path):
    archive = make_zip(tmp_path / "many.zip", [(f"p{n}.jpg", JPG) for n in range(10)] + [("big.mp4", MP4 * 20)])
    sandboxed.archives.max_files = 4
    sandboxed.download.max_file_bytes = 50_000
    result, _, names = unpack(sandboxed, archive, tmp_path)
    assert len(names) == 4 and "more than 4" in result.stopped


def test_only_photos_keeps_videos_out(sandboxed, tmp_path):
    archive = make_zip(tmp_path / "mix.zip", [("a.jpg", JPG), ("b.mp4", MP4)])
    result, _, names = unpack(sandboxed, archive, tmp_path, only="images")
    assert names == ["mix - a.jpg"] and result.skipped["not images"] == 1


def test_damaged_zip_keeps_what_came_before(sandboxed, tmp_path):
    archive = make_zip(tmp_path / "torn.zip", [("a.jpg", JPG), ("b.jpg", JPG + b"1")])
    data = bytearray(archive.read_bytes())
    data[len(data) // 2] ^= 0xFF  # inside b.jpg's data: its CRC fails
    archive.write_bytes(bytes(data))
    result, _, names = unpack(sandboxed, archive, tmp_path)
    assert "torn - a.jpg" in names and "torn - b.jpg" not in names
    garbage = tmp_path / "garbage.zip"
    garbage.write_bytes(os.urandom(5000))
    result, _, names = unpack(sandboxed, garbage, tmp_path)
    assert "damaged" in result.stopped and not any(n.startswith("garbage") for n in names)


def test_full_drive_leaves_the_archive_for_later(cfg, tmp_path, monkeypatch):
    cfg.archives.sandbox = False
    cfg.download.min_free_bytes = 10**18
    archive = make_zip(tmp_path / "wait.zip", [("a.jpg", JPG)])
    result, staging, names = unpack(cfg, archive, tmp_path)
    assert result.full and names == ["wait.zip"]


def test_runaway_worker_is_killed(cfg, tmp_path, monkeypatch):
    """The parent's own limits, for a worker that ignores its own."""
    cfg.archives.sandbox = False
    cfg.archives.timeout_seconds = 1
    sleeper = tmp_path / "sleeper.py"
    sleeper.write_text("import time\ntime.sleep(30)\n")
    monkeypatch.setattr(archives, "WORKER", sleeper)
    archive = make_zip(tmp_path / "slow.zip", [("a.jpg", JPG)])
    result, _, names = unpack(cfg, archive, tmp_path)
    assert "longer than 1 s" in result.stopped and names == []


def test_check_output_trusts_nothing(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    (out / "good.jpg").write_bytes(JPG)
    (out / "fake.jpg").write_bytes(EXE)
    (out / "run.sh").write_bytes(b"#!/bin/sh\n")
    (out / "link.jpg").symlink_to("/etc/passwd")
    (out / "sub").mkdir()
    (out / "sub" / "x.jpg").write_bytes(JPG)
    (out / "hard.jpg").write_bytes(JPG)
    os.link(out / "hard.jpg", tmp_path / "elsewhere.jpg")
    (out / "we<ird.jpg").write_bytes(JPG)
    rules = {"max_file_bytes": 10**9, "max_files": 10, "max_total_bytes": 10**9}
    assert [p.name for p in archives.check_output(out, rules)] == ["good.jpg"]
    assert sorted(p.name for p in out.iterdir()) == ["good.jpg"]
    assert (tmp_path / "elsewhere.jpg").exists() and Path("/etc/passwd").exists()


def test_sandbox_sees_only_the_archive(tmp_path):
    """Inside bwrap: no home folder, no network, /usr read-only."""
    if not archives.sandbox_works():
        pytest.skip("bwrap does not work here")
    import subprocess

    out = tmp_path / "out"
    out.mkdir()
    probe = (
        "import os, socket\n"
        f"print('home', os.path.exists({str(Path.home())!r}), os.path.exists('/home'))\n"
        "s = socket.socket()\n"
        "try:\n    s.connect(('1.1.1.1', 80)); print('net yes')\nexcept OSError: print('net no')\n"
        "try:\n    open('/usr/x', 'w'); print('usr writable')\nexcept OSError: print('usr ro')\n"
        "try:\n    open('/work/archive', 'a'); print('archive writable')\nexcept OSError: print('archive ro')\n"
        "open('/work/out/ok', 'w').write('1')\n"
    )
    archive = tmp_path / "a.zip"
    archive.write_bytes(b"PK")
    argv = archives._bwrap([("--ro-bind", str(archive), "/work/archive"), ("--bind", str(out), "/work/out")], None)
    done = subprocess.run(argv[:-1] + ["-c", probe], capture_output=True, text=True, timeout=30)
    assert done.stdout.split("\n")[:4] == ["home False False", "net no", "usr ro", "archive ro"], done.stderr
    assert (out / "ok").read_text() == "1"


# ---- rar and 7z (libarchive)


def test_rar_takes_media_and_skips_links_and_secrets(sandboxed, tmp_path):
    need_libarchive()
    unix, windows = 3, 2
    data = rar4([
        ("set/a.jpg", JPG, 0, windows, 0x20),
        ("../../escape.mp4", MP4, 0, unix, stat.S_IFREG | 0o644),
        ("link.jpg", b"/etc/passwd", 0, unix, stat.S_IFLNK | 0o777),
        ("tool.exe", EXE, 0, windows, 0x20),
        ("fake.jpg", EXE, 0, windows, 0x20),
        ("secret.jpg", JPG, 0x04, windows, 0x20),  # last: libarchive may stop at it
    ])
    archive = tmp_path / "set.rar"
    archive.write_bytes(data)
    result, staging, names = unpack(sandboxed, archive, tmp_path)
    assert names[:2] == ["set - a.jpg", "set - escape.mp4"]
    assert (staging / "set - escape.mp4").read_bytes() == MP4
    assert not (tmp_path.parent / "escape.mp4").exists()
    assert "link.jpg" not in " ".join(names) and not any("secret" in n or "tool" in n or "fake" in n for n in names)
    assert result.skipped["a link or special file"] == 1
    assert result.skipped["not a photo or video"] == 1
    assert result.skipped["not really a .jpg file"] == 1
    assert result.stopped or result.skipped["password-protected"] == 1


def test_rar_that_is_not_a_rar_is_damaged(sandboxed, tmp_path):
    need_libarchive()
    archive = make_zip(tmp_path / "liar.rar", [("a.jpg", JPG)])  # a zip named .rar
    result, _, names = unpack(sandboxed, archive, tmp_path)
    assert "damaged" in result.stopped and names == []


def seven_zip() -> str:
    exe = os.environ.get("SEVENZIP") or shutil.which("7zz") or shutil.which("7z")
    if not exe or archives.libarchive() is None:
        pytest.skip("7z program or libarchive missing")
    return exe


def test_7z_unpacks_and_stops_a_bomb(sandboxed, tmp_path):
    import subprocess

    exe = seven_zip()
    src = tmp_path / "src"
    (src / "deep").mkdir(parents=True)
    (src / "deep" / "a.jpg").write_bytes(JPG)
    (src / "b.mp4").write_bytes(MP4)
    (src / "tool.exe").write_bytes(EXE)
    archive = tmp_path / "Set.7z"
    subprocess.run([exe, "a", "-bd", "-bso0", str(archive), "."], cwd=src, check=True)
    result, _, names = unpack(sandboxed, archive, tmp_path)
    assert names == ["Set - a.jpg", "Set - b.mp4"] and result.skipped["not a photo or video"] == 1

    (tmp_path / "bomb").mkdir()
    (tmp_path / "bomb" / "zeros.mp4").write_bytes(MP4[:16] + b"\0" * (200 * 1024 * 1024))
    bomb = tmp_path / "bomb.7z"
    subprocess.run([exe, "a", "-bd", "-bso0", str(bomb), "zeros.mp4"], cwd=tmp_path / "bomb", check=True)
    (tmp_path / "bomb" / "zeros.mp4").unlink()
    assert bomb.stat().st_size < 1024 * 1024
    result, _, names = unpack(sandboxed, bomb, tmp_path)
    assert "zip bomb" in result.stopped and not any(n.startswith("bomb") for n in names)


# ---- in a real download


def test_archive_from_cyberdrop_dl_lands_as_photos(cfg, tmp_path, monkeypatch):
    cfg.archives.sandbox = archives.sandbox_works()
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)

    def run(cfg, urls, out, **kw):
        assert kw.get("staging") is True
        make_zip(out / "album.zip", [("x/1.jpg", JPG), ("x/2.mp4", MP4), ("x/setup.exe", EXE)])
        return 0

    monkeypatch.setattr(download, "run_cyberdrop_dl", run)
    result = ModelResult("model")
    download._run_cdl(cfg, tmp_path / "urls", folder, result)
    assert sorted(p.name for p in folder.iterdir()) == ["album - 1.jpg", "album - 2.mp4"]
    assert result.ok == 2
    staging_root = cfg.models_root().parent / f".{cfg.models_root().name}.simp-incoming"
    assert not list(staging_root.rglob("*.zip")) and not list(staging_root.rglob("*.exe"))


def test_archive_never_reaches_the_library_when_off(cfg, tmp_path, monkeypatch):
    cfg.archives.unpack = False
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)
    monkeypatch.setattr(download, "run_cyberdrop_dl",
                        lambda cfg, urls, out, **kw: make_zip(out / "a.zip", [("1.jpg", JPG)]) and 0)
    download._run_cdl(cfg, tmp_path / "urls", folder, ModelResult("model"))
    assert list(folder.iterdir()) == []


def test_direct_links_never_bring_archives(cfg, tmp_path):
    import httpx

    from simp.download import direct_download_one
    from simp.hosts import MediaKind, MediaLink
    from simp.index import DownloadIndex

    cfg.download.exclude_extensions = []
    folder = cfg.models_root() / "model"
    folder.mkdir(parents=True)
    payload = make_zip(tmp_path / "p.zip", [("a.jpg", JPG)]).read_bytes()
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=payload))
    link = MediaLink("https://simpcity.cr/attachments/pack-zip.1/", MediaKind.ATTACHMENT, "attachment")
    with httpx.Client(transport=transport) as client:
        status, detail = direct_download_one(client, link, folder, cfg, DownloadIndex.for_model(cfg, "model"),
                                             url="https://host/pack.zip")
    assert status == "skip" and "archive" in detail and list(folder.iterdir()) == []
