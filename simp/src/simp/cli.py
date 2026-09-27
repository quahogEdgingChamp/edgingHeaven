from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from rich.console import Console
from rich.table import Table

from .auth import assert_logged_in, build_client
from .bookmarks import Bookmark, collect_targets
from .config import Config, load_config
from .download import (
    ModelResult,
    download_model,
    export_url_list,
    failed_slugs,
    retry_model,
)
from .estimate import estimate_models
from .hosts import MediaLink, link_to_dict, links_from_rows
from .thread import crawl_thread
from .util import ensure_dir, polite_sleep

console = Console()


def _add_bookmark_page_args(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--page",
        type=int,
        default=None,
        help="Only this bookmarks list page (1-based). Example: --page 3",
    )
    p.add_argument(
        "--pages",
        type=str,
        default=None,
        help="Bookmark list pages to use: 3 | 2-4 | 1,3,8 (default: all)",
    )
    p.add_argument("--limit", type=int, default=0, help="Stop after N model threads (0=all)")
    p.add_argument(
        "--no-estimate",
        action="store_true",
        help="Skip post-crawl size estimate (HEAD probes)",
    )
    _add_full_crawl_arg(p)


def _add_full_crawl_arg(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--full-crawl",
        action="store_true",
        help="Re-crawl threads from page 1 instead of resuming at the last page seen",
    )


def _pages_arg(args: argparse.Namespace) -> str | int | None:
    # --page wins if both given; --pages accepts ranges/lists.
    if getattr(args, "page", None):
        return args.page
    return getattr(args, "pages", None)


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="simp",
        description="Download images/videos for every model in your SimpCity bookmarks.",
    )
    p.add_argument(
        "-c",
        "--config",
        type=Path,
        default=None,
        help="Path to config.toml (default: ./config.toml)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    login = sub.add_parser("check-auth", help="Verify cookies / browser session")
    login.set_defaults(func=cmd_check_auth)

    bm = sub.add_parser("bookmarks", help="List / export bookmarked model threads")
    bm.add_argument("--json", action="store_true", help="Print JSON")
    _add_bookmark_page_args(bm)
    bm.set_defaults(func=cmd_bookmarks)

    scrape = sub.add_parser(
        "scrape",
        help="Crawl bookmarked threads and export media URLs (no download)",
    )
    _add_bookmark_page_args(scrape)
    scrape.set_defaults(func=cmd_scrape)

    dl = sub.add_parser(
        "download",
        help="Full pipeline: bookmarks → crawl → cyberdrop-dl + direct download",
    )
    _add_bookmark_page_args(dl)
    dl.add_argument(
        "--skip-crawl",
        action="store_true",
        help="Reuse state/media_urls.jsonl from a previous scrape",
    )
    dl.set_defaults(func=cmd_download)

    one = sub.add_parser(
        "thread",
        help="Scrape + download one or more thread URLs (sequential, one after another)",
    )
    one.add_argument(
        "urls",
        nargs="+",
        help="One or more https://simpcity…/threads/model-name.id/ URLs",
    )
    one.add_argument(
        "--title",
        default="",
        help="Folder name override (only applies when a single URL is given)",
    )
    one.add_argument(
        "--no-estimate",
        action="store_true",
        help="Skip size estimate (HEAD probes)",
    )
    _add_full_crawl_arg(one)
    one.set_defaults(func=cmd_thread)

    retry = sub.add_parser(
        "retry",
        help="Re-run failed downloads recorded in state/failed/ (all models, or the ones named)",
    )
    retry.add_argument("models", nargs="*", help="Model slugs (folder names); default: all")
    retry.set_defaults(func=cmd_retry)

    from .clear import CLEAR_TARGETS

    clr = sub.add_parser(
        "clear",
        help="Clear project-local state (CDL history, crawl cache, downloads, …)",
    )
    clr.add_argument(
        "targets",
        nargs="*",
        choices=list(CLEAR_TARGETS),
        help="What to clear (omit to list). Pick any of: " + ", ".join(CLEAR_TARGETS),
    )
    clr.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Required for destructive targets (downloads, state)",
    )
    clr.set_defaults(func=cmd_clear)

    return p


def cmd_check_auth(args: argparse.Namespace, cfg: Config) -> int:
    with build_client(cfg) as client:
        assert_logged_in(client, cfg)
    console.print("[green]Session OK — logged into SimpCity.[/]")
    return 0


