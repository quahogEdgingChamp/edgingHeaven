"""Take the photos and videos out of one archive. The untrusted half of
simp.archives: it parses a file from the internet, so it runs as its own
process, normally inside bwrap with no network, nothing of the home folder,
the archive read-only and one empty folder to write to (see archives.py).

    python3 -I -S unpack_worker.py ARCHIVE OUT_DIR LIMITS_JSON

Only the standard library (plus libarchive-c for .rar/.7z, from the folder
named in LIMITS_JSON), so it runs the same inside and outside the sandbox.
Every file it writes is a new, flat, plain file in OUT_DIR: names lose their
folders, entries that are folders, links or devices are skipped, and so is
anything whose first bytes are not the photo or video its name says. It
prints one JSON line per entry it skips and a last line with the totals.

The parent checks every one of these limits again on what it finds in
OUT_DIR, without trusting this process (see archives.check_output)."""
from __future__ import annotations

import json
import lzma
import os
import re
import resource
import stat
import sys
import unicodedata
import zipfile
import zlib

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".jfif"}
VIDEO_EXT = {".mp4", ".m4v", ".webm", ".mkv", ".mov", ".avi", ".wmv", ".ts"}
MEDIA_EXT = IMAGE_EXT | VIDEO_EXT
# Bytes enough to recognise every type below (MPEG-TS needs its second packet).
SNIFF_BYTES = 189
CHUNK = 1024 * 1024
# Skipped entries named in the output; the rest are only counted.
SKIPS_SHOWN = 100


def looks_like(ext: str, head: bytes) -> bool:
    """True if a file starting with head really is the type ext names."""
    ext = ext.lower()
    if ext in (".jpg", ".jpeg", ".jfif"):
        return head.startswith(b"\xff\xd8\xff")
    if ext == ".png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext == ".gif":
        return head.startswith((b"GIF87a", b"GIF89a"))
    if ext == ".webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if ext == ".avi":
        return head[:4] == b"RIFF" and head[8:12] == b"AVI "
    if ext == ".bmp":
        return head.startswith(b"BM")
    if ext == ".avif":
        return head[4:8] == b"ftyp" and head[8:12] in (b"avif", b"avis", b"mif1", b"msf1")
    if ext in (".mp4", ".m4v", ".mov"):
        return head[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"wide", b"skip", b"pnot")
    if ext in (".webm", ".mkv"):
        return head.startswith(b"\x1a\x45\xdf\xa3")
    if ext == ".wmv":
        return head.startswith(b"\x30\x26\xb2\x75\x8e\x66\xcf\x11")
    if ext == ".ts":
        return len(head) >= SNIFF_BYTES and head[0] == 0x47 and head[188] == 0x47
    return False


_UNSAFE = re.compile(r'[\x00-\x1f\x7f<>:"|?*]')


def safe_name(raw) -> str:
    """The entry's own name, without any folder: 'a/../b\\c.jpg' -> 'c.jpg'.
    Empty when nothing usable is left."""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    if not isinstance(raw, str):
        return ""
    name = re.split(r"[\\/]", raw)[-1]
    name = unicodedata.normalize("NFC", _UNSAFE.sub("_", name)).strip().lstrip(".")
    stem, ext = os.path.splitext(name)
    encoded = stem.encode("utf-8")[:150].decode("utf-8", "ignore").strip()
    return f"{encoded}{ext.lower()}" if encoded and ext else ""


class Stop(Exception):
    """The whole archive is abandoned (a limit was hit)."""


class Writer:
    def __init__(self, out: str, limits: dict, archive_bytes: int):
        self.out = out
        self.max_files = int(limits["max_files"])
        self.max_file = int(limits["max_file_bytes"])
        self.max_total = int(limits["max_total_bytes"])
        # A photo or video barely compresses; a zip bomb is mostly nothing.
        self.max_out = int(archive_bytes * float(limits["max_ratio"])) + 4 * CHUNK
        self.total = 0
        self.files = 0
        self.skipped = 0
        self.names: set[str] = set()

    def skip(self, name, why: str) -> None:
        self.skipped += 1
        if self.skipped <= SKIPS_SHOWN:
            print(json.dumps({"skip": str(name)[:300], "why": why}), flush=True)

    def take(self, raw_name, size_hint, chunks) -> None:
        """Write one entry from an iterator of byte chunks, or skip it."""
        name = safe_name(raw_name)
        ext = os.path.splitext(name)[1]
        if not name or ext not in MEDIA_EXT:
            self.skip(raw_name, "not a photo or video")
            return
        if size_hint is not None and size_hint > self.max_file:
            self.skip(raw_name, f"bigger than {self.max_file} bytes")
            return
        if self.files >= self.max_files:
            raise Stop(f"more than {self.max_files} photos and videos")
        stem, n = name[: -len(ext)], 1
        while name.lower() in self.names:
            n += 1
            name = f"{stem} ({n}){ext}"
        path = os.path.join(self.out, name)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        written, head, ok = 0, b"", False
        try:
            with os.fdopen(fd, "wb") as fh:
                for chunk in chunks:
                    if len(head) < SNIFF_BYTES:
                        head += chunk[: SNIFF_BYTES - len(head)]
                    written += len(chunk)
                    self.total += len(chunk)
                    if written > self.max_file:
                        self.skip(raw_name, f"bigger than {self.max_file} bytes")
                        return
                    if self.total > self.max_total or self.total > self.max_out:
                        raise Stop("unpacks to far more than the archive holds (a zip bomb?)")
                    fh.write(chunk)
            if not looks_like(ext, head):
                self.skip(raw_name, f"not really a {ext} file")
                return
            ok = True
        finally:
            if not ok:
                os.unlink(path)
                self.total -= written
        self.names.add(name.lower())
        self.files += 1


