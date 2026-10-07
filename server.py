#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import hmac
import json
import mimetypes
import os
import re
import shutil
import socket
import sqlite3
import stat
import threading
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse
from faststart import layout as faststart_layout, read_chunks
from simpjobs import SimpError, SimpJobs, tree_bytes, valid_model


IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".avif",
}

VIDEO_EXTENSIONS = {
    ".mp4",
    ".webm",
    ".mov",
    ".m4v",
    ".avi",
    ".mkv",
}

DEFAULT_SETTINGS = {
    # Legacy booleans, kept so old state.json files still load. The client
    # migrates them into the *RatingFilter keys below on first run.
    "unratedOnly": False,
    "toktinderUnratedOnly": False,
    # "all" | "unrated" | "liked"
    "swipeRatingFilter": "all",
    "toktinderRatingFilter": "all",
    "photoInterval": 14,
    "videoCount": 2,
    "videoVolume": 0.18,
    "clipStartMode": "random",
    "clipStartSeconds": 0,
    "escalationBaseInterval": 12,
    "escalationMinInterval": 2,
    "escalationRampSeconds": 90,
    "escalationMaxSpeed": 2.2,
    "escalationVideoVolume": 0.32,
    "theme": "dark",
    "swipeFolders": [],
    "toktinderFolders": [],
    "streamFolders": [],
    "escalationFolders": [],
    # Session
    "sessionFolders": [],
    "sessionRounds": 5,
    "sessionBuildSeconds": 60,
    "sessionHoldSeconds": 15,
    "sessionIncludeVideos": True,
    "sessionVideoVolume": 0.3,
    # Gallery
    "galleryFolders": [],
    "galleryRatingFilter": "all",
    "galleryKind": "all",
    "gallerySort": "name",
    # Mosaic
    "mosaicFolders": [],
    "mosaicTiles": 4,
    "mosaicSwapSeconds": 12,
    "mosaicIncludePhotos": False,
    "mosaicVolume": 0.3,
    # Feed
    "feedFolders": [],
    "feedRatingFilter": "all",
    "feedVolume": 1.0,
    # false: clips loop. true: a clip that ends scrolls on to the next.
    "feedAutoAdvance": False,
    # Pick a folder first, then a file inside it, so a 1,000-file folder does
    # not crowd out a 12-file one in every mode. See the picker notes in app.js.
    "balancedFolders": True,
    # The mode the app reopens on.
    "lastMode": "swipe",
    # Ranked
    "rankedSort": "recent",
    "rankedKind": "all",
    "dangerousKind": "all",
    # Old: "only unrated files" in Dangerous. Replaced by dangerousHideKept,
    # since Dangerous no longer rates anything; kept so old state still loads.
    "dangerousUnrated": False,
    # Dangerous skips files you already kept there (see dangerousKept below).
    "dangerousHideKept": True,
    # Sort & rate (photo deck, video deck, Feed, Rediscover): Tune → "Only files
    # I kept in Dangerous" limits the mode to dangerousKept.
    "swipeDangerKeptOnly": False,
    "toktinderDangerKeptOnly": False,
    "feedDangerKeptOnly": False,
    "rediscoverDangerKeptOnly": False,
    "dangerousFolders": [],
    # Swipe (Dangerous): deal order, ↑ = keep and Love, a frame strip under
    # clips, the free-space goal and Blitz rounds.
    "dangerousOrder": "random",
    "dangerousUpLoves": True,
    "dangerousFrames": True,
    "cleanupGoalGb": 0,
    "blitzSeconds": 60,
    "blitzBest": 0,
    # The other Dangerous modes: Grid, Look-alikes, Junk, Folders.
    "dgridFolders": [],
    "dgridKind": "all",
    "dgridOrder": "random",
    "dgridTiles": 12,
    "dgridHideKept": True,
    "dsimilarFolders": [],
    "dsimilarKind": "photos",
    "dsimilarStrictness": "close",
    "djunkFolders": [],
    "djunkKind": "all",
    "djunkHideKept": True,
    "dfoldersFolders": [],
    "dfoldersHideKept": True,
    # Grid / Junk on a phone: tiles per page, and clips playing in their tiles.
    "cleanupPhoneTiles": 4,
    "cleanupClipPreviews": True,
    # Survivor (Dangerous): two files from one folder, the loser goes to trash,
    # until the folder is down to half / a third / a quarter or 10 / 25 / 50.
    # survivorFolder "" means the biggest model.
    "survivorFolder": "",
    "survivorKind": "photos",
    "survivorTarget": "half",
    "survivorLovedSafe": True,
    # Every Dangerous mode: burn/shred and a sound (effects / off) on
    # delete, a reward clip of Loved files every so many MB freed, and the toy
    # driven by deletes/keeps. thrillSound was a bool once; the page maps it.
    "thrillEffect": "burn",
    "thrillSound": "effects",
    "thrillBestStreak": 0,
    "rewardEveryMb": 500,
    "rewardSeconds": 30,
    "rewardAuto": True,
    "toyCleanup": "delete",
    "toyCleanupStep": 0.1,
    "toyCleanupHurry": False,
    # "Show: All / Unrated / Liked" for the lean-back modes.
    "escalationRatingFilter": "all",
    "sessionRatingFilter": "all",
    "mosaicRatingFilter": "all",
    # Named folder selections any mode can apply: [{"name": str, "folders": [str]}]
    "folderSets": [],
    # Escalation absorbed the old Stream mode: ramp off = Stream's steady pace.
    "escalationRamp": True,
    "escalationCorners": 0,
    # Duel: two at a time, pick the better one; builds an Elo ranking.
    "duelFolders": [],
    "duelKind": "photos",
    "duelRatingFilter": "liked",
    # Rediscover: what you have not seen for longest, never-seen first.
    "rediscoverFolders": [],
    "rediscoverKind": "all",
    "rediscoverRatingFilter": "all",
    # Lean-back modes start a clip at one of its marked moments when it has any.
    "useMarks": True,
    # Privacy: a plain tab title, and blanking the page when the tab is hidden.
    "neutralTitle": False,
    "panicOnHide": False,
    # Toy sync through Intiface Central (Buttplug protocol, local websocket).
    "toyUrl": "ws://127.0.0.1:12345",
    "toyMax": 0.7,
    "toyAuto": False,
    # Beat: a metronome that ramps, with random stops.
    "beatFolders": [],
    "beatRatingFilter": "all",
    "beatKind": "all",
    "beatStartBpm": 70,
    "beatPeakBpm": 140,
    "beatMinutes": 8,
    "beatStops": "some",
    "beatSound": "click",
    "beatVolume": 0.6,
    "beatVibrate": False,
    "beatMediaVolume": 0.2,
    "beatSwapBeats": 8,
    # Red light / green light: go and stop at random.
    "redlightFolders": [],
    "redlightRatingFilter": "all",
    "redlightKind": "all",
    "redlightGreenMin": 8,
    "redlightGreenMax": 40,
    "redlightRedMin": 8,
    "redlightRedMax": 25,
    "redlightMinutes": 10,
    "redlightEnding": "random",
    "redlightWarning": False,
    "redlightSound": True,
    "redlightVolume": 0.3,
    # Dice: a card every so often changes the rules.
    "diceFolders": [],
    "diceRatingFilter": "all",
    "diceKind": "all",
    "diceDrawMin": 20,
    "diceDrawMax": 45,
    "diceFinishOdds": 10,
    "diceMinMinutes": 10,
    "diceHolds": True,
    "diceSpeed": True,
    "diceEdges": True,
    "diceVolume": 0.3,
    # Ladder: kept files in rising duel rank, best last.
    "ladderFolders": [],
    "ladderRatingFilter": "liked",
    "ladderKind": "all",
    "ladderSteps": 40,
    "ladderStartSeconds": 10,
    "ladderEndSeconds": 3,
    "ladderVolume": 0.3,
    # Spotlight: one model (top-level folder), photos building to clips.
    "spotlightModel": "",
    "spotlightRatingFilter": "all",
    "spotlightRampSeconds": 240,
    "spotlightBaseInterval": 10,
    "spotlightMinInterval": 3,
    "spotlightVolume": 0.3,
    # Highlights: only the moments you marked, back to back.
    "highlightsFolders": [],
    "highlightsRatingFilter": "all",
    "highlightsOrder": "shuffle",
    "highlightsRepeat": 1,
    "highlightsVolume": 0.5,
}

RATINGS = {"like", "dislike", "love"}
KEPT = {"like", "love"}
# Marked moments: at most this many per file, each at most this long.
MARKS_PER_FILE = 24
MARK_MAX_SECONDS = 600
SESSIONS_LIMIT = 1000
SESSION_MODES = {"session", "beat", "redlight", "dice", "escalation", "ladder", "spotlight", "highlights"}
# PIN lock. The PIN is never stored, only a salted PBKDF2 hash of it.
PIN_RE = re.compile(r"\d{4,12}")
PIN_ITERATIONS = 200_000
LOCK_COOKIE = "heaven_session"
LOCK_TOKEN_SECONDS = 30 * 86400
LOCK_FREE_ATTEMPTS = 5
# Reachable without unlocking: the page itself, so it can show the PIN pad.
PUBLIC_PATHS = {"/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/api/lock", "/api/unlock"}
STATIC_JS_RE = re.compile(r"/js/[0-9a-z-]+\.js")
FEATURES = ["love", "marks", "sessions", "lock", "simp", "bookmarks", "additions", "dangerousKept", "cleanup", "modelReset"]
# Downloads (simpjobs.py): /api/simp/jobs/<id>/log and /api/simp/jobs/<id>/cancel.
SIMP_JOB_RE = re.compile(r"/api/simp/jobs/([a-f0-9]{12})/(log|cancel|arrivals)")
# Bookmark previews: /api/simp/previews/<model, URL-encoded>/<n>.<ext>
SIMP_PREVIEW_RE = re.compile(r"/api/simp/previews/([^/]+)/([^/]+)")

DUEL_START = 1500.0
# Seen times are flushed by the page in batches; one request never needs more.
SEEN_BATCH_LIMIT = 500

# Video stills made by the browser (there is no ffmpeg here) and kept so each
# video is only ever decoded for a thumbnail once.
THUMB_MAX_BYTES = 400 * 1024
JPEG_MAGIC = b"\xff\xd8\xff"

MANIFEST = {
    "name": "Edging Heaven",
    "short_name": "Heaven",
    "start_url": "/",
    "display": "standalone",
    "background_color": "#0b131a",
    "theme_color": "#0b131a",
    "icons": [
        {
            "src": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='10' fill='%239fe7c8'/%3E%3Cpath d='M10 7h3v8c5-5 10-2 9 4l-1 7h-3l1-7c1-4-4-4-6 1l-1 6H9z' fill='%230d2a24'/%3E%3C/svg%3E",
            "sizes": "any",
            "type": "image/svg+xml",
        }
    ],
}