def cmd_bookmarks(args: argparse.Namespace, cfg: Config) -> int:
    with build_client(cfg) as client:
        assert_logged_in(client, cfg)
        bookmarks = collect_targets(
            client,
            cfg,
            limit=getattr(args, "limit", 0) or 0,
            pages=_pages_arg(args),
        )

    export_path = cfg.resolve(cfg.paths.urls_export)
    export_url_list(export_path, [b.url for b in bookmarks])
    console.print(f"Wrote {len(bookmarks)} URLs → {export_path}")

    if args.json:
        print(json.dumps([b.__dict__ for b in bookmarks], indent=2, ensure_ascii=False))
        return 0

    table = Table(title="Bookmarked models")
    table.add_column("#", style="dim", width=4)
    table.add_column("Title")
    table.add_column("URL", overflow="fold")
    for i, b in enumerate(bookmarks, 1):
        table.add_row(str(i), b.title, b.url)
    console.print(table)
    return 0


def _crawl_all(
    cfg: Config,
    bookmarks: list[Bookmark],
    *,
    full: bool = False,
) -> list[tuple[Bookmark, list[MediaLink]]]:
    results: list[tuple[Bookmark, list[MediaLink]]] = []
    state = ensure_dir(cfg.resolve(cfg.paths.state_dir))
    jsonl = state / "media_urls.jsonl"
    flat_urls: list[str] = []

    # Written thread by thread so an interrupted crawl keeps what it got.
    with build_client(cfg) as client, jsonl.open("w", encoding="utf-8") as fh:
        assert_logged_in(client, cfg)
        for i, bm in enumerate(bookmarks, 1):
            console.print(f"[bold]({i}/{len(bookmarks)})[/] {bm.title}")
            try:
                links = crawl_thread(client, bm.url, cfg, full=full)
            except Exception as exc:
                console.print(f"  [red]crawl failed:[/] {exc}")
                links = []
            results.append((bm, links))
            row = {
                "title": bm.title,
                "thread": bm.url,
                "media": [link_to_dict(l) for l in links],
                # legacy flat fields kept for older tooling
                "kinds": [l.kind.value for l in links],
            }
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
            flat_urls.extend(l.url for l in links)
            if i < len(bookmarks):
                polite_sleep(cfg.scrape.delay_min, cfg.scrape.delay_max)

    export_url_list(cfg.resolve(cfg.paths.media_export), flat_urls)
    console.print(f"[green]Saved crawl state → {jsonl}[/]")
    return results


def _estimate(cfg: Config, results: list[tuple[Bookmark, list[MediaLink]]]) -> None:
    with build_client(cfg) as client:
        estimate_models(client, [(bm.url, links) for bm, links in results], cfg)


def _summarize(results: list[ModelResult]) -> int:
    """Print totals across models; exit code 1 if anything failed."""
    ok = sum(r.ok for r in results)
    skipped = sum(r.skipped for r in results)
    failed = sum(len(r.failed) for r in results)
    cdl_failed = [r.slug for r in results if r.cdl_failed]
    console.print(
        f"[bold]Summary:[/] {len(results)} model(s) · [green]{ok} downloaded[/] · "
        f"{skipped} already had · [red]{failed} failed[/] (direct)"
    )
    if cdl_failed:
        console.print(f"  [red]cyberdrop-dl failed for:[/] {', '.join(cdl_failed)}")
    if failed or cdl_failed:
        console.print("  Retry with: [bold]simp retry[/]  (lists in state/failed/)")
        return 1
    return 0


def cmd_scrape(args: argparse.Namespace, cfg: Config) -> int:
    with build_client(cfg) as client:
        assert_logged_in(client, cfg)
        bookmarks = collect_targets(
            client, cfg, limit=args.limit, pages=_pages_arg(args)
        )
    export_url_list(cfg.resolve(cfg.paths.urls_export), [b.url for b in bookmarks])
    results = _crawl_all(cfg, bookmarks, full=args.full_crawl)
    total = sum(len(links) for _, links in results)
    if not args.no_estimate and results:
        _estimate(cfg, results)
    console.print(f"[bold green]Done.[/] {len(results)} threads, {total} media URLs.")
    return 0


