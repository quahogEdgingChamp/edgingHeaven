"""Downloads: run simp (SimpCity threads and bookmarks -> media) from the page.

simp lives in scrprsimp/ with its own venv and packages. The server never imports
it: each job is `simp -c <data dir>/scrprsimp/config.toml <command>` started as a
separate process, so server.py stays stdlib-only. One job runs at a time and
the rest wait in a queue, because two simp or cyberdrop-dl runs sharing
state/cdl/cyberdrop.db corrupt or lock it.

Everything simp keeps (config.toml, whereto.txt, cookies/, state/) and the job
logs here (jobs/) live under <data dir>/scrprsimp/: the service is sandboxed with a
read-only home, and the data dir is the one place it may write.
"""
import collections
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import threading
import time
import tomllib
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import quote, unquote, urlsplit

SIMP_BIN = Path(__file__).parent / "scrprsimp" / ".venv" / "bin" / "simp"

# Only whole thread links reach simp's command line (an argument list, never a
# shell), so nothing a page sends can turn into an option or a file path.
THREAD_URL_RE = re.compile(r"https://simpcity\.[a-z]{2,12}/threads/[^/\s?#]+\.\d+/")
PAGES_RE = re.compile(r"\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?)*")
JOB_ID_RE = re.compile(r"[a-f0-9]{12}")
# Preview pictures simp saves: state/previews/<model>/<n>.<ext>
PREVIEW_NAME_RE = re.compile(r"\d{1,2}\.(?:jpg|png|gif|webp|avif)")
# The same characters simp's sanitize_filename replaces in a folder name.
INVALID_FS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')

MAX_URLS = 20
MAX_ACTIVE = 20
JOBS_KEPT = 50
LOG_CHUNK = 256 * 1024
COOKIES_MAX_BYTES = 512 * 1024
# Cancel: Ctrl-C first (simp removes its half-written file, cyberdrop-dl shuts
# down), then SIGTERM, then SIGKILL, to the whole process group.
CANCEL_STEPS = ((signal.SIGINT, 10), (signal.SIGTERM, 5), (signal.SIGKILL, 5))

# How simp's log lines about the login start, see scrprsimp/src/simp/auth.py.
AUTH_OK = ("Signed in to ", "Session OK")
AUTH_BAD = ("Session looks logged-out", "Cookies file not found", "No cookies for host")

ACTIVE = {"queued", "running"}
# Jobs that write to the drive: refused below the reserve, held when it is reached.
DRIVE_ACTIONS = {"thread", "update", "bookmarks", "retry", "later"}
# Fast hosts first, Bunkr last: downloads run simp with --slow-later, which
# saves each model's Bunkr links (one file at a time per Bunkr server, slow)
# in state/later/. A "later" job (`simp later`) downloads them once nothing
# else waits, and steps aside, to go on afterwards, when a new download is
# queued. cyberdrop-dl skips what it finished and resumes its .part files.
SLOW_LATER = "--slow-later"
# simp's exit code when the drive reached download.min_free_bytes (see its space.py).
EXIT_DRIVE_FULL = 3
# Resume only with this much room beyond the reserve, or it would stop again at once.
RESUME_HEADROOM = 1024**3
# How often a running job's model folders are looked at for new files.
WATCH_SECONDS = 10
ARRIVALS_KEPT = 1000
# simp prints this when it starts writing into a model's folder.
MODEL_FOLDER = "Model folder: "

# What cyberdrop-dl is doing, for the page: read from its own files while it
# runs, never from its output (--ui disabled prints almost nothing).
#   the log (--log-file, rewritten each run): which files started, finished, failed
#   the database (--db): one row per file it queued, with the size once done
#   the download folder (-o): the .part file of each download in progress
# A line carries its time only when it changed since the line before.
CDL_EVENT_RE = re.compile(
    r"^(?:\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)[.\d]*\])?\s*[A-Z]+\s+(Download|Scrape) (starting|finished|skipped|failed|Failed):? (\S+)(.*)$")
CDL_TIME_RE = re.compile(r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)")
CDL_SCRAPING = "] Scraping "
PROGRESS_SECONDS = 2
# Speed is the growth over this many seconds; shorter jumps around.
SPEED_WINDOW = 30
# The estimate goes by how many files finished in the last hour.
PACE_WINDOW = 3600
PARTS_SHOWN = 8


class SimpError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_thread_url(raw) -> Optional[str]:
    """A pasted thread link as simp wants it, https://simpcity.<tld>/threads/<slug>.<id>/.
    A trailing page, post or #anchor is dropped; anything else is refused."""
    if not isinstance(raw, str):
        return None
    url = raw.strip().split("#", 1)[0].split("?", 1)[0]
    url = re.sub(r"/(?:page|post)-\d+/?$", "/", url)
    if not url.endswith("/"):
        url += "/"
    return url if THREAD_URL_RE.fullmatch(url) else None


def thread_slug(url: str) -> str:
    """The model folder simp downloads a thread into (its thread_slug_from_url)."""
    part = url.rstrip("/").rsplit("/", 1)[-1]
    name = re.sub(r"\.\d+$", "", unquote(part))
    return INVALID_FS_RE.sub("_", re.sub(r"\s+", " ", name)).strip(" ._") or "untitled"


