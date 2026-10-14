"""Choosing another library folder: a copy of the same library keeps ratings,
keeps, marks and seen times; a different library starts clean.

Run: python3 -m unittest tests/test_library_move.py
"""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import MediaLibrary  # noqa: E402


class LibraryMoveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.old = self.base / "old" / "media"
        for n in range(10):
            folder = self.old / f"model{n % 3}"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f"p{n}.jpg").write_bytes(b"\xff\xd8\xff photo %d" % n)
        self.state = self.base / "data" / "state.json"
        self.library = MediaLibrary(self.old, self.state)
        self.library.scan()
        self.assertTrue(self.library.set_rating("model0/p0.jpg", "love"))
        self.assertTrue(self.library.set_rating("model1/p1.jpg", "like"))
        with self.library.lock:
            self.library.state["dangerousKept"] = {"model2/p2.jpg": "2026-10-01T00:00:00+00:00"}
            self.library.seen = {"model0/p0.jpg": 1_700_000_000}

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_same_library_on_a_new_drive_keeps_everything(self):
        new = self.base / "bigger-drive" / "media"
        shutil.copytree(self.old, new)
        ok, error = self.library.set_media_directory(str(new))
        self.assertTrue(ok, error)
        self.assertEqual(self.library.state["mediaDirectory"], str(new.resolve()))
        self.assertEqual(self.library.state["ratings"], {"model0/p0.jpg": "love", "model1/p1.jpg": "like"})
        self.assertIn("model2/p2.jpg", self.library.state["dangerousKept"])
        self.assertIn("model0/p0.jpg", self.library.seen)

    def test_a_different_library_starts_clean(self):
        other = self.base / "other"
        (other / "someone").mkdir(parents=True)
        (other / "someone/x.jpg").write_bytes(b"\xff\xd8\xff other")
        ok, error = self.library.set_media_directory(str(other))
        self.assertTrue(ok, error)
        self.assertEqual(self.library.state["ratings"], {})
        self.assertEqual(self.library.state["dangerousKept"], {})
        self.assertEqual(self.library.seen, {})

    def test_a_partial_copy_is_not_the_same_library(self):
        new = self.base / "half" / "media"
        (new / "model0").mkdir(parents=True)
        shutil.copy2(self.old / "model0/p0.jpg", new / "model0/p0.jpg")
        self.library.set_media_directory(str(new))
        self.assertEqual(self.library.state["ratings"], {})


if __name__ == "__main__":
    unittest.main()
