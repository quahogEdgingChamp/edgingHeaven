"""Love ratings, marked moments, session history and the PIN lock, against a
throwaway library of generated stub files and a real HTTP server on a free
port (no real media)."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import server
from server import AppServer, LOCK_COOKIE, MediaLibrary, RequestHandler


class LibraryCase(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.media = root / "media"
        (self.media / "model").mkdir(parents=True)
        (self.media / "model/one.jpg").write_bytes(b"\xff\xd8\xff stub image")
        (self.media / "model/clip.mp4").write_bytes(b"not really a video")
        self.state = root / "data" / "state.json"
        self.library = MediaLibrary(self.media, self.state)

    def tearDown(self):
        self.folder.cleanup()


class LoveTests(LibraryCase):
    def test_love_is_a_kept_rating_and_counts_twice(self):
        self.assertTrue(self.library.set_rating("model/one.jpg", "love"))
        self.assertTrue(self.library.set_rating("model/clip.mp4", "like"))
        counts = self.library.library_payload()["counts"]
        self.assertEqual((counts["liked"], counts["loved"], counts["unrated"]), (2, 1, 0))
        self.assertFalse(self.library.set_rating("model/one.jpg", "adore"))
        reloaded = MediaLibrary(self.media, self.state)
        self.assertEqual(reloaded.library_payload()["counts"]["loved"], 1)


class MarkTests(LibraryCase):
    def test_marks_are_cleaned_merged_and_persist(self):
        spans = self.library.set_marks("model/clip.mp4", [[40, 50], [5, 12.345], [10, 20], [3, 3.1], [-2, 1]])
        self.assertEqual(spans, [[0.0, 1.0], [5.0, 20.0], [40.0, 50.0]])
        reloaded = MediaLibrary(self.media, self.state)
        self.assertEqual(reloaded.marks_payload(), {"model/clip.mp4": spans})
        self.assertEqual(self.library.set_marks("model/clip.mp4", []), [])
        self.assertEqual(self.library.marks_payload(), {})

    def test_marks_only_on_library_videos_and_well_formed(self):
        self.assertIsNone(self.library.set_marks("model/one.jpg", [[1, 5]]))
        self.assertIsNone(self.library.set_marks("../escape.mp4", [[1, 5]]))
        self.assertIsNone(self.library.set_marks("model/clip.mp4", [[1, "5"]]))
        self.assertIsNone(self.library.set_marks("model/clip.mp4", [[True, 5]]))
        long = self.library.set_marks("model/clip.mp4", [[0, 5000]])
        self.assertEqual(long, [[0.0, 600.0]])

    def test_clearing_ratings_keeps_marks(self):
        self.library.set_marks("model/clip.mp4", [[1, 5]])
        self.library.clear_ratings()
        self.assertEqual(self.library.marks_payload(), {"model/clip.mp4": [[1.0, 5.0]]})


class SessionTests(LibraryCase):
    def test_sessions_validate_append_and_clear(self):
        self.assertIsNotNone(self.library.add_session({"mode": "beat", "seconds": 600, "edges": 3, "ending": "finish"}))
        self.assertIsNone(self.library.add_session({"mode": "gallery", "seconds": 60}))
        self.assertIsNone(self.library.add_session({"mode": "session", "seconds": -1}))
        record = self.library.add_session({"mode": "session", "seconds": 60, "ending": "<b>"})
        self.assertNotIn("ending", record)
        reloaded = MediaLibrary(self.media, self.state)
        self.assertEqual([s["mode"] for s in reloaded.sessions_payload()], ["beat", "session"])
        self.library.clear_sessions()
        self.assertEqual(self.library.sessions_payload(), [])


class HTTPCase(LibraryCase):
    def setUp(self):
        super().setUp()
        # A stand-in static folder, so these checks do not depend on which
        # page files the checkout has right now.
        static = Path(self.folder.name) / "static"
        (static / "js").mkdir(parents=True)
        (static / "index.html").write_text("<!doctype html>")
        (static / "js" / "01-core.js").write_text("// page")
        patcher = mock.patch.object(server, "STATIC_DIR", static)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = AppServer(("127.0.0.1", 0), RequestHandler, self.library)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def call(self, path, payload=None, cookie=None):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.base + path, data=data, method="POST" if data else "GET")
        if data:
            request.add_header("Content-Type", "application/json")
        if cookie:
            request.add_header("Cookie", f"{LOCK_COOKIE}={cookie}")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, dict(error.headers), error.read()

    @staticmethod
    def token(headers):
        raw = headers.get("Set-Cookie", "")
        return raw.split(";", 1)[0].split("=", 1)[1] if raw.startswith(LOCK_COOKIE) else None


class LockTests(HTTPCase):
    def test_everything_is_open_without_a_pin(self):
        self.assertEqual(self.call("/api/state")[0], 200)
        status, _, body = self.call("/api/lock")
        self.assertEqual(json.loads(body), {"enabled": False, "unlocked": True, "retryAfter": 0})

    def test_pin_locks_api_and_media_but_not_the_page(self):
        status, headers, _ = self.call("/api/lock/set", {"pin": "2468"})
        self.assertEqual(status, 200)
        mine = self.token(headers)
        self.assertTrue(mine)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        # A different browser, no cookie: the page loads, nothing else does.
        self.assertEqual(self.call("/")[0], 200)
        self.assertEqual(self.call("/js/01-core.js")[0], 200)
        for path in ("/api/state", "/api/marks", "/media?path=model/one.jpg", "/thumb?path=model/clip.mp4"):
            self.assertEqual(self.call(path)[0], 401, path)
        self.assertEqual(self.call("/api/rating", {"path": "model/one.jpg", "rating": "like"})[0], 401)
        self.assertEqual(self.call("/api/lock/set", {"pin": "1111"})[0], 401)
        # The device that set it is still in.
        self.assertEqual(self.call("/api/state", cookie=mine)[0], 200)
        self.assertEqual(self.call("/media?path=model/one.jpg", cookie=mine)[0], 200)

    def test_unlock_wrong_then_right_and_backoff(self):
        self.call("/api/lock/set", {"pin": "2468"})
        self.assertEqual(self.call("/api/unlock", {"pin": "0000"})[0], 403)
        status, headers, _ = self.call("/api/unlock", {"pin": "2468"})
        self.assertEqual(status, 200)
        cookie = self.token(headers)
        self.assertEqual(self.call("/api/state", cookie=cookie)[0], 200)
        for _ in range(5):
            self.call("/api/unlock", {"pin": "0000"})
        status, _, body = self.call("/api/unlock", {"pin": "2468"})
        self.assertEqual(status, 429)
        self.assertGreater(json.loads(body)["retryAfter"], 0)

    def test_change_and_remove_need_the_current_pin(self):
        _, headers, _ = self.call("/api/lock/set", {"pin": "2468"})
        cookie = self.token(headers)
        self.assertEqual(self.call("/api/lock/set", {"pin": "1357", "current": "9999"}, cookie)[0], 403)
        self.assertEqual(self.call("/api/lock/set", {"pin": "12", "current": "2468"}, cookie)[0], 400)
        status, headers, _ = self.call("/api/lock/set", {"pin": "1357", "current": "2468"}, cookie)
        self.assertEqual(status, 200)
        # The old device session is signed out by the change; the new cookie works.
        self.assertEqual(self.call("/api/state", cookie=cookie)[0], 401)
        cookie = self.token(headers)
        self.assertEqual(self.call("/api/lock/clear", {"current": "1357"}, cookie)[0], 200)
        self.assertEqual(self.call("/api/state")[0], 200)

    def test_pin_is_stored_hashed_and_survives_restart(self):
        _, headers, _ = self.call("/api/lock/set", {"pin": "86420"})
        text = self.state.read_text()
        self.assertNotIn("86420", text)
        self.assertNotIn(self.token(headers), text)
        reloaded = MediaLibrary(self.media, self.state)
        self.assertTrue(reloaded.lock_enabled())
        self.assertTrue(reloaded.token_valid(self.token(headers)))
        self.assertTrue(reloaded.pin_matches("86420"))

    def test_logout_revokes_this_device(self):
        _, headers, _ = self.call("/api/lock/set", {"pin": "2468"})
        cookie = self.token(headers)
        self.call("/api/lock/logout", {}, cookie)
        self.assertEqual(self.call("/api/state", cookie=cookie)[0], 401)


class ApiTests(HTTPCase):
    def test_marks_and_sessions_over_http(self):
        status, _, body = self.call("/api/marks", {"path": "model/clip.mp4", "marks": [[1, 4]]})
        self.assertEqual((status, json.loads(body)["marks"]), (200, [[1.0, 4.0]]))
        self.assertEqual(json.loads(self.call("/api/marks")[2])["marks"], {"model/clip.mp4": [[1.0, 4.0]]})
        self.assertEqual(self.call("/api/sessions", {"mode": "dice", "seconds": 90})[0], 200)
        self.assertEqual(len(json.loads(self.call("/api/sessions")[2])["sessions"]), 1)
        self.assertEqual(self.call("/api/sessions", {"mode": "dice"})[0], 400)
        self.assertEqual(self.call("/api/rating", {"path": "model/one.jpg", "rating": "love"})[0], 200)
        state = json.loads(self.call("/api/state")[2])
        self.assertIn("love", state["features"])
        self.assertEqual(state["library"]["counts"]["loved"], 1)

    def test_static_scripts_only_from_static_js(self):
        self.assertEqual(self.call("/js/../../server.py")[0], 404)
        self.assertEqual(self.call("/js/nope.js")[0], 404)
        # /app.js is only answered while an old single-file page still exists.
        self.assertEqual(self.call("/app.js")[0], 404)
        (server.STATIC_DIR / "app.js").write_text("// old page")
        self.assertEqual(self.call("/app.js")[0], 200)


if __name__ == "__main__":
    unittest.main()
