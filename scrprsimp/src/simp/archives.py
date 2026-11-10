"""Unpacking .zip, .rar and .7z downloads ([archives] in config.toml).

Archives come in only through cyberdrop-dl's staging folder, never straight
into a model folder. Each finished archive there is handed to
unpack_worker.py, a separate process that parses it inside bwrap: no network,
no view of the home folder (cookies) or the library, the archive read-only,
one empty folder to write to, and kernel limits on file size, memory, CPU
and open files. While it runs, this side kills it if its folder grows past
the limit, the drive reaches its reserve or it takes too long. Afterwards
every file it left is checked again here (check_output) as if the worker had
been taken over: only plain, flat photo and video files whose first bytes
match their type, within the limits. Those move into the staging folder like
any other finished download (so dedupe, --max-files and the move into the
library all apply) and the archive is deleted.

.zip needs only Python. .rar and .7z need libarchive (apt: libarchive13t64)
and its Python binding (pip: libarchive-c); without them those two are not
downloaded at all.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import functools
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from rich.console import Console

from . import unpack_worker
from .config import Config
from .content import complete_files
from .filters import RunFilter
from .space import free_bytes, gib
from .util import sanitize_filename

console = Console(soft_wrap=True)

ARCHIVE_KIND = {".zip": "zip", ".rar": "rar", ".7z": "7z"}
WORKER = Path(unpack_worker.__file__).resolve()
# Unpacked files may be this big when download.max_file_bytes sets no limit.
DEFAULT_MAX_FILE = 64 * 1024**3
WORKER_MEMORY = 2 * 1024**3
# What the worker may print (one line per skipped entry, at most 100 of them).
REPORT_BYTES = 256 * 1024
WATCH_EVERY = 0.5


def is_archive(path: Path | str) -> bool:
    return Path(path).suffix.lower() in ARCHIVE_KIND


@functools.cache
def libarchive() -> tuple[str, str] | None:
    """(the libarchive library, the folder holding the libarchive-c package),
    or None when either is missing or the library does not load."""
    spec = importlib.util.find_spec("libarchive")
    library = os.environ.get("LIBARCHIVE") or ctypes.util.find_library("archive")
    if spec is None or not spec.origin or not library:
        return None
    try:
        ctypes.CDLL(library)
    except OSError:
        return None
    return library, str(Path(spec.origin).parent.parent)


def _bwrap(binds: list[tuple[str, str, str]], library: str | None) -> list[str]:
    """bwrap with a new root holding only /usr (programs and libraries), an
    empty /tmp and the given (option, source, target) binds."""
    argv = [
        shutil.which("bwrap") or "bwrap",
        "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
        "--ro-bind", "/usr", "/usr", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/work",
        "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    ]
    for name in ("bin", "sbin", "lib", "lib32", "lib64", "libx32"):
        link = Path("/", name)
        if link.is_symlink():
            argv += ["--symlink", os.readlink(link), str(link)]
    python = os.path.realpath(sys.executable)
    if not python.startswith("/usr/"):
        argv += ["--ro-bind", sys.base_prefix, sys.base_prefix]
    if library and os.path.isabs(library) and not os.path.realpath(library).startswith("/usr/"):
        argv += ["--ro-bind", os.path.realpath(library), "/work/libarchive.so", "--setenv", "LIBARCHIVE", "/work/libarchive.so"]
    elif library:
        argv += ["--setenv", "LIBARCHIVE", library]
    argv += ["--ro-bind", str(WORKER), "/work/unpack_worker.py"]
    for option, source, target in binds:
        argv += [option, source, target]
    return argv + ["--chdir", "/tmp", "--", python, "-I", "-S", "/work/unpack_worker.py"]


@functools.cache
def sandbox_works() -> bool:
    """bwrap runs here (it needs unprivileged user namespaces)."""
    try:
        done = subprocess.run(_bwrap([], None) + ["--probe"], capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0 and b'"ok": true' in done.stdout


def supported(cfg: Config) -> frozenset[str]:
    """The archive extensions this run downloads and unpacks."""
    if not cfg.archives.unpack:
        return frozenset()
    if cfg.archives.sandbox and not sandbox_works():
        _warn_once("archives: bwrap does not work here, so no archive is downloaded (archives.sandbox = true)")
        return frozenset()
    exts = {".zip"}
    if libarchive():
        exts |= {".rar", ".7z"}
    else:
        _warn_once("archives: .rar and .7z need libarchive (apt install libarchive13t64; pip install libarchive-c)")
    return frozenset(exts)


@functools.cache
def _warn_once(message: str) -> None:
    console.print(f"  [yellow]{message}[/]")


def link_excludes(cfg: Config) -> list[str]:
    """download.exclude_extensions without the archives this run unpacks: for
    links found on thread pages, which then go to cyberdrop-dl."""
    keep = supported(cfg)
    return [ext for ext in cfg.download.exclude_extensions if f".{ext.lower().lstrip('.')}" not in keep]


@dataclass
class Unpacked:
    files: list[Path] = field(default_factory=list)
    skipped: Counter = field(default_factory=Counter)
    stopped: str = ""
    full: bool = False  # the drive reached its reserve: the archive waits


def limits(cfg: Config, kind: str, site: str) -> dict:
    a = cfg.archives
    return {
        "kind": kind,
        "max_files": a.max_files,
        "max_file_bytes": cfg.download.max_file_bytes or DEFAULT_MAX_FILE,
        "max_total_bytes": a.max_unpacked_bytes,
        "max_ratio": a.max_ratio,
        "max_memory_bytes": WORKER_MEMORY,
        "max_cpu_seconds": a.timeout_seconds,
        "site": site,
    }


def _folder_bytes(folder: Path) -> int:
    total = 0
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                try:
                    total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
    except OSError:
        pass
    return total


def run_worker(cfg: Config, archive: Path, out: Path) -> Unpacked:
    """Unpack archive into the empty folder out. The worker's report says what
    it skipped; what it wrote is checked separately (check_output)."""
    kind = ARCHIVE_KIND[archive.suffix.lower()]
    lib = libarchive() if kind != "zip" else None
    if kind != "zip" and lib is None:
        return Unpacked(stopped="needs libarchive for this type")
    rules = limits(cfg, kind, "")
    env = None
    if cfg.archives.sandbox:
        binds = [("--ro-bind", str(archive), "/work/archive"), ("--bind", str(out), "/work/out")]
        if lib:
            binds.append(("--ro-bind", str(Path(lib[1]) / "libarchive"), "/work/site/libarchive"))
            rules["site"] = "/work/site"
        argv = _bwrap(binds, lib[0] if lib else None) + ["/work/archive", "/work/out", json.dumps(rules)]
    else:
        rules["site"] = lib[1] if lib else ""
        argv = [os.path.realpath(sys.executable), "-I", "-S", str(WORKER), str(archive), str(out), json.dumps(rules)]
        if lib:
            env = {**os.environ, "LIBARCHIVE": lib[0]}

    result = Unpacked()
    report: list[bytes] = []
    reserve = cfg.download.min_free_bytes
    if reserve and (free_bytes(out) or 0) - archive.stat().st_size < reserve:
        result.stopped, result.full = "the drive is nearly full", True
        return result

    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)

    def read_report():
        size = 0
        for line in proc.stdout:
            size += len(line)
            if size <= REPORT_BYTES:
                report.append(line)

    reader = threading.Thread(target=read_report, daemon=True)
    reader.start()
    started = time.monotonic()
    try:
        while proc.poll() is None:
            try:
                proc.wait(timeout=WATCH_EVERY)
                break
            except subprocess.TimeoutExpired:
                pass
            if time.monotonic() - started > cfg.archives.timeout_seconds:
                result.stopped = f"took longer than {cfg.archives.timeout_seconds} s"
            elif _folder_bytes(out) > cfg.archives.max_unpacked_bytes:
                result.stopped = f"unpacks to more than {gib(cfg.archives.max_unpacked_bytes)}"
            elif reserve and (free_bytes(out) or 0) < reserve:
                result.stopped, result.full = "the drive is nearly full", True
            if result.stopped:
                proc.kill()
                proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        reader.join(timeout=5)

    done = None
    for line in report:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        if "skip" in row:
            result.skipped[str(row.get("why"))[:80]] += 1
        elif row.get("done"):
            done = row
    if done and isinstance(done.get("skipped"), int):
        shown = sum(result.skipped.values())
        if done["skipped"] > shown:
            result.skipped["other entries"] += done["skipped"] - shown
    if not result.stopped:
        if done is None:
            signal = -proc.returncode if proc.returncode and proc.returncode < 0 else 0
            result.stopped = {25: "a file was bigger than the limit", 24: "used too much CPU time"}.get(
                signal, f"the unpacker failed (exit {proc.returncode})")
        else:
            result.stopped = str(done.get("stopped") or "")[:200]
    return result


def check_output(out: Path, rules: dict) -> list[Path]:
    """The worker's files that pass every check, made on this side of the
    sandbox. Everything else in out is removed."""
    good: list[Path] = []
    total = 0
    with os.scandir(out) as entries:
        names = sorted(entry.name for entry in entries)
    for name in names:
        path = out / name
        try:
            st = os.lstat(path)
        except OSError:
            continue
        ext = os.path.splitext(name)[1]
        keep = (
            stat.S_ISREG(st.st_mode)
            and st.st_nlink == 1
            and unpack_worker.safe_name(name) == name
            and ext in unpack_worker.MEDIA_EXT
            and st.st_size <= rules["max_file_bytes"]
            and len(good) < rules["max_files"]
            and total + st.st_size <= rules["max_total_bytes"]
        )
        if keep:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as fh:
                    keep = unpack_worker.looks_like(ext, fh.read(unpack_worker.SNIFF_BYTES))
            except OSError:
                keep = False
        if keep:
            good.append(path)
            total += st.st_size
        elif stat.S_ISDIR(st.st_mode):
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
    return good


def _free_name(folder: Path, name: str) -> Path:
    target = folder / name
    stem, ext = os.path.splitext(name)
    n = 1
    while target.exists() or target.is_symlink():
        n += 1
        target = folder / f"{stem} ({n}){ext}"
    return target


def unpack_into(cfg: Config, archive: Path, staging: Path, work: Path, *, only: str = "") -> Unpacked:
    """Replace a finished archive in staging with the photos and videos in it,
    named '<archive name> - <file name>'. With result.full the archive stays
    for the next run; otherwise it is gone afterwards, whatever happened."""
    if work.is_symlink():
        raise RuntimeError(f"Unpack folder must not be a symlink: {work}")
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, mode=0o700)
    try:
        result = run_worker(cfg, archive, work)
        if result.full:
            return result
        rules = limits(cfg, ARCHIVE_KIND[archive.suffix.lower()], "")
        prefix = sanitize_filename(archive.stem, max_len=60)
        wrong = RunFilter(only=only)
        for path in check_output(work, rules):
            if wrong.wrong_file(path.name):
                result.skipped[f"not {only}"] += 1
                continue
            target = _free_name(staging, sanitize_filename(f"{prefix} - {path.name}"))
            path.replace(target)
            result.files.append(target)
        archive.unlink(missing_ok=True)
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)


# Archives that hit an unexpected error: left alone for the rest of this run.
_broken: set[Path] = set()


def unpack_waiting(cfg: Config, staging: Path, work: Path, *, only: str = "", settled: float = 0.0) -> None:
    """Unpack every finished archive in staging (see unpack_into). An archive
    of a type this run cannot unpack is deleted, never moved into the library."""
    kinds = supported(cfg)
    for archive in list(complete_files(staging)):
        if not is_archive(archive) or archive in _broken:
            continue
        try:
            if settled and time.time() - archive.stat().st_ctime < settled:
                continue
        except FileNotFoundError:
            continue
        if archive.suffix.lower() not in kinds:
            console.print(f"  archive {archive.name}: not unpacked here (see [archives] in config.toml), deleted")
            archive.unlink(missing_ok=True)
            continue
        size = archive.stat().st_size
        try:
            result = unpack_into(cfg, archive, staging, work, only=only)
        except Exception as exc:
            _broken.add(archive)
            console.print(f"  archive {archive.name}: could not unpack ({exc}), left in {staging}",
                          markup=False, highlight=False)
            continue
        if result.full:
            console.print(f"  archive {archive.name}: waits for space on the drive ({gib(size)})")
            continue
        skipped = ", ".join(f"{n} {why}" for why, n in result.skipped.most_common(4))
        console.print(
            f"  unpacked {archive.name} ({gib(size)}): {len(result.files)} photos and videos"
            + (f"; skipped {skipped}" if skipped else "")
            + (f"; stopped: {result.stopped}" if result.stopped else ""),
            markup=False, highlight=False,
        )
