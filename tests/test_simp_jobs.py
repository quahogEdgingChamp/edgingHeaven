"""Downloads (simpjobs.py) over real HTTP: a stand-in simp binary, a throwaway
data dir and library, and a server on a free port. Nothing is fetched from
the internet and no real media is touched."""
import collections
import json
import os
import sqlite3
import signal
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from collections import namedtuple
from unittest import mock

import simpjobs
from server import AppServer, LOCK_COOKIE, MediaLibrary, RequestHandler
from simpjobs import SimpJobs, cdl_file_name, cdl_run_paths, decode_tail, normalize_thread_url, thread_slug

# Behaves like simp for what the server looks at: its log lines, exit codes,
# state/crawl and state/failed, and files in the model folder.
FAKE_SIMP = r'''#!{python}
import json, os, pathlib, signal, subprocess, sys, time
args = sys.argv[3:]  # after "-c <config>"
root = pathlib.Path.cwd()
pathlib.Path("calls.jsonl").open("a").write(json.dumps(sys.argv[1:]) + "\n")
target = pathlib.Path(root.joinpath("whereto.txt").read_text().split("\n")[-2].strip())
cmd = args[0]
cookies = root / "cookies" / "simpcity.txt"
if cmd in ("check-auth", "thread", "download", "bookmarks"):
    if "GOOD" not in (cookies.read_text() if cookies.exists() else ""):
        print("Session looks logged-out. Re-export cookies while logged into https://simpcity.cr and try again.")
        sys.exit(2)
    print("Signed in to https://simpcity.cr")
if cmd == "check-auth":
    print("Session OK — logged into SimpCity.")
elif cmd == "thread":
    for url in [arg for arg in args[1:] if not arg.startswith("--")]:
        key = url.rstrip("/").rsplit("/", 1)[-1]
        slug = key.rsplit(".", 1)[0]
        if slug == "slow":
            # Ignores Ctrl-C, and so does its child: only the whole-group
            # SIGTERM/SIGKILL steps stop them.
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            child = subprocess.Popen([sys.executable, "-c",
                "import signal, time; signal.signal(signal.SIGINT, signal.SIG_IGN); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"])
            pathlib.Path("child.pid").write_text(str(child.pid))
            print("crawling slow thread", flush=True)
            time.sleep(60)
        crawl = root / "state" / "crawl"
        crawl.mkdir(parents=True, exist_ok=True)
        (crawl / f"simpcity.cr_{key}.json").write_text(json.dumps({"thread": url, "last_page": 7, "failed_pages": [], "links": []}))
        (target / slug).mkdir(parents=True, exist_ok=True)
        print(f"Model folder: {target / slug}", flush=True)
        if slug == "drip":  # files land one by one, then it waits to be let go
            # Real pictures when the browser check provides some (copies of test media).
            source = sorted((root / "drip-source").glob("*")) if (root / "drip-source").is_dir() else []
            for n in range(len(source) or 3):
                (target / slug / f"{n}.jpg").write_bytes(source[n].read_bytes() if source else b"\xff\xd8\xff drip")
                time.sleep(1.0 if source else 0.3)
            for _ in range(200):
                if (root / "release").exists():
                    break
                time.sleep(0.1)
        if "--slow-later" in args and slug.startswith("bunkr"):  # its Bunkr links wait for `simp later`
            (root / "state" / "later").mkdir(parents=True, exist_ok=True)
            (root / "state" / "later" / f"{slug}.txt").write_text("https://bunkr.cr/a/one\nhttps://bunkr.cr/a/two\n")
        if slug == "cdl":  # a stand-in cyberdrop-dl in simp's group, until let go
            fake = root / "fake-cdl" / "cyberdrop-dl"
            subprocess.run([str(fake), *json.loads((root / "cdl-args.json").read_text())])
        if slug == "full-model" and not (root / "was-full").exists():  # simp's space.py stopping at the reserve, once
            (root / "was-full").write_text("")
            (target / slug / "first.jpg").write_bytes(b"\xff\xd8\xff first")
            time.sleep(1)
            print("Drive nearly full: 2.0 GB free, keeping 3.0 GB spare. Stopped.")
            sys.exit(3)
        (target / slug / "new.jpg").write_bytes(b"\xff\xd8\xff fetched")
        print("héllo " * 3)
    print("Summary: 1 model(s) · 1 downloaded · 0 already had · 0 failed (direct)")
elif cmd == "later":
    lists = sorted((root / "state" / "later").glob("*.txt"))
    for path in lists:
        (target / path.stem).mkdir(parents=True, exist_ok=True)
        print(f"Model folder: {target / path.stem}", flush=True)
    for _ in range(300):  # a slow Bunkr download, until let go
        if (root / "release-later").exists():
            break
        time.sleep(0.05)
    for path in lists:
        path.unlink()
    print(f"Summary: {len(lists)} model(s) · 0 downloaded · 0 skipped · 0 failed (direct)")
elif cmd == "retry":
    for model in args[1:] or [p.stem for p in (root / "state" / "failed").glob("*.jsonl")]:
        (root / "state" / "failed" / f"{model}.jsonl").unlink()
    print("Summary: 1 model(s) · 2 downloaded · 0 already had · 0 failed (direct)")
elif cmd == "download":
    print("Summary: 3 model(s) · 9 downloaded · 0 already had · 2 failed (direct)")
    sys.exit(1)
elif cmd == "bookmarks" and "--save" in args:
    shots = root / "state" / "previews" / "new-model"
    shots.mkdir(parents=True, exist_ok=True)
    for name in ("0.jpg", "1.png"):
        if not (shots / name).exists():  # the browser check puts real test pictures here
            (shots / name).write_bytes(b"\xff\xd8\xff preview " + name.encode())
    rows = [
        {"url": "https://simpcity.cr/threads/new-model.5/", "title": "New Model", "model": "new-model", "downloaded": False, "previews": ["0.jpg", "1.png", "../../cookies/simpcity.txt"]},
        {"url": "https://simpcity.cr/threads/old-model.6/", "title": "Old Model", "model": "old-model", "downloaded": True, "previews": []},
        {"url": "https://elsewhere.example/threads/x.7/", "title": "Odd", "model": "odd", "downloaded": False, "previews": []},
    ]
    if (root / "bookmark_rows.json").exists():
        rows = json.loads((root / "bookmark_rows.json").read_text())
    (root / "state" / "bookmarks.json").write_text(json.dumps({"updatedAt": "2026-09-27T22:00:00+00:00", "complete": True, "bookmarks": rows}))
    print(f"Saved {len(rows)} bookmarks")
'''

GOOD_COOKIES = "# Netscape HTTP Cookie File\n.simpcity.cr\tTRUE\t/\tTRUE\t0\txf_user\tGOOD\n"


