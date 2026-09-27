from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from rich.console import Console
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn

from .config import Config
from .hosts import MediaKind, MediaLink, blocked_extensions, link_to_dict, links_from_rows
from .index import DownloadIndex
from .net import MEDIA_ACCEPT, ThreadClients, retry_after_seconds
from .util import ensure_dir, polite_sleep, sanitize_filename, thread_slug_from_url

console = Console()

_FILENAME_RE = re.compile(r'filename\*?=(?:UTF-8\'\')?"?([^\";]+)"?', re.I)
_HTML_TYPES = {"text/html", "application/xhtml+xml"}


def _filename_from_response(url: str, response: httpx.Response) -> str:
    cd = response.headers.get("content-disposition", "")
    m = _FILENAME_RE.search(cd)
    if m:
        return sanitize_filename(unquote(m.group(1).strip()))

    path = urlparse(str(response.url)).path
    name = unquote(path.rstrip("/").split("/")[-1] or "")
    # XenForo attachments often look like: foo.12345/  or foo-jpg.12345
    if not name or name.isdigit():
        name = unquote(urlparse(url).path.rstrip("/").split("/")[-1] or "file")
    name = sanitize_filename(name)
    if "." not in name:
        ctype = response.headers.get("content-type", "").split(";")[0].strip().lower()
        ext_map = {
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "video/mp4": ".mp4",
            "video/webm": ".webm",
            "application/pdf": ".pdf",
            "application/zip": ".zip",
        }
        name += ext_map.get(ctype, "")
    return name


def image_from_page(html: str, base: str) -> str | None:
    """Full-size image URL on an image-host viewer page (jpg5 /img/, pixhost /show/, imgbox)."""
    soup = BeautifulSoup(html, "lxml")
    for selector, attr in (
        ("img#img", "src"),  # imgbox
        ("img#image", "src"),  # pixhost
        ("meta[property='og:image']", "content"),  # jpg5 / chevereto hosts
        ("link[rel='image_src']", "href"),
    ):
        el = soup.select_one(selector)
        if el and el.get(attr):
            return urljoin(base, el[attr])
    return None


def _track_line(model: str, link: MediaLink, *, status: str, detail: str = "") -> str:
    page = f"p.{link.thread_page}" if link.thread_page else "p.?"
    host = urlparse(link.url).hostname or "?"
    extra = f" | {detail}" if detail else ""
    return (
        f"    [{status}] {model} | thread {page} | {link.kind.value} | "
        f"{link.source} | {host}{extra}"
    )


def _report(label: str, link: MediaLink, status: str, detail: str) -> tuple[str, str]:
    console.print(_track_line(label, link, status=status, detail=detail))
    if status == "fail":
        console.print(f"         {link.url}")
    return status, detail


def direct_download_one(
    client: httpx.Client,
    link: MediaLink,
    dest_dir: Path,
    cfg: Config,
    index: DownloadIndex,
    retries: int = 4,
    *,
    url: str | None = None,
    aliases: tuple[str, ...] | list[str] = (),
    model: str = "",
) -> tuple[str, str]:
    """
    Download one direct link. Returns (status, detail):
      ok / skip / fail — detail is the filename or the failure reason
      page             — link is an image-host viewer page; detail is the image URL on it

    url= fetches that URL on link's behalf (the image found on its page);
    aliases are more page links that resolved to the same image.
    """
    ensure_dir(dest_dir)
    label = model or dest_dir.name
    target = url or link.url
    record_as = list(dict.fromkeys([target, link.url, *aliases]))
    reuse = cfg.download.skip_existing

    if reuse:
        for u in record_as:
            have = index.done(u)
            if have:
                index.record(have.name, *record_as)
                return _report(label, link, "skip", have.name)

    blocked = blocked_extensions(cfg.download.exclude_extensions)
    last = ""
    for attempt in range(1, retries + 1):
        try:
            with client.stream(
                "GET",
                target,
                headers={"Accept": MEDIA_ACCEPT},
                follow_redirects=True,
                timeout=120.0,
            ) as r:
                if r.status_code == 429 or r.status_code >= 500:
                    last = f"HTTP {r.status_code}"
                    time.sleep(retry_after_seconds(r, attempt, base=5.0, cap=60.0))
                    continue
                if r.status_code >= 400:
                    return _report(label, link, "fail", f"HTTP {r.status_code}")

                ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                if ctype in _HTML_TYPES:
                    # Only image links follow their viewer page: for a video the
                    # page's og:image is just a thumbnail (fileditch, …).
                    if url is not None or link.kind != MediaKind.IMAGE:
                        return _report(label, link, "fail", "got a web page, not media")
                    r.read()
                    image = image_from_page(r.text, str(r.url))
                    if not image or image == target:
                        return _report(label, link, "fail", "web page with no image on it")
                    return "page", image

                name = _filename_from_response(target, r)
                if any(name.lower().endswith(ext) for ext in blocked):
                    return _report(label, link, "skip", f"{name} (excluded)")

                cl = r.headers.get("content-length", "")
                # Compressed bodies don't match Content-Length once decoded.
                encoded = r.headers.get("content-encoding", "identity") != "identity"
                expected = int(cl) if cl.isdigit() and not encoded else None

                name, have = index.claim(target, name, expected, reuse=reuse)
                if have:
                    index.record(name, *record_as)
                    return _report(label, link, "skip", name)

                dest = dest_dir / name
                tmp = dest_dir / (name + ".part")
                try:
                    with tmp.open("wb") as fh:
                        for chunk in r.iter_bytes(1024 * 256):
                            fh.write(chunk)
                    size = tmp.stat().st_size
                    if expected is not None and size != expected:
                        raise OSError(f"incomplete: got {size} of {expected} B")
                    tmp.replace(dest)
                except BaseException:
                    tmp.unlink(missing_ok=True)
                    index.release(name)
                    raise
                index.record(name, *record_as)
                return _report(label, link, "ok", f"{name} ({size} B)")
        except (httpx.TransportError, OSError) as exc:
            last = str(exc) or exc.__class__.__name__
            # Errno 11 / transient CDN blips — back off and retry.
            polite_sleep(0.4 * attempt, 0.8 * attempt)
        except Exception as exc:
            return _report(label, link, "fail", str(exc))
    return _report(label, link, "fail", last)


