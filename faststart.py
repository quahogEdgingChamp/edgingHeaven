"""Expose ordinary MP4 files with their index first, without rewriting originals.

Some downloads put `moov` after hundreds of MB of video. Browsers must get
that index before decoding. A virtual byte layout moves it to the front and
patches chunk offsets; HTTP range requests see a normal fast-start MP4.
Unknown/fragmented layouts fall back to the original file.
"""
import struct
from functools import lru_cache


def atoms(data, start=0, end=None):
    end = len(data) if end is None else end
    while start < end:
        if end - start < 8:
            raise ValueError("Truncated atom")
        size, kind = struct.unpack_from(">I4s", data, start)
        header = 8
        if size == 1:
            size = struct.unpack_from(">Q", data, start + 8)[0]
            header = 16
        elif size == 0:
            size = end - start
        if size < header or start + size > end:
            raise ValueError("Invalid atom")
        yield start, size, kind, header
        start += size


def patch_offsets(data, shift, insertion, moov_start):
    containers = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}
    tables = 0

    def walk(start, end):
        nonlocal tables
        for pos, size, kind, header in atoms(data, start, end):
            payload = pos + header
            if kind in {b"mvex", b"cmov", b"saio"}:
                raise ValueError("Unsupported movie index")
            if kind in containers:
                walk(payload, pos + size)
            elif kind in {b"stco", b"co64"}:
                tables += 1
                count = struct.unpack_from(">I", data, payload + 4)[0]
                width, fmt = (4, ">I") if kind == b"stco" else (8, ">Q")
                if payload + 8 + count * width != pos + size:
                    raise ValueError("Invalid offsets")
                for index in range(count):
                    offset_pos = payload + 8 + index * width
                    old = struct.unpack_from(fmt, data, offset_pos)[0]
                    new = old + shift if insertion <= old < moov_start else old
                    struct.pack_into(fmt, data, offset_pos, new)
    walk(0, len(data))
    if not tables:
        raise ValueError("No ordinary chunk tables")


@lru_cache(maxsize=8)
def layout(path, size, mtime_ns):
    """Segments are (virtual start, length, original offset or bytes)."""
    if path.suffix.lower() not in {".mp4", ".m4v", ".mov"}:
        return None
    try:
        with path.open("rb") as handle:
            pos, boxes = 0, []
            while pos < size and len(boxes) < 4096:
                handle.seek(pos)
                header = handle.read(16)
                length, kind = struct.unpack_from(">I4s", header)
                minimum = 8
                if length == 1:
                    length = struct.unpack_from(">Q", header, 8)[0]
                    minimum = 16
                elif length == 0:
                    length = size - pos
                if length < minimum or pos + length > size:
                    return None
                boxes.append((pos, length, kind))
                pos += length
            if pos != size or any(b[2] in {b"moof", b"sidx", b"mfra"} for b in boxes):
                return None
            movies = [b for b in boxes if b[2] == b"moov"]
            media = [b for b in boxes if b[2] == b"mdat"]
            if len(movies) != 1 or not media:
                return None
            moov, length, _ = movies[0]
            insertion = media[0][0]
            if moov < insertion or length > 16 * 1024 * 1024:
                return None
            handle.seek(moov)
            index = bytearray(handle.read(length))
            patch_offsets(index, length, insertion, moov)
            return (
                (0, insertion, 0),
                (insertion, length, bytes(index)),
                (insertion + length, moov - insertion, insertion),
                (moov + length, size - moov - length, moov + length),
            )
    except (OSError, ValueError, struct.error, OverflowError):
        return None


def read_chunks(handle, segments, start, length):
    end = start + length
    if segments is None:
        segments = ((0, end, 0),)
    for virtual, size, source in segments:
        left, right = max(start, virtual), min(end, virtual + size)
        if left >= right:
            continue
        offset, remaining = left - virtual, right - left
        if isinstance(source, int):
            handle.seek(source + offset)
        while remaining:
            take = min(64 * 1024, remaining)
            chunk = (handle.read(take) if isinstance(source, int)
                     else source[offset:offset + take])
            if not chunk:
                return
            yield chunk
            remaining -= len(chunk)
            offset += len(chunk)
