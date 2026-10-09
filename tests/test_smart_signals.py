"""Smart order's server side: watch signals and Rediscover's revisit
schedule (watch.json), and the duel history (duels.json), against a
throwaway library of stub files (no real media)."""
import json
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

from server import AppServer, DEFAULT_SETTINGS, FEATURES, MediaLibrary, RequestHandler


class LibraryCase(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.media = root / "media"
        (self.media / "a").mkdir(parents=True)
        (self.media / "b").mkdir(parents=True)
        for name in ("a/one.jpg", "a/two.jpg", "b/three.jpg"):
            (self.media / name).write_bytes(b"\xff\xd8\xff stub image")
        (self.media / "a/clip.mp4").write_bytes(b"not really a video")
        self.state = root / "data" / "state.json"
        self.library = MediaLibrary(self.media, self.state)

    def tearDown(self):
        self.folder.cleanup()


class WatchTests(LibraryCase):
    def test_counts_views_skips_completions_and_survives_restart(self):
        stored = self.library.record_watch([
            {"path": "a/clip.mp4", "seconds": 12.5, "coverage": 0.95, "skipped": False},
            {"path": "a/clip.mp4", "seconds": 1.2, "coverage": 0.1, "skipped": True},
            {"path": "a/one.jpg", "seconds": 5000, "coverage": None, "skipped": False},
        ])
        self.assertEqual(stored, 3)
        clip = self.library.watch_payload()["a/clip.mp4"]
        self.assertEqual((clip["v"], clip["s"], clip["c"]), (2, 1, 1))
        self.assertAlmostEqual(clip["t"], 13.7)
        # Time on screen is capped per view, so a tab left open does not count.
        self.assertEqual(self.library.watch_payload()["a/one.jpg"]["t"], 600)
        reloaded = MediaLibrary(self.media, self.state)
        self.assertEqual(reloaded.watch_payload()["a/clip.mp4"]["v"], 2)

    def test_rejects_bad_events(self):
        self.assertEqual(self.library.record_watch("nope"), 0)
        self.assertEqual(self.library.record_watch([
            {"path": "../x.jpg", "seconds": 1},
            {"path": "a/one.jpg", "seconds": -1},
            {"path": "a/one.jpg", "seconds": True},
            {"path": "a/one.jpg", "seconds": 2, "coverage": 3},
            "a/one.jpg",
        ]), 0)
        self.assertEqual(self.library.watch_payload(), {})

    def test_revisit_schedule_grows_on_keep_and_drops_on_pass(self):
        now = time.time()
        self.library.record_watch([{"path": "a/one.jpg", "seconds": 3, "review": "keep"}])
        row = self.library.watch_payload()["a/one.jpg"]
        self.assertEqual(row["iv"], 7)
        self.assertAlmostEqual(row["due"], now + 7 * 86400, delta=5)
        self.library.record_watch([{"path": "a/one.jpg", "seconds": 3, "review": "love"}])
        self.assertEqual(self.library.watch_payload()["a/one.jpg"]["iv"], 17.5)
        self.library.record_watch([{"path": "a/one.jpg", "seconds": 3, "review": "skip"}])
        row = self.library.watch_payload()["a/one.jpg"]
        self.assertEqual(row["iv"], 17.5)
        self.assertAlmostEqual(row["due"], now + 86400, delta=5)
        self.library.record_watch([{"path": "a/one.jpg", "seconds": 3, "review": "pass"}])
        self.assertNotIn("iv", self.library.watch_payload()["a/one.jpg"])
        # A skip of something not on the schedule does not put it there.
        self.library.record_watch([{"path": "a/two.jpg", "seconds": 3, "review": "skip"}])
        self.assertNotIn("due", self.library.watch_payload()["a/two.jpg"])

    def test_full_reset_and_library_switch_forget_it(self):
        self.library.record_watch([{"path": "a/one.jpg", "seconds": 3}])
        self.library.reset_saved_data()
        self.assertEqual(json.loads((self.state.parent / "watch.json").read_text()), {})


class DuelLogTests(LibraryCase):
    def test_every_duel_is_logged_and_undo_removes_only_that_one(self):
        self.library.record_duel("a/one.jpg", "b/three.jpg")
        before = self.library.record_duel("a/two.jpg", "b/three.jpg")["before"]
        self.library.record_duel("a/one.jpg", "b/three.jpg")
        self.assertEqual([row[:2] for row in self.library.duel_log_payload()],
                         [["a/one.jpg", "b/three.jpg"], ["a/two.jpg", "b/three.jpg"], ["a/one.jpg", "b/three.jpg"]])
        # Undo the last pick: the last matching entry goes.
        self.library.restore_duel(before, ["a/one.jpg", "b/three.jpg"])
        self.assertEqual([row[:2] for row in self.library.duel_log_payload()],
                         [["a/one.jpg", "b/three.jpg"], ["a/two.jpg", "b/three.jpg"]])
        reloaded = MediaLibrary(self.media, self.state)
        self.assertEqual(len(reloaded.duel_log_payload()), 2)

    def test_reset_and_clearing_ratings_empty_the_log(self):
        self.library.record_duel("a/one.jpg", "b/three.jpg")
        self.library.restore_duel({"a/one.jpg": None, "b/three.jpg": None}, None, True)
        self.assertEqual(self.library.duel_log_payload(), [])
        self.library.record_duel("a/one.jpg", "b/three.jpg")
        self.library.clear_ratings()
        self.assertEqual(self.library.duel_log_payload(), [])

    def test_old_style_restore_leaves_the_log(self):
        before = self.library.record_duel("a/one.jpg", "b/three.jpg")["before"]
        self.library.restore_duel(before)
        self.assertEqual(len(self.library.duel_log_payload()), 1)

    def test_removing_a_model_forgets_its_duels_and_watch_rows(self):
        self.library.record_duel("a/one.jpg", "b/three.jpg")
        self.library.record_duel("a/one.jpg", "a/two.jpg")
        self.library.record_watch([{"path": "b/three.jpg", "seconds": 3}, {"path": "a/one.jpg", "seconds": 3}])
        pending, _counts = self.library.detach_model("b", str(self.media))
        self.library.erase_detached(pending)
        self.assertEqual([row[:2] for row in self.library.duel_log_payload()], [["a/one.jpg", "a/two.jpg"]])
        self.assertEqual(set(self.library.watch_payload()), {"a/one.jpg"})


class HttpTests(LibraryCase):
    def setUp(self):
        super().setUp()
        self.server = AppServer(("127.0.0.1", 0), RequestHandler, self.library)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def call(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read())

    def test_watch_and_duel_log_round_trip(self):
        self.assertIn("smart", FEATURES)
        self.assertEqual(self.call("/api/watch", {"events": [{"path": "a/one.jpg", "seconds": 2, "skipped": True}]})["stored"], 1)
        self.assertEqual(self.call("/api/watch")["watch"]["a/one.jpg"]["s"], 1)
        self.call("/api/duel", {"winner": "a/one.jpg", "loser": "a/two.jpg"})
        self.assertEqual(self.call("/api/duel-log")["log"][0][:2], ["a/one.jpg", "a/two.jpg"])
        self.call("/api/duel-restore", {"ratings": {"a/one.jpg": None, "a/two.jpg": None}, "undo": ["a/one.jpg", "a/two.jpg"]})
        self.assertEqual(self.call("/api/duel-log")["log"], [])

    def test_order_settings_save(self):
        self.assertEqual(DEFAULT_SETTINGS["feedOrder"], "random")
        settings = self.call("/api/settings", {"feedOrder": "smart", "ladderRank": "fair"})["settings"]
        self.assertEqual((settings["feedOrder"], settings["ladderRank"]), ("smart", "fair"))


if __name__ == "__main__":
    unittest.main()
