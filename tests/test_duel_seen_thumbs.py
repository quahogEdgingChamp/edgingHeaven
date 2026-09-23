"""Duel ratings, seen times and stored video thumbnails, against a
throwaway library of generated stub files (no real media)."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from server import AppServer, JPEG_MAGIC, MediaLibrary, RequestHandler, THUMB_MAX_BYTES


class LibraryCase(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.media = root / "media"
        (self.media / "a").mkdir(parents=True)
        for name in ("a/one.jpg", "a/two.jpg", "b.jpg"):
            (self.media / name).write_bytes(b"\xff\xd8\xff stub image")
        (self.media / "a/clip.mp4").write_bytes(b"not really a video")
        self.state = root / "data" / "state.json"
        self.library = MediaLibrary(self.media, self.state)

    def tearDown(self):
        self.folder.cleanup()


class DuelTests(LibraryCase):
    def test_winner_gains_what_loser_loses_and_persists(self):
        result = self.library.record_duel("a/one.jpg", "b.jpg")
        self.assertEqual(result["before"], {"a/one.jpg": None, "b.jpg": None})
        win, lose = result["ratings"]["a/one.jpg"], result["ratings"]["b.jpg"]
        self.assertEqual((win["n"], lose["n"]), (1, 1))
        self.assertGreater(win["r"], 1500)
        self.assertAlmostEqual(win["r"] - 1500, 1500 - lose["r"], places=1)
        reloaded = MediaLibrary(self.media, self.state)
        self.assertEqual(reloaded.duel_payload()["a/one.jpg"], win)

    def test_upset_moves_more_than_expected_win(self):
        for _ in range(5):
            self.library.record_duel("a/one.jpg", "b.jpg")
        favourite = self.library.duel_payload()["a/one.jpg"]["r"]
        upset = self.library.record_duel("b.jpg", "a/one.jpg")["ratings"]["a/one.jpg"]["r"]
        self.assertGreater(favourite - upset, 20)

    def test_rejects_unknown_or_same_file_and_restores(self):
        self.assertIsNone(self.library.record_duel("a/one.jpg", "a/one.jpg"))
        self.assertIsNone(self.library.record_duel("a/one.jpg", "../escape.jpg"))
        before = self.library.record_duel("a/two.jpg", "b.jpg")["before"]
        self.assertTrue(self.library.restore_duel(before))
        self.assertEqual(self.library.duel_payload(), {})

    def test_clearing_ratings_clears_duels(self):
        self.library.record_duel("a/one.jpg", "b.jpg")
        self.library.clear_ratings()
        self.assertEqual(self.library.duel_payload(), {})


class SeenTests(LibraryCase):
    def test_marks_only_catalog_files_and_survives_restart(self):
        self.assertEqual(self.library.mark_seen(["a/one.jpg", "nope.jpg", 7, "../x"]), 1)
        self.assertIn("a/one.jpg", self.library.seen_payload())
        self.assertTrue((self.state.parent / "seen.json").exists())
        reloaded = MediaLibrary(self.media, self.state)
        self.assertEqual(set(reloaded.seen_payload()), {"a/one.jpg"})
        self.assertEqual(self.library.mark_seen("a/one.jpg"), 0)


class ThumbTests(LibraryCase):
    def test_only_videos_get_thumbs_and_keys_follow_the_file(self):
        self.assertIsNone(self.library.thumb_path("a/one.jpg"))
        self.assertIsNone(self.library.thumb_path("../outside.mp4"))
        body = JPEG_MAGIC + b"frame"
        self.assertTrue(self.library.save_thumb("a/clip.mp4", body))
        first = self.library.thumb_path("a/clip.mp4")
        self.assertEqual(first.read_bytes(), body)
        self.assertTrue(str(first).startswith(str(self.state.parent)))
        self.assertFalse(self.library.save_thumb("a/clip.mp4", b"<svg>not a jpeg"))
        self.assertFalse(self.library.save_thumb("a/clip.mp4", JPEG_MAGIC + b"x" * THUMB_MAX_BYTES))
        (self.media / "a/clip.mp4").write_bytes(b"a replaced, longer video file")
        self.assertNotEqual(self.library.thumb_path("a/clip.mp4"), first)


class ThumbHTTPTests(LibraryCase):
    def setUp(self):
        super().setUp()
        self.server = AppServer(("127.0.0.1", 0), RequestHandler, self.library)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def request(self, path, data=None, content_type="image/jpeg"):
        req = urllib.request.Request(self.base + path, data=data, method="POST" if data is not None else "GET")
        if data is not None:
            req.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_missing_is_204_then_upload_then_served(self):
        self.assertEqual(self.request("/thumb?path=a/clip.mp4")[0], 204)
        status, _ = self.request("/api/thumb?path=a/clip.mp4", JPEG_MAGIC + b"frame")
        self.assertEqual(status, 200)
        self.assertEqual(self.request("/thumb?path=a/clip.mp4"), (200, JPEG_MAGIC + b"frame"))
        self.assertEqual(self.request("/api/thumb?path=a/one.jpg", JPEG_MAGIC + b"frame")[0], 400)
        # The connection stays usable after a rejected upload.
        self.assertEqual(json.loads(self.request("/api/duel")[1]), {"ratings": {}})

    def test_manifest(self):
        status, body = self.request("/manifest.webmanifest")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["display"], "standalone")


if __name__ == "__main__":
    unittest.main()
