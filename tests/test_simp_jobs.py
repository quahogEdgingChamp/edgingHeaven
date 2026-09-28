"""Downloads (simpjobs.py) over real HTTP: a stand-in simp binary, a throwaway
data dir and library, and a server on a free port. Nothing is fetched from
the internet and no real media is touched."""
import json
import os
import signal
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from collections import namedtuple
from unittest import mock

import simpjobs
from server import AppServer, LOCK_COOKIE, MediaLibrary, RequestHandler
from simpjobs import SimpJobs, decode_tail, normalize_thread_url, thread_slug

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
    for url in args[1:]:
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
        if slug == "full-model" and not (root / "was-full").exists():  # simp's space.py stopping at the reserve, once
            (root / "was-full").write_text("")
            (target / slug / "first.jpg").write_bytes(b"\xff\xd8\xff first")
            time.sleep(1)
            print("Drive nearly full: 2.0 GB free, keeping 3.0 GB spare. Stopped.")
            sys.exit(3)
        (target / slug / "new.jpg").write_bytes(b"\xff\xd8\xff fetched")
        print("héllo " * 3)
    print("Summary: 1 model(s) · 1 downloaded · 0 already had · 0 failed (direct)")
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
        self.assertEqual(self.calls(), [["-c", str(self.root / "config.toml"), "thread", "https://simpcity.cr/threads/new-model.123/"]])
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
        self.assertEqual(body["job"]["args"], ["thread", "https://simpcity.cr/threads/new-model.123/"])
        self.assertEqual(self.finished(body["job"]["id"])["status"], "done")
        self.assertEqual(self.call("/api/simp/jobs", {"action": "update", "model": "old-model"})[0], 404)

    def test_the_log_streams_by_offset_and_tail(self):
        self.cookies()
        job_id = self.call("/api/simp/jobs", {"action": "thread", "urls": ["https://simpcity.cr/threads/m.1/"]})[1]["job"]["id"]
        self.finished(job_id)
        status, whole = self.call(f"/api/simp/jobs/{job_id}/log?offset=0")
        self.assertEqual(status, 200)
        self.assertTrue(whole["text"].startswith("$ simp thread https://simpcity.cr/threads/m.1/\n"))
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
        self.assertEqual(job["args"], ["download", "--pages", "2-3,5", "--limit", "4"])
        self.assertEqual(self.finished(job["id"])["status"], "failed")  # exit 1: some files failed
        job = self.call("/api/simp/jobs", {"action": "bookmarks", "pages": "all"})[1]["job"]
        self.assertEqual(job["args"], ["download"])
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
        order = [call[3] for call in self.calls() if call[2] == "thread"]
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