def cmd_download(args: argparse.Namespace, cfg: Config) -> int:
    if args.skip_crawl:
        jsonl = cfg.resolve(cfg.paths.state_dir) / "media_urls.jsonl"
        if not jsonl.is_file():
            console.print(f"[red]No crawl state at {jsonl}. Run scrape first.[/]")
            return 1
        results: list[tuple[Bookmark, list[MediaLink]]] = []
        for line in jsonl.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            bm = Bookmark(url=row["thread"], title=row.get("title") or "")
            links = links_from_rows(
                row.get("media", []), exclude_extensions=cfg.download.exclude_extensions
            )
            results.append((bm, links))
        if args.limit and args.limit > 0:
            results = results[: args.limit]
    else:
        with build_client(cfg) as client:
            assert_logged_in(client, cfg)
            bookmarks = collect_targets(
                client, cfg, limit=args.limit, pages=_pages_arg(args)
            )
        export_url_list(cfg.resolve(cfg.paths.urls_export), [b.url for b in bookmarks])
        results = _crawl_all(cfg, bookmarks, full=args.full_crawl)

    if not args.no_estimate and results:
        _estimate(cfg, results)

    from .util import thread_slug_from_url

    done: list[ModelResult] = []
    with build_client(cfg) as client:
        for i, (bm, links) in enumerate(results, 1):
            slug = thread_slug_from_url(bm.url)
            console.print(f"[bold]download ({i}/{len(results)})[/] {slug}  ({bm.title})")
            if not links:
                console.print("  (no media)")
                continue
            done.append(download_model(client, bm.url, bm.title, links, cfg))

    console.print("[bold green]Pipeline finished.[/]")
    return _summarize(done)


def cmd_thread(args: argparse.Namespace, cfg: Config) -> int:
    urls: list[str] = list(args.urls)
    done: list[ModelResult] = []
    with build_client(cfg) as client:
        assert_logged_in(client, cfg)
        for i, url in enumerate(urls, 1):
            title = args.title if len(urls) == 1 else ""
            console.print(
                f"[bold]thread ({i}/{len(urls)})[/] {url}"
            )
            try:
                links = crawl_thread(client, url, cfg, full=args.full_crawl)
            except Exception as exc:
                console.print(f"  [red]crawl failed:[/] {exc}")
                continue
            if links and not args.no_estimate:
                estimate_models(client, [(url, links)], cfg)
            done.append(download_model(client, url, title, links, cfg))
    return _summarize(done)


def cmd_retry(args: argparse.Namespace, cfg: Config) -> int:
    available = failed_slugs(cfg)
    slugs = list(args.models) or available
    unknown = [m for m in slugs if m not in available]
    if unknown:
        console.print(f"[yellow]nothing recorded as failed for:[/] {', '.join(unknown)}")
    slugs = [m for m in slugs if m in available]
    if not slugs:
        console.print("[green]No failed downloads to retry.[/]")
        return 0
    done: list[ModelResult] = []
    with build_client(cfg) as client:
        for i, slug in enumerate(slugs, 1):
            console.print(f"[bold]retry ({i}/{len(slugs)})[/] {slug}")
            done.append(retry_model(client, cfg, slug))
    return _summarize(done)


def cmd_clear(args: argparse.Namespace, cfg: Config) -> int:
    from .clear import clear_target, print_clear_menu

    targets: list[str] = list(args.targets or [])
    if not targets:
        print_clear_menu(cfg)
        return 0

    destructive = {"downloads", "state"}
    need_yes = destructive.intersection(targets)
    if need_yes and not args.yes:
        console.print(
            f"[red]Refusing to clear {', '.join(sorted(need_yes))} without --yes[/]"
        )
        return 2

    for name in targets:
        removed = clear_target(cfg, name)
        if removed:
            console.print(f"[green]cleared {name}:[/]")
            for line in removed:
                console.print(f"  - {line}")
        else:
            console.print(f"[dim]cleared {name}: nothing to remove[/]")
    return 0


def main(argv: list[str] | None = None) -> None:
    parser = _parser()
    args = parser.parse_args(argv)
    cfg = load_config(args.config)
    ensure_dir(cfg.resolve(cfg.paths.state_dir))
    if args.cmd in {"download", "thread", "retry"}:
        whereto = cfg.read_whereto()
        # Only create the whereto folder itself, never its parents: a missing
        # parent means the drive isn't mounted.
        if whereto is not None and not whereto.exists() and not whereto.parent.is_dir():
            console.print(
                f"[red]Download folder {whereto} isn't available — is the drive mounted?[/]"
            )
            sys.exit(2)
        try:
            ensure_dir(cfg.models_root())
        except OSError as exc:
            console.print(f"[red]Can't create download folder: {exc}[/]")
            sys.exit(2)
    if args.cmd in {"download", "thread", "scrape"}:
        whereto = cfg.read_whereto()
        if whereto is not None:
            console.print(
                f"[dim]whereto.txt →[/] {cfg.models_root()}/<model>/"
            )
        else:
            console.print(
                f"[dim]download dir →[/] {cfg.models_root()}/<model>/  "
                f"(set a path in {cfg.paths.whereto_file} to override)"
            )
    try:
        code = args.func(args, cfg)
    except (OSError, RuntimeError) as exc:
        console.print(f"[red]{exc}[/]")
        code = 2
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted.[/]")
        code = 130
    sys.exit(code)


if __name__ == "__main__":
    main()