def read_zip(path: str, writer: Writer) -> None:
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            kind = stat.S_IFMT(info.external_attr >> 16)  # 0: made on Windows
            if info.is_dir():
                continue
            if kind and kind != stat.S_IFREG:
                writer.skip(info.filename, "a link or special file")
                continue
            if info.flag_bits & 0x1:
                writer.skip(info.filename, "password-protected")
                continue
            if info.compress_size and info.file_size / info.compress_size > 100:
                writer.skip(info.filename, "compressed too well to be a photo or video")
                continue

            def chunks(info=info):
                with zf.open(info) as fh:
                    while chunk := fh.read(CHUNK):
                        yield chunk

            try:
                writer.take(info.filename, info.file_size, chunks())
            except (zipfile.BadZipFile, zlib.error, lzma.LZMAError, EOFError, NotImplementedError, RuntimeError) as exc:
                writer.skip(info.filename, f"damaged: {exc}")


def read_libarchive(path: str, kind: str, writer: Writer) -> None:
    # Only the one format this file claims to be: fewer parsers see it.
    from libarchive import ffi
    from libarchive.read import ArchiveRead

    archive_p = ffi.read_new()
    try:
        if kind == "7z":
            ffi.read_support_format_7zip(archive_p)
        else:
            ffi.read_support_format_rar(archive_p)
            rar5 = getattr(ffi.libarchive, "archive_read_support_format_rar5", None)
            if rar5 is not None:
                rar5.argtypes = [ffi.c_archive_p]
                rar5(archive_p)
        ffi.read_open_filename_w(archive_p, path, CHUNK)
        for entry in ArchiveRead(archive_p):
            name = entry.pathname
            if entry.isdir:
                continue
            if not entry.isreg or entry.issym or entry.islnk:
                writer.skip(name, "a link or special file")
                continue
            if ffi.libarchive.archive_entry_is_encrypted(entry._entry_p):
                writer.skip(name, "password-protected")
                continue
            writer.take(name, entry.size, entry.get_blocks(CHUNK))
    finally:
        ffi.read_free(archive_p)


def limit_self(limits: dict) -> None:
    """Kernel limits that hold even if a broken archive took over this
    process: it cannot write a bigger file, use more memory or CPU, or open
    more files. Lowered hard limits can never be raised again."""
    for which, value in (
        (resource.RLIMIT_FSIZE, int(limits["max_file_bytes"]) + 1),
        (resource.RLIMIT_AS, int(limits["max_memory_bytes"])),
        (resource.RLIMIT_CPU, int(limits["max_cpu_seconds"])),
        (resource.RLIMIT_NOFILE, 32),
        (resource.RLIMIT_CORE, 0),
    ):
        resource.setrlimit(which, (value, value))


def main(argv: list[str]) -> int:
    if argv[1:] == ["--probe"]:
        print(json.dumps({"ok": True}))
        return 0
    archive, out, limits = argv[1], argv[2], json.loads(argv[3])
    kind = limits["kind"]
    if kind != "zip" and limits.get("site"):
        sys.path.insert(0, limits["site"])
    archive_bytes = os.stat(archive).st_size
    limit_self(limits)
    writer = Writer(out, limits, archive_bytes)
    reason = ""
    try:
        if kind == "zip":
            read_zip(archive, writer)
        else:
            read_libarchive(archive, kind, writer)
    except Stop as exc:
        reason = str(exc)
    except Exception as exc:  # a damaged archive: keep what came out before it
        reason = f"damaged archive: {exc.__class__.__name__}: {exc}"[:300]
    print(json.dumps({"done": True, "files": writer.files, "bytes": writer.total, "skipped": writer.skipped,
                      "stopped": reason}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
