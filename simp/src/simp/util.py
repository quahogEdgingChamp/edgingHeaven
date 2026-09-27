from __future__ import annotations

import hashlib
import os
import random
import re
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

_INVALID_FS = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
_WHITESPACE = re.compile(r"\s+")


def polite_sleep(delay_min: float, delay_max: float) -> None:
    lo = max(0.0, float(delay_min))
    hi = max(lo, float(delay_max))
    time.sleep(random.uniform(lo, hi))


def sanitize_filename(name: str, max_len: int = 180) -> str:
    name = unquote(name or "").strip()
    name = _WHITESPACE.sub(" ", name)
    name = _INVALID_FS.sub("_", name).strip(" ._")
    if not name:
        name = "untitled"
    if len(name) > max_len:
        stem, ext = os.path.splitext(name)
        if len(ext) > 10:  # not a real extension — truncate the whole thing
            stem, ext = name, ""
        digest = hashlib.sha1(name.encode("utf-8", "ignore")).hexdigest()[:8]
        name = f"{stem[: max_len - len(ext) - 9]}_{digest}{ext}"
    return name


def thread_slug_from_url(url: str) -> str:
    """Turn https://host/threads/model-name.12345/ into model-name (drop .id)."""
    path = urlparse(url).path.rstrip("/")
    parts = [p for p in path.split("/") if p]
    raw = ""
    if "threads" in parts:
        idx = parts.index("threads")
        if idx + 1 < len(parts):
            raw = parts[idx + 1]
    if not raw:
        raw = parts[-1] if parts else "thread"
    # XenForo slug form: <name>.<numeric-id> — keep only the name.
    raw = re.sub(r"\.\d+$", "", raw)
    return sanitize_filename(raw)


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def looks_like_login_page(html: str) -> bool:
    low = html.lower()
    markers = (
        'name="login"',
        "data-xf-init=\"login-form\"",
        "/login/login",
        "you must be logged in",
        "must log in to continue",
    )
    return any(m in low for m in markers)


def absolute_url(base: str, href: str) -> str:
    from urllib.parse import urljoin

    return urljoin(base, href)
