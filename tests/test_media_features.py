import io
import json
import struct
import tempfile
import unittest
from pathlib import Path

from faststart import layout, read_chunks
from server import MediaLibrary


def atom(kind, payload):
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def movie_fixture(offset_kind=b"stco", trailer=True):
    ftyp = atom(b"ftyp", b"isom0000")
    media = atom(b"mdat", b"0123456789" * 20)
    offset = len(ftyp) + 8
    table = atom(offset_kind, b"\0" * 4 + struct.pack(">I", 1) +
                 struct.pack(">I" if offset_kind == b"stco" else ">Q", offset))
    for kind in (b"stbl", b"minf", b"mdia", b"trak", b"moov"):
        table = atom(kind, table)
    tail = atom(b"free", b"tail") if trailer else b""
    return ftyp, media, table, tail


class FastStartTests(unittest.TestCase):
    def test_range_views_match_reordered_mp4_and_keep_original(self):
        for kind in (b"stco", b"co64"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "movie.mp4"
                ftyp, media, moov, tail = movie_fixture(kind)
                original = ftyp + media + moov + tail
                path.write_bytes(original)
                view = layout(path, len(original), path.stat().st_mtime_ns)
                self.assertIsNotNone(view)
                whole = b"".join(read_chunks(io.BytesIO(original), view, 0, len(original)))
                self.assertEqual(whole[:len(ftyp)], ftyp)
                self.assertEqual(whole[len(ftyp)+4:len(ftyp)+8], b"moov")
                self.assertEqual(whole[len(ftyp)+len(moov):], media + tail)
                offset_index = whole.index(kind) + 12
                value = struct.unpack_from(">I" if kind == b"stco" else ">Q", whole, offset_index)[0]
                self.assertEqual(value, len(ftyp) + len(moov) + 8)
                self.assertEqual(path.read_bytes(), original)
                for start in range(len(original)):
                    for size in (1, 13, 50, len(original) - start):
                        self.assertEqual(b"".join(read_chunks(io.BytesIO(original), view, start, size)), whole[start:start+size])

    def test_unsupported_files_fall_back(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "movie.mp4"
            ftyp, media, moov, tail = movie_fixture()
            for content in (b"bad", ftyp + moov + media, ftyp + media + atom(b"moof", b"") + moov,
                            atom(b"ftyp", b"isom") + b"\0\0\0\1mdat", ftyp + media + atom(b"moov", atom(b"cmov", b""))):
                path.write_bytes(content)
                self.assertIsNone(layout(path, len(content), path.stat().st_mtime_ns))


class TrashTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.media = self.root / "library"
        self.media.mkdir()
        (self.media / "photo.jpg").write_bytes(b"original")
        self.library = MediaLibrary(self.media, self.root / "state.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_delete_restart_restore_retains_bytes_and_rating(self):
        self.library.set_rating("photo.jpg", "like")
        result = self.library.trash_media("photo.jpg", str(self.media))
        self.assertFalse((self.media / "photo.jpg").exists())
        self.assertEqual(self.library.library_payload()["counts"]["images"], 0)
        self.library = MediaLibrary(self.media, self.root / "state.json")
        self.assertEqual(self.library.library_payload()["counts"]["images"], 0)
        self.assertEqual(self.library.trash_entries()[0]["token"], result["token"])
        self.assertIsNone(self.library.resolve_media_path(f'.heaven-trash/{result["token"]}/media'))
        self.library.restore_media(result["token"], str(self.media))
        self.assertEqual((self.media / "photo.jpg").read_bytes(), b"original")
        self.assertEqual(self.library.library_payload()["images"][0]["rating"], "like")
        self.assertEqual(self.library.trash_entries(), [])

    def test_duplicate_restore_never_overwrites(self):
        token = self.library.trash_media("photo.jpg", str(self.media))["token"]
        (self.media / "photo.jpg").write_bytes(b"replacement")
        with self.assertRaises(ValueError):
            self.library.restore_media(token, str(self.media))
        self.assertEqual((self.media / "photo.jpg").read_bytes(), b"replacement")
        self.assertEqual(len(self.library.trash_entries()), 1)

    def test_stale_library_and_traversal_are_rejected(self):
        for path, library in (("photo.jpg", "other-library"), ("../outside.jpg", str(self.media)), ("/etc/passwd", str(self.media))):
            with self.assertRaises(ValueError):
                self.library.trash_media(path, library)
        for token in ("../../outside", None, "", "a" * 31):
            with self.assertRaises(ValueError):
                self.library.restore_media(token, str(self.media))
        self.assertTrue((self.media / "photo.jpg").exists())

    def test_symlink_trash_is_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.media / ".heaven-trash").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.library.trash_media("photo.jpg", str(self.media))
        self.assertEqual(list(outside.iterdir()), [])

    def test_tampered_restore_path_is_rejected(self):
        token = self.library.trash_media("photo.jpg", str(self.media))["token"]
        entry = self.media / ".heaven-trash" / token / "record.json"
        record = json.loads(entry.read_text())
        record["path"] = "../escaped.jpg"
        entry.write_text(json.dumps(record))
        with self.assertRaises(ValueError):
            self.library.restore_media(token, str(self.media))
        self.assertFalse((self.root / "escaped.jpg").exists())


if __name__ == "__main__":
    unittest.main()