def decode_tail(data: bytes) -> tuple[str, int]:
    """Decode a log chunk without splitting a UTF-8 character at its end.
    Returns the text and how many bytes it used."""
    for trim in range(4):
        try:
            return data[: len(data) - trim].decode("utf-8"), len(data) - trim
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace"), len(data)


def cdl_run_paths(argv: list) -> Optional[dict]:
    """The folder, database and log of a `cyberdrop-dl download` command line
    (as simp's run_cyberdrop_dl builds it), or None for any other process."""
    if "download" not in argv[:3] or not any(Path(arg).name.startswith("cyberdrop") for arg in argv[:2]):
        return None
    options = {}
    for flag, value in zip(argv, argv[1:]):
        if flag in ("-o", "--db", "--log-file") and flag not in options:
            options[flag] = value
    if len(options) < 3:
        return None
    return {"out": Path(options["-o"]), "db": Path(options["--db"]), "log": Path(options["--log-file"])}


def cdl_file_name(url: str) -> str:
    """What cyberdrop-dl calls a download: Bunkr's ?n= name, else the last path part."""
    name = re.search(r"[?&]n=([^&]+)", url)
    if name:
        return unquote(name.group(1).replace("+", " "))
    return unquote(url.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1])


def url_key(url_or_path: str) -> str:
    """The last part of a URL's path: what a log URL and a database row share
    (the row keeps only the end of the path, /Name-abc.mp4 or /api/file/<id>)."""
    return url_or_path.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]