@dataclass
class DirectResult:
    ok: int = 0
    skipped: int = 0
    failed: list[tuple[MediaLink, str]] = field(default_factory=list)


def download_direct_batch(
    client: httpx.Client,
    links: list[MediaLink],
    dest_dir: Path,
    cfg: Config,
    index: DownloadIndex,
    *,
    model: str = "",
) -> DirectResult:
    """Download non-CDL links with a small thread pool."""
    res = DirectResult()
    if not links:
        return res
    workers = max(1, min(cfg.scrape.concurrency, 4))
    label = model or dest_dir.name

    def tally(status: str, detail: str, group: list[MediaLink]) -> None:
        # A group is several page links that turned out to show one image:
        # the first carries the result, the rest are duplicates of it.
        if status == "fail":
            res.failed.extend((link, detail) for link in group)
            return
        if status == "ok":
            res.ok += 1
        else:
            res.skipped += 1
        res.skipped += len(group) - 1

    with ThreadClients(client, httpx.Timeout(120.0, connect=30.0)) as clients, Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("direct downloads", total=len(links))

        def job(
            link: MediaLink, url: str | None = None, aliases: list[str] | None = None
        ) -> tuple[str, str]:
            polite_sleep(0.05, 0.25)
            return direct_download_one(
                clients.get(), link, dest_dir, cfg, index,
                url=url, aliases=aliases or [], model=label,
            )

        with ThreadPoolExecutor(max_workers=workers) as pool:
            # Pass 1: every link. Viewer pages only report the image they show;
            # pass 2 fetches those after the direct images are on disk, so a page
            # and the thumbnail it duplicates can't race into two copies.
            pages: dict[str, list[MediaLink]] = {}
            futures = {pool.submit(job, link): link for link in links}
            for fut in as_completed(futures):
                link = futures[fut]
                status, detail = fut.result()
                if status == "page":
                    pages.setdefault(detail, []).append(link)
                    continue
                tally(status, detail, [link])
                progress.advance(task)

            groups = {
                pool.submit(job, group[0], image, [l.url for l in group[1:]]): group
                for image, group in pages.items()
            }
            for fut in as_completed(groups):
                group = groups[fut]
                status, detail = fut.result()
                tally(status, detail, group)
                progress.advance(task, len(group))

    return res


def export_url_list(path: Path, urls: list[str]) -> None:
    ensure_dir(path.parent)
    path.write_text("\n".join(urls) + ("\n" if urls else ""), encoding="utf-8")


def cdl_paths(cfg: Config) -> dict[str, Path]:
    """Project-local cyberdrop-dl paths (not ~/.local)."""
    root = ensure_dir(cfg.resolve(cfg.paths.cdl_dir))
    logs = ensure_dir(root / "logs")
    return {
        "root": root,
        "db": root / "cyberdrop.db",
        "cache": root / "cache.json",
        "logs": logs,
        "log_main": logs / "downloader.log",
        "log_download_errors": logs / "download_errors.csv",
        "log_scrape_errors": logs / "scrape_errors.csv",
        "log_unsupported": logs / "unsupported_urls.csv",
        "log_dedupe": logs / "dedupe.csv",
    }