STATIC_DIR = Path(__file__).parent / "static"

# The most an open-ended range request is answered with in one go. Roughly
# half a minute of typical video, so playback never starves, while no single
# request can monopolise the link.
OPEN_RANGE_CHUNK = 1024 * 1024
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


def client_path(path: str) -> str:
    """The name the browser sees for a file. Python hands back bytes that are
    not valid UTF-8 (an old Latin-1 "\xa9" for a copyright sign, say) as
    lone surrogates, which cannot be encoded to UTF-8, put in a URL, or
    hashed. Each such byte is shown as its Latin-1 character instead, and
    MediaLibrary maps the name back to the real one on disk."""
    return "".join(chr(ord(c) - 0xDC00) if 0xDC80 <= ord(c) <= 0xDCFF else c for c in path)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def local_ip_address() -> str:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


def suggested_media_directories() -> list[str]:
    candidates = []
    for mount_root in (Path("/media") / Path.home().name, Path("/run/media") / Path.home().name, Path("/mnt")):
        try:
            candidates.extend(sorted(mount_root.iterdir()))
        except OSError:
            pass
    volumes_dir = Path("/Volumes")
    if volumes_dir.exists():
        candidates.extend(
            sorted((path for path in volumes_dir.iterdir() if path.is_dir()), key=lambda p: p.name.lower())
        )

    home = Path.home()
    candidates.extend(
        [
            home / "Pictures",
            home / "Movies",
            home / "Downloads",
            home / "Desktop",
            Path.cwd(),
        ]
    )

    results = []
    seen = set()
    for candidate in candidates:
        try:
            resolved = candidate.expanduser().resolve()
        except OSError:
            continue
        if not resolved.exists() or not resolved.is_dir():
            continue
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        results.append(key)
    return results