class SimpCase(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        base = Path(self.folder.name)
        self.media = base / "media"
        (self.media / "old-model").mkdir(parents=True)
        (self.media / "old-model/one.jpg").write_bytes(b"\xff\xd8\xff stub image")
        self.state = base / "data" / "state.json"
        self.library = MediaLibrary(self.media, self.state)
        self.root = base / "data" / "scrprsimp"
        (self.root / "cookies").mkdir(parents=True)
        (self.root / "config.toml").write_text('[paths]\nmodels_subdir = ""\n')
        (self.root / "whereto.txt").write_text(f"# where\n{self.media}\n")
        self.bin = base / "fake-simp"
        self.bin.write_text(FAKE_SIMP.replace("{python}", sys.executable))
        self.bin.chmod(0o755)
        self.jobs = SimpJobs(self.root, self.bin, add_files=self.library.add_new_files)
        self.server = AppServer(("127.0.0.1", 0), RequestHandler, self.library, simp=self.jobs)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        for job in self.jobs.jobs:
            if job["status"] == "running":
                self.jobs.cancel(job["id"])
        self.wait(lambda: self.jobs.worker is None, timeout=30)
        self.server.shutdown()
        self.server.server_close()
        self.folder.cleanup()

    def call(self, path, payload=None, cookie=None):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.url + path, data=data, headers={"Content-Type": "application/json"})
        if cookie:
            request.add_header("Cookie", f"{LOCK_COOKIE}={cookie}")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read() or b"{}")

    def wait(self, condition, timeout=15.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return True
            time.sleep(0.05)
        self.fail("timed out waiting")

    def job(self, job_id):
        return next(job for job in self.call("/api/simp/status")[1]["jobs"] if job["id"] == job_id)

    def finished(self, job_id):
        self.wait(lambda: self.job(job_id)["status"] not in ("queued", "running"))
        return self.job(job_id)

    def calls(self):
        path = self.root / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def cookies(self, text=GOOD_COOKIES):
        return self.call("/api/simp/cookies", {"text": text})


class HelperTests(unittest.TestCase):
    def test_thread_links(self):
        ok = "https://simpcity.cr/threads/some-model.12345/"
        for raw in (ok, " https://simpcity.cr/threads/some-model.12345 ", ok + "page-7", ok + "post-99#post-99", ok + "?x=1"):
            self.assertEqual(normalize_thread_url(raw), ok, raw)
        for bad in ("http://simpcity.cr/threads/a.1/", "https://evil.com/threads/a.1/", "https://simpcity.cr/threads/a/",
                    "https://simpcity.cr/forums/a.1/", "https://simpcity.cr/threads/a.1/extra/", "-o/etc", None, 5,
                    "https://simpcity.cr/threads/a b.1/"):
            self.assertIsNone(normalize_thread_url(bad), bad)
        self.assertEqual(thread_slug(ok), "some-model")
        self.assertEqual(thread_slug("https://simpcity.su/threads/a%3Cb%3E.9/"), "a_b")

    def test_cyberdrop_command_lines(self):
        argv = ["/usr/bin/python3", "/x/.venv/bin/cyberdrop-dl", "download", "--config-file", "c.yaml", "-i", "l.txt",
                "-o", "/srv/in/model", "--db", "/s/cyberdrop.db", "--cache-file", "c.json", "--log-file", "/s/logs/downloader.log"]
        self.assertEqual(cdl_run_paths(argv), {"out": Path("/srv/in/model"), "db": Path("/s/cyberdrop.db"), "log": Path("/s/logs/downloader.log")})
        self.assertIsNone(cdl_run_paths(["/x/bin/simp", "-c", "config.toml", "thread", "-o", "a", "--db", "b", "--log-file", "c"]))
        self.assertIsNone(cdl_run_paths(argv[:8]))
        self.assertEqual(cdl_file_name("https://c5.cdn.cr/storage/media/Tameeka-ppv--4--x.mp4?n=Tameeka+ppv+(4).mp4"), "Tameeka ppv (4).mp4")
        self.assertEqual(cdl_file_name("https://pixeldrain.com/api/file/wvV1psZ7?download"), "wvV1psZ7")

    def test_speed_is_growth_over_the_window(self):
        samples = collections.deque()
        self.assertIsNone(SimpJobs._speed(samples, 100.0, 0))
        self.assertIsNone(SimpJobs._speed(samples, 102.0, 1000))  # too soon to say
        self.assertEqual(SimpJobs._speed(samples, 110.0, 5000), 500.0)
        self.assertEqual(SimpJobs._speed(samples, 200.0, 5000), 0.0)  # old samples age out
        self.assertEqual(len(samples), 2)

    def test_decode_tail_never_splits_a_character(self):
        data = "héllo".encode()
        self.assertEqual(decode_tail(data[:2]), ("h", 1))
        self.assertEqual(decode_tail(data), ("héllo", 6))


class SetupTests(SimpCase):
    def test_not_set_up_is_reported_not_run(self):
        (self.root / "config.toml").unlink()
        status = self.call("/api/simp/status")[1]
        self.assertTrue(status["installed"])
        self.assertFalse(status["configured"])
        self.assertEqual(self.call("/api/simp/jobs", {"action": "check-auth"})[0], 409)
        missing = SimpJobs(self.root, self.root / "no-such-simp")
        self.assertFalse(missing.status()["installed"])
        self.assertEqual(self.calls(), [])

    def test_feature_flag_and_pin_lock(self):
        state = self.call("/api/state")[1]
        self.assertIn("simp", state["features"])
        self.assertIn("bookmarks", state["features"])
        self.call("/api/lock/set", {"pin": "2468"})
        for path, payload in (("/api/simp/status", None), ("/api/simp/jobs", {"action": "check-auth"}),
                              ("/api/simp/cookies", {"text": GOOD_COOKIES})):
            self.assertEqual(self.call(path, payload)[0], 401, path)
        self.assertEqual(self.calls(), [])


class JobTests(SimpCase):
    def test_thread_job_downloads_rescans_and_remembers_the_thread(self):
        self.cookies()
        status, body = self.call("/api/simp/jobs", {"action": "thread", "urls": [
            "https://simpcity.cr/threads/new-model.123/page-4#post-9", "https://simpcity.cr/threads/new-model.123/"]})
        self.assertEqual(status, 200, body)
        job = self.finished(body["job"]["id"])
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["models"], ["new-model"])
        self.assertTrue(job["summary"].startswith("Summary: 1 model(s)"))
        # One URL (deduplicated, page and anchor dropped), after -c <config>.
        self.assertEqual(self.calls(), [["-c", str(self.root / "config.toml"), "thread", "--slow-later", "https://simpcity.cr/threads/new-model.123/"]])
        # The rescan put the new file in the library.
        self.wait(lambda: any(item["path"] == "new-model/new.jpg" for item in self.call("/api/state")[1]["library"]["images"]))
        status = self.call("/api/simp/status")[1]
        self.assertEqual(status["threads"], [{"model": "new-model", "url": "https://simpcity.cr/threads/new-model.123/", "lastPage": 7}])
        self.assertTrue(status["auth"]["ok"])
        self.assertEqual(status["target"], str(self.media))
        self.assertIsNotNone(status["freeBytes"])

        # Check for new posts: the same thread again, found from the crawl cache.
        status, body = self.call("/api/simp/jobs", {"action": "update", "model": "new-model"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["job"]["args"], ["thread", "--slow-later", "https://simpcity.cr/threads/new-model.123/"])
        self.assertEqual(self.finished(body["job"]["id"])["status"], "done")
        self.assertEqual(self.call("/api/simp/jobs", {"action": "update", "model": "old-model"})[0], 404)

    def test_the_log_streams_by_offset_and_tail(self):
        self.cookies()
        job_id = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/m.1/"]})[1]["job"]["id"]
        self.finished(job_id)
        status, whole = self.call(f"/api/simp/jobs/{job_id}/log?offset=0")
        self.assertEqual(status, 200)
        self.assertTrue(whole["text"].startswith("$ simp thread --slow-later https://simpcity.cr/threads/m.1/\n"))
        self.assertIn("héllo", whole["text"])
        self.assertEqual(whole["offset"], whole["size"])
        self.assertEqual(self.call(f"/api/simp/jobs/{job_id}/log?offset={whole['offset']}")[1]["text"], "")
        # A tail that starts a few bytes into the line before the summary
        # begins at the summary: whole lines only.
        encoded = whole["text"].encode()
        back = len(encoded) - encoded.rindex(b"\nSummary:") + 3
        tail = self.call(f"/api/simp/jobs/{job_id}/log?offset=-{back}")[1]
        self.assertTrue(tail["text"].startswith("Summary:"))
        self.assertTrue(whole["text"].endswith(tail["text"]))
        self.assertEqual(self.call(f"/api/simp/jobs/{job_id}/log?offset=x")[0], 400)
        self.assertEqual(self.call("/api/simp/jobs/0123456789ab/log")[0], 404)

    def test_bad_requests_run_nothing(self):
        self.cookies()
        for payload in (
            {"action": "thread", "urls": ["https://simpcity.cr/threads/a.1/", "--output=/etc"]},
            {"action": "thread", "urls": ["http://simpcity.cr/threads/a.1/"]},
            {"action": "thread", "urls": []},
            {"action": "thread", "urls": [f"https://simpcity.cr/threads/m{n}.{n}/" for n in range(21)]},
            {"action": "bookmarks", "pages": "1;rm -rf /"},
            {"action": "bookmarks", "pages": "1", "limit": -1},
            {"action": "bookmarks", "pages": "1", "limit": "5"},
            {"action": "retry", "models": ["../../etc"]},
            {"action": "clear"},
            {"action": "update", "model": ["x"]},
        ):
            self.assertIn(self.call("/api/simp/jobs", payload)[0], (400, 404, 409), payload)
        self.assertEqual(self.calls(), [])

    def test_bookmarks_and_retry(self):
        self.cookies()
        job = self.call("/api/simp/jobs", {"action": "bookmarks", "pages": "2-3, 5", "limit": 4})[1]["job"]
        self.assertEqual(job["args"], ["download", "--slow-later", "--pages", "2-3,5", "--limit", "4"])
        self.assertEqual(self.finished(job["id"])["status"], "failed")  # exit 1: some files failed
        job = self.call("/api/simp/jobs", {"action": "bookmarks", "pages": "all"})[1]["job"]
        self.assertEqual(job["args"], ["download", "--slow-later"])
        self.finished(job["id"])

        self.assertEqual(self.call("/api/simp/jobs", {"action": "retry"})[0], 409)  # nothing failed yet
        failed = self.root / "state" / "failed"
        failed.mkdir(parents=True)
        (failed / "a.jsonl").write_text('{"via": "direct", "url": "https://x/1.jpg"}\n{"via": "cdl", "exit": 1}\n')
        (failed / "b.jsonl").write_text('{"via": "direct", "url": "https://x/2.jpg"}\n')
        rows = self.call("/api/simp/status")[1]["failed"]
        self.assertEqual(rows, [{"model": "a", "files": 1, "cyberdrop": True}, {"model": "b", "files": 1, "cyberdrop": False}])
        job = self.call("/api/simp/jobs", {"action": "retry", "models": ["a"]})[1]["job"]
        self.assertEqual((job["args"], job["models"]), (["retry", "a"], ["a"]))
        self.assertEqual(self.finished(job["id"])["status"], "done")
        self.assertEqual([row["model"] for row in self.call("/api/simp/status")[1]["failed"]], ["b"])

    def test_one_at_a_time_duplicates_and_cancel(self):
        self.cookies()
        with mock.patch.object(simpjobs, "CANCEL_STEPS", ((signal.SIGINT, 0.5), (signal.SIGTERM, 0.5), (signal.SIGKILL, 2))):
            slow = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/slow.1/"]})[1]["job"]
            waiting = self.call("/api/simp/jobs", {"action": "check-auth"})[1]["job"]
            self.wait(lambda: (self.root / "child.pid").exists())
            self.assertEqual(self.job(slow["id"])["status"], "running")
            self.assertEqual(self.job(waiting["id"])["status"], "queued")
            self.assertEqual(self.call("/api/simp/jobs", {"action": "check-auth"})[0], 409)  # already queued

            # A queued job is dropped without ever running.
            self.assertEqual(self.call(f"/api/simp/jobs/{waiting['id']}/cancel", {})[1]["job"]["status"], "cancelled")
            # The running one: simp ignores Ctrl-C and its child ignores
            # Ctrl-C and SIGTERM; the whole process group still goes.
            child = int((self.root / "child.pid").read_text())
            self.assertEqual(self.call(f"/api/simp/jobs/{slow['id']}/cancel", {})[0], 200)
            job = self.finished(slow["id"])
            self.assertEqual(job["status"], "cancelled")
            self.wait(lambda: not process_alive(child), timeout=10)
            self.assertEqual(self.call(f"/api/simp/jobs/{slow['id']}/cancel", {})[0], 409)
            self.assertIn("Cancelled.", self.call(f"/api/simp/jobs/{slow['id']}/log")[1]["text"])
        self.assertEqual([call[2] for call in self.calls()], ["thread"])  # check-auth never ran

    def test_restart_marks_unfinished_jobs_interrupted(self):
        (self.root / "jobs").mkdir()
        (self.root / "jobs" / "jobs.json").write_text(json.dumps({"jobs": [
            {"id": "aaaaaaaaaaaa", "action": "check-auth", "label": "x", "args": ["check-auth"], "models": [], "status": "running"},
            {"id": "bbbbbbbbbbbb", "action": "check-auth", "label": "y", "args": ["check-auth"], "models": [], "status": "queued"},
            {"id": "../../escape", "status": "done"},
        ], "auth": {"ok": True}}))
        reloaded = SimpJobs(self.root, self.bin)
        self.assertEqual([job["status"] for job in reloaded.jobs], ["interrupted", "interrupted"])
        self.assertTrue(reloaded.auth["ok"])
        self.assertIsNone(reloaded.worker)


class BookmarkTests(SimpCase):
    def test_refresh_list_and_previews(self):
        self.assertEqual(self.call("/api/simp/bookmarks")[1], {"updatedAt": None, "complete": True, "bookmarks": []})
        self.cookies()
        job = self.call("/api/simp/jobs", {"action": "bookmarks-sync"})[1]["job"]
        self.assertEqual(job["args"], ["bookmarks", "--save"])
        self.assertEqual(self.finished(job["id"])["status"], "done")

        listing = self.call("/api/simp/bookmarks")[1]
        self.assertEqual(listing["updatedAt"], "2026-09-27T22:00:00+00:00")
        self.assertEqual([(row["model"], row["title"], row["url"]) for row in listing["bookmarks"]], [
            ("new-model", "New Model", "https://simpcity.cr/threads/new-model.5/"),
            ("old-model", "Old Model", "https://simpcity.cr/threads/old-model.6/"),
            ("odd", "Odd", None),  # not a SimpCity thread link: no Download button
        ])
        # Only proper preview names become URLs, served by this server.
        self.assertEqual(listing["bookmarks"][0]["previews"], ["/api/simp/previews/new-model/0.jpg", "/api/simp/previews/new-model/1.png"])
        with urllib.request.urlopen(self.url + listing["bookmarks"][0]["previews"][1]) as response:
            self.assertEqual((response.headers["Content-Type"], response.read()), ("image/png", b"\xff\xd8\xff preview 1.png"))
        (self.root / "state" / "previews" / "..x").mkdir()
        (self.root / "state" / "previews" / "..x" / "0.jpg").write_bytes(b"x")
        for path in ("/api/simp/previews/new-model/2.jpg", "/api/simp/previews/new-model/..%2F..%2Fcookies%2Fsimpcity.txt",
                     "/api/simp/previews/..%2F..%2Fcookies/simpcity.txt", "/api/simp/previews/%2E%2E/config.toml",
                     "/api/simp/previews/..x/0.jpg", "/api/simp/previews/new-model/0.txt"):
            self.assertEqual(self.call(path)[0], 404, path)
        self.call("/api/lock/set", {"pin": "2468"})
        self.assertEqual(self.call("/api/simp/bookmarks")[0], 401)
        self.assertEqual(self.call(listing["bookmarks"][0]["previews"][0])[0], 401)


Usage = namedtuple("Usage", "total used free")
GB = 1024**3


class WhileDownloadingTests(SimpCase):
    def test_files_arrive_in_the_library_while_the_job_runs(self):
        self.cookies()
        before = self.call("/api/library-status")[1]
        with mock.patch.object(simpjobs, "WATCH_SECONDS", 0.2):
            job = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/drip.1/"]})[1]["job"]
            # Before the job ends, its first files are already in the library...
            self.wait(lambda: self.call(f"/api/simp/jobs/{job['id']}/arrivals")[1]["count"] >= 2)
            self.assertEqual(self.job(job["id"])["status"], "running")
            status = self.call("/api/library-status")[1]
            self.assertEqual(status["scanId"], before["scanId"])  # added, not rescanned
            self.assertGreaterEqual(status["appended"], 2)
            added = self.call(f"/api/library-additions?scan={before['scanId']}&from=0")[1]
            self.assertEqual({item["path"] for item in added["items"]} >= {"drip/0.jpg", "drip/1.jpg"}, True)
            self.assertTrue(all(item["kind"] == "image" and item["folder"] == "drip" for item in added["items"]))
            (self.root / "release").write_text("go")
            self.finished(job["id"])
        arrivals = self.call(f"/api/simp/jobs/{job['id']}/arrivals")[1]
        self.assertEqual(arrivals["paths"], ["drip/new.jpg", "drip/2.jpg", "drip/1.jpg", "drip/0.jpg"])  # newest first
        self.assertEqual(self.job(job["id"])["arrived"], 4)
        self.assertIn("drip", self.job(job["id"])["models"])
        # A page that is behind asks from where it left off; after a full scan it must reload.
        self.assertEqual(self.call(f"/api/library-additions?scan={before['scanId']}&from=4")[1]["items"], [])
        self.library.scan()
        self.assertEqual(self.call(f"/api/library-additions?scan={before['scanId']}&from=0")[0], 409)

    def test_only_library_folders_are_added_and_trashed_files_drop_out(self):
        (self.media / "fresh").mkdir()
        (self.media / "fresh" / "a.jpg").write_bytes(b"\xff\xd8\xff a")
        (self.media / ".heaven-trash").mkdir()
        (self.media / ".heaven-trash" / "x.jpg").write_bytes(b"\xff\xd8\xff x")
        outside = Path(self.folder.name) / "elsewhere"
        outside.mkdir()
        (outside / "b.jpg").write_bytes(b"\xff\xd8\xff b")
        added = self.library.add_new_files([str(self.media / "fresh" / "sub"), str(outside), str(self.media / ".heaven-trash")])
        self.assertEqual([item["path"] for item in added], ["fresh/a.jpg"])
        self.assertEqual(self.library.add_new_files([str(self.media / "fresh")]), [])  # already known
        scan = self.library.scan_id
        self.library.trash_media("fresh/a.jpg", str(self.media))
        self.assertEqual(self.library.additions(scan, 0)["items"], [])


class DriveFullTests(SimpCase):
    def setUp(self):
        super().setUp()
        (self.root / "config.toml").write_text('[paths]\nmodels_subdir = ""\n[download]\nmin_free_bytes = %d\n' % (3 * GB))
        self.free = 50 * GB
        patcher = mock.patch.object(simpjobs.shutil, "disk_usage", lambda path: Usage(100 * GB, 0, self.free))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cookies()

    def test_a_full_drive_holds_the_rest_and_resume_continues(self):
        first = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/full-model.1/"]})[1]["job"]
        waiting = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/other.2/"]})[1]["job"]
        login = self.call("/api/simp/jobs", {"action": "check-auth"})[1]["job"]
        self.assertEqual(self.job(waiting["id"])["status"], "queued")
        self.assertEqual(self.finished(first["id"])["status"], "full")
        self.assertTrue(self.job(first["id"])["summary"].startswith("Drive nearly full"))
        self.assertEqual(self.job(waiting["id"])["status"], "held")
        self.assertEqual(self.finished(login["id"])["status"], "done")  # does not write to the drive
        resume = next(job for job in self.call("/api/simp/status")[1]["jobs"] if job["label"] == "Resume: Download full-model")
        self.assertEqual((resume["status"], resume["args"]), ("held", first["args"]))
        # What arrived before the stop is in the library anyway.
        self.assertIn("full-model/first.jpg", [item["path"] for item in self.library.library_payload()["images"]])

        self.free = 2 * GB
        status = self.call("/api/simp/status")[1]
        self.assertEqual((status["reserveBytes"], status["resumeBytes"]), (3 * GB, 4 * GB))
        self.assertEqual(self.call("/api/simp/resume", {})[0], 409)  # not enough room yet
        self.assertEqual(self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/x.3/"]})[0], 409)
        self.assertEqual(self.call("/api/simp/jobs", {"action": "check-auth"})[0], 200)

        self.free = 20 * GB
        self.assertEqual(self.call("/api/simp/resume", {})[1]["resumed"], 2)
        # The stopped job goes first, then the one that was waiting behind it.
        self.wait(lambda: all(self.job(j)["status"] not in ("held", "queued", "running") for j in (resume["id"], waiting["id"])), timeout=30)
        order = [call[-1] for call in self.calls() if call[2] == "thread"]
        self.assertEqual(order[-2:], ["https://simpcity.cr/threads/full-model.1/", "https://simpcity.cr/threads/other.2/"])
        self.assertEqual(self.call("/api/simp/resume", {})[0], 409)  # nothing left waiting

    def test_held_jobs_can_be_dropped(self):
        self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/full-model.1/"]})
        waiting = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/other.2/"]})[1]["job"]
        self.wait(lambda: self.job(waiting["id"])["status"] == "held")
        self.assertEqual(self.call(f"/api/simp/jobs/{waiting['id']}/cancel", {})[1]["job"]["status"], "cancelled")


class DangerousKeptTests(SimpCase):
    def test_keeping_in_dangerous_is_not_a_rating(self):
        self.assertEqual(self.call("/api/dangerous-kept", {"path": "old-model/one.jpg", "kept": True})[0], 200)
        self.assertEqual(self.call("/api/dangerous-kept")[1]["kept"].keys(), {"old-model/one.jpg"})
        counts = self.call("/api/state")[1]["library"]["counts"]
        self.assertEqual((counts["liked"], counts["unrated"]), (0, 1))
        self.assertEqual(self.call("/api/dangerous-kept", {"path": "nope.jpg", "kept": True})[0], 400)
        self.assertEqual(self.call("/api/dangerous-kept", {"path": "old-model/one.jpg", "kept": "yes"})[0], 400)
        # Clearing ratings leaves it; so does a restart.
        self.call("/api/reset-ratings", {})
        self.assertIn("old-model/one.jpg", MediaLibrary(self.media, self.state).dangerous_kept_payload())
        self.call("/api/dangerous-kept", {"path": "old-model/one.jpg", "kept": False})
        self.assertEqual(self.call("/api/dangerous-kept")[1]["kept"], {})

    def test_import_once_and_forget_erased_files(self):
        (self.state.parent / "dangerous-kept-import.json").write_text(json.dumps(["old-model/one.jpg", 5]))
        library = MediaLibrary(self.media, self.state)
        self.assertEqual(list(library.dangerous_kept_payload()), ["old-model/one.jpg"])
        self.assertFalse((self.state.parent / "dangerous-kept-import.json").exists())
        self.assertTrue((self.state.parent / "dangerous-kept-import.json.imported").exists())
        library.trash_media("old-model/one.jpg", str(self.media))
        library.empty_trash(str(self.media))
        self.assertEqual(library.state["dangerousKept"], {})


class CookieTests(SimpCase):
    def test_login_expiry_comes_from_the_stay_logged_in_cookie(self):
        self.assertIsNone(self.call("/api/simp/status")[1]["cookies"]["loginExpiresAt"])
        self.cookies(GOOD_COOKIES + "simpcity.cr\tFALSE\t/\tTRUE\t1803254400\tabc_user\tsecret\n"
                     ".simpcity.cr\tTRUE\t/\tFALSE\t1790000000\t__ddg1_\tx\n")
        cookies = self.call("/api/simp/status")[1]["cookies"]
        self.assertEqual(cookies["loginExpiresAt"], "2027-02-22T00:00:00+00:00")
        self.assertNotIn("secret", json.dumps(cookies))

    def test_cookies_are_checked_stored_privately_and_drive_the_login_state(self):
        for text in ("", "hello", "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\ta\tb\n", "x" * 600_000):
            self.assertEqual(self.cookies(text)[0], 400)
        self.assertFalse((self.root / "cookies" / "simpcity.txt").exists())

        # Without the header line, and with Windows line ends: stored fixed.
        status, body = self.cookies("#HttpOnly_.simpcity.cr\tTRUE\t/\tTRUE\t0\txf_session\tBAD\r\n")
        self.assertEqual((status, body["cookies"]), (200, 1))
        stored = self.root / "cookies" / "simpcity.txt"
        self.assertEqual(stored.read_text(), "# Netscape HTTP Cookie File\n#HttpOnly_.simpcity.cr\tTRUE\t/\tTRUE\t0\txf_session\tBAD\n")
        self.assertEqual(stored.stat().st_mode & 0o777, 0o600)
        self.assertIsNone(self.call("/api/simp/status")[1]["auth"]["ok"])

        job = self.call("/api/simp/jobs", {"action": "check-auth"})[1]["job"]
        self.assertEqual(self.finished(job["id"])["status"], "error")
        auth = self.call("/api/simp/status")[1]["auth"]
        self.assertFalse(auth["ok"])
        self.assertTrue(auth["message"].startswith("Session looks logged-out"))

        self.cookies()
        job = self.call("/api/simp/jobs", {"action": "check-auth"})[1]["job"]
        self.assertEqual(self.finished(job["id"])["status"], "done")
        status = self.call("/api/simp/status")[1]
        self.assertTrue(status["auth"]["ok"])
        self.assertTrue(status["cookies"]["present"])
        self.assertNotIn("GOOD", json.dumps(status))  # the cookie values never come back


def process_alive(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except OSError:
        return False
    return state != "Z"


if __name__ == "__main__":
    unittest.main()


class CyberdropProgressTests(SimpCase):
    def test_what_cyberdrop_dl_is_doing_shows_while_it_runs(self):
        """A stand-in cyberdrop-dl in the job's process group, with a log,
        database and .part files like the real one's (cyberdrop-dl 10.10)."""
        self.cookies()
        cdl = self.root / "cdl-state"
        (cdl / "logs").mkdir(parents=True)
        out = self.root / "incoming" / "a_b"  # "_" must not match any character in SQL
        (out / "Model (Bunkr)").mkdir(parents=True)
        fake = self.root / "fake-cdl" / "cyberdrop-dl"
        fake.parent.mkdir()
        fake.write_text(f"#!{sys.executable}\nimport pathlib, time\nfor _ in range(300):\n"
                        f"    if pathlib.Path({str(self.root / 'release')!r}).exists(): break\n    time.sleep(0.1)\n")
        fake.chmod(0o755)
        (self.root / "cdl-args.json").write_text(json.dumps(
            ["download", "-i", "urls.txt", "-o", str(out), "--db", str(cdl / "cyberdrop.db"), "--log-file", str(cdl / "logs" / "downloader.log")]))

        now = datetime.now()
        stamp = f"[{now:%Y-%m-%d %H:%M:%S}.123]"
        pad = " " * 26
        big = "https://c5.cdn.cr/storage/media/Big-one-AAA.mp4?n=Big+one.mp4"
        busy = "https://pbc.scdn.st/storage/media/uuid1.mp4?n=1+(2).mp4"
        (cdl / "logs" / "downloader.log").write_text("\n".join([
            f"[2020-01-01 00:00:00.000] INFO     Download starting: https://old.example/left-over.mp4",
            f"{stamp} INFO     Running cyberdrop-dl v10.10.0",
            f"{pad}INFO     [Bunkr] Scraping https://bunkr.cr/a/album",
            f"{stamp} INFO     Download starting: {big}",
            f"{pad}INFO     Download starting: https://pixeldrain.com/api/file/PIX1?download",
            f"{stamp} INFO     Download starting: {busy}",
            f"{stamp} ERROR    Download Failed: {busy} (503 Service Unavailable) ",
            " -> Referer: https://bunkr.cr/f/abc",
            f"{stamp} INFO     Download finished: https://pixeldrain.com/api/file/PIX1?download",
            f"{stamp} ERROR    Download failed: {big} with error: 999 Timeout - Download timeout reached, retrying",
            f"{pad}INFO     Retrying download: {big}, attempt: 2",
            f"{stamp} INFO     Download skipped https://c2.cdn.cr/y.rar?n=y.rar due to filename regex exclude filter.",
            f"{stamp} ERROR    Scrape Failed: https://gofile.io/d/zz (404 Not Found)",
            f"{stamp} INFO     Download starting: https://c5.cdn.cr/storage/media/half-written",  # no newline yet
        ]))
        db = sqlite3.connect(cdl / "cyberdrop.db")
        db.execute("CREATE TABLE media (domain TEXT, url_path TEXT, download_path TEXT, file_size INT, completed INTEGER, completed_at TIMESTAMP)")
        utc_now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        bunkr = str(out / "Model (Bunkr)")
        db.executemany("INSERT INTO media VALUES (?, ?, ?, ?, ?, ?)", [
            ("bunkr", "/Big-one-AAA.mp4", bunkr, None, 0, None),              # downloading
            ("pixeldrain", "/api/file/PIX1", str(out / "Loose"), 5000, 1, utc_now),
            ("bunkr", "/uuid1.mp4", bunkr, None, 0, None),                    # failed
            ("bunkr", "/Next-BBB.mp4", bunkr, None, 0, None),                 # waiting
            ("bunkr", "/Next-CCC.mp4", bunkr, None, 0, None),                 # waiting
            ("goonbox", "/old.jpg", str(out), 70, 1, "2020-01-01 00:00:00"),  # an earlier run
            ("bunkr", "/Other.mp4", str(out.parent / "aXb"), None, 0, None),   # another model
        ])
        db.commit()
        db.close()
        (out / "Model (Bunkr)" / "Big one.mp4.part").write_bytes(b"x" * 1000)
        stale = out / "old.mp4.part"
        stale.write_bytes(b"x" * 10)
        os.utime(stale, (time.time() - 3600, time.time() - 3600))

        self.assertIsNone(self.call("/api/simp/status")[1]["progress"])
        job_id = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/cdl.1/"]})[1]["job"]["id"]
        self.wait(lambda: (self.call("/api/simp/status")[1]["progress"] or {}).get("jobId") == job_id)
        progress = self.call("/api/simp/status")[1]["progress"]
        self.assertEqual(progress["phase"], "downloading")
        self.assertEqual((progress["linksChecked"], progress["scrapeFailed"], progress["skipped"]), (1, 1, 1))
        self.assertEqual((progress["done"], progress["doneBytes"]), (1, 5000))
        self.assertEqual(progress["downloading"], 1)
        self.assertEqual([(file["name"], file["bytes"], file["host"]) for file in progress["active"]], [("Big one.mp4", 1000, "c5.cdn.cr")])
        self.assertEqual((progress["waiting"], progress["waitingByHost"]), (2, {"bunkr": 2}))
        self.assertEqual((progress["failed"], progress["failedReasons"]), (1, [["503 Service Unavailable", 1]]))
        self.assertIsNone(progress["etaSeconds"])  # one finish is too few to go by

        (self.root / "release").write_text("")
        self.assertEqual(self.finished(job_id)["status"], "done")
        self.jobs._progress = (0.0, None)
        self.assertIsNone(self.call("/api/simp/status")[1]["progress"])


class SlowLaterTests(SimpCase):
    def test_bunkr_files_go_last_and_step_aside_for_new_downloads(self):
        self.cookies()
        first = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/bunkr-model.1/"]})[1]["job"]
        self.assertEqual(self.finished(first["id"])["status"], "done")
        # Its Bunkr links were saved; the "later" job for them runs next.
        self.wait(lambda: any(job["action"] == "later" and job["status"] == "running" for job in self.call("/api/simp/status")[1]["jobs"]))
        status = self.call("/api/simp/status")[1]
        later = next(job for job in status["jobs"] if job["action"] == "later")
        self.assertEqual((later["label"], later["models"]), ("Bunkr files, last: bunkr-model", ["bunkr-model"]))
        self.assertEqual([(row["model"], row["links"]) for row in status["later"]], [("bunkr-model", 2)])
        self.assertNotIn("yielding", later)

        # A new download pauses it, runs, and the Bunkr files go on after.
        other = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/other.2/"]})[1]["job"]
        self.wait(lambda: self.job(later["id"])["status"] == "queued")
        self.assertIn("Paused", self.job(later["id"])["summary"])
        self.assertEqual(self.finished(other["id"])["status"], "done")
        self.wait(lambda: self.job(later["id"])["status"] == "running")
        (self.root / "release-later").write_text("")
        self.assertEqual(self.finished(later["id"])["status"], "done")
        self.assertEqual([call[2:] for call in self.calls()], [
            ["thread", "--slow-later", "https://simpcity.cr/threads/bunkr-model.1/"], ["later"],
            ["thread", "--slow-later", "https://simpcity.cr/threads/other.2/"], ["later"]])
        # Nothing new was saved meanwhile: no further later job.
        status = self.call("/api/simp/status")[1]
        self.assertEqual(status["later"], [])
        self.assertEqual(sum(job["action"] == "later" for job in status["jobs"]), 1)
        self.assertEqual(self.call("/api/simp/jobs", {"action": "later"})[0], 409)

    def test_waiting_bunkr_files_run_after_everything_else(self):
        self.cookies()
        (self.root / "release-later").write_text("")
        (self.root / "state" / "later").mkdir(parents=True)
        (self.root / "state" / "later" / "kept.txt").write_text("https://bunkr.cr/a/x\n")
        # Queued first by hand, yet the downloads queued after it run before it.
        self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/slow.1/"]})
        later = self.call("/api/simp/jobs", {"action": "later"})[1]["job"]
        second = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/next.3/"]})[1]["job"]
        self.cancel_slow_when_running()
        self.finished(second["id"])
        self.assertEqual(self.finished(later["id"])["status"], "done")
        self.assertEqual([call[2] if call[2] != "thread" else call[-1] for call in self.calls()],
                         ["https://simpcity.cr/threads/slow.1/", "https://simpcity.cr/threads/next.3/", "later"])

    def cancel_slow_when_running(self):
        self.wait(lambda: (self.root / "child.pid").exists())  # simp itself is running, not just starting
        slow = next(job for job in self.call("/api/simp/status")[1]["jobs"] if "slow" in job["label"])
        self.call(f"/api/simp/jobs/{slow['id']}/cancel", {})



class ModelResetTests(SimpCase):
    """Settings → Remove a model: the folder, its trash, what the app and
    simp remember. Everything here lives in the test's temporary folder."""

    def setUp(self):
        super().setUp()
        self.state_dir = self.root / "state"
        self.staging = self.media.parent / f".{self.media.name}.simp-incoming"
        for model in ("gone", "stays"):
            folder = self.media / model / "Loose Files (Bunkr)"
            folder.mkdir(parents=True)
            (self.media / model / "a.jpg").write_bytes(b"\xff\xd8\xff photo " + model.encode())
            (self.media / model / "b.jpg").write_bytes(b"\xff\xd8\xff second " + model.encode())
            (folder / "c.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42 clip")
            (self.media / model / "notes.txt").write_text("not media")
            for sub, name in (("done", f"{model}.jsonl"), ("content", f"{model}.jsonl"), ("failed", f"{model}.jsonl")):
                (self.state_dir / sub).mkdir(parents=True, exist_ok=True)
                (self.state_dir / sub / name).write_text('{"url": "u1"}\n{"url": "u2"}\n')
            (self.state_dir / "later").mkdir(exist_ok=True)
            (self.state_dir / "later" / f"{model}.txt").write_text("https://bunkr.cr/a/1\n")
            (self.state_dir / f"cdl_{model}.txt").write_text("https://bunkr.cr/a/1\n")
            (self.state_dir / "crawl").mkdir(exist_ok=True)
            (self.state_dir / "crawl" / f"simpcity.cr_{model}.9.json").write_text(
                json.dumps({"thread": f"https://simpcity.cr/threads/{model}.9/", "last_page": 4, "links": []}))
            (self.staging / model).mkdir(parents=True)
            (self.staging / model / "half.mp4.part").write_bytes(b"x" * 1000)
        (self.state_dir / "cdl").mkdir()
        with sqlite3.connect(self.state_dir / "cdl" / "cyberdrop.db") as db:
            db.execute("CREATE TABLE media (domain TEXT, url_path TEXT, download_path TEXT, completed INTEGER)")
            db.executemany("INSERT INTO media VALUES (?, ?, ?, 1)", [
                ("bunkr", "/1", f"{self.staging}/gone/Loose Files (Bunkr)"),
                ("bunkr", "/2", "/old/drive/.baza.simp-incoming/gone"),  # from before the library moved
                ("bunkr", "/3", f"{self.media}/gone"),
                ("bunkr", "/4", f"{self.staging}/stays"),
                ("bunkr", "/5", f"{self.staging}/gone-too"),  # a different model whose name starts the same
            ])
        db.close()
        self.library.scan()
        # What the app remembers about each model's files.
        for model in ("gone", "stays"):
            self.call("/api/rating", {"path": f"{model}/a.jpg", "rating": "love"})
            self.call("/api/rating", {"path": f"{model}/b.jpg", "rating": "dislike"})
            self.call("/api/marks", {"path": f"{model}/Loose Files (Bunkr)/c.mp4", "marks": [[1, 5]]})
            self.call("/api/duel", {"winner": f"{model}/a.jpg", "loser": f"{model}/b.jpg"})
            self.call("/api/seen", {"paths": [f"{model}/a.jpg"]})
            self.call("/api/fingerprints", {"items": {f"{model}/a.jpg": ["0123456789abcdef", 10, 10]}})
            self.assertTrue(self.library.save_thumb(f"{model}/Loose Files (Bunkr)/c.mp4", b"\xff\xd8\xff still"))
        self.call("/api/dangerous-kept", {"path": "gone/a.jpg", "kept": True})
        self.still = self.library.thumb_path("gone/Loose Files (Bunkr)/c.mp4")
        # One of its files is already in the trash, with its own still.
        (self.media / "gone" / "d.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42 trashed")
        self.library.scan()
        self.assertTrue(self.library.save_thumb("gone/d.mp4", b"\xff\xd8\xff still"))
        trashed_still = self.library.thumb_path("gone/d.mp4")
        self.assertEqual(self.call("/api/trash", {"path": "gone/d.mp4", "library": str(self.media)})[0], 200)
        self.stills = [self.still, trashed_still]
        self.assertTrue(all(still.is_file() for still in self.stills))

    def remove(self, model="gone", full=False, confirm=None):
        return self.call("/api/model-reset", {"model": model, "confirm": model if confirm is None else confirm,
                                              "library": str(self.media), "full": full})

    def cdl_paths(self):
        with sqlite3.connect(self.state_dir / "cdl" / "cyberdrop.db") as db:
            paths = sorted(row[0] for row in db.execute("SELECT download_path FROM media"))
        db.close()
        return paths

    def test_preview_says_what_would_go(self):
        code, body = self.call("/api/model-reset?model=gone")
        self.assertEqual(code, 200)
        drive = body["drive"]
        self.assertEqual((drive["onDrive"], drive["media"], drive["photos"], drive["files"]), (True, 3, 2, 4))
        self.assertEqual(drive["trashFiles"], 1)
        self.assertEqual(drive["remembered"], {"kept": 1, "loved": 1, "passed": 1, "marked": 1, "dueled": 2, "keptInDangerous": 1})
        records = body["records"]
        self.assertEqual(records["thread"], "https://simpcity.cr/threads/gone.9/")
        self.assertEqual((records["links"], records["hashes"], records["failed"], records["later"]), (2, 2, 2, 1))
        self.assertEqual((records["cdlFiles"], records["stagingFiles"], records["stagingBytes"]), (3, 1, 1000))
        self.assertEqual(body["busy"], {"drive": "", "full": ""})
        # Bad names never reach the drive.
        for bad in ("", "../media", ".heaven-trash", "a/b"):
            self.assertEqual(self.call(f"/api/model-reset?model={bad}")[0], 400, bad)
        self.assertEqual(self.call("/api/model-reset?model=nobody")[0], 404)

    def test_remove_from_drive_keeps_what_simp_downloaded(self):
        self.assertEqual(self.remove(confirm="Gone")[0], 409)  # the name must be typed exactly
        self.assertTrue((self.media / "gone").is_dir())
        code, body = self.remove()
        self.assertEqual(code, 200, body)
        self.assertEqual((body["media"], body["trashFiles"], body["full"]), (3, 1, False))
        self.assertGreater(body["freedBytes"], 1000)
        # The folder, its trash and its half-downloaded files are gone; nothing is left aside.
        self.assertFalse((self.media / "gone").exists())
        self.assertEqual(self.call("/api/trash")[1]["entries"], [])
        self.assertEqual(list((self.media / ".heaven-trash").iterdir()), [])
        self.assertFalse((self.staging / "gone").exists())
        self.assertFalse(any(still.exists() for still in self.stills))
        # The library and every per-file record forget it; the other model is untouched.
        state = self.call("/api/state")[1]
        paths = [item["path"] for kind in ("images", "videos") for item in state["library"][kind]]
        self.assertEqual(sorted(paths), ["old-model/one.jpg", "stays/Loose Files (Bunkr)/c.mp4", "stays/a.jpg", "stays/b.jpg"])
        self.assertFalse(any(model in path for model in ("gone",)
                             for table in (self.library.state["ratings"], self.library.state["ratingTimes"],
                                           self.library.state["duel"], self.library.state["marks"],
                                           self.library.state["dangerousKept"], self.library.seen,
                                           self.library.fingerprints) for path in table))
        saved = json.loads(self.state.read_text())
        self.assertEqual(sorted(saved["ratings"]), ["stays/a.jpg", "stays/b.jpg"])
        self.assertEqual(list(json.loads((self.state.parent / "seen.json").read_text())), ["stays/a.jpg"])
        self.assertEqual(list(json.loads((self.state.parent / "fingerprints.json").read_text())), ["stays/a.jpg"])
        self.assertIsNotNone(self.library.thumb_path("stays/Loose Files (Bunkr)/c.mp4"))
        self.assertTrue(self.library.thumb_path("stays/Loose Files (Bunkr)/c.mp4").is_file())
        # Pending work is dropped, so nothing brings the files back...
        for path in ("failed/gone.jsonl", "later/gone.txt", "cdl_gone.txt"):
            self.assertFalse((self.state_dir / path).exists(), path)
        # ...but simp still remembers what it fetched: downloading again brings only new posts.
        for path in ("done/gone.jsonl", "content/gone.jsonl", "crawl/simpcity.cr_gone.9.json"):
            self.assertTrue((self.state_dir / path).exists(), path)
        self.assertEqual(len(self.cdl_paths()), 5)
        self.assertEqual(self.call("/api/model-reset?model=gone")[1]["records"]["thread"], "https://simpcity.cr/threads/gone.9/")
        # The other model's simp files are all still there.
        for path in ("done/stays.jsonl", "failed/stays.jsonl", "later/stays.txt", "cdl_stays.txt"):
            self.assertTrue((self.state_dir / path).exists(), path)

    def test_full_reset_also_forgets_the_download_history(self):
        code, body = self.remove(full=True)
        self.assertEqual(code, 200, body)
        self.assertEqual(body["records"]["cdlFiles"], 3)
        self.assertFalse((self.media / "gone").exists())
        for path in ("done/gone.jsonl", "content/gone.jsonl", "crawl/simpcity.cr_gone.9.json", "failed/gone.jsonl",
                     "later/gone.txt", "cdl_gone.txt"):
            self.assertFalse((self.state_dir / path).exists(), path)
        self.assertEqual(self.cdl_paths(), [f"{self.staging}/gone-too", f"{self.staging}/stays"])
        self.assertNotIn("gone", [row["model"] for row in self.call("/api/simp/status")[1]["threads"]])
        # Nothing at all is left of it now.
        self.assertEqual(self.call("/api/model-reset?model=gone")[0], 404)
        self.assertTrue((self.state_dir / "crawl" / "simpcity.cr_stays.9.json").exists())

    def test_reset_a_model_that_is_only_in_simps_records(self):
        self.remove()
        code, body = self.call("/api/model-reset?model=gone")
        self.assertIsNone(body["drive"])
        self.assertEqual(self.remove(full=True)[0], 200)
        self.assertFalse((self.state_dir / "done" / "gone.jsonl").exists())

    def test_waits_for_downloads_of_the_model(self):
        self.cookies()
        with self.jobs.lock:  # stand-ins for jobs, never started
            self.jobs.jobs.append({"id": "a" * 12, "action": "thread", "label": "Download gone", "status": "queued",
                                   "args": ["thread", "https://simpcity.cr/threads/gone.9/"], "models": ["gone"]})
        body = self.call("/api/model-reset?model=gone")[1]
        self.assertIn("waiting to download", body["busy"]["drive"])
        code, body = self.remove()
        self.assertEqual(code, 409)
        self.assertIn("Cancel it", body["error"])
        self.assertTrue((self.media / "gone" / "a.jpg").exists())
        # A running download of another model only stops a full reset (it may have cyberdrop-dl's database open).
        with self.jobs.lock:
            self.jobs.jobs[-1].update(status="running", models=["stays"], label="Download stays")
        busy = self.call("/api/model-reset?model=gone")[1]["busy"]
        self.assertEqual(busy["drive"], "")
        self.assertIn("is running", busy["full"])
        self.assertEqual(self.remove(full=True)[0], 409)
        self.assertEqual(self.remove()[0], 200)
        # A waiting Bunkr job that named it carries on without it.
        with self.jobs.lock:
            self.jobs.jobs[-1]["status"] = "done"
            self.jobs.jobs.append({"id": "b" * 12, "action": "later", "label": "Bunkr files, last: stays, gone", "status": "queued",
                                   "args": ["later"], "models": ["stays", "gone"]})
        self.assertEqual(self.remove(full=True)[0], 200)
        self.assertEqual(self.jobs.jobs[-1]["models"], ["stays"])
        self.assertEqual(self.jobs.jobs[-1]["status"], "queued")
        with self.jobs.lock:
            self.jobs.jobs[-1]["status"] = "cancelled"

    def test_read_only_drive_changes_nothing(self):
        if os.geteuid() == 0:
            self.skipTest("root ignores permissions")
        self.media.chmod(0o555)
        try:
            code, body = self.remove()
        finally:
            self.media.chmod(0o755)
        self.assertEqual(code, 409)
        self.assertIn("read-only", body["error"])
        self.assertTrue((self.media / "gone" / "a.jpg").exists())
        self.assertEqual(self.library.state["ratings"]["gone/a.jpg"], "love")
        self.assertTrue((self.state_dir / "failed" / "gone.jsonl").exists())