def cdl_exclude_regex(exclude: list[str] | None) -> str | None:
    """cyberdrop-dl --filename-regex-exclude for the configured extensions (None = keep all)."""
    exts = sorted(e.lstrip(".") for e in blocked_extensions(exclude))
    if not exts:
        return None
    # (\.|$) also catches split archives like .7z.001
    return r"(?i)\.(" + "|".join(re.escape(e) for e in exts) + r")(\.|$)"


def run_cyberdrop_dl(cfg: Config, urls_file: Path, download_dir: Path) -> int:
    """Invoke cyberdrop-dl on a URL list. Returns process exit code."""
    bin_name = cfg.download.cyberdrop_dl_bin
    resolved = shutil.which(bin_name) or shutil.which("cyberdrop-dl-patched") or shutil.which("cyberdrop")
    if not resolved:
        console.print(
            "[yellow]cyberdrop-dl not found on PATH.[/]\n"
            "  Install:  pipx install cyberdrop-dl-patched\n"
            "  Or set download.use_cyberdrop_dl = false to skip."
        )
        return 127

    ensure_dir(download_dir)
    paths = cdl_paths(cfg)
    # CDL requires --cache-file / log paths to already exist (errors out otherwise).
    if not paths["cache"].is_file():
        paths["cache"].write_text("{}", encoding="utf-8")
    for log_path in (
        paths["log_main"],
        paths["log_download_errors"],
        paths["log_scrape_errors"],
        paths["log_unsupported"],
        paths["log_dedupe"],
    ):
        if not log_path.is_file():
            log_path.touch()
    if not paths["db"].is_file():
        paths["db"].touch()

    # Keep db/cache/logs inside the project instead of ~/.local/share/cyberdrop-dl
    cmd = [
        resolved,
        "download",
        "-i",
        str(urls_file),
        "-o",
        str(download_dir),
        "--db",
        str(paths["db"]),
        "--cache-file",
        str(paths["cache"]),
        "--logs.folder",
        str(paths["logs"]),
        "--log-file",
        str(paths["log_main"]),
        "--logs.files.download-errors",
        str(paths["log_download_errors"]),
        "--logs.files.scrape-errors",
        str(paths["log_scrape_errors"]),
        "--logs.files.unsupported",
        str(paths["log_unsupported"]),
        "--logs.files.dedupe",
        str(paths["log_dedupe"]),
        "--ui",
        "disabled",
        "--subfolders.no-create",
        # Skip archives / non-media inside host albums
        "--no-non-media",
        "--logs.console-level",
        "WARNING",
        "--logs.level",
        "INFO",
        "--logs.no-http-traffic",
    ]
    exclude = cdl_exclude_regex(cfg.download.exclude_extensions)
    if exclude:
        cmd.extend(["--filename-regex-exclude", exclude])
    cookies = cfg.resolve(cfg.auth.cookies_file)
    if cookies.is_file():
        cmd.extend(["--cookies", str(cookies)])
    console.print(f"[bold]Running[/] {' '.join(cmd)}")
    try:
        proc = subprocess.run(cmd, check=False)
        return proc.returncode
    except FileNotFoundError:
        console.print(f"[red]Could not execute {resolved}[/]")
        return 127


def partition_links(links: list[MediaLink]) -> tuple[list[MediaLink], list[MediaLink]]:
    """Split into (cdl_links, direct_links)."""
    cdl: list[MediaLink] = []
    direct: list[MediaLink] = []
    for link in links:
        if link.prefer_cdl:
            cdl.append(link)
        else:
            direct.append(link)
    return cdl, direct


def model_folder(cfg: Config, thread_url: str, title: str = "") -> Path:
    """Always name folders from the URL slug (model-name), never 'Thread …'.

    Layout:
      whereto.txt set  → <whereto>/<models_subdir>/<slug>/
      otherwise        → <download_dir>/<slug>/   (default: ./downloads/<slug>/)
    """
    slug = thread_slug_from_url(thread_url)
    return ensure_dir(cfg.models_root() / slug)


