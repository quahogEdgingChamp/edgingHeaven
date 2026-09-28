import io
import os
import json
import struct
import tempfile
import unittest
from pathlib import Path

from faststart import layout, read_chunks
from server import MediaLibrary, utc_now_iso


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

    def test_restore_puts_back_one_file_without_a_rescan(self):
        self.library.set_rating("photo.jpg", "like")
        scan_id = self.library.scan_id
        token = self.library.trash_media("photo.jpg", str(self.media))["token"]
        self.library.scan = lambda: self.fail("restore must not rescan the library")
        path = self.library.restore_media(token, str(self.media))
        self.assertEqual(self.library.scan_id, scan_id)
        payload = self.library.restored_payload(path)
        self.assertEqual(payload["item"]["path"], "photo.jpg")
        self.assertEqual(payload["item"]["kind"], "image")
        self.assertEqual(payload["item"]["rating"], "like")
        self.assertEqual(payload["updatedAt"], self.library.library_payload()["updatedAt"])
        # Other pages pick it up through the additions feed.
        additions = self.library.additions(scan_id, 0)
        self.assertEqual([item["path"] for item in additions["items"]], ["photo.jpg"])

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

    def test_non_utf8_name_is_served_trashed_restored_and_emptied(self):
        # b"\xa9" is a Latin-1 copyright sign: not valid UTF-8 on its own.
        folder = self.media / os.fsdecode(b"a\xa9b")
        folder.mkdir()
        (folder / "clip.mp4").write_bytes(b"video")
        self.library.scan()
        self.assertEqual([item["path"] for item in self.library.catalog["videos"]], ["a©b/clip.mp4"])
        json.dumps(self.library.library_payload()).encode("utf-8")
        self.assertIsNotNone(self.library.thumb_path("a©b/clip.mp4"))
        token = self.library.trash_media("a©b/clip.mp4", str(self.media))["token"]
        self.assertEqual(self.library.restore_media(token, str(self.media)), "a©b/clip.mp4")
        self.assertTrue((folder / "clip.mp4").exists())
        self.library.trash_media("a©b/clip.mp4", str(self.media))
        self.assertEqual(self.library.empty_trash(str(self.media))["removed"], 1)
        self.assertFalse((folder / "clip.mp4").exists())

    def test_old_trash_record_with_raw_name_can_be_emptied(self):
        entry = self.media / ".heaven-trash" / ("f" * 32)
        entry.mkdir(parents=True)
        (entry / "media").write_bytes(b"video")
        raw = os.fsdecode(b"a\xa9b/clip.mp4")
        (entry / "record.json").write_text(json.dumps({"path": raw, "item": {}, "deletedAt": utc_now_iso()}))
        self.assertEqual(self.library.trash_entries()[0]["path"], "a©b/clip.mp4")
        self.assertEqual(self.library.empty_trash(str(self.media))["removed"], 1)

    def test_empty_trash_erases_files_ratings_and_stills(self):
        self.library.set_rating("photo.jpg", "like")
        self.library.trash_media("photo.jpg", str(self.media))
        (self.media / "clip.mp4").write_bytes(b"video")
        self.library.scan()
        still = self.library.thumb_path("clip.mp4")
        still.parent.mkdir(parents=True)
        still.write_bytes(b"jpeg")
        self.library.trash_media("clip.mp4", str(self.media))
        stray = self.media / ".heaven-trash" / "not-ours.txt"
        stray.write_text("keep me")
        result = self.library.empty_trash(str(self.media))
        self.assertEqual((result["removed"], result["freedBytes"]), (2, 13))
        self.assertGreater(result["freeBytes"], 0)
        self.assertEqual(self.library.trash_entries(), [])
        self.assertEqual(sorted(p.name for p in (self.media / ".heaven-trash").iterdir()), ["not-ours.txt"])
        self.assertFalse(still.exists())
        self.assertNotIn("photo.jpg", self.library.state["ratings"])
        (self.media / "photo.jpg").write_bytes(b"new file, same name")
        self.library = MediaLibrary(self.media, self.root / "state.json")
        self.assertNotIn("rating", self.library.library_payload()["images"][0])

    def test_empty_trash_rejects_stale_library_and_symlinked_entries(self):
        token = self.library.trash_media("photo.jpg", str(self.media))["token"]
        with self.assertRaises(ValueError):
            self.library.empty_trash("other-library")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "media").write_bytes(b"precious")
        (self.media / ".heaven-trash" / ("b" * 32)).symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.library.empty_trash(str(self.media))["removed"], 1)
        self.assertEqual((outside / "media").read_bytes(), b"precious")
        self.assertFalse((self.media / ".heaven-trash" / token).exists())

    def test_empty_trash_without_trash_folder(self):
        result = self.library.empty_trash(str(self.media))
        self.assertEqual((result["removed"], result["freedBytes"]), (0, 0))
        self.assertIsInstance(result["freeBytes"], int)


if __name__ == "__main__":
    unittest.main()
