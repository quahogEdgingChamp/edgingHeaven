from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from urllib.parse import urlparse

# Hosts cyberdrop-dl (and gallery-dl) usually handle well.
CDL_HOST_HINTS = (
    "bunkr.",
    "bunkrr.",
    "cyberdrop.",
    "gofile.io",
    "pixeldrain.com",
    "mega.nz",
    "mega.io",
    "saint2.",
    "saint.",
    "turbovid.",
    "turbo.cr",
    "goonbox.",
    "erome.com",
    "redgifs.com",
    "imgur.com",
    "ibb.co",
    "imagebam.com",
    "imagevenue.com",
    "imgchest.com",
    "sendvid.com",
    "streamable.com",
    "krakenfiles.com",
    "files.vc",
    "mediafire.com",
    "anonfiles.",
    "bayfiles.",
    "catbox.moe",
    "litter.catbox.moe",
    "pomf2.lain.la",
    "qiwi.gg",
    "nexusrules.online",
)

# Simple hosts we resolve/download ourselves.
DIRECT_IMAGE_HOSTS = (
    "jpg5.su",
    "jpg6.su",
    "jpg7.cr",
    "jpg4.su",
    "pixhost.to",
    "imgbox.com",
    "i.imgur.com",
    "iili.io",
    "postimg.cc",
    "simp4.",
    "simp6.",
    "selti-delivery.ru",
)

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".jfif"}
VIDEO_EXT = {".mp4", ".m4v", ".webm", ".mkv", ".mov", ".avi", ".wmv", ".ts"}
# Dropped by default; config exclude_extensions = [] keeps everything.
DEFAULT_EXCLUDE_EXT = {
    ".zip",
    ".rar",
    ".7z",
    ".tar",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".lz4",
    ".zst",
    ".cab",
    ".iso",
}


class MediaKind(str, Enum):
    IMAGE = "image"
    VIDEO = "video"
    ALBUM = "album"
    ATTACHMENT = "attachment"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class MediaLink:
    url: str
    kind: MediaKind
    source: str  # where we found it: attachment | bbimage | href | embed
    prefer_cdl: bool = False
    # 1-based XenForo thread page where this link was found (None if unknown)
    thread_page: int | None = None


def with_thread_page(link: MediaLink, page: int) -> MediaLink:
    return MediaLink(
        url=link.url,
        kind=link.kind,
        source=link.source,
        prefer_cdl=link.prefer_cdl,
        thread_page=page,
    )


_EXT_RE = re.compile(r"\.([a-z0-9]{2,5})(?:$|\?|#)", re.I)


def _ext(url: str) -> str:
    path = urlparse(url).path.lower()
    m = _EXT_RE.search(path)
    return f".{m.group(1).lower()}" if m else ""


def blocked_extensions(exclude: list[str] | set[str] | None = None) -> set[str]:
    """Normalize to lowercase '.ext'. None → defaults; an empty list means block nothing."""
    exts = DEFAULT_EXCLUDE_EXT if exclude is None else exclude
    return {e.lower() if e.startswith(".") else f".{e.lower()}" for e in exts}


def is_excluded_ext(url: str, exclude: list[str] | set[str] | None = None) -> bool:
    """True if URL path ends with an excluded extension (.zip, …)."""
    return _ext(url) in blocked_extensions(exclude)


def classify_url(
    url: str,
    source: str = "href",
    *,
    exclude_extensions: list[str] | set[str] | None = None,
) -> MediaLink | None:
    if not url or url.startswith(("javascript:", "data:", "#", "mailto:")):
        return None

    if is_excluded_ext(url, exclude_extensions):
        return None

    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    ext = _ext(url)

    # Forum attachments
    if "/attachments/" in path or "/data/attachments/" in path:
        kind = MediaKind.VIDEO if ext in VIDEO_EXT else MediaKind.IMAGE if ext in IMAGE_EXT else MediaKind.ATTACHMENT
        return MediaLink(url=url, kind=kind, source="attachment", prefer_cdl=False)

    # Direct file by extension
    if ext in IMAGE_EXT:
        return MediaLink(url=url, kind=MediaKind.IMAGE, source=source, prefer_cdl=_host_in(host, CDL_HOST_HINTS))
    if ext in VIDEO_EXT:
        return MediaLink(url=url, kind=MediaKind.VIDEO, source=source, prefer_cdl=_host_in(host, CDL_HOST_HINTS))

    # Known album / file hosts → cyberdrop-dl
    if _host_in(host, CDL_HOST_HINTS):
        kind = MediaKind.ALBUM
        if "saint" in host or "turbo" in host or "goonbox" in host or "redgifs" in host:
            kind = MediaKind.VIDEO
        return MediaLink(url=url, kind=kind, source=source, prefer_cdl=True)

    # Image hosts we handle directly
    if _host_in(host, DIRECT_IMAGE_HOSTS):
        return MediaLink(url=url, kind=MediaKind.IMAGE, source=source, prefer_cdl=False)

    return None


def _host_in(host: str, needles: tuple[str, ...]) -> bool:
    return any(n in host for n in needles)


def is_wanted(link: MediaLink, want_images: bool, want_videos: bool) -> bool:
    if link.kind == MediaKind.IMAGE:
        return want_images
    if link.kind == MediaKind.VIDEO:
        return want_videos
    if link.kind == MediaKind.ALBUM:
        return want_images or want_videos
    if link.kind == MediaKind.ATTACHMENT:
        return want_images or want_videos
    return False


def link_to_dict(link: MediaLink) -> dict:
    return {
        "url": link.url,
        "kind": link.kind.value,
        "source": link.source,
        "prefer_cdl": link.prefer_cdl,
        "thread_page": link.thread_page,
    }


def links_from_rows(
    rows: list,
    *,
    exclude_extensions: list[str] | set[str] | None = None,
) -> list[MediaLink]:
    """Rebuild links saved with link_to_dict (or bare URL strings).

    URLs are re-classified so host-list changes apply to saved state.
    """
    links: list[MediaLink] = []
    for row in rows:
        if isinstance(row, str):
            row = {"url": row}
        if not isinstance(row, dict) or not row.get("url"):
            continue
        link = classify_url(
            row["url"],
            source=row.get("source") or "href",
            exclude_extensions=exclude_extensions,
        )
        if not link:
            continue
        if row.get("thread_page"):
            link = with_thread_page(link, int(row["thread_page"]))
        links.append(link)
    return links