def _queue_cdl(cfg: Config, slug: str, cdl_links: list[MediaLink]) -> Path:
    """Write state/cdl_<slug>.txt (+ .jsonl provenance sidecar) for cyberdrop-dl."""
    state = ensure_dir(cfg.resolve(cfg.paths.state_dir))
    per_thread = state / f"cdl_{slug}.txt"
    export_url_list(per_thread, [l.url for l in cdl_links])
    # Sidecar with thread-page provenance for host URLs (CDL can't print this).
    meta = state / f"cdl_{slug}.jsonl"
    with meta.open("w", encoding="utf-8") as fh:
        for link in cdl_links:
            fh.write(
                json.dumps(
                    {
                        "model": slug,
                        "thread_page": link.thread_page,
                        "kind": link.kind.value,
                        "source": link.source,
                        "url": link.url,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    console.print(
        f"  queued {len(cdl_links)} host URLs for cyberdrop-dl ({per_thread.name})"
    )
    # One tracking line per host URL so you can grep thread pages.
    for link in cdl_links:
        console.print(_track_line(slug, link, status="cdl", detail=link.url[:80]))
    return per_thread


@dataclass
class ModelResult:
    slug: str
    ok: int = 0
    skipped: int = 0
    failed: list[tuple[MediaLink, str]] = field(default_factory=list)
    cdl_exit: int | None = None  # None = cyberdrop-dl not run

    @property
    def cdl_failed(self) -> bool:
        return self.cdl_exit not in (None, 0)


def failed_path(cfg: Config, slug: str) -> Path:
    return cfg.resolve(cfg.paths.state_dir) / "failed" / f"{slug}.jsonl"


def failed_slugs(cfg: Config) -> list[str]:
    folder = cfg.resolve(cfg.paths.state_dir) / "failed"
    return sorted(p.stem for p in folder.glob("*.jsonl")) if folder.is_dir() else []


def write_failures(cfg: Config, thread_url: str, result: ModelResult) -> None:
    """Record what failed for `simp retry`; remove the file once nothing has."""
    path = failed_path(cfg, result.slug)
    rows = [
        {"via": "direct", "thread": thread_url, "reason": reason, **link_to_dict(link)}
        for link, reason in result.failed
    ]
    if result.cdl_failed:
        rows.append({"via": "cdl", "thread": thread_url, "exit": result.cdl_exit})
    if not rows:
        path.unlink(missing_ok=True)
        return
    ensure_dir(path.parent)
    path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
    )


def _run_direct(
    client: httpx.Client,
    cfg: Config,
    slug: str,
    dest: Path,
    links: list[MediaLink],
    result: ModelResult,
) -> None:
    console.print(f"  direct: {len(links)} files → {dest}")
    index = DownloadIndex.for_model(cfg, slug)
    d = download_direct_batch(client, links, dest, cfg, index, model=slug)
    result.ok, result.skipped, result.failed = d.ok, d.skipped, d.failed
    console.print(
        f"  direct done: [green]{d.ok} ok[/] / {d.skipped} skipped / "
        f"[red]{len(d.failed)} fail[/]"
    )


def _run_cdl(cfg: Config, urls_file: Path, dest: Path, result: ModelResult) -> None:
    console.print(f"  cyberdrop-dl → {dest}")
    result.cdl_exit = run_cyberdrop_dl(cfg, urls_file, dest)
    if result.cdl_failed:
        console.print(
            f"  [yellow]cyberdrop-dl exited {result.cdl_exit}.[/] "
            f"URLs kept in {urls_file} — `simp retry {result.slug}` reruns it"
        )


def download_model(
    client: httpx.Client,
    thread_url: str,
    title: str,
    links: list[MediaLink],
    cfg: Config,
) -> ModelResult:
    """Direct downloads, then cyberdrop-dl, into the model's folder."""
    slug = thread_slug_from_url(thread_url)
    dest = model_folder(cfg, thread_url, title)
    result = ModelResult(slug)
    cdl_links, direct_links = partition_links(links)

    if cfg.download.use_direct and direct_links:
        _run_direct(client, cfg, slug, dest, direct_links, result)
    if cdl_links:
        urls_file = _queue_cdl(cfg, slug, cdl_links)
        if cfg.download.use_cyberdrop_dl:
            _run_cdl(cfg, urls_file, dest, result)

    write_failures(cfg, thread_url, result)
    return result


def retry_model(client: httpx.Client, cfg: Config, slug: str) -> ModelResult:
    """Re-run whatever state/failed/<slug>.jsonl lists."""
    path = failed_path(cfg, slug)
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    thread_url = next((r["thread"] for r in rows if r.get("thread")), "")
    dest = ensure_dir(cfg.models_root() / slug)
    result = ModelResult(slug)

    direct = links_from_rows(
        [r for r in rows if r.get("via") == "direct"],
        exclude_extensions=cfg.download.exclude_extensions,
    )
    if direct:
        _run_direct(client, cfg, slug, dest, direct, result)

    cdl_row = next((r for r in rows if r.get("via") == "cdl"), None)
    if cdl_row:
        urls_file = cfg.resolve(cfg.paths.state_dir) / f"cdl_{slug}.txt"
        if cfg.download.use_cyberdrop_dl and urls_file.is_file():
            _run_cdl(cfg, urls_file, dest, result)
        else:
            result.cdl_exit = cdl_row.get("exit", 1)  # couldn't rerun — keep it listed

    write_failures(cfg, thread_url, result)
    return result
