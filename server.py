#!/usr/bin/env python3
import argparse
import json
import mimetypes
import os
import re
import socket
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse


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
    "unratedOnly": False,
    "toktinderUnratedOnly": False,
    "photoInterval": 14,
    "videoCount": 2,
    "videoVolume": 0.18,
    "clipStartMode": "random",
    "clipStartSeconds": 0,
    "theme": "velvet",
    "swipeFolders": [],
    "toktinderFolders": [],
    "streamFolders": [],
}

STATIC_DIR = Path(__file__).parent / "static"
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


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
        self.catalog = {"images": [], "videos": [], "updatedAt": None}
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
        return {
            "ratings": loaded.get("ratings", {}),
            "settings": {**DEFAULT_SETTINGS, **loaded.get("settings", {})},
            "mediaDirectory": loaded.get("mediaDirectory"),
        }

    def _save_state(self) -> None:
        payload = {
            "ratings": self.state["ratings"],
            "settings": self.state["settings"],
            "mediaDirectory": self.state.get("mediaDirectory"),
        }
        self._write_state_payload(payload)

    def _write_state_payload(self, payload: dict) -> None:
        with self.state_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)

    def scan(self) -> None:
        if self.media_dir is None or not self.media_dir.exists() or not self.media_dir.is_dir():
            with self.lock:
                self.catalog = {"images": [], "videos": [], "updatedAt": None}
                self._save_state()
            return

        images = []
        videos = []

        for file_path in sorted(self.media_dir.rglob("*")):
            if not file_path.is_file():
                continue

            ext = file_path.suffix.lower()
            if ext not in IMAGE_EXTENSIONS and ext not in VIDEO_EXTENSIONS:
                continue

            relative_path = file_path.relative_to(self.media_dir).as_posix()
            folder = ""
            if file_path.parent != self.media_dir:
                folder = file_path.parent.relative_to(self.media_dir).as_posix()

            payload = {
                "path": relative_path,
                "name": file_path.name,
                "folder": folder,
                "size": file_path.stat().st_size,
                "rating": self.state["ratings"].get(relative_path),
            }

            if ext in IMAGE_EXTENSIONS:
                images.append(payload)
            else:
                videos.append(payload)

        with self.lock:
            self.catalog = {
                "images": images,
                "videos": videos,
                "updatedAt": utc_now_iso(),
            }
            self._save_state()

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
                "counts": {
                    "images": len(self.catalog["images"]),
                    "videos": len(self.catalog["videos"]),
                    "liked": sum(
                        1 for item in all_items if item.get("rating") == "like"
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
        with self.lock:
            return {
                "library": self.library_payload(),
                "settings": dict(self.state["settings"]),
                "mediaDirectory": self.state.get("mediaDirectory"),
                "libraryReady": self.media_dir is not None,
                "mediaChoices": suggested_media_directories(),
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

        self.scan()
        return True, None

    def set_rating(self, relative_path: str, rating: Optional[str]) -> bool:
        if rating not in {None, "like", "dislike"}:
            return False

        with self.lock:
            found = False
            for item in [*self.catalog["images"], *self.catalog["videos"]]:
                if item["path"] == relative_path:
                    item["rating"] = rating
                    found = True
                    break

            if not found:
                return False

            if rating is None:
                self.state["ratings"].pop(relative_path, None)
            else:
                self.state["ratings"][relative_path] = rating

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

    def clear_ratings(self) -> None:
        with self.lock:
            self.state["ratings"] = {}
            for item in [*self.catalog["images"], *self.catalog["videos"]]:
                item["rating"] = None
            self._save_state()

    def reset_saved_data(self) -> None:
        with self.lock:
            self.media_dir = None
            self.catalog = {"images": [], "videos": [], "updatedAt": None}
            self.state["ratings"] = {}
            self.state["settings"] = dict(DEFAULT_SETTINGS)
            self.state["mediaDirectory"] = None
            self._write_state_payload({})

    def reset_mode_data(self, mode: str) -> bool:
        with self.lock:
            if mode == "swipe":
                for item in self.catalog["images"]:
                    item["rating"] = None
                    self.state["ratings"].pop(item["path"], None)
            elif mode == "toktinder":
                for item in self.catalog["videos"]:
                    item["rating"] = None
                    self.state["ratings"].pop(item["path"], None)
            else:
                return False

            self._save_state()
            return True

    def resolve_media_path(self, relative_path: str) -> Optional[Path]:
        if self.media_dir is None:
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


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address, handler_class, library: MediaLibrary):
        super().__init__(server_address, handler_class)
        self.library = library


class RequestHandler(BaseHTTPRequestHandler):
    server: AppServer

    def log_message(self, format, *args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/state":
            self._send_json(self.server.library.state_payload())
            return

        if parsed.path == "/media":
            query = parse_qs(parsed.query)
            relative_path = query.get("path", [None])[0]
            if not relative_path:
                self._send_json({"error": "Missing media path."}, HTTPStatus.BAD_REQUEST)
                return
            self._serve_media(relative_path)
            return

        static_routes = {
            "/": "index.html",
            "/index.html": "index.html",
            "/app.js": "app.js",
            "/styles.css": "styles.css",
        }
        target = static_routes.get(parsed.path)
        if target:
            self._serve_static(STATIC_DIR / target)
            return

        self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path == "/media":
            query = parse_qs(parsed.query)
            relative_path = query.get("path", [None])[0]
            if not relative_path:
                self.send_error(HTTPStatus.BAD_REQUEST)
                return
            self._serve_media(relative_path, send_body=False)
            return

        static_routes = {
            "/": "index.html",
            "/index.html": "index.html",
            "/app.js": "app.js",
            "/styles.css": "styles.css",
        }
        target = static_routes.get(parsed.path)
        if target:
            self._serve_static(STATIC_DIR / target, send_body=False)
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        parsed = urlparse(self.path)
        payload = self._read_json()
        if payload is None:
            self._send_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
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

        if parsed.path == "/api/settings":
            if not isinstance(payload, dict):
                self._send_json({"error": "Invalid settings payload."}, HTTPStatus.BAD_REQUEST)
                return
            settings = self.server.library.update_settings(payload)
            self._send_json({"ok": True, "settings": settings})
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

    def _read_json(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length == 0:
            return {}
        try:
            raw = self.rfile.read(content_length)
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path: Path, send_body: bool = True):
        if not path.exists():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self._serve_file(path, send_body=send_body)

    def _serve_media(self, relative_path: str, send_body: bool = True):
        file_path = self.server.library.resolve_media_path(relative_path)
        if file_path is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self._serve_file(file_path, send_body=send_body)

    def _serve_file(self, path: Path, send_body: bool = True):
        stat = path.stat()
        content_type, _ = mimetypes.guess_type(path.name)
        content_type = content_type or "application/octet-stream"
        range_header = self.headers.get("Range")

        if range_header:
            match = RANGE_RE.match(range_header.strip())
            if not match:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return

            start_raw, end_raw = match.groups()
            if start_raw == "" and end_raw == "":
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return

            if start_raw == "":
                length = int(end_raw)
                start = max(0, stat.st_size - length)
                end = stat.st_size - 1
            else:
                start = int(start_raw)
                end = int(end_raw) if end_raw else stat.st_size - 1

            if start > end or end >= stat.st_size:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return

            content_length = end - start + 1
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{stat.st_size}")
            self.send_header("Content-Length", str(content_length))
            self.end_headers()

            if not send_body:
                return

            with path.open("rb") as handle:
                handle.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = handle.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    if not self._write_chunk(chunk):
                        return
                    remaining -= len(chunk)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

        if not send_body:
            return

        with path.open("rb") as handle:
            while True:
                chunk = handle.read(64 * 1024)
                if not chunk:
                    break
                if not self._write_chunk(chunk):
                    return

    def _write_chunk(self, chunk: bytes) -> bool:
        try:
            self.wfile.write(chunk)
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
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
        if not media_dir.exists() or not media_dir.is_dir():
            raise SystemExit(f"Media directory does not exist: {media_dir}")

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