class MediaLibrary:
    def __init__(self, media_dir: Optional[Path], state_path: Path):
        self.media_dir: Optional[Path] = None
        self.state_path = state_path
        self.lock = threading.RLock()
        self.state = self._load_state()
        self._import_dangerous_kept()
        # When each file was last on screen. Its own file: it changes every
        # few seconds while browsing, and rewriting all of state.json for
        # that would be wasteful.
        self.seen_path = state_path.parent / "seen.json"
        self.seen = self._load_seen()
        self.fingerprints_path = state_path.parent / "fingerprints.json"
        self.fingerprints = self._load_fingerprints()
        self.catalog = {"images": [], "videos": [], "updatedAt": None}
        # Files a download added since the last full scan, oldest first, as
        # (path, kind). Pages fetch these instead of the whole catalog, so a
        # download in progress never reshuffles a deck (see add_new_files).
        self.scan_id = uuid.uuid4().hex
        self.appended = []
        # client_path -> real relative path, only for names that differ.
        self.fs_paths = {}
        self._directory_identity = None
        self._last_availability_check = 0.0
        configured_media_dir = (
            str(media_dir.expanduser().resolve()) if media_dir is not None else self.state.get("mediaDirectory")
        )
        if configured_media_dir:
            self._activate_media_directory(configured_media_dir)
        self.scan()

    def _load_state(self) -> dict:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        if self.state_path.exists():
            try:
                with self.state_path.open("r", encoding="utf-8") as handle:
                    loaded = json.load(handle)
            except (OSError, json.JSONDecodeError):
                loaded = {}
        else:
            loaded = {}
        broken = loaded.get("brokenPaths", [])
        times = loaded.get("ratingTimes", {})
        return {
            "ratings": loaded.get("ratings", {}),
            # When each rating was made, kept alongside `ratings` rather than
            # inside it so every state.json written before this still loads.
            # Older likes simply have no time and sort last.
            "ratingTimes": times if isinstance(times, dict) else {},
            "settings": {**DEFAULT_SETTINGS, **loaded.get("settings", {})},
            "mediaDirectory": loaded.get("mediaDirectory"),
            "brokenPaths": set(broken) if isinstance(broken, list) else set(),
            # Duel ratings: {path: {"r": elo, "n": duels fought}}
            "duel": loaded.get("duel") if isinstance(loaded.get("duel"), dict) else {},
            # Marked moments: {path: [[start, end], ...]} in seconds.
            "marks": loaded.get("marks") if isinstance(loaded.get("marks"), dict) else {},
            # Finished timed sessions, oldest first.
            "sessions": loaded.get("sessions") if isinstance(loaded.get("sessions"), list) else [],
            # PIN lock: {"salt", "hash", "iterations"} or None; tokens are
            # stored hashed with their expiry, so a restart keeps you in.
            "lock": loaded.get("lock") if isinstance(loaded.get("lock"), dict) else None,
            "lockTokens": loaded.get("lockTokens") if isinstance(loaded.get("lockTokens"), dict) else {},
            # Files kept in Dangerous: {path: when}. Not a rating -- Dangerous
            # is for clearing space, and this only stops a kept file from
            # coming up there again.
            "dangerousKept": loaded.get("dangerousKept") if isinstance(loaded.get("dangerousKept"), dict) else {},
        }

    def _import_dangerous_kept(self) -> None:
        """dangerous-kept-import.json next to state.json: a list of paths to
        count as kept in Dangerous, read once and renamed to .imported. Used
        when Dangerous stopped rating files: its old likes became this list."""
        source = self.state_path.parent / "dangerous-kept-import.json"
        try:
            paths = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(paths, list):
            now = utc_now_iso()
            kept = self.state.setdefault("dangerousKept", {})
            for path in paths:
                if isinstance(path, str):
                    kept.setdefault(path, now)
            self._save_state()
        source.replace(source.with_name(source.name + ".imported"))

    def _save_state(self) -> None:
        payload = {
            "ratings": self.state["ratings"],
            "ratingTimes": self.state.get("ratingTimes", {}),
            "settings": self.state["settings"],
            "mediaDirectory": self.state.get("mediaDirectory"),
            "brokenPaths": sorted(self.state.get("brokenPaths", set())),
            "duel": self.state.get("duel", {}),
            "marks": self.state.get("marks", {}),
            "sessions": self.state.get("sessions", []),
            "lock": self.state.get("lock"),
            "lockTokens": self.state.get("lockTokens", {}),
            "dangerousKept": self.state.get("dangerousKept", {}),
        }
        self._write_state_payload(payload)

    def _write_state_payload(self, payload: dict) -> None:
        # Written aside and renamed, so a crash mid-write cannot leave half a
        # state.json (which would lose every rating on the next start).
        temporary = self.state_path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
        temporary.replace(self.state_path)

    def scan(self) -> None:
        with self.lock:
            configured = self.state.get("mediaDirectory")
            self._directory_identity = self._media_directory_identity()
            if configured and self._directory_identity is not None:
                self._activate_media_directory(configured)
            else:
                self.media_dir = None
            self._scan_locked()

    def _media_directory_identity(self):
        configured = self.state.get("mediaDirectory")
        if not configured:
            return None
        try:
            path = Path(configured)
            # Access inside the directory to trigger Linux automounts even
            # when the library is the mount root itself.
            info = os.stat(str(path) + "/.")
            if not stat.S_ISDIR(info.st_mode):
                return None
            return (info.st_dev, info.st_ino)
        except OSError:
            return None

    def availability_payload(self) -> dict:
        with self.lock:
            now = time.monotonic()
            if now - self._last_availability_check >= 5:
                self._last_availability_check = now
                if self._media_directory_identity() != self._directory_identity:
                    self.scan()
            return {
                "libraryReady": self.media_dir is not None,
                "mediaDirectory": self.state.get("mediaDirectory"),
                "updatedAt": self.catalog["updatedAt"],
                "scanId": self.scan_id,
                "appended": len(self.appended),
            }

    def _scan_locked(self) -> None:
        self.scan_id = uuid.uuid4().hex
        self.appended = []
        if self.media_dir is None or not self.media_dir.exists() or not self.media_dir.is_dir():
            with self.lock:
                self.catalog = {"images": [], "videos": [], "updatedAt": None}
                self._save_state()
            return

        images = []
        videos = []
        fs_paths = {}
        broken = self.state.get("brokenPaths", set())

        try:
            file_paths = []
            for directory, dirs, names in os.walk(self.media_dir):
                dirs[:] = [name for name in dirs if name != ".heaven-trash"]
                file_paths.extend(Path(directory) / name for name in names)
            file_paths.sort()
        except OSError:
            file_paths = []
        for file_path in file_paths:
            entry = self._catalog_entry(self.media_dir, file_path, broken)
            if entry is None:
                continue
            payload, is_image, fs_path = entry
            if fs_path:
                fs_paths[payload["path"]] = fs_path
            (images if is_image else videos).append(payload)

        with self.lock:
            # Forget entries whose file is gone: either it was deleted, or it
            # was flagged in error and the path never existed. Only prune when
            # the scan actually saw files, so a disconnected drive cannot wipe
            # the list.
            if broken and (images or videos):
                present = {path for path in broken if (self.media_dir / fs_paths.get(path, path)).exists()}
                if present != broken:
                    self.state["brokenPaths"] = present

            self.fs_paths = fs_paths
            self.catalog = {
                "images": images,
                "videos": videos,
                "updatedAt": utc_now_iso(),
            }
            self._save_state()

    def _catalog_entry(self, root: Path, file_path: Path, broken: set):
        """One media file as the catalog lists it: (payload, is_image, real
        relative path when it differs from the client's), or None to skip."""
        try:
            if not file_path.is_file():
                return None
            file_stat = file_path.stat()
            file_size = file_stat.st_size
        except OSError:
            return None

        ext = file_path.suffix.lower()
        if ext not in IMAGE_EXTENSIONS and ext not in VIDEO_EXTENSIONS:
            return None

        # A zero-byte file is always a failed copy or a stub. Cheap to
        # detect here; the browser would only show a broken-image glyph.
        if file_size == 0:
            return None

        relative_path = file_path.relative_to(root).as_posix()
        fs_path = relative_path
        relative_path = client_path(relative_path)
        if relative_path != fs_path:
            # A real file already has the display name; skip rather than
            # let two files answer to one path.
            if (root / relative_path).exists():
                return None
        if relative_path in broken:
            return None
        folder = ""
        if file_path.parent != root:
            folder = client_path(file_path.parent.relative_to(root).as_posix())

        # `name` is not sent: it is always the tail of `path`, and with
        # hash-style filenames that duplication was ~1.8MB of a 2.9MB
        # payload. The client splits it back off on arrival. `rating` and
        # `ratedAt` are omitted when unset for the same reason -- most of
        # a library is unrated, and "rating": null 13,000 times is 400KB.
        payload = {
            "path": relative_path,
            "folder": folder,
            "size": file_size,
            # Epoch seconds; the gallery sorts on it.
            "mtime": int(file_stat.st_mtime),
        }
        rating = self.state["ratings"].get(relative_path)
        if rating:
            payload["rating"] = rating
            rated_at = self.state.get("ratingTimes", {}).get(relative_path)
            if rated_at:
                payload["ratedAt"] = rated_at
        return payload, ext in IMAGE_EXTENSIONS, fs_path if relative_path != fs_path else None

    def add_new_files(self, directories) -> list:
        """Add files that appeared under these directories (a download in
        progress) without a full rescan. Each directory counts as the whole
        top-level folder (model) it is in; anything outside the library, and
        the trash, is ignored. Returns the added catalog entries."""
        with self.lock:
            root = self.media_dir
            if root is None:
                return []
            known = self._catalog_paths()
            broken = set(self.state.get("brokenPaths", set()))
        models = []
        for directory in directories:
            try:
                parts = Path(directory).resolve().relative_to(root).parts
            except (OSError, ValueError):
                continue
            if parts and parts[0] != ".heaven-trash" and parts[0] not in models:
                models.append(parts[0])
        found = []
        # Walked outside the lock: listing a big model folder on USB takes a
        # moment, and browsing must not wait for it. Only new names are stat'ed.
        for model in models:
            for directory, dirs, names in os.walk(root / model):
                dirs[:] = [name for name in dirs if name != ".heaven-trash"]
                for name in names:
                    file_path = Path(directory) / name
                    if client_path(file_path.relative_to(root).as_posix()) in known:
                        continue
                    entry = self._catalog_entry(root, file_path, broken)
                    if entry is not None:
                        found.append(entry)
        if not found:
            return []
        with self.lock:
            if self.media_dir != root:
                return []
            known = self._catalog_paths()
            added = []
            for payload, is_image, fs_path in sorted(found, key=lambda entry: entry[0]["path"]):
                if payload["path"] in known:
                    continue
                if fs_path:
                    self.fs_paths[payload["path"]] = fs_path
                self.catalog["images" if is_image else "videos"].append(payload)
                self.appended.append((payload["path"], "image" if is_image else "video"))
                added.append(payload)
            if added:
                self.catalog["updatedAt"] = utc_now_iso()
            return added

    def additions(self, scan_id, start) -> Optional[dict]:
        """Files added since the page's copy of the catalog: the entries of
        appended[start:] that are still in the library (not trashed since).
        None when a full scan happened since; the page reloads everything."""
        with self.lock:
            if scan_id != self.scan_id:
                return None
            wanted = {path: kind for path, kind in self.appended[max(0, start):]}
            items = [{**item, "kind": kind} for key, kind in (("images", "image"), ("videos", "video"))
                     for item in self.catalog[key] if wanted.get(item["path"]) == kind]
            return {"scanId": self.scan_id, "next": len(self.appended), "updatedAt": self.catalog["updatedAt"], "items": items}

    def library_payload(self) -> dict:
        with self.lock:
            all_items = [*self.catalog["images"], *self.catalog["videos"]]
            folders = sorted(
                {
                    item["folder"] for item in all_items
                },
                key=lambda value: (value != "", value.lower()),
            )
            return {
                "images": list(self.catalog["images"]),
                "videos": list(self.catalog["videos"]),
                "folders": folders,
                "updatedAt": self.catalog["updatedAt"],
                "scanId": self.scan_id,
                "appended": len(self.appended),
                "counts": {
                    "images": len(self.catalog["images"]),
                    "videos": len(self.catalog["videos"]),
                    # "liked" is everything kept; "loved" is the top tier of it.
                    "liked": sum(
                        1 for item in all_items if item.get("rating") in KEPT
                    ),
                    "loved": sum(
                        1 for item in all_items if item.get("rating") == "love"
                    ),
                    "disliked": sum(
                        1 for item in all_items if item.get("rating") == "dislike"
                    ),
                    "unrated": sum(
                        1 for item in all_items if not item.get("rating")
                    ),
                },
            }

    def state_payload(self) -> dict:
        self.availability_payload()
        with self.lock:
            return {
                "library": self.library_payload(),
                "settings": dict(self.state["settings"]),
                "mediaDirectory": self.state.get("mediaDirectory"),
                "libraryReady": self.media_dir is not None,
                "brokenCount": len(self.state.get("brokenPaths", set())),
                "canTrash": self.media_dir is not None and os.access(self.media_dir, os.W_OK),
                "mediaChoices": suggested_media_directories(),
                "features": FEATURES,
            }

    def _activate_media_directory(self, media_dir: str) -> bool:
        try:
            resolved = Path(media_dir).expanduser().resolve()
        except OSError:
            self.media_dir = None
            self.state["mediaDirectory"] = media_dir
            return False

        self.state["mediaDirectory"] = str(resolved)
        if not resolved.exists() or not resolved.is_dir():
            self.media_dir = None
            return False

        self.media_dir = resolved
        return True

    def set_media_directory(self, media_dir: str) -> tuple[bool, Optional[str]]:
        raw_value = media_dir.strip()
        if not raw_value:
            return False, "Enter a media folder path."

        with self.lock:
            previous = self.state.get("mediaDirectory")
            activated = self._activate_media_directory(raw_value)
            if not activated:
                self._save_state()
                return False, f"Media directory does not exist: {self.state.get('mediaDirectory')}"

            if previous and previous != self.state.get("mediaDirectory"):
                self.state["ratings"] = {}
                self.state["ratingTimes"] = {}
                self.state["duel"] = {}
                self.state["marks"] = {}
                self.state["dangerousKept"] = {}
                self.seen = {}
                self._save_seen()

        self.scan()
        return True, None

    def set_rating(self, relative_path: str, rating: Optional[str]) -> bool:
        if rating is not None and rating not in RATINGS:
            return False

        with self.lock:
            stamped = None if rating is None else utc_now_iso()
            found = False
            for item in [*self.catalog["images"], *self.catalog["videos"]]:
                if item["path"] == relative_path:
                    if rating:
                        item["rating"] = rating
                        item["ratedAt"] = stamped
                    else:
                        item.pop("rating", None)
                        item.pop("ratedAt", None)
                    found = True
                    break

            if not found:
                return False

            times = self.state.setdefault("ratingTimes", {})
            if rating is None:
                self.state["ratings"].pop(relative_path, None)
                times.pop(relative_path, None)
            else:
                self.state["ratings"][relative_path] = rating
                times[relative_path] = stamped

            self._save_state()
            return True

    def update_settings(self, patch: dict) -> dict:
        allowed = set(DEFAULT_SETTINGS)
        with self.lock:
            for key, value in patch.items():
                if key in allowed:
                    self.state["settings"][key] = value
            self._save_state()
            return dict(self.state["settings"])

    def mark_broken(self, relative_path: str) -> bool:
        """Record a file the browser could not decode and drop it from the
        catalog, so it stops turning up while browsing."""
        if self.resolve_media_path(relative_path) is None:
            return False

        with self.lock:
            broken = self.state.setdefault("brokenPaths", set())
            if relative_path in broken:
                return True
            broken.add(relative_path)
            for key in ("images", "videos"):
                self.catalog[key] = [
                    item for item in self.catalog[key] if item["path"] != relative_path
                ]
            self._save_state()
            return True

    def clear_broken(self) -> int:
        with self.lock:
            count = len(self.state.get("brokenPaths", set()))
            self.state["brokenPaths"] = set()
            self._save_state()
        if count:
            self.scan()
        return count

    def clear_ratings(self) -> None:
        with self.lock:
            self.state["ratings"] = {}
            self.state["ratingTimes"] = {}
            self.state["duel"] = {}
            for item in [*self.catalog["images"], *self.catalog["videos"]]:
                item.pop("rating", None)
                item.pop("ratedAt", None)
            self._save_state()

    def reset_saved_data(self) -> None:
        with self.lock:
            self.media_dir = None
            self.catalog = {"images": [], "videos": [], "updatedAt": None}
            self.state["ratings"] = {}
            self.state["ratingTimes"] = {}
            self.state["settings"] = dict(DEFAULT_SETTINGS)
            self.state["mediaDirectory"] = None
            self.state["brokenPaths"] = set()
            self.state["marks"] = {}
            self.state["sessions"] = []
            self.state["dangerousKept"] = {}
            # The PIN is privacy, not library data: resetting the library keeps it.
            self._write_state_payload({"lock": self.state.get("lock"), "lockTokens": self.state.get("lockTokens", {})})

    def reset_mode_data(self, mode: str) -> bool:
        with self.lock:
            times = self.state.setdefault("ratingTimes", {})
            if mode == "swipe":
                for item in self.catalog["images"]:
                    item.pop("rating", None)
                    item.pop("ratedAt", None)
                    self.state["ratings"].pop(item["path"], None)
                    times.pop(item["path"], None)
            elif mode == "toktinder":
                for item in self.catalog["videos"]:
                    item.pop("rating", None)
                    item.pop("ratedAt", None)
                    self.state["ratings"].pop(item["path"], None)
                    times.pop(item["path"], None)
            else:
                return False

            self._save_state()
            return True

    # ---- kept in Dangerous ----

    def dangerous_kept_payload(self) -> dict:
        with self.lock:
            known = self._catalog_paths()
            return {path: when for path, when in self.state.get("dangerousKept", {}).items() if path in known}

    def set_dangerous_kept(self, relative_path, kept) -> bool:
        return isinstance(relative_path, str) and self.set_dangerous_kept_many([relative_path], kept) == 1

    def set_dangerous_kept_many(self, paths, kept) -> int:
        """Mark (or unmark) files as kept in Dangerous; one state write for
        a whole Grid page. Paths not in the library are ignored."""
        if not isinstance(paths, list) or not isinstance(kept, bool) or not all(isinstance(p, str) for p in paths):
            return 0
        with self.lock:
            known = self._catalog_paths()
            table = self.state.setdefault("dangerousKept", {})
            stamp = utc_now_iso()
            changed = 0
            for relative_path in paths:
                if relative_path not in known:
                    continue
                if kept:
                    table[relative_path] = stamp
                else:
                    table.pop(relative_path, None)
                changed += 1
            if changed:
                self._save_state()
            return changed

    # ---- Look-alike fingerprints (Dangerous) ----
    # The server has no image decoder, so the page makes a 64-bit difference
    # hash of each photo (and of each clip's still) and stores it here with
    # the file's size and date: a changed file is fingerprinted again, and a
    # phone never repeats work a laptop already did.

    def _load_fingerprints(self) -> dict:
        try:
            loaded = json.loads(self.fingerprints_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return loaded if isinstance(loaded, dict) else {}

    def fingerprints_payload(self) -> dict:
        """path -> [hash, width, height] for files whose size and date still match."""
        with self.lock:
            result = {}
            for item in [*self.catalog["images"], *self.catalog["videos"]]:
                row = self.fingerprints.get(item["path"])
                if isinstance(row, list) and len(row) == 5 and row[:2] == [item.get("size"), item.get("mtime")]:
                    result[item["path"]] = row[2:]
            return result

    def save_fingerprints(self, items) -> int:
        if not isinstance(items, dict) or len(items) > 2000:
            return 0
        with self.lock:
            by_path = {item["path"]: item for key in ("images", "videos") for item in self.catalog[key]}
            stored = 0
            for path, value in items.items():
                item = by_path.get(path)
                if item is None or not isinstance(value, list) or len(value) != 3:
                    continue
                digest, width, height = value
                if not (isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{16}", digest)):
                    continue
                if not all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 100000 for v in (width, height)):
                    continue
                self.fingerprints[path] = [item.get("size"), item.get("mtime"), digest, width, height]
                stored += 1
            if stored:
                # Forget files that left the library, unless it is offline.
                if by_path:
                    self.fingerprints = {k: v for k, v in self.fingerprints.items() if k in by_path}
                temporary = self.fingerprints_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(self.fingerprints, separators=(",", ":")), encoding="utf-8")
                temporary.replace(self.fingerprints_path)
            return stored

    # ---- seen times (Rediscover) ----

    def _load_seen(self) -> dict:
        try:
            with self.seen_path.open("r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            return {k: int(v) for k, v in loaded.items() if isinstance(k, str) and isinstance(v, (int, float))}
        except (OSError, ValueError, AttributeError):
            return {}

    def _save_seen(self) -> None:
        temporary = self.seen_path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(self.seen, handle, separators=(",", ":"))
        temporary.replace(self.seen_path)

    def _catalog_paths(self) -> set:
        return {item["path"] for item in [*self.catalog["images"], *self.catalog["videos"]]}

    def mark_seen(self, paths) -> int:
        if not isinstance(paths, list):
            return 0
        now = int(time.time())
        with self.lock:
            known = self._catalog_paths()
            fresh = [path for path in paths[:SEEN_BATCH_LIMIT] if isinstance(path, str) and path in known]
            for path in fresh:
                self.seen[path] = now
            if fresh:
                self._save_seen()
            return len(fresh)

    def seen_payload(self) -> dict:
        with self.lock:
            known = self._catalog_paths()
            return {path: stamp for path, stamp in self.seen.items() if path in known}

    # ---- duel (Elo) ----

    def duel_payload(self) -> dict:
        with self.lock:
            return dict(self.state.get("duel", {}))

    def record_duel(self, winner: str, loser: str):
        """Standard Elo. New items move faster (K=40) until they have ten
        duels behind them, then settle (K=24)."""
        with self.lock:
            known = self._catalog_paths()
            if winner == loser or winner not in known or loser not in known:
                return None
            table = self.state.setdefault("duel", {})
            before = {path: dict(table[path]) if path in table else None for path in (winner, loser)}
            w = table.get(winner) or {"r": DUEL_START, "n": 0}
            l = table.get(loser) or {"r": DUEL_START, "n": 0}
            expected = 1 / (1 + 10 ** ((l["r"] - w["r"]) / 400))
            k_w = 40 if w["n"] < 10 else 24
            k_l = 40 if l["n"] < 10 else 24
            table[winner] = {"r": round(w["r"] + k_w * (1 - expected), 1), "n": w["n"] + 1}
            table[loser] = {"r": round(l["r"] - k_l * (1 - expected), 1), "n": l["n"] + 1}
            self._save_state()
            return {"before": before, "ratings": {winner: table[winner], loser: table[loser]}}

    def restore_duel(self, ratings) -> bool:
        if not isinstance(ratings, dict):
            return False
        with self.lock:
            table = self.state.setdefault("duel", {})
            for path, value in ratings.items():
                if value is None:
                    table.pop(path, None)
                elif isinstance(value, dict) and isinstance(value.get("r"), (int, float)) and isinstance(value.get("n"), int):
                    table[path] = {"r": float(value["r"]), "n": int(value["n"])}
            self._save_state()
            return True

    # ---- marked moments (Highlights) ----

    def marks_payload(self) -> dict:
        with self.lock:
            known = self._catalog_paths()
            return {path: spans for path, spans in self.state.get("marks", {}).items() if path in known}

    def set_marks(self, relative_path, spans) -> Optional[list]:
        """Replace one file's marks. Spans are cleaned: numbers, start before
        end, sorted, overlaps merged, capped in length and count."""
        if not isinstance(relative_path, str) or not isinstance(spans, list):
            return None
        clean = []
        for span in spans:
            if not (isinstance(span, (list, tuple)) and len(span) == 2):
                return None
            start, end = span
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (start, end)):
                return None
            start, end = round(max(0.0, float(start)), 2), round(float(end), 2)
            if end - start < 0.5:
                continue
            clean.append([start, min(end, start + MARK_MAX_SECONDS)])
        clean.sort()
        merged = []
        for start, end in clean:
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        merged = merged[:MARKS_PER_FILE]
        with self.lock:
            if not any(item["path"] == relative_path for item in self.catalog["videos"]):
                return None
            table = self.state.setdefault("marks", {})
            if merged:
                table[relative_path] = merged
            else:
                table.pop(relative_path, None)
            self._save_state()
            return merged

    # ---- session history ----

    def sessions_payload(self) -> list:
        with self.lock:
            return list(self.state.get("sessions", []))

    def add_session(self, entry) -> Optional[dict]:
        if not isinstance(entry, dict) or entry.get("mode") not in SESSION_MODES:
            return None
        seconds, edges = entry.get("seconds"), entry.get("edges", 0)
        if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not 0 < seconds <= 86400:
            return None
        if not isinstance(edges, int) or isinstance(edges, bool) or not 0 <= edges <= 10000:
            return None
        ending = entry.get("ending")
        record = {
            "mode": entry["mode"],
            "endedAt": utc_now_iso(),
            "seconds": int(seconds),
            "edges": edges,
        }
        if isinstance(ending, str) and re.fullmatch(r"[a-z]{1,16}", ending):
            record["ending"] = ending
        with self.lock:
            sessions = self.state.setdefault("sessions", [])
            sessions.append(record)
            del sessions[:-SESSIONS_LIMIT]
            self._save_state()
        return record

    def clear_sessions(self) -> None:
        with self.lock:
            self.state["sessions"] = []
            self._save_state()

    # ---- PIN lock ----

    def lock_enabled(self) -> bool:
        return bool(self.state.get("lock"))

    @staticmethod
    def _hash_pin(pin: str, salt: bytes, iterations: int) -> str:
        return hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, iterations).hex()

    def pin_matches(self, pin) -> bool:
        record = self.state.get("lock")
        if not record or not isinstance(pin, str):
            return False
        try:
            salt = bytes.fromhex(record["salt"])
            expected = record["hash"]
            iterations = int(record.get("iterations", PIN_ITERATIONS))
        except (KeyError, ValueError, TypeError):
            return False
        return hmac.compare_digest(self._hash_pin(pin, salt, iterations), expected)

    def issue_token(self) -> str:
        token = uuid.uuid4().hex + uuid.uuid4().hex
        with self.lock:
            now = time.time()
            tokens = {key: expiry for key, expiry in self.state.setdefault("lockTokens", {}).items() if expiry > now}
            tokens[hashlib.sha256(token.encode()).hexdigest()] = int(now + LOCK_TOKEN_SECONDS)
            self.state["lockTokens"] = tokens
            self._save_state()
        return token

    def token_valid(self, token) -> bool:
        if not isinstance(token, str) or not token:
            return False
        expiry = self.state.get("lockTokens", {}).get(hashlib.sha256(token.encode()).hexdigest())
        return bool(expiry and expiry > time.time())

    def revoke_token(self, token) -> None:
        if isinstance(token, str):
            with self.lock:
                self.state.get("lockTokens", {}).pop(hashlib.sha256(token.encode()).hexdigest(), None)
                self._save_state()

    def set_pin(self, pin) -> bool:
        if not isinstance(pin, str) or not PIN_RE.fullmatch(pin):
            return False
        salt = os.urandom(16)
        with self.lock:
            self.state["lock"] = {"salt": salt.hex(), "hash": self._hash_pin(pin, salt, PIN_ITERATIONS),
                                  "iterations": PIN_ITERATIONS}
            # A new PIN signs every other device out.
            self.state["lockTokens"] = {}
            self._save_state()
        return True

    def clear_pin(self) -> None:
        with self.lock:
            self.state["lock"] = None
            self.state["lockTokens"] = {}
            self._save_state()

    def resolve_media_path(self, relative_path: str) -> Optional[Path]:
        if self.media_dir is None:
            return None
        relative_path = self.fs_paths.get(relative_path, relative_path)
        if ".heaven-trash" in Path(relative_path).parts:
            return None
        candidate = (self.media_dir / relative_path).resolve()
        try:
            common_root = os.path.commonpath([str(candidate), str(self.media_dir)])
        except ValueError:
            return None
        if common_root != str(self.media_dir):
            return None
        if not candidate.is_file():
            return None
        return candidate

    def thumb_path(self, relative_path: str) -> Optional[Path]:
        """Where the still for this video lives (see _still_for)."""
        file_path = self.resolve_media_path(relative_path)
        if file_path is None or file_path.suffix.lower() not in VIDEO_EXTENSIONS:
            return None
        return self._still_for(relative_path, file_path.stat())

    def save_thumb(self, relative_path: str, body: bytes) -> bool:
        target = self.thumb_path(relative_path)
        if target is None or not body.startswith(JPEG_MAGIC) or len(body) > THUMB_MAX_BYTES:
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".tmp")
        temporary.write_bytes(body)
        temporary.replace(target)
        return True

    def _trash_root(self):
        if self.media_dir is None:
            raise ValueError("The library is offline.")
        root = self.media_dir / ".heaven-trash"
        if root.is_symlink():
            raise ValueError("The trash folder must not be a symlink.")
        return root

    def trash_media(self, relative_path, expected_library):
        with self.lock:
            if expected_library != str(self.media_dir):
                raise ValueError("The library changed. Reload before deleting.")
            item = next((item for key in ("images", "videos")
                         for item in self.catalog[key] if item["path"] == relative_path), None)
            token = self._move_to_trash(relative_path, item)
            for key in ("images", "videos"):
                self.catalog[key] = [i for i in self.catalog[key] if i["path"] != relative_path]
            self.catalog["updatedAt"] = utc_now_iso()
            # Keep ratings on disk so restoring also survives a process restart.
            return {"token": token, "path": relative_path, "updatedAt": self.catalog["updatedAt"]}

    def trash_many(self, paths, expected_library):
        """Trash several files in one request (Grid, Look-alikes, Junk,
        Folders). Each moves exactly as trash_media moves one; a file that
        cannot be moved is reported and the others still go."""
        if not isinstance(paths, list) or not paths or len(paths) > 20000 or not all(isinstance(p, str) for p in paths):
            raise ValueError("Send a list of media paths.")
        with self.lock:
            if expected_library != str(self.media_dir):
                raise ValueError("The library changed. Reload before deleting.")
            by_path = {item["path"]: item for key in ("images", "videos") for item in self.catalog[key]}
            trashed, failed = [], []
            for relative_path in dict.fromkeys(paths):
                try:
                    trashed.append({"path": relative_path, "token": self._move_to_trash(relative_path, by_path.get(relative_path))})
                except (OSError, ValueError) as error:
                    failed.append({"path": relative_path, "error": str(error)})
            gone = {entry["path"] for entry in trashed}
            if gone:
                for key in ("images", "videos"):
                    self.catalog[key] = [i for i in self.catalog[key] if i["path"] not in gone]
                self.catalog["updatedAt"] = utc_now_iso()
            return {"trashed": trashed, "failed": failed, "updatedAt": self.catalog["updatedAt"]}

    def _move_to_trash(self, relative_path, item) -> str:
        """Move one catalogued file into .heaven-trash/<token>/; the caller
        holds the lock and takes it out of the catalog."""
        source = self.resolve_media_path(relative_path)
        if item is None or source is None:
            raise ValueError("This file is no longer in the library.")
        fs_path = self.fs_paths.get(relative_path, relative_path)
        if (self.media_dir / fs_path).is_symlink():
            raise ValueError("Delete the original file, not a symbolic link.")
        # Renaming on the same drive is immediate, including large videos.
        token = uuid.uuid4().hex
        entry = self._trash_root() / token
        entry.mkdir(parents=True)
        # fsPath is the real name on disk when it is not valid UTF-8;
        # json.dumps escapes it, so the record stays plain ASCII.
        record = {"path": relative_path, "fsPath": fs_path, "item": dict(item), "deletedAt": utc_now_iso()}
        try:
            (entry / "record.json").write_text(json.dumps(record), encoding="utf-8")
            source.rename(entry / "media")
        except OSError:
            (entry / "record.json").unlink(missing_ok=True)
            entry.rmdir()
            raise
        return token

    def restore_media(self, token, expected_library):
        with self.lock:
            if expected_library != str(self.media_dir):
                raise ValueError("The library changed. Reload before restoring.")
            if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{32}", token):
                raise ValueError("Invalid trash entry.")
            entry = self._trash_root() / token
            if entry.is_symlink() or (entry / "media").is_symlink() or (entry / "record.json").is_symlink():
                raise ValueError("Invalid trash entry.")
            record = json.loads((entry / "record.json").read_text(encoding="utf-8"))
            fs_path = record.get("fsPath", record["path"])
            if not isinstance(fs_path, str) or client_path(fs_path) != client_path(record["path"]):
                raise ValueError("Invalid trash entry.")
            destination = (self.media_dir / fs_path).resolve()
            if not destination.is_relative_to(self.media_dir) or ".heaven-trash" in destination.parts:
                raise ValueError("Invalid restore path.")
            if destination.exists():
                raise ValueError("A file already exists at that path. Nothing was overwritten.")
            destination.parent.mkdir(parents=True, exist_ok=True)
            (entry / "media").rename(destination)
            (entry / "record.json").unlink()
            entry.rmdir()
            # Only this file comes back. A full scan here held the lock for as
            # long as walking the whole drive takes, stalling every picture and
            # poll behind an Undo, and its new scanId made pages reload it all.
            found = self._catalog_entry(self.media_dir, self.media_dir / fs_path, set(self.state.get("brokenPaths", set())))
            if found is not None and found[0]["path"] not in self._catalog_paths():
                payload, is_image, real_path = found
                if real_path:
                    self.fs_paths[payload["path"]] = real_path
                self.catalog["images" if is_image else "videos"].append(payload)
                self.appended.append((payload["path"], "image" if is_image else "video"))
                self.catalog["updatedAt"] = utc_now_iso()
            return client_path(record["path"])

    def restore_many(self, tokens, expected_library) -> dict:
        """Undo for a Grid page or a whole folder: every token restored as
        restore_media restores one, and the entries sent back in one go."""
        if not isinstance(tokens, list) or not tokens or len(tokens) > 20000:
            raise ValueError("Send a list of trash entries.")
        with self.lock:
            restored, failed = [], []
            for token in tokens:
                try:
                    restored.append(self.restore_media(token, expected_library))
                except (OSError, ValueError, KeyError) as error:
                    failed.append({"token": token if isinstance(token, str) else "", "error": str(error)})
            wanted = set(restored)
            items = [{**item, "kind": kind} for key, kind in (("images", "image"), ("videos", "video"))
                     for item in self.catalog[key] if item["path"] in wanted]
            return {"items": items, "failed": failed, "updatedAt": self.catalog["updatedAt"]}

    def restored_payload(self, path) -> dict:
        """What the page needs to put a restored file back without reloading
        the library: its catalog entry, and the catalog's new updatedAt."""
        with self.lock:
            for key, kind in (("images", "image"), ("videos", "video")):
                item = next((item for item in self.catalog[key] if item["path"] == path), None)
                if item is not None:
                    return {"item": {**item, "kind": kind}, "updatedAt": self.catalog["updatedAt"]}
            return {"updatedAt": self.catalog["updatedAt"]}

    def trash_entries(self):
        with self.lock:
            if self.media_dir is None:
                return []
            entries = []
            for entry in self._trash_root().glob("*"):
                if entry.is_symlink() or not re.fullmatch(r"[a-f0-9]{32}", entry.name):
                    continue
                try:
                    record = json.loads((entry / "record.json").read_text(encoding="utf-8"))
                    if (entry / "media").is_file():
                        entries.append({"token": entry.name, "path": client_path(record["path"]),
                                        "deletedAt": record["deletedAt"]})
                except (OSError, ValueError, KeyError):
                    continue
            return sorted(entries, key=lambda item: item["deletedAt"], reverse=True)

    def empty_trash(self, expected_library):
        """Permanently erase every trash entry. Only the files trash_media
        wrote are removed; anything else found in the trash folder stays."""
        with self.lock:
            if expected_library != str(self.media_dir):
                raise ValueError("The library changed. Reload before emptying trash.")
            root = self._trash_root()
            removed, freed = 0, 0
            if not root.is_dir():
                return {"removed": 0, "freedBytes": 0, "freeBytes": self._free_bytes()}
            for entry in root.iterdir():
                if entry.is_symlink() or not re.fullmatch(r"[a-f0-9]{32}", entry.name) or not entry.is_dir():
                    continue
                media, record_file = entry / "media", entry / "record.json"
                if media.is_symlink() or record_file.is_symlink():
                    continue
                try:
                    record = json.loads(record_file.read_text(encoding="utf-8"))
                    fs_path = record.get("fsPath", record["path"])
                    # Records written before client_path existed hold the raw
                    # name; the catalog, ratings and thumbnails use the clean one.
                    path = client_path(record["path"])
                except (OSError, ValueError, KeyError, TypeError, AttributeError):
                    path = fs_path = None
                if media.is_file():
                    info = media.stat()
                    if isinstance(path, str):
                        # Same key as thumb_path: a rename keeps size and mtime.
                        self._still_for(path, info).unlink(missing_ok=True)
                    media.unlink()
                    removed += 1
                    freed += info.st_size
                record_file.unlink(missing_ok=True)
                try:
                    entry.rmdir()
                except OSError:
                    continue
                # The file is gone for good, so its ratings must not attach to
                # a different file that later lands on the same path.
                if isinstance(path, str) and isinstance(fs_path, str) and not (self.media_dir / fs_path).exists():
                    for key in ("ratings", "ratingTimes", "duel", "marks", "dangerousKept"):
                        self.state.get(key, {}).pop(path, None)
            self._save_state()
            return {"removed": removed, "freedBytes": freed, "freeBytes": self._free_bytes()}

    def delete_trash_folder(self, expected_library):
        """Empty the trash, then delete the .heaven-trash folder itself with
        whatever empty_trash leaves in it (stray files, broken entries)."""
        with self.lock:
            result = self.empty_trash(expected_library)
            root = self._trash_root()
            if root.is_dir():
                leftovers = 0
                for directory, _dirs, names in os.walk(root):
                    for name in names:
                        leftovers += (Path(directory) / name).lstat().st_size
                # rmtree removes symlinks inside without following them.
                shutil.rmtree(root)
                result["freedBytes"] += leftovers
                result["freeBytes"] = self._free_bytes()
            return result

    # ---- removing a whole model (Settings → Remove a model) ----
    # A model is a top-level folder. Removing it erases the folder, its files
    # in the trash, and everything the app remembers about them. Nothing goes
    # through the trash: there is no undo, which the page says before asking.

    @staticmethod
    def _model_keys(table, model) -> list:
        return [path for path in table if isinstance(path, str) and path.startswith(model + "/")]

    def _model_folder(self, model) -> Optional[Path]:
        """The model's folder as it is named on disk, or None if there is none."""
        if self.media_dir is None:
            raise ValueError("The library is offline.")
        try:
            names = os.listdir(self.media_dir)
        except OSError:
            return None
        for name in names:
            if client_path(name) == model and name != ".heaven-trash":
                folder = self.media_dir / name
                if folder.is_symlink():
                    raise ValueError("That model folder is a link to somewhere else. Remove it by hand.")
                if folder.is_dir():
                    return folder
        return None

    def _model_trash(self, model) -> list:
        """(entry folder, size) of each of the model's files in the trash."""
        root = self._trash_root()
        found = []
        if not root.is_dir():
            return found
        for entry in root.iterdir():
            if entry.is_symlink() or not re.fullmatch(r"[a-f0-9]{32}", entry.name):
                continue
            try:
                record = json.loads((entry / "record.json").read_text(encoding="utf-8"))
                if client_path(record["path"]).startswith(model + "/"):
                    media = entry / "media"
                    found.append((entry, media.lstat().st_size if media.is_file() else 0))
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                continue
        return found

    def model_summary(self, model) -> Optional[dict]:
        """What removing a model would erase; None when nothing is kept for it."""
        with self.lock:
            folder = self._model_folder(model)
            items = [item for key in ("images", "videos") for item in self.catalog[key] if item["path"].startswith(model + "/")]
            trash = self._model_trash(model)
            ratings = {path: self.state["ratings"][path] for path in self._model_keys(self.state["ratings"], model)}
            remembered = {
                "kept": sum(1 for rating in ratings.values() if rating in KEPT),
                "loved": sum(1 for rating in ratings.values() if rating == "love"),
                "passed": sum(1 for rating in ratings.values() if rating == "dislike"),
                "marked": len(self._model_keys(self.state.get("marks", {}), model)),
                "dueled": len(self._model_keys(self.state.get("duel", {}), model)),
                "keptInDangerous": len(self._model_keys(self.state.get("dangerousKept", {}), model)),
            }
        # Outside the lock: walking a big folder takes a moment.
        files, size = tree_bytes(folder) if folder else (0, 0)
        if folder is None and not trash and not any(remembered.values()):
            return None
        return {
            "onDrive": folder is not None,
            "media": len(items),
            "photos": sum(1 for item in items if Path(item["path"]).suffix.lower() in IMAGE_EXTENSIONS),
            "files": files,
            "bytes": size,
            "trashFiles": len(trash),
            "trashBytes": sum(entry_size for _entry, entry_size in trash),
            "remembered": remembered,
        }

    def detach_model(self, model, expected_library) -> tuple:
        """Take a model out of the library in one quick step: its folder and
        trash entries are renamed into .heaven-trash/.removing-<token>/ (the
        scanner and the trash list skip it), and every rating, mark, duel
        score, seen time, fingerprint and video still of its files is
        forgotten. erase_detached deletes the folder afterwards, outside the
        lock. Returns (that folder or None, counts for the page)."""
        with self.lock:
            if expected_library != str(self.media_dir):
                raise ValueError("The library changed. Reload before removing a model.")
            folder = self._model_folder(model)
            trash = self._model_trash(model)
            items = [item for key in ("images", "videos") for item in self.catalog[key] if item["path"].startswith(model + "/")]
            # Stills are keyed by size and date, so look them up before the files go.
            for item in items:
                if Path(item["path"]).suffix.lower() in VIDEO_EXTENSIONS:
                    still = self.thumb_path(item["path"])
                    if still is not None:
                        still.unlink(missing_ok=True)
            for entry, _size in trash:
                media = entry / "media"
                try:
                    record = json.loads((entry / "record.json").read_text(encoding="utf-8"))
                    if media.is_file() and Path(record["path"]).suffix.lower() in VIDEO_EXTENSIONS:
                        self._still_for(client_path(record["path"]), media.stat()).unlink(missing_ok=True)
                except (OSError, ValueError, KeyError, TypeError, AttributeError):
                    pass

            pending = None
            if folder is not None or trash:
                pending = self._trash_root() / f".removing-{uuid.uuid4().hex}"
                pending.mkdir(parents=True)
                try:
                    if folder is not None:
                        # Same drive, so this is a rename, however big the folder.
                        folder.rename(pending / "folder")
                except OSError:
                    pending.rmdir()
                    raise
                for entry, _size in trash:
                    try:
                        (pending / "trash").mkdir(exist_ok=True)
                        entry.rename(pending / "trash" / entry.name)
                    except OSError:
                        continue  # stays in the trash, where Empty trash still erases it

            for key in ("ratings", "ratingTimes", "duel", "marks", "dangerousKept"):
                table = self.state.get(key, {})
                for path in self._model_keys(table, model):
                    table.pop(path, None)
            self.state["brokenPaths"] = {path for path in self.state.get("brokenPaths", set()) if not path.startswith(model + "/")}
            for path in self._model_keys(self.fs_paths, model):
                self.fs_paths.pop(path)
            gone = {item["path"] for item in items}
            if gone:
                for key in ("images", "videos"):
                    self.catalog[key] = [item for item in self.catalog[key] if item["path"] not in gone]
            # A new updatedAt makes every open page reload the library.
            self.catalog["updatedAt"] = utc_now_iso()
            self._save_state()
            seen = self._model_keys(self.seen, model)
            for path in seen:
                self.seen.pop(path)
            if seen:
                self._save_seen()
            prints = self._model_keys(self.fingerprints, model)
            for path in prints:
                self.fingerprints.pop(path)
            if prints:
                temporary = self.fingerprints_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(self.fingerprints, separators=(",", ":")), encoding="utf-8")
                temporary.replace(self.fingerprints_path)
            return pending, {"media": len(items), "trashFiles": len(trash), "wasOnDrive": folder is not None}

    def erase_detached(self, pending: Optional[Path]) -> dict:
        """Delete what detach_model set aside. If this stops halfway (drive
        unplugged), the rest stays in .heaven-trash, and Settings → Delete
        trash folder removes it."""
        freed = 0
        if pending is not None and pending.is_dir() and not pending.is_symlink():
            freed = tree_bytes(pending)[1]
            # rmtree removes links inside without following them.
            shutil.rmtree(pending)
        return {"freedBytes": freed, "freeBytes": self._free_bytes()}

    def _still_for(self, relative_path: str, info) -> Path:
        """Where a video's still is stored. The key includes size and mtime
        (which a move to the trash keeps), so a replaced file gets a fresh one."""
        key = hashlib.sha1(f"{relative_path}\0{info.st_size}\0{info.st_mtime_ns}".encode("utf-8")).hexdigest()
        return self.state_path.parent / "thumbs" / key[:2] / f"{key}.jpg"

    def _free_bytes(self):
        """Space left on the drive that holds the library, or None if unknown."""
        try:
            return shutil.disk_usage(self.media_dir).free
        except OSError:
            return None


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address, handler_class, library: MediaLibrary, simp: Optional[SimpJobs] = None):
        super().__init__(server_address, handler_class)
        self.library = library
        # Downloads: simp's config, cookies, state and job logs sit next to
        # state.json, inside the one folder the sandboxed service may write.
        # While a job runs, the model folders it writes to are added to the
        # library as files land (no full rescan, so no deck is reshuffled).
        self.simp = simp if simp is not None else SimpJobs(library.state_path.parent / "scrprsimp", add_files=library.add_new_files)
        # Wrong PINs, counted for the whole server: behind `tailscale serve`
        # every request comes from 127.0.0.1, so a per-address count is the
        # same thing. After a few free tries each miss doubles the wait.
        self.pin_failures = 0
        self.pin_blocked_until = 0.0
        self.pin_lock = threading.Lock()

    def pin_wait(self) -> int:
        return max(0, int(self.pin_blocked_until - time.monotonic() + 0.999))

    def note_pin_result(self, ok: bool) -> None:
        with self.pin_lock:
            if ok:
                self.pin_failures = 0
                self.pin_blocked_until = 0.0
                return
            self.pin_failures += 1
            if self.pin_failures >= LOCK_FREE_ATTEMPTS:
                delay = min(900, 30 * 2 ** (self.pin_failures - LOCK_FREE_ATTEMPTS))
                self.pin_blocked_until = time.monotonic() + delay


