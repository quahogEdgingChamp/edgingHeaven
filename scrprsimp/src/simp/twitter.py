"""Twitter / X: a model's own posts, photos and videos, into <model>/Twitter/.

A model gets a Twitter account in state/twitter.json (Edging Heaven's
Downloads → Twitter, or a model page):

    {"<model>": {"handle": "anna", "only": "videos", "maxFiles": 40,
                 "reposts": false, "updatedAt": "..."}}

`simp twitter [model…]` reads the account's media timeline through the
FxTwitter API (api.fxtwitter.com, no login, newest posts first) and downloads
each photo and video with simp's own direct downloader. So a model's Twitter
files share its done list (state/done/<model>.jsonl: deleted stays deleted)
and its duplicate check (a photo already in the model's folder is not kept
twice).

Why not cyberdrop-dl: its Twitter crawler (10.10) skips every post
(TweetsFilterer.should_skip ends in `return True, ""`), and its search step
gets 404s. Reading the API here also knows each file's type before
downloading, so "videos only" and "at most N" are exact.

The API answers a few requests with a 404 that the same request a second
later does not get, so every page is asked for up to API_ATTEMPTS times.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from rich.console import Console

from .config import Config
from .download import ModelResult, download_direct_batch
from .filters import ONLY_CHOICES, Budget
from .hosts import MediaKind, MediaLink
from .index import DownloadIndex, index_path
from .space import DriveFull, check_space
from .util import ensure_dir, polite_sleep

console = Console(soft_wrap=True)

TWITTER_FILE = "twitter.json"
# Each model's last run: state/twitter/<model>.json
RUNS_DIR = "twitter"
SUBFOLDER = "Twitter"
API = "https://api.fxtwitter.com/2"
API_ATTEMPTS = 6
PAGE_SIZE = 100
# A timeline goes back about 3,200 posts; this is far past that.
MAX_PAGES = 200
# After a run that got to the end of the timeline once, this many pages in a
# row with nothing new end the next one: the rest is older, and already here.
QUIET_PAGES = 2

HANDLE_RE = re.compile(r"[A-Za-z0-9_]{1,15}")
# x.com/<these> are pages, not accounts.
NOT_HANDLES = frozenset({
    "home", "explore", "search", "notifications", "messages", "settings", "i", "intent", "share",
    "compose", "login", "logout", "signup", "tos", "privacy", "hashtag", "jobs", "lists", "about",
})
TWITTER_HOSTS = ("x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com", "fixvx.com", "nitter.net")


class TwitterError(Exception):
    """An account that cannot be read (missing, suspended, the API down)."""


def parse_handle(text: str | None) -> str | None:
    """'@anna', 'anna', 'https://x.com/anna/media', 'twitter.com/anna?s=20'
    → 'anna'. None for anything that is not one account."""
    text = (text or "").strip()
    if not text:
        return None
    if text.startswith("@"):
        text = text[1:]
    elif "/" in text or "." in text:
        url = urlparse(text if "://" in text else "https://" + text)
        host = (url.hostname or "").lower()
        host = host[4:] if host.startswith("www.") else host[7:] if host.startswith("mobile.") else host
        if url.scheme not in ("http", "https") or host not in TWITTER_HOSTS:
            return None
        parts = [part for part in url.path.split("/") if part]
        if not parts:
            return None
        text = parts[0]
        if text.startswith("@"):
            text = text[1:]
    if not HANDLE_RE.fullmatch(text) or text.lower() in NOT_HANDLES:
        return None
    return text


@dataclass(frozen=True)
class TwitterRule:
    handle: str
    only: str = ""  # "" photos and videos, "images", "videos"
    max_files: int = 0  # new files per run, 0 = all
    reposts: bool = False  # also posts the account reposted from others

    def describe(self) -> str:
        parts = [f"@{self.handle}"]
        if self.only:
            parts.append(f"{self.only} only")
        if self.max_files:
            parts.append(f"at most {self.max_files} new file{'' if self.max_files == 1 else 's'}")
        if self.reposts:
            parts.append("with reposts")
        return " · ".join(parts)


def twitter_rules(state_dir: Path, say=print) -> dict[str, TwitterRule]:
    """model → its Twitter account and settings. An entry that cannot be read
    is reported and left out."""
    path = state_dir / TWITTER_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        say(f"  could not read {path.name}: {exc}; no Twitter accounts used")
        return {}
    rules: dict[str, TwitterRule] = {}
    for model, entry in (raw.items() if isinstance(raw, dict) else ()):
        if not isinstance(entry, dict) or not isinstance(model, str) or not _plain_name(model):
            continue
        handle = parse_handle(entry.get("handle") if isinstance(entry.get("handle"), str) else None)
        if not handle:
            say(f"  {model}: saved Twitter account {entry.get('handle')!r} is not a handle; skipped")
            continue
        limit = entry.get("maxFiles")
        rules[model] = TwitterRule(
            handle=handle,
            only=entry.get("only") if entry.get("only") in ONLY_CHOICES else "",
            max_files=limit if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0 else 0,
            reposts=entry.get("reposts") is True,
        )
    return rules


def _plain_name(model: str) -> bool:
    """A model is one top-level folder (as Edging Heaven's valid_model)."""
    return 0 < len(model) <= 255 and "/" not in model and "\x00" not in model and not model.startswith(".")


def build_twitter_client(cfg: Config) -> httpx.Client:
    """No SimpCity cookies or Referer: those are not Twitter's business."""
    return httpx.Client(
        headers={"User-Agent": cfg.site.user_agent, "Accept": "application/json,*/*;q=0.8"},
        follow_redirects=True,
        timeout=httpx.Timeout(60.0, connect=30.0),
        http2=True,
    )


def _api(client: httpx.Client, path: str, params: dict | None = None, *, attempts: int = API_ATTEMPTS) -> dict:
    """One API answer as JSON. 404s are asked again (the API gives the odd
    false one); a real "not found" stays one and raises with its message."""
    last = ""
    for attempt in range(1, attempts + 1):
        try:
            r = client.get(f"{API}{path}", params=params)
        except httpx.TransportError as exc:
            last = exc.__class__.__name__
        else:
            try:
                body = r.json()
            except ValueError:
                body = {}
            if r.status_code == 200 and isinstance(body, dict):
                return body
            message = body.get("message") if isinstance(body, dict) else ""
            last = f"HTTP {r.status_code}" + (f": {message}" if message else "")
            if r.status_code not in (404, 429) and r.status_code < 500:
                break
        if attempt < attempts:
            polite_sleep(1.0 * attempt, 2.0 * attempt)
    raise TwitterError(last or "no answer")


def profile(client: httpx.Client, handle: str) -> dict:
    """The account (screen_name, media_count, …). Raises TwitterError."""
    try:
        body = _api(client, f"/profile/{handle}", attempts=3)
    except TwitterError as exc:
        if "not found" in str(exc).lower():
            raise TwitterError(f"@{handle} does not exist (or is suspended)") from None
        raise TwitterError(f"could not read @{handle}: {exc}") from None
    user = body.get("user")
    if not isinstance(user, dict):
        raise TwitterError(f"could not read @{handle}: {body.get('message') or 'no account in the answer'}")
    return user


def timeline(client: httpx.Client, handle: str):
    """Pages of the account's posts with media, newest first: lists of posts."""
    cursor = None
    for page in range(1, MAX_PAGES + 1):
        params = {"count": PAGE_SIZE, **({"cursor": cursor} if cursor else {})}
        try:
            body = _api(client, f"/profile/{handle}/media", params)
        except TwitterError as exc:
            raise TwitterError(f"@{handle}: page {page} of the timeline could not be read ({exc})") from None
        results = body.get("results")
        yield [post for post in results if isinstance(post, dict)] if isinstance(results, list) else []
        following = (body.get("cursor") or {}).get("bottom") if isinstance(body.get("cursor"), dict) else None
        if not following or following == cursor:
            return
        cursor = following
        polite_sleep(0.5, 1.5)


@dataclass(frozen=True)
class TwitterFile:
    key: str  # the post's permalink to this file: what the done list remembers
    url: str  # where it downloads from
    save_as: str  # Twitter/<date> <post id> <n>.<ext>
    kind: str  # "images" / "videos"


def _orig(url: str) -> str:
    """A pbs.twimg.com photo at full size (?name=orig)."""
    parts = urlparse(url)
    if parts.hostname != "pbs.twimg.com":
        return url
    query = dict(parse_qsl(parts.query))
    query["name"] = "orig"
    return urlunparse(parts._replace(query=urlencode(query)))


def _best_video(video: dict) -> str | None:
    """The highest-bitrate mp4 (never the m3u8 stream)."""
    formats = [f for f in video.get("formats") or [] if isinstance(f, dict) and isinstance(f.get("url"), str)
               and (f.get("container") == "mp4" or urlparse(f["url"]).path.endswith(".mp4"))]
    if formats:
        return max(formats, key=lambda f: f.get("bitrate") or 0)["url"]
    url = video.get("url")
    return url if isinstance(url, str) and urlparse(url).path.endswith(".mp4") else None


def _ext(url: str, default: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    return suffix if re.fullmatch(r"\.[a-z0-9]{2,5}", suffix) else default


def post_files(post: dict, handle: str, *, reposts: bool = False) -> list[TwitterFile]:
    """The photos and videos of one post, in the order the post shows them.
    A post by someone else (a repost) gives nothing unless reposts is on."""
    post_id = str(post.get("id") or "")
    if not post_id.isdigit():
        return []
    author = (post.get("author") or {}).get("screen_name") or ""
    if author.lower() != handle.lower() and not reposts:
        return []
    author = author if HANDLE_RE.fullmatch(author) else handle
    stamp = post.get("created_timestamp")
    day = datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%d") if isinstance(stamp, (int, float)) else "undated"
    media = post.get("media") or {}
    items = media.get("all")
    if not isinstance(items, list) or not items:
        items = [*(media.get("photos") or []), *(media.get("videos") or [])]
    files: list[TwitterFile] = []
    for n, item in enumerate((i for i in items if isinstance(i, dict)), 1):
        if item.get("type") == "photo" and isinstance(item.get("url"), str):
            url, kind, part, ext = _orig(item["url"]), "images", "photo", _ext(item["url"], ".jpg")
        elif item.get("type") in ("video", "gif"):
            url = _best_video(item)
            if not url:
                continue
            kind, part, ext = "videos", "video", ".mp4"
        else:
            continue
        files.append(TwitterFile(
            key=f"https://x.com/{author}/status/{post_id}/{part}/{n}",
            url=url,
            save_as=f"{SUBFOLDER}/{day} {post_id} {n}{ext}",
            kind=kind,
        ))
    return files


def runs_path(cfg: Config, model: str) -> Path:
    return cfg.resolve(cfg.paths.state_dir) / RUNS_DIR / f"{model}.json"


def _last_run(cfg: Config, model: str) -> dict:
    try:
        row = json.loads(runs_path(cfg, model).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return row if isinstance(row, dict) else {}


def _save_run(cfg: Config, model: str, row: dict) -> None:
    path = runs_path(cfg, model)
    ensure_dir(path.parent)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def twitter_model(client: httpx.Client, cfg: Config, model: str, rule: TwitterRule) -> ModelResult:
    """Download what is new on one model's account into <model>/Twitter/.

    Page by page, newest first: each page's new files download before the
    next page is read, so a limit (max_files) takes the newest. Raises
    TwitterError when the account cannot be read, DriveFull at the reserve."""
    result = ModelResult(model)
    check_space(cfg, cfg.models_root())
    user = profile(client, rule.handle)
    handle = user.get("screen_name") if HANDLE_RE.fullmatch(str(user.get("screen_name") or "")) else rule.handle
    dest = ensure_dir(cfg.models_root() / model)
    # Edging Heaven reads this line to add new files to its library as they land.
    console.print(f"Model folder: {dest}")
    console.print(f"  @{handle}: {user.get('media_count', '?')} posts with media · taking {rule.describe()}")

    index = DownloadIndex.for_model(cfg, model)
    # From now on the model has a done list, so simp's "adopt an earlier
    # download" step never runs for it (see download.adopt_existing).
    if not index_path(cfg, model).exists():
        ensure_dir(index_path(cfg, model).parent)
        index_path(cfg, model).touch()
    budget = Budget(rule.max_files) if rule.max_files else None
    last = _last_run(cfg, model)
    # Only an account this model went all the way through once, taking at
    # least what this run takes, may stop early.
    may_stop = (last.get("reachedEnd") is True and str(last.get("handle", "")).lower() == handle.lower()
                and last.get("only", "") in ("", rule.only) and (last.get("reposts") is True or not rule.reposts))
    quiet = pages = seen_files = 0
    reached_end = True
    for posts in timeline(client, handle):
        pages += 1
        files = [f for post in posts for f in post_files(post, handle, reposts=rule.reposts)]
        files = [f for f in files if not rule.only or f.kind == rule.only]
        seen_files += len(files)
        new = [f for f in files if not index.done(f.key) and not index.done(f.url) and not index.is_gone(f.key)]
        if not files:
            continue  # nothing of this type here: says nothing about what is older
        if not new:
            quiet += 1
            if may_stop and quiet >= QUIET_PAGES:
                console.print(f"  nothing new on {QUIET_PAGES} pages in a row: the rest was downloaded before")
                break
            continue
        quiet = 0
        links = [MediaLink(url=f.key, kind=MediaKind.IMAGE if f.kind == "images" else MediaKind.VIDEO, source="twitter")
                 for f in new]
        batch = download_direct_batch(client, links, dest, cfg, index, model=model, only=rule.only, budget=budget,
                                      fetch={f.key: (f.url, f.save_as) for f in new})
        result.ok += batch.ok
        result.skipped += batch.skipped + (len(files) - len(new))
        result.failed.extend(batch.failed)
        if batch.full:
            raise DriveFull(batch.full)
        if budget is not None and budget.spent():
            console.print(f"  [bold]enough new files[/] (at most {rule.max_files}): older posts are left for the next run")
            reached_end = False
            break
    else:
        reached_end = pages < MAX_PAGES

    console.print(
        f"  twitter done: [green]{result.ok} new[/] / {result.skipped} had already / "
        f"[red]{len(result.failed)} failed[/] · {pages} pages, {seen_files} files looked at"
    )
    for link, why in result.failed[:20]:
        console.print(f"    failed {link.url}: {why}", markup=False, highlight=False)
    if result.failed:
        console.print("  Failed files are not marked done: the next Twitter download tries them again.")
    _save_run(cfg, model, {
        "handle": handle,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        # Went through the whole timeline (or stopped where the rest was here
        # before), with these settings. A run cut short by the limit never
        # counts: posts it left can sit behind pages it had downloaded.
        "reachedEnd": reached_end,
        "only": rule.only,
        "reposts": rule.reposts,
        "mediaCount": user.get("media_count"),
        "new": result.ok,
        "failed": len(result.failed),
    })
    return result