class SimpJobs:
    def __init__(self, root: Path, simp_bin: Path = SIMP_BIN, add_files: Optional[Callable[[list], list]] = None):
        self.root = root
        self.bin = simp_bin
        # Adds new files under these folders to the library and returns them
        # (MediaLibrary.add_new_files): called while a job runs, and at its end.
        self.add_files = add_files
        # job id -> paths of the files it added, newest first (this run of the server only).
        self._arrivals = {}
        self.jobs_dir = root / "jobs"
        self.lock = threading.RLock()
        self.jobs = []  # oldest first
        self.auth = {"ok": None, "checkedAt": None, "message": ""}
        self.proc: Optional[subprocess.Popen] = None
        self.worker: Optional[threading.Thread] = None
        self._threads_cache = {}
        # The running cyberdrop-dl and what has been read of it (see progress).
        self._cdl: Optional[dict] = None
        self._progress = (0.0, None)
        self._progress_lock = threading.Lock()
        self._load()

    # ---- persistence ----

    @property
    def config_path(self) -> Path:
        return self.root / "config.toml"

    def _load(self) -> None:
        try:
            saved = json.loads((self.jobs_dir / "jobs.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        jobs = saved.get("jobs") if isinstance(saved, dict) else None
        self.jobs = [job for job in jobs if isinstance(job, dict) and JOB_ID_RE.fullmatch(str(job.get("id")))] if isinstance(jobs, list) else []
        if isinstance(saved.get("auth"), dict):
            self.auth = {**self.auth, **saved["auth"]}
        # A restart of the service kills its jobs with it (they run in its
        # cgroup). Nothing is restarted by itself; say what happened.
        stale = [job for job in self.jobs if job.get("status") in ACTIVE]
        for job in stale:
            job["status"] = "interrupted"
            job["endedAt"] = utc_now_iso()
        if stale:
            self._save()

    def _save(self) -> None:
        with self.lock:
            del self.jobs[:-JOBS_KEPT]
            self.jobs_dir.mkdir(parents=True, exist_ok=True)
            temporary = self.jobs_dir / "jobs.tmp"
            temporary.write_text(json.dumps({"jobs": self.jobs, "auth": self.auth}, indent=1), encoding="utf-8")
            temporary.replace(self.jobs_dir / "jobs.json")
            kept = {job["id"] for job in self.jobs}
            for log in self.jobs_dir.glob("*.log"):
                if log.stem not in kept:
                    log.unlink(missing_ok=True)

    # ---- simp's own files ----

    def _config(self) -> dict:
        try:
            with self.config_path.open("rb") as handle:
                return tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError):
            return {}

    def _space(self) -> tuple:
        """(free bytes on the download drive or None, the reserve simp keeps)."""
        download = self._config().get("download")
        reserve = download.get("min_free_bytes", 0) if isinstance(download, dict) else 0
        reserve = reserve if isinstance(reserve, int) and reserve > 0 else 0
        target = self._paths()["target"]
        try:
            free = shutil.disk_usage(target).free if target.is_dir() else None
        except OSError:
            free = None
        return free, reserve

    @staticmethod
    def _gb(n: int) -> str:
        return f"{n / 1024**3:.1f} GB"

    def _paths(self) -> dict:
        """Where simp keeps its cookies and state and puts the media, read
        from its config the way simp reads it (relative to the config file)."""
        config = self._config()
        paths = config.get("paths") if isinstance(config.get("paths"), dict) else {}
        auth = config.get("auth") if isinstance(config.get("auth"), dict) else {}

        def resolve(value) -> Path:
            # simp runs in this folder, so relative paths start here.
            return (self.root / Path(str(value)).expanduser()).resolve()

        target = None
        try:
            for line in resolve(paths.get("whereto_file", "whereto.txt")).read_text(encoding="utf-8").splitlines():
                line = line.strip().strip("\"'")
                if line and not line.startswith("#"):
                    subdir = str(paths.get("models_subdir", "models")).strip().strip("/\\")
                    target = resolve(line) / subdir if subdir else resolve(line)
                    break
        except OSError:
            pass
        return {
            "cookies": resolve(auth.get("cookies_file", "cookies/simpcity.txt")),
            "state": resolve(paths.get("state_dir", "state")),
            "target": target or resolve(paths.get("download_dir", "downloads")),
        }

    def failed_models(self, state: Path) -> list:
        rows = []
        for path in sorted((state / "failed").glob("*.jsonl")):
            try:
                lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
            except (OSError, ValueError):
                continue
            rows.append({
                "model": path.stem,
                "files": sum(1 for line in lines if line.get("via") == "direct"),
                "cyberdrop": any(line.get("via") == "cdl" for line in lines),
            })
        return rows

    def login_expiry(self, cookies: Path) -> Optional[str]:
        """When the "stay logged in" cookie in cookies.txt runs out (XenForo's
        <prefix>_user). The short session cookies are renewed by the site
        itself; this one is what ends the login."""
        try:
            lines = cookies.read_text(encoding="utf-8").splitlines()
        except OSError:
            return None
        stamps = []
        for line in lines:
            fields = line.split("\t")
            if len(fields) == 7 and fields[5].endswith("_user") and fields[4].isdigit() and int(fields[4]) > 0:
                stamps.append(int(fields[4]))
        return datetime.fromtimestamp(max(stamps), timezone.utc).isoformat() if stamps else None

    def later_models(self, state: Path) -> list:
        """Models whose Bunkr links wait for the "later" job (state/later/<model>.txt)."""
        rows = []
        for path in sorted((state / "later").glob("*.txt")):
            try:
                links = sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
                changed = path.stat().st_mtime
            except OSError:
                continue
            rows.append({"model": path.stem, "links": links, "savedAt": datetime.fromtimestamp(changed, timezone.utc).isoformat()})
        return rows

    @staticmethod
    def _later_label(models: list) -> str:
        shown = ", ".join(models[:4]) + (f" and {len(models) - 4} more" if len(models) > 4 else "")
        return f"Bunkr files, last: {shown}" if shown else "Bunkr files, last"

    def bookmarks(self) -> dict:
        """What `simp bookmarks --save` last wrote, with each preview as a URL
        this server answers (the page never loads anything from SimpCity)."""
        path = self._paths()["state"] / "bookmarks.json"
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"updatedAt": None, "complete": True, "bookmarks": []}
        rows = []
        for row in saved.get("bookmarks", []) if isinstance(saved, dict) else []:
            if not isinstance(row, dict) or not isinstance(row.get("model"), str):
                continue
            model = row["model"]
            names = [name for name in row.get("previews") or [] if isinstance(name, str) and PREVIEW_NAME_RE.fullmatch(name)]
            rows.append({
                "model": model,
                "title": str(row.get("title") or model)[:300],
                "url": normalize_thread_url(row.get("url")),
                "previews": [f"/api/simp/previews/{quote(model, safe='')}/{name}" for name in names],
            })
        return {"updatedAt": saved.get("updatedAt"), "complete": bool(saved.get("complete", True)), "bookmarks": rows}

    def preview_file(self, model: str, name: str) -> Optional[Path]:
        if not PREVIEW_NAME_RE.fullmatch(name) or not model or model.startswith(".") or "/" in model or "\x00" in model:
            return None
        root = (self._paths()["state"] / "previews").resolve()
        path = (root / model / name).resolve()
        return path if path.parent.parent == root and path.is_file() else None

    def known_threads(self, state: Path) -> dict:
        """model -> {"url", "lastPage"} from simp's crawl cache
        (state/crawl/<host>_<slug.id>.json). Those files hold every link
        found and can be megabytes, so only their head is read, once per change."""
        threads, stamps = {}, {}
        with self.lock:
            files = sorted((state / "crawl").glob("*.json"))
        for path in files:
            try:
                info = path.stat()
            except OSError:
                continue
            key = (info.st_mtime_ns, info.st_size)
            cached = self._threads_cache.get(path.name)
            if not cached or cached[0] != key:
                entry = None
                try:
                    with path.open("rb") as handle:
                        head = handle.read(4096).decode("utf-8", errors="replace")
                    found = re.search(r'"thread":\s*"([^"]+)"', head)
                    page = re.search(r'"last_page":\s*(\d+)', head)
                    url = normalize_thread_url(found.group(1)) if found else None
                    if url:
                        entry = {"url": url, "lastPage": int(page.group(1)) if page else None}
                except OSError:
                    pass
                cached = (key, entry)
                with self.lock:
                    self._threads_cache[path.name] = cached
            entry = cached[1]
            if entry:
                model = thread_slug(entry["url"])
                # Two files for one model (a mirror change): the newer wins.
                if model not in threads or info.st_mtime_ns > stamps[model]:
                    threads[model], stamps[model] = entry, info.st_mtime_ns
        return threads

    # ---- what the page shows ----

    def status(self) -> dict:
        paths = self._paths()
        target = paths["target"]
        try:
            cookie_info = paths["cookies"].stat()
            cookies = {"present": True, "updatedAt": datetime.fromtimestamp(cookie_info.st_mtime, timezone.utc).isoformat(),
                       "loginExpiresAt": self.login_expiry(paths["cookies"])}
        except OSError:
            cookies = {"present": False, "updatedAt": None, "loginExpiresAt": None}
        free, reserve = self._space()
        threads = self.known_threads(paths["state"])
        with self.lock:
            jobs = [self._public(job) for job in reversed(self.jobs)]
            auth = dict(self.auth)
        return {
            "installed": self.bin.is_file() and os.access(self.bin, os.X_OK),
            "configured": self.config_path.is_file(),
            "target": str(target),
            "targetReady": free is not None,
            "freeBytes": free,
            "reserveBytes": reserve,
            "resumeBytes": reserve + RESUME_HEADROOM if reserve else 0,
            "cookies": cookies,
            "auth": auth,
            "jobs": jobs[:25],
            "failed": self.failed_models(paths["state"]),
            "later": self.later_models(paths["state"]),
            "threads": [{"model": model, **entry} for model, entry in sorted(threads.items())],
            "progress": self.progress(),
        }

    @staticmethod
    def _public(job: dict) -> dict:
        return {key: value for key, value in job.items() if key not in ("cancelRequested", "yielding")}

    def _job(self, job_id) -> dict:
        with self.lock:
            job = next((job for job in self.jobs if job["id"] == job_id), None) if isinstance(job_id, str) else None
        if job is None:
            raise SimpError("No such download job.", 404)
        return job

    def log(self, job_id, offset: int) -> dict:
        """The job's output from byte `offset` on (at most LOG_CHUNK), or its
        last -offset bytes when negative, starting at a whole line."""
        job = self._job(job_id)
        path = self.jobs_dir / f"{job['id']}.log"
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        start = max(0, size + offset) if offset < 0 else min(offset, size)
        data = b""
        if start < size:
            with path.open("rb") as handle:
                handle.seek(start)
                data = handle.read(LOG_CHUNK)
            if offset < 0 and start > 0:
                newline = data.find(b"\n")
                data, start = (data[newline + 1:], start + newline + 1) if newline != -1 else (b"", size)
        text, used = decode_tail(data)
        with self.lock:
            return {"text": text, "offset": start + used, "size": size, "job": self._public(job)}

    # ---- what cyberdrop-dl is doing ----

    def progress(self) -> Optional[dict]:
        """The running job's cyberdrop-dl: files downloading now and their
        speed, how many wait, how many finished or failed, and a rough time
        left. None while no cyberdrop-dl runs (simp's own downloads show in
        its output). Worked out at most every PROGRESS_SECONDS: every open
        page asks with each poll."""
        with self._progress_lock:
            now = time.time()
            if now - self._progress[0] < PROGRESS_SECONDS:
                return self._progress[1]
            try:
                value = self._measure(now)
            except (OSError, sqlite3.Error, ValueError):
                value = None
            self._progress = (now, value)
            return value

    def _find_cdl(self) -> Optional[dict]:
        """cyberdrop-dl among the running job's processes: simp starts its own
        session (see _run), so they all share simp's pid as their group."""
        with self.lock:
            proc = self.proc
            job = next((job for job in self.jobs if job["status"] == "running"), None)
        if proc is None or job is None:
            self._cdl = None
            return None
        known = self._cdl
        if known and known["group"] == proc.pid:
            try:
                if os.getpgid(known["pid"]) == proc.pid:
                    return known
            except (OSError, ProcessLookupError):
                pass
        self._cdl = None
        for name in os.listdir("/proc"):
            if not name.isdigit() or int(name) == proc.pid:
                continue
            try:
                if os.getpgid(int(name)) != proc.pid:
                    continue
                argv = [arg.decode("utf-8", "replace") for arg in Path(f"/proc/{name}/cmdline").read_bytes().split(b"\0") if arg]
                paths = cdl_run_paths(argv)
                started = self._process_start(int(name)) if paths else None
            except (OSError, ProcessLookupError, ValueError):
                continue
            if paths:
                self._cdl = {**paths, "pid": int(name), "group": proc.pid, "job": job["id"], "started": started,
                             "offset": 0, "time": None, "active": {}, "finishes": [], "failed": collections.Counter(),
                             "failedUrls": set(), "skipped": 0, "scraped": 0, "scrapeFailed": 0, "downloading": False,
                             "samples": collections.deque(), "parts": {}}
                return self._cdl
        return None

    @staticmethod
    def _process_start(pid: int) -> float:
        """When a process started, from /proc: clock ticks after boot."""
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        boot = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
        return boot + int(fields[19]) / os.sysconf("SC_CLK_TCK")

    def _read_cdl_log(self, run: dict) -> None:
        """Follow cyberdrop-dl's log from where the last look stopped."""
        with run["log"].open("rb") as handle:
            handle.seek(run["offset"])
            data = handle.read(4 * 1024 * 1024)
        whole = data[: data.rfind(b"\n") + 1]
        run["offset"] += len(whole)
        for line in whole.decode("utf-8", errors="replace").splitlines():
            stamp = CDL_TIME_RE.match(line)
            if stamp:
                run["time"] = datetime.strptime(stamp.group(1), "%Y-%m-%d %H:%M:%S").timestamp()
            # A log left over from an earlier run is not this one's.
            if run["time"] is not None and run["time"] < run["started"] - 60:
                continue
            if CDL_SCRAPING in line:
                run["scraped"] += 1
                continue
            event = CDL_EVENT_RE.match(line)
            if not event:
                continue
            what, verb, url, rest = event.group(2), event.group(3), event.group(4), event.group(5)
            when = run["time"] or time.time()
            if what == "Scrape":
                run["scrapeFailed"] += verb in ("failed", "Failed")
            elif verb == "starting":
                run["active"][url] = when
                run["downloading"] = True
            elif verb in ("finished", "skipped"):
                run["active"].pop(url, None)
                if verb == "finished":
                    run["finishes"].append(when)
                else:
                    run["skipped"] += 1
            elif verb == "Failed" or "retrying" not in rest:
                # "Download failed: … retrying" is followed by another attempt.
                run["active"].pop(url, None)
                reason = rest.strip()
                run["failed"][reason[1:-1] if reason.startswith("(") and reason.endswith(")") else reason or "failed"] += 1
                run["failedUrls"].add(url)

    @staticmethod
    def _speed(samples, now: float, value: int) -> Optional[float]:
        """Bytes per second over the last SPEED_WINDOW seconds of samples."""
        samples.append((now, value))
        while len(samples) > 2 and samples[1][0] <= now - SPEED_WINDOW:
            samples.popleft()
        then, before = samples[0]
        return max(0.0, (value - before) / (now - then)) if now - then >= 4 else None

    def _measure(self, now: float) -> Optional[dict]:
        run = self._find_cdl()
        if run is None:
            return None
        self._read_cdl_log(run)
        out = str(run["out"]).rstrip("/")
        like = out.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%"
        db = sqlite3.connect(f"{run['db'].as_uri()}?mode=ro", uri=True, timeout=1)
        try:
            rows = db.execute("SELECT domain, url_path, completed, file_size, completed_at FROM media "
                              "WHERE download_path = ? OR download_path LIKE ? ESCAPE '\\'", (out, like)).fetchall()
        finally:
            db.close()
        since = datetime.fromtimestamp(run["started"], timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        done = [row for row in rows if row[2] and str(row[4] or "") >= since]
        # A row is queued when cyberdrop-dl lines a file up; the ones not
        # downloading now and not given up on are still waiting.
        busy = {url_key(url) for url in run["active"]} | {url_key(url) for url in run["failedUrls"]}
        waiting = [row for row in rows if not row[2] and url_key(str(row[1] or "")) not in busy]

        parts = []
        for folder, _, names in os.walk(run["out"]):
            for name in names:
                if name.endswith(".part"):
                    try:
                        info = os.stat(os.path.join(folder, name))
                    except OSError:
                        continue
                    parts.append((os.path.join(folder, name), name[:-5], info.st_size, info.st_mtime))
        total = sum(row[3] or 0 for row in rows if row[2]) + sum(part[2] for part in parts)
        speed = self._speed(run["samples"], now, total)

        names = {cdl_file_name(url): url for url in run["active"]}
        seen = set()
        active = []
        # A .part left by an earlier, stopped run does not grow.
        for path, name, size, mtime in sorted(parts, key=lambda part: -part[3]):
            url = names.get(name)
            if url is None and mtime < now - 120:
                continue
            seen.add(path)
            samples = run["parts"].setdefault(path, collections.deque())
            active.append({"name": name, "bytes": size, "speed": self._speed(samples, now, size),
                           "host": urlsplit(url).hostname if url else None,
                           "startedAt": datetime.fromtimestamp(run["active"][url], timezone.utc).isoformat() if url else None})
        run["parts"] = {path: samples for path, samples in run["parts"].items() if path in seen}

        recent = [when for when in run["finishes"] if when >= now - PACE_WINDOW]
        span = now - max(run["started"], now - PACE_WINDOW)
        pace = len(recent) / span if len(recent) >= 2 and span >= 300 else None
        left = len(waiting) + len(run["active"])
        return {
            "jobId": run["job"],
            "phase": "downloading" if run["downloading"] else "scanning",
            "startedAt": datetime.fromtimestamp(run["started"], timezone.utc).isoformat(),
            "linksChecked": run["scraped"],
            "scrapeFailed": run["scrapeFailed"],
            "done": len(done),
            "doneBytes": sum(row[3] or 0 for row in done),
            "downloading": len(run["active"]),
            "active": active[:PARTS_SHOWN],
            "waiting": len(waiting),
            "waitingByHost": dict(collections.Counter(str(row[0]) for row in waiting).most_common()),
            "skipped": run["skipped"],
            "failed": sum(run["failed"].values()),
            "failedReasons": run["failed"].most_common(3),
            "speed": speed,
            "filesPerHour": round(pace * 3600, 1) if pace else None,
            "etaSeconds": round(left / pace) if pace and left else None,
        }

    # ---- starting jobs ----

    def submit(self, payload: dict) -> dict:
        if not (self.bin.is_file() and os.access(self.bin, os.X_OK)):
            raise SimpError("simp is not installed on the server (scrprsimp/.venv). See deploy/EDGING-HEAVEN.md.", 409)
        if not self.config_path.is_file():
            raise SimpError(f"simp is not set up: {self.config_path} is missing.", 409)
        action = payload.get("action")
        paths = self._paths()
        if action == "check-auth":
            args, label, models = ["check-auth"], "Check the SimpCity login", []
        elif action == "bookmarks-sync":
            args, label, models = ["bookmarks", "--save"], "Refresh bookmarks from SimpCity", []
        elif action == "thread":
            raw = payload.get("urls")
            if isinstance(raw, str):
                raw = raw.split()
            if not isinstance(raw, list) or not raw:
                raise SimpError("Paste at least one thread link.")
            urls = []
            for item in raw:
                url = normalize_thread_url(item)
                if url is None:
                    raise SimpError(f"Not a SimpCity thread link: {str(item)[:120]}")
                if url not in urls:
                    urls.append(url)
            if len(urls) > MAX_URLS:
                raise SimpError(f"At most {MAX_URLS} threads per job.")
            models = [thread_slug(url) for url in urls]
            args, label = ["thread", SLOW_LATER, *urls], "Download " + ", ".join(models)
        elif action == "update":
            model = payload.get("model")
            entry = self.known_threads(paths["state"]).get(model) if isinstance(model, str) else None
            if entry is None:
                raise SimpError("simp has no thread for this model yet. Download it once from its thread link.", 404)
            args, label, models = ["thread", SLOW_LATER, entry["url"]], f"New posts: {model}", [model]
        elif action == "bookmarks":
            pages = str(payload.get("pages") or "").replace(" ", "")
            limit = payload.get("limit") or 0
            if pages != "all" and not PAGES_RE.fullmatch(pages):
                raise SimpError("Pages look like 1, 2-4, 1,3,8 or all.")
            if not isinstance(limit, int) or isinstance(limit, bool) or not 0 <= limit <= 1000:
                raise SimpError("The model limit is a number from 0 (no limit) to 1000.")
            args = ["download", SLOW_LATER] + ([] if pages == "all" else ["--pages", pages]) + (["--limit", str(limit)] if limit else [])
            label = ("All bookmarks" if pages == "all" else f"Bookmarks page {pages}") + (f", first {limit}" if limit else "")
            models = []
        elif action == "retry":
            failed = [row["model"] for row in self.failed_models(paths["state"])]
            wanted = payload.get("models") or []
            if not isinstance(wanted, list) or any(model not in failed for model in wanted):
                raise SimpError("Only models with failed downloads can be retried.")
            if not failed:
                raise SimpError("Nothing has failed.", 409)
            models = wanted or failed
            args, label = ["retry", *wanted], "Retry " + (", ".join(wanted) if wanted else "everything that failed")
        elif action == "later":
            models = [row["model"] for row in self.later_models(paths["state"])]
            if not models:
                raise SimpError("No Bunkr files are waiting.", 409)
            args, label = ["later"], self._later_label(models)
        else:
            raise SimpError("Unknown download action.")

        if action in DRIVE_ACTIONS:
            free, reserve = self._space()
            if reserve and free is not None and free < reserve:
                raise SimpError(f"The drive is nearly full: {self._gb(free)} free, and downloads keep {self._gb(reserve)} spare. "
                                "Free up space (Dangerous, then Empty trash), then try again.", 409)

        with self.lock:
            active = [job for job in self.jobs if job["status"] in ACTIVE]
            if any(job["args"] == args for job in active):
                raise SimpError("That is already queued.", 409)
            if len(active) >= MAX_ACTIVE:
                raise SimpError("The queue is full. Wait for a job to finish.", 409)
            job = {"id": uuid.uuid4().hex[:12], "action": action, "label": label, "args": args, "models": models,
                   "status": "queued", "createdAt": utc_now_iso(), "startedAt": None, "endedAt": None,
                   "exitCode": None, "summary": ""}
            self.jobs.append(job)
            self._save()
            # A new download goes before the Bunkr files, even once they started.
            running = next((other for other in self.jobs if other["status"] == "running"), None)
            if action in DRIVE_ACTIONS and action != "later" and running and running["action"] == "later" \
                    and not running.get("cancelRequested") and not running.get("yielding"):
                running["yielding"] = True
                if self.proc is not None:
                    threading.Thread(target=self._stop, args=(self.proc,), daemon=True).start()
            if self.worker is None:
                self.worker = threading.Thread(target=self._work, name="simp-jobs", daemon=True)
                self.worker.start()
            return self._public(job)

    def arrivals(self, job_id) -> dict:
        """What the job has added to the library so far, newest first."""
        job = self._job(job_id)
        with self.lock:
            return {"paths": list(self._arrivals.get(job["id"], ())), "count": job.get("arrived", 0)}

    def resume(self) -> dict:
        """Queue the jobs held when the drive filled up, in their order."""
        free, reserve = self._space()
        if reserve and free is not None and free < reserve + RESUME_HEADROOM:
            raise SimpError(f"Still not enough room: {self._gb(free)} free. Resuming needs more than "
                            f"{self._gb(reserve + RESUME_HEADROOM)} (the {self._gb(reserve)} reserve plus room to download).", 409)
        with self.lock:
            held = [job for job in self.jobs if job["status"] == "held"]
            if not held:
                raise SimpError("Nothing is waiting for space.", 409)
            for job in held:
                job["status"] = "queued"
            self._save()
            if self.worker is None:
                self.worker = threading.Thread(target=self._work, name="simp-jobs", daemon=True)
                self.worker.start()
            return {"resumed": len(held)}

    def cancel(self, job_id) -> dict:
        job = self._job(job_id)
        with self.lock:
            if job["status"] in ("queued", "held"):
                job["status"] = "cancelled"
                job["endedAt"] = utc_now_iso()
                self._save()
                return self._public(job)
            if job["status"] != "running":
                raise SimpError("This job has already ended.", 409)
            job["cancelRequested"] = True
            proc = self.proc
        if proc is not None:
            threading.Thread(target=self._stop, args=(proc,), daemon=True).start()
        return self._public(job)

    def save_cookies(self, text) -> dict:
        """Store a browser's cookies.txt export (Netscape format) as simp's
        login. It is a credential: mode 600, never under the media folder."""
        if not isinstance(text, str) or not text.strip():
            raise SimpError("That file is empty.")
        if len(text.encode("utf-8")) > COOKIES_MAX_BYTES:
            raise SimpError("That is too big for a cookies.txt.")
        lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        # "#HttpOnly_" starts a real cookie line, not a comment.
        rows = [line.split("\t") for line in lines if line.strip() and (not line.startswith("#") or line.startswith("#HttpOnly_"))]
        simpcity = [row for row in rows if len(row) == 7 and "simpcity" in row[0].lower()]
        if not simpcity:
            raise SimpError("No SimpCity cookies in that file. Export cookies.txt (Netscape format) while logged in to SimpCity.")
        # Python's cookie loader insists on this first line; some exports leave it out.
        if not re.match(r"#( Netscape)? HTTP Cookie File", lines[0]):
            lines.insert(0, "# Netscape HTTP Cookie File")
        target = self._paths()["cookies"]
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".tmp")
        handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write("\n".join(lines).rstrip("\n") + "\n")
        os.chmod(temporary, 0o600)
        temporary.replace(target)
        with self.lock:
            self.auth = {"ok": None, "checkedAt": None, "message": "New cookies saved. Not checked yet."}
            self._save()
        return {"cookies": len(simpcity)}

    # ---- running jobs ----

    def _work(self) -> None:
        while True:
            with self.lock:
                # The Bunkr files go last: after every other waiting job.
                queued = [job for job in self.jobs if job["status"] == "queued"]
                job = next((job for job in queued if job["action"] != "later"), queued[0] if queued else None)
                if job is None:
                    self.worker = None
                    return
                job["status"] = "running"
                job["startedAt"] = utc_now_iso()
                self._save()
            try:
                code = self._run(job)
            except Exception as error:  # the queue must keep going
                code = None
                self._append(job, f"\nCould not run simp: {error}\n")
            text = self._head_and_tail(job)
            with self.lock:
                job["exitCode"] = code
                job["endedAt"] = utc_now_iso()
                if job.pop("yielding", False) and not job.get("cancelRequested"):
                    # Stepped aside for a newer download: waits again, and
                    # goes on from where it stopped when its turn comes.
                    job["status"] = "queued"
                    job["summary"] = "Paused while newer downloads go first. Picks up where it stopped."
                    self._save()
                    continue
                if job.pop("cancelRequested", False):
                    job["status"] = "cancelled"
                else:
                    # simp: 0 all done, 1 some downloads failed (see `simp retry`),
                    # 2 error, 3 stopped at the drive's reserve.
                    job["status"] = {0: "done", 1: "failed", EXIT_DRIVE_FULL: "full"}.get(code, "error")
                lines = [line.strip() for line in text.splitlines() if line.strip()]
                summary = [line for line in lines if line.startswith("Summary:")]
                full = [line for line in lines if line.startswith(("Drive nearly full", "Drive full"))]
                job["summary"] = ((full if job["status"] == "full" else []) or summary or lines or [""])[-1][:300]
                self._note_auth(lines)
                if job["status"] == "full":
                    self._hold_for_space(job)
                elif job["action"] in DRIVE_ACTIONS:
                    self._queue_later(job)
                self._save()

    def _queue_later(self, finished: dict) -> None:
        """After a download, queue the "later" job for the Bunkr links it saved
        (or add its models to the one already waiting). A later job that ends
        with lists left over (they failed) does not queue itself again: only
        lists saved while it ran do; the page offers the rest."""
        pending = self.later_models(self._paths()["state"])
        if finished["action"] == "later":
            began = datetime.fromisoformat(finished["startedAt"]) if finished.get("startedAt") else None
            pending = [row for row in pending if began and datetime.fromisoformat(row["savedAt"]) > began]
        if not pending:
            return
        models = [row["model"] for row in self.later_models(self._paths()["state"])]
        waiting = next((job for job in self.jobs if job["action"] == "later" and job["status"] in ("queued", "held")), None)
        if waiting:
            waiting["models"], waiting["label"] = models, self._later_label(models)
            return
        self.jobs.append({"id": uuid.uuid4().hex[:12], "action": "later", "label": self._later_label(models), "args": ["later"],
                          "models": models, "status": "queued", "createdAt": utc_now_iso(), "startedAt": None,
                          "endedAt": None, "exitCode": None, "summary": ""})

    def _hold_for_space(self, job: dict) -> None:
        """The drive reached its reserve: keep the stopped job, and every
        download waiting behind it, for Resume. Run again, simp skips what it
        already has (its per-file record and cyberdrop-dl's history) and
        continues where it stopped."""
        waiting = [other for other in self.jobs if other["status"] == "queued" and other["action"] in DRIVE_ACTIONS]
        for other in waiting:
            other["status"] = "held"
        label = job["label"] if job["label"].startswith("Resume: ") else f"Resume: {job['label']}"
        again = {**{key: job[key] for key in ("action", "args")}, "id": uuid.uuid4().hex[:12], "label": label,
                 "models": list(job.get("models", [])), "status": "held", "createdAt": utc_now_iso(),
                 "startedAt": None, "endedAt": None, "exitCode": None, "summary": ""}
        # First in line when resumed.
        position = self.jobs.index(waiting[0]) if waiting else len(self.jobs)
        self.jobs.insert(position, again)

    def _watch(self, job: dict, watch: dict) -> None:
        """Read the job's new log lines for the model folders simp writes
        into, and add their new files to the library right away, so they can
        be watched and used before the job ends."""
        try:
            with (self.jobs_dir / f"{job['id']}.log").open("rb") as handle:
                handle.seek(watch["offset"])
                data = handle.read()
        except OSError:
            return
        whole = data[: data.rfind(b"\n") + 1]
        watch["offset"] += len(whole)
        for line in whole.decode("utf-8", errors="replace").splitlines():
            if line.startswith(MODEL_FOLDER):
                folder = line[len(MODEL_FOLDER):].strip()
                if folder and folder not in watch["folders"]:
                    watch["folders"].append(folder)
        if not watch["folders"] or self.add_files is None:
            return
        # The folder being written now, plus any earlier one once more after it finished.
        todo = [folder for folder in watch["folders"][:-1] if folder not in watch["finished"]] + watch["folders"][-1:]
        watch["finished"].update(watch["folders"][:-1])
        try:
            added = self.add_files(todo)
        except Exception:
            return
        if not added:
            return
        with self.lock:
            arrivals = self._arrivals.setdefault(job["id"], collections.deque(maxlen=ARRIVALS_KEPT))
            for item in added:
                arrivals.appendleft(item["path"])
                model = (item.get("folder") or "").split("/")[0]
                if model and model not in job["models"]:
                    job["models"].append(model)
            job["arrived"] = job.get("arrived", 0) + len(added)
            self._save()

    def _run(self, job: dict) -> Optional[int]:
        env = dict(os.environ)
        # Plain text for the log: no colours, a fixed width, written as it happens.
        env.update(NO_COLOR="1", TERM="dumb", COLUMNS="120", PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1")
        # cyberdrop-dl sits next to simp in the same venv.
        env["PATH"] = f"{self.bin.parent}{os.pathsep}{env.get('PATH', '')}"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        with (self.jobs_dir / f"{job['id']}.log").open("ab") as log:
            log.write(f"$ simp {' '.join(job['args'])}\n".encode("utf-8"))
            log.flush()
            try:
                # Its own session: cancel signals the whole group, which takes
                # cyberdrop-dl (simp's child) down with it.
                proc = subprocess.Popen([str(self.bin), "-c", str(self.config_path), *job["args"]], cwd=self.root,
                                        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, env=env,
                                        start_new_session=True)
            except OSError as error:
                log.write(f"Could not start simp: {error}\n".encode("utf-8"))
                return None
            with self.lock:
                self.proc = proc
                cancelled = job.get("cancelRequested")
            if cancelled:
                threading.Thread(target=self._stop, args=(proc,), daemon=True).start()
            watch = {"offset": 0, "folders": [], "finished": set()}
            while True:
                try:
                    code = proc.wait(timeout=WATCH_SECONDS)
                    break
                except subprocess.TimeoutExpired:
                    self._watch(job, watch)
            if not watch["folders"] and job["action"] in DRIVE_ACTIONS:
                # No folder named in the log: look at the job's own models.
                target = self._paths()["target"]
                watch["folders"] = [str(target / model) for model in job.get("models", [])]
            self._watch(job, watch)  # whatever landed in the last seconds
            with self.lock:
                self.proc = None
            if job.get("cancelRequested"):
                log.write(b"\nCancelled.\n")
            return code

    @staticmethod
    def _stop(proc: subprocess.Popen) -> None:
        for sig, grace in CANCEL_STEPS:
            try:
                os.killpg(proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                return
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    # simp is gone; anything left in its group goes too.
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
                    return
                time.sleep(0.1)

    def _append(self, job: dict, text: str) -> None:
        try:
            self.jobs_dir.mkdir(parents=True, exist_ok=True)
            with (self.jobs_dir / f"{job['id']}.log").open("ab") as log:
                log.write(text.encode("utf-8"))
        except OSError:
            pass

    def _head_and_tail(self, job: dict, size: int = 16 * 1024) -> str:
        """The start of a log (where the login is checked) and its end (the summary)."""
        try:
            with (self.jobs_dir / f"{job['id']}.log").open("rb") as handle:
                head = handle.read(size)
                handle.seek(0, os.SEEK_END)
                end = handle.tell()
                handle.seek(max(len(head), end - size))
                data = head + b"\n" + handle.read()
        except OSError:
            return ""
        return data.decode("utf-8", errors="replace")

    def _note_auth(self, lines: list) -> None:
        if any(line.startswith(AUTH_BAD) for line in lines):
            message = next(line for line in lines if line.startswith(AUTH_BAD))
            self.auth = {"ok": False, "checkedAt": utc_now_iso(), "message": message[:300]}
        elif any(line.startswith(AUTH_OK) for line in lines):
            self.auth = {"ok": True, "checkedAt": utc_now_iso(), "message": ""}