class RequestHandler(BaseHTTPRequestHandler):
    server: AppServer

    # BaseHTTPRequestHandler defaults to HTTP/1.0, which has no keep-alive:
    # the socket is torn down after every response, so each thumbnail, each
    # range request and each poll paid for a fresh TCP handshake. On loopback
    # that is invisible; over Tailscale, where a round trip is tens of
    # milliseconds and TLS sits on top, it is most of why the gallery and the
    # mosaic felt like treacle. 1.1 reuses one connection for the whole burst.
    # Every response below sends an exact Content-Length, which is what makes
    # this safe -- without it the client cannot tell where a body ends.
    protocol_version = "HTTP/1.1"

    # The flip side of keep-alive: an idle connection holds its thread until
    # somebody closes it. Browsers park several sockets per tab, so without a
    # timeout those threads accumulate for as long as the server runs.
    timeout = 120

    def log_message(self, format, *args):
        return

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, TimeoutError):
            # With keep-alive the thread sits in readline() waiting for the
            # next request on an idle socket, so every closed tab, sleeping
            # phone and dropped Tailscale link surfaces here. It is the normal
            # end of a connection, not an error; without this the journal
            # fills with tracebacks.
            self.close_connection = True

    # ---- PIN lock ----

    def _session_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            cookie = SimpleCookie(raw)
        except Exception:
            return None
        morsel = cookie.get(LOCK_COOKIE)
        return morsel.value if morsel else None

    def _unlocked(self) -> bool:
        library = self.server.library
        return not library.lock_enabled() or library.token_valid(self._session_token())

    def _allowed(self, path: str) -> bool:
        return path in PUBLIC_PATHS or bool(STATIC_JS_RE.fullmatch(path)) or self._unlocked()

    def _send_locked(self):
        self._send_json({"error": "Locked. Enter the PIN.", "locked": True}, HTTPStatus.UNAUTHORIZED)

    def _cookie_header(self, token, max_age):
        # HttpOnly: page scripts never see it. SameSite=Strict: another site
        # cannot make the browser send it along with a forged request.
        return f"{LOCK_COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict"

    def _lock_status(self):
        library = self.server.library
        return {"enabled": library.lock_enabled(), "unlocked": self._unlocked(), "retryAfter": self.server.pin_wait()}

    def _handle_lock_post(self, path, payload):
        library = self.server.library
        server = self.server
        if path == "/api/unlock":
            if not library.lock_enabled():
                self._send_json({"ok": True, **self._lock_status()})
                return
            wait = server.pin_wait()
            if wait:
                self._send_json({"error": f"Too many wrong PINs. Try again in {wait}s.", "retryAfter": wait},
                                HTTPStatus.TOO_MANY_REQUESTS)
                return
            ok = library.pin_matches(payload.get("pin"))
            server.note_pin_result(ok)
            if not ok:
                self._send_json({"error": "Wrong PIN.", "retryAfter": server.pin_wait()}, HTTPStatus.FORBIDDEN)
                return
            token = library.issue_token()
            self._send_json({"ok": True, "enabled": True, "unlocked": True},
                            extra_headers=[("Set-Cookie", self._cookie_header(token, LOCK_TOKEN_SECONDS))])
            return
        if path == "/api/lock/logout":
            library.revoke_token(self._session_token())
            self._send_json({"ok": True}, extra_headers=[("Set-Cookie", self._cookie_header("", 0))])
            return
        # Changing or removing the PIN: must be unlocked, and must know the
        # current PIN, so an unlocked phone left lying around cannot change it.
        if library.lock_enabled():
            if server.pin_wait():
                self._send_json({"error": "Too many wrong PINs. Wait and try again."}, HTTPStatus.TOO_MANY_REQUESTS)
                return
            ok = library.pin_matches(payload.get("current"))
            server.note_pin_result(ok)
            if not ok:
                self._send_json({"error": "The current PIN is wrong."}, HTTPStatus.FORBIDDEN)
                return
        if path == "/api/lock/set":
            if not library.set_pin(payload.get("pin")):
                self._send_json({"error": "A PIN is 4 to 12 digits."}, HTTPStatus.BAD_REQUEST)
                return
            token = library.issue_token()
            self._send_json({"ok": True, "enabled": True, "unlocked": True},
                            extra_headers=[("Set-Cookie", self._cookie_header(token, LOCK_TOKEN_SECONDS))])
            return
        if path == "/api/lock/clear":
            library.clear_pin()
            self._send_json({"ok": True, "enabled": False, "unlocked": True},
                            extra_headers=[("Set-Cookie", self._cookie_header("", 0))])
            return
        self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def _handle_simp(self, parsed, payload):
        """Downloads. GET status and a job's log; POST a job, a cancel, cookies.
        payload is None for a GET."""
        simp = self.server.simp
        job = SIMP_JOB_RE.fullmatch(parsed.path)
        try:
            if payload is None and parsed.path == "/api/simp/status":
                self._send_json(simp.status())
            elif payload is None and parsed.path == "/api/simp/bookmarks":
                self._send_json(simp.bookmarks())
            elif payload is None and SIMP_PREVIEW_RE.fullmatch(parsed.path):
                model, name = (unquote(part) for part in SIMP_PREVIEW_RE.fullmatch(parsed.path).groups())
                picture = simp.preview_file(model, name)
                if picture is None:
                    self._send_json({"error": "No such preview."}, HTTPStatus.NOT_FOUND)
                else:
                    self._serve_file(picture, cache_control="private, max-age=86400")
            elif payload is None and job and job.group(2) == "log":
                try:
                    offset = int(parse_qs(parsed.query).get("offset", ["0"])[0])
                except ValueError:
                    raise SimpError("Bad log offset.")
                self._send_json(simp.log(job.group(1), offset))
            elif payload is not None and parsed.path == "/api/simp/jobs":
                self._send_json({"ok": True, "job": simp.submit(payload)})
            elif payload is None and job and job.group(2) == "arrivals":
                self._send_json(simp.arrivals(job.group(1)))
            elif payload is not None and job and job.group(2) == "cancel":
                self._send_json({"ok": True, "job": simp.cancel(job.group(1))})
            elif payload is not None and parsed.path == "/api/simp/resume":
                self._send_json({"ok": True, **simp.resume()})
            elif payload is not None and parsed.path == "/api/simp/cookies":
                self._send_json({"ok": True, **simp.save_cookies(payload.get("text"))})
            else:
                self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
        except SimpError as error:
            self._send_json({"error": str(error)}, HTTPStatus(error.status))
        except OSError as error:
            self._send_json({"error": f"Could not reach simp's files: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _handle_model_reset(self, parsed, payload):
        """Settings → Remove a model. GET ?model= says what would go; POST
        {model, confirm (the name again), library, full} removes it from the
        drive, and with full also makes simp forget it. payload is None for a GET."""
        library, simp = self.server.library, self.server.simp
        model = parse_qs(parsed.query).get("model", [""])[0] if payload is None else payload.get("model")
        if not valid_model(model):
            self._send_json({"error": "Pick a model."}, HTTPStatus.BAD_REQUEST)
            return
        try:
            if payload is None:
                drive = library.model_summary(model)
                records = simp.model_records(model)
                if drive is None and not records["known"]:
                    self._send_json({"error": "Nothing is stored for this model."}, HTTPStatus.NOT_FOUND)
                    return
                self._send_json({"model": model, "drive": drive, "records": records,
                                 "busy": {"drive": simp.busy_for(model, False), "full": simp.busy_for(model, True)}})
                return
            if payload.get("confirm") != model:
                raise ValueError("Type the model's name to confirm.")
            full = payload.get("full") is True
            # Held throughout, so no download starts while the model goes.
            with simp.lock:
                busy = simp.busy_for(model, full)
                if busy:
                    raise ValueError(busy)
                pending, result = library.detach_model(model, payload.get("library"))
                result["records"] = simp.forget_model(model, full)
            result.update(library.erase_detached(pending))
            result["freedBytes"] += result["records"]["stagingBytes"]
            self._send_json({"ok": True, "model": model, "full": full, **result})
        except (OSError, ValueError, sqlite3.Error) as error:
            message = ("The drive is read-only, so nothing can be deleted from it."
                       if isinstance(error, OSError) and error.errno in {13, 30} else str(error))
            self._send_json({"error": message}, HTTPStatus.CONFLICT)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/lock":
            self._send_json(self._lock_status())
            return

        if not self._allowed(parsed.path):
            self._send_locked()
            return

        if parsed.path == "/api/marks":
            self._send_json({"marks": self.server.library.marks_payload()})
            return

        if parsed.path.startswith("/api/simp/"):
            self._handle_simp(parsed, None)
            return

        if parsed.path == "/api/model-reset":
            self._handle_model_reset(parsed, None)
            return

        if parsed.path == "/api/sessions":
            self._send_json({"sessions": self.server.library.sessions_payload()})
            return

        if parsed.path == "/api/dangerous-kept":
            self._send_json({"kept": self.server.library.dangerous_kept_payload()})
            return

        if parsed.path == "/api/fingerprints":
            self._send_json({"fingerprints": self.server.library.fingerprints_payload()})
            return

        if parsed.path == "/api/trash":
            try:
                self._send_json({"entries": self.server.library.trash_entries()})
            except (OSError, ValueError) as error:
                self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return

        if parsed.path == "/api/library-status":
            self._send_json(self.server.library.availability_payload())
            return

        if parsed.path == "/api/library-additions":
            query = parse_qs(parsed.query)
            try:
                start = int(query.get("from", ["0"])[0])
            except ValueError:
                start = 0
            result = self.server.library.additions(query.get("scan", [""])[0], start)
            if result is None:
                self._send_json({"error": "The library was rescanned. Reload it."}, HTTPStatus.CONFLICT)
                return
            self._send_json(result)
            return

        if parsed.path == "/api/state":
            self._send_json(self.server.library.state_payload())
            return

        if parsed.path == "/api/seen":
            self._send_json({"seen": self.server.library.seen_payload()})
            return

        if parsed.path == "/api/duel":
            self._send_json({"ratings": self.server.library.duel_payload()})
            return

        if parsed.path == "/media":
            query = parse_qs(parsed.query)
            relative_path = query.get("path", [None])[0]
            if not relative_path:
                self._send_json({"error": "Missing media path."}, HTTPStatus.BAD_REQUEST)
                return
            self._serve_media(relative_path)
            return

        if parsed.path == "/thumb":
            relative_path = parse_qs(parsed.query).get("path", [None])[0]
            target = self.server.library.thumb_path(relative_path) if relative_path else None
            if target is None or not target.is_file():
                # 204, not 404: "no still yet" is the normal first visit, and
                # the page makes one. A 404 would log an error per tile.
                self.send_response(HTTPStatus.NO_CONTENT)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self._serve_file(target, cache_control="private, max-age=604800")
            return

        if parsed.path == "/manifest.webmanifest":
            body = json.dumps(MANIFEST).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/manifest+json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return

        target = self._static_target(parsed.path)
        if target:
            self._serve_static(target)
            return

        self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    @staticmethod
    def _static_target(path: str) -> Optional[Path]:
        static_routes = {
            "/": "index.html",
            "/index.html": "index.html",
            "/styles.css": "styles.css",
            # The single-file frontend from before static/js existed. Kept so
            # an old page still loads during an update; 404 once it is gone.
            "/app.js": "app.js",
        }
        if path in static_routes:
            return STATIC_DIR / static_routes[path]
        # The page's scripts: plain names only, so nothing outside static/js.
        if STATIC_JS_RE.fullmatch(path):
            return STATIC_DIR / path.lstrip("/")
        return None

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if not self._allowed(parsed.path):
            self.send_error(HTTPStatus.UNAUTHORIZED)
            return
        if parsed.path == "/media":
            query = parse_qs(parsed.query)
            relative_path = query.get("path", [None])[0]
            if not relative_path:
                self.send_error(HTTPStatus.BAD_REQUEST)
                return
            self._serve_media(relative_path, send_body=False)
            return

        target = self._static_target(parsed.path)
        if target:
            self._serve_static(target, send_body=False)
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self._allowed(parsed.path):
            # Read the body anyway, or keep-alive would parse it as the next request.
            length = int(self.headers.get("Content-Length", "0") or 0)
            if 0 < length <= 1024 * 1024:
                self.rfile.read(length)
            else:
                self.close_connection = True
            self._send_locked()
            return
        if parsed.path == "/api/thumb":
            self._receive_thumb(parsed)
            return
        payload = self._read_json()
        if not isinstance(payload, dict):
            self._send_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
            return

        if parsed.path == "/api/unlock" or parsed.path.startswith("/api/lock/"):
            self._handle_lock_post(parsed.path, payload)
            return

        if parsed.path.startswith("/api/simp/"):
            self._handle_simp(parsed, payload)
            return

        if parsed.path == "/api/model-reset":
            self._handle_model_reset(parsed, payload)
            return

        if parsed.path == "/api/marks":
            spans = self.server.library.set_marks(payload.get("path"), payload.get("marks"))
            if spans is None:
                self._send_json({"error": "Marks need a video in the library and [start, end] pairs."}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"ok": True, "marks": spans})
            return

        if parsed.path == "/api/sessions":
            record = self.server.library.add_session(payload)
            if record is None:
                self._send_json({"error": "Invalid session."}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"ok": True, "session": record})
            return

        if parsed.path == "/api/dangerous-kept":
            if isinstance(payload.get("paths"), list):
                changed = self.server.library.set_dangerous_kept_many(payload["paths"], payload.get("kept"))
                self._send_json({"ok": True, "changed": changed})
                return
            if not self.server.library.set_dangerous_kept(payload.get("path"), payload.get("kept")):
                self._send_json({"error": "That file is not in the library."}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"ok": True})
            return

        if parsed.path == "/api/fingerprints":
            stored = self.server.library.save_fingerprints(payload.get("items"))
            self._send_json({"ok": True, "stored": stored})
            return

        if parsed.path == "/api/sessions-clear":
            self.server.library.clear_sessions()
            self._send_json({"ok": True})
            return

        if parsed.path in {"/api/trash", "/api/trash-many", "/api/restore", "/api/restore-many", "/api/empty-trash",
                           "/api/delete-trash-folder"}:
            try:
                if parsed.path == "/api/restore-many":
                    result = self.server.library.restore_many(payload.get("tokens"), payload.get("library"))
                elif parsed.path == "/api/trash-many":
                    result = self.server.library.trash_many(payload.get("paths"), payload.get("library"))
                elif parsed.path == "/api/empty-trash":
                    result = self.server.library.empty_trash(payload.get("library"))
                elif parsed.path == "/api/delete-trash-folder":
                    result = self.server.library.delete_trash_folder(payload.get("library"))
                elif parsed.path == "/api/trash":
                    if not isinstance(payload.get("path"), str):
                        raise ValueError("Missing media path.")
                    result = self.server.library.trash_media(payload["path"], payload.get("library"))
                else:
                    path = self.server.library.restore_media(payload.get("token"), payload.get("library"))
                    result = {"path": path, **self.server.library.restored_payload(path)}
                self._send_json({"ok": True, **result})
            except (OSError, ValueError) as error:
                message = ("This folder is read-only. Enable writing on the media drive to delete files."
                           if isinstance(error, OSError) and error.errno in {13, 30} else str(error))
                self._send_json({"error": message}, HTTPStatus.CONFLICT)
            return

        if parsed.path == "/api/rating":
            relative_path = payload.get("path")
            rating = payload.get("rating")
            if not isinstance(relative_path, str):
                self._send_json({"error": "Missing media path."}, HTTPStatus.BAD_REQUEST)
                return
            ok = self.server.library.set_rating(relative_path, rating)
            if not ok:
                self._send_json({"error": "Media item not found."}, HTTPStatus.NOT_FOUND)
                return
            self._send_json({"ok": True})
            return

        if parsed.path == "/api/seen":
            self._send_json({"ok": True, "marked": self.server.library.mark_seen(payload.get("paths"))})
            return

        if parsed.path == "/api/duel":
            result = self.server.library.record_duel(payload.get("winner"), payload.get("loser"))
            if result is None:
                self._send_json({"error": "Both files must be in the library."}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"ok": True, **result})
            return

        if parsed.path == "/api/duel-restore":
            if not self.server.library.restore_duel(payload.get("ratings")):
                self._send_json({"error": "Invalid duel ratings."}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"ok": True})
            return

        if parsed.path == "/api/settings":
            if not isinstance(payload, dict):
                self._send_json({"error": "Invalid settings payload."}, HTTPStatus.BAD_REQUEST)
                return
            settings = self.server.library.update_settings(payload)
            self._send_json({"ok": True, "settings": settings})
            return

        if parsed.path == "/api/broken":
            relative_path = payload.get("path")
            if not isinstance(relative_path, str) or not relative_path:
                self._send_json({"error": "Missing media path."}, HTTPStatus.BAD_REQUEST)
                return
            self.server.library.mark_broken(relative_path)
            self._send_json({"ok": True})
            return

        if parsed.path == "/api/clear-broken":
            cleared = self.server.library.clear_broken()
            self._send_json({"ok": True, "cleared": cleared, "state": self.server.library.state_payload()})
            return

        if parsed.path == "/api/rescan":
            self.server.library.scan()
            self._send_json({"ok": True, "library": self.server.library.library_payload()})
            return

        if parsed.path == "/api/media-dir":
            media_dir = payload.get("path")
            if not isinstance(media_dir, str):
                self._send_json({"error": "Missing media directory path."}, HTTPStatus.BAD_REQUEST)
                return
            ok, error = self.server.library.set_media_directory(media_dir)
            if not ok:
                self._send_json({"error": error or "Could not set media directory."}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"ok": True, "state": self.server.library.state_payload()})
            return

        if parsed.path == "/api/reset-ratings":
            self.server.library.clear_ratings()
            self._send_json({"ok": True, "library": self.server.library.library_payload()})
            return

        if parsed.path == "/api/reset-state":
            self.server.library.reset_saved_data()
            self._send_json({"ok": True, "state": self.server.library.state_payload()})
            return

        if parsed.path == "/api/reset-mode-data":
            mode = payload.get("mode")
            if not isinstance(mode, str):
                self._send_json({"error": "Missing mode."}, HTTPStatus.BAD_REQUEST)
                return
            ok = self.server.library.reset_mode_data(mode)
            if not ok:
                self._send_json({"error": "Unknown mode."}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"ok": True, "state": self.server.library.state_payload()})
            return

        self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def _receive_thumb(self, parsed):
        relative_path = parse_qs(parsed.query).get("path", [None])[0]
        length = int(self.headers.get("Content-Length", "0") or 0)
        if not relative_path or length <= 0 or length > THUMB_MAX_BYTES:
            # Drain what we will not store so the keep-alive stream stays in sync.
            if 0 < length <= THUMB_MAX_BYTES * 4:
                self.rfile.read(length)
            else:
                self.close_connection = True
            self._send_json({"error": "Bad thumbnail."}, HTTPStatus.BAD_REQUEST)
            return
        body = self.rfile.read(length)
        try:
            ok = self.server.library.save_thumb(relative_path, body)
        except OSError as error:
            self._send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if not ok:
            self._send_json({"error": "Not a video thumbnail."}, HTTPStatus.BAD_REQUEST)
            return
        self._send_json({"ok": True})

    def _read_json(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length == 0:
            return {}
        try:
            raw = self.rfile.read(content_length)
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _accepts_gzip(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK, extra_headers=()):
        # Compact separators first: the default ", " / ": " costs about a tenth
        # of the catalog on its own.
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        encoding = None
        # A catalog is long, repetitive text -- the case gzip is best at. It
        # was going over Tailscale uncompressed, which is most of why opening
        # the app felt slow on a phone.
        if len(body) > 1024 and self._accepts_gzip():
            body = gzip.compress(body, 6)
            encoding = "gzip"

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in extra_headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_static(self, path: Path, send_body: bool = True):
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content_type, _ = mimetypes.guess_type(path.name)
        content_type = content_type or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "text/javascript",
        }:
            content_type = f"{content_type}; charset=utf-8"

        encoding = None
        if len(body) > 1024 and self._accepts_gzip():
            body = gzip.compress(body, 6)
            encoding = "gzip"

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        # "no-cache" means "you may keep a copy, but ask me before using it".
        # Without it a phone can sit on a stale index.html/styles.css for days.
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _serve_media(self, relative_path: str, send_body: bool = True):
        file_path = self.server.library.resolve_media_path(relative_path)
        if file_path is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        # Media is addressed by path and effectively immutable for a browsing
        # session. Letting the browser keep it makes the gallery grid and
        # re-viewed clips load from disk instead of the network.
        self._serve_file(file_path, send_body=send_body, cache_control="private, max-age=3600")

    def _serve_file(self, path: Path, send_body: bool = True, cache_control: str = ""):
        try:
            stat = path.stat()
        except OSError:
            # The file was there when we resolved it and is not there now --
            # almost always the USB drive dropping out mid-browse. A 404 lets
            # the client mark the item and move on; letting OSError escape
            # would spill a traceback and drop the connection instead.
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type, _ = mimetypes.guess_type(path.name)
        content_type = content_type or "application/octet-stream"
        range_header = self.headers.get("Range")
        segments = faststart_layout(path, stat.st_size, stat.st_mtime_ns)

        if range_header:
            match = RANGE_RE.match(range_header.strip())
            if not match:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return

            start_raw, end_raw = match.groups()
            if start_raw == "" and end_raw == "":
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return

            open_ended = start_raw != "" and end_raw == ""
            if start_raw == "":
                length = int(end_raw)
                start = max(0, stat.st_size - length)
                end = stat.st_size - 1
            else:
                start = int(start_raw)
                end = int(end_raw) if end_raw else stat.st_size - 1
                # RFC 9110: an end past the last byte is clamped, not refused.
                # Players routinely ask for a round number of bytes off the end
                # of a file; answering 416 makes the clip look corrupt.
                end = min(end, stat.st_size - 1)

            # An open-ended "bytes=N-" asks for the entire rest of the file.
            # Honouring that literally means one request can start streaming
            # 700MB down a Tailscale link, saturating it while the browser is
            # still trying to fetch the bit it actually needs first (for a
            # video whose moov atom sits at the end, that is the tail). Answer
            # with a bounded slice instead; a 206 is allowed to return less
            # than was asked for, and the player simply asks for the next
            # piece when it wants it. Keep-alive makes those follow-ups cheap.
            if open_ended and end - start + 1 > OPEN_RANGE_CHUNK:
                end = start + OPEN_RANGE_CHUNK - 1

            if start > end or start >= stat.st_size:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{stat.st_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            content_length = end - start + 1
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{stat.st_size}")
            self.send_header("Content-Length", str(content_length))
            if cache_control:
                self.send_header("Cache-Control", cache_control)
            self.end_headers()

            if not send_body:
                return

            with path.open("rb") as handle:
                for chunk in read_chunks(handle, segments, start, content_length):
                    if not self._write_chunk(chunk):
                        return
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Accept-Ranges", "bytes")
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        self.end_headers()

        if not send_body:
            return

        with path.open("rb") as handle:
            for chunk in read_chunks(handle, segments, 0, stat.st_size):
                if not self._write_chunk(chunk):
                    return

    def _write_chunk(self, chunk: bytes) -> bool:
        try:
            self.wfile.write(chunk)
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            # The browser hung up mid-file (it does this constantly: seeking a
            # video abandons the range request in flight). Fewer bytes went out
            # than Content-Length promised, so this connection can no longer be
            # kept alive -- the next response would be read as part of this one.
            self.close_connection = True
            return False


def parse_args():
    parser = argparse.ArgumentParser(
        description="Edging Heaven media browser with swipe and stream modes."
    )
    parser.add_argument(
        "--media-dir",
        help="Directory containing your images and videos.",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind.")
    parser.add_argument("--port", type=int, default=8420, help="Port to bind.")
    parser.add_argument(
        "--data-dir",
        default=str(Path(__file__).parent / "data"),
        help="Directory for app state.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    media_dir = None
    if args.media_dir:
        media_dir = Path(args.media_dir).expanduser().resolve()

    data_dir = Path(args.data_dir).expanduser().resolve()
    state_path = data_dir / "state.json"
    library = MediaLibrary(media_dir, state_path)
    server = AppServer((args.host, args.port), RequestHandler, library)

    local_url = f"http://127.0.0.1:{args.port}"
    lan_url = f"http://{local_ip_address()}:{args.port}"
    if library.media_dir is not None:
        print(f"Serving {library.media_dir}")
    else:
        print("No media directory selected yet.")
        print("Open the app and choose a folder from the website.")
    print(f"Open locally: {local_url}")
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        print(f"Open on your network: {lan_url}")
    print("Press Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
