from __future__ import annotations

import shutil
from pathlib import Path

from rich.console import Console
from rich.table import Table

from .config import Config
from .download import cdl_paths
from .util import ensure_dir

# soft_wrap: a long line stays one line in job logs (the page wraps it)
console = Console(soft_wrap=True)

# What `simp clear` can wipe. Keys are CLI choices.
CLEAR_TARGETS = (
    "history",   # cyberdrop-dl download DB + direct download index (skip/resume memory)
    "cache",     # cyberdrop-dl cache.json
    "logs",      # state/cdl/logs/*
    "crawl",     # URL exports, per-thread crawl cache, cdl_* lists, failed lists
    "resolve",   # post→thread resolve cache
    "downloads", # downloads/ media (destructive)
    "state",     # entire state/ tree (keeps downloads/)
)


def _rm(path: Path) -> bool:
    if not path.exists():
        return False
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)
    return True


def _rm_glob(folder: Path, pattern: str) -> int:
    if not folder.is_dir():
        return 0
    n = 0
    for p in folder.glob(pattern):
        if _rm(p):
            n += 1
    return n


def describe_targets(cfg: Config) -> list[tuple[str, str, str]]:
    """Return (name, path, status) rows for the clear menu."""
    state = cfg.resolve(cfg.paths.state_dir)
    cdl = cdl_paths(cfg)
    downloads = cfg.models_root()

    def status_for(path: Path) -> str:
        if not path.exists():
            return "missing"
        if path.is_file():
            return f"{path.stat().st_size} B"
        # dir
        try:
            count = sum(1 for _ in path.rglob("*") if _.is_file())
        except OSError:
            count = 0
        return f"dir · {count} files"

    rows = [
        ("history", str(cdl["db"]), status_for(cdl["db"])),
        ("history", str(state / "done"), status_for(state / "done")),
        ("history", str(state / "content"), status_for(state / "content")),
        ("cache", str(cdl["cache"]), status_for(cdl["cache"])),
        ("logs", str(cdl["logs"]), status_for(cdl["logs"])),
        ("crawl", str(state / "media_urls.jsonl"), status_for(state / "media_urls.jsonl")),
        ("crawl", str(state / "crawl"), status_for(state / "crawl")),
        ("crawl", str(state / "failed"), status_for(state / "failed")),
        ("resolve", str(state / "post_resolve_cache.json"), status_for(state / "post_resolve_cache.json")),
        ("downloads", str(downloads), status_for(downloads)),
        ("state", str(state), status_for(state)),
    ]
    return rows


def clear_target(cfg: Config, name: str) -> list[str]:
    """Clear one target. Returns human lines of what was removed."""
    state = cfg.resolve(cfg.paths.state_dir)
    cdl = cdl_paths(cfg)
    removed: list[str] = []

    if name == "history":
        for p in (
            cdl["db"],
            Path(str(cdl["db"]) + "-wal"),
            Path(str(cdl["db"]) + "-shm"),
        ):
            if _rm(p):
                removed.append(str(p))
        if _rm(state / "done"):
            removed.append(str(state / "done"))
        if _rm(state / "content"):
            removed.append(str(state / "content"))
        # CDL requires --db path to exist; leave an empty stub for next run.
        cdl["db"].touch()
        removed.append(f"(recreated empty stub) {cdl['db']}")
    elif name == "cache":
        if _rm(cdl["cache"]):
            removed.append(str(cdl["cache"]))
        cdl["cache"].write_text("{}", encoding="utf-8")
        removed.append(f"(recreated empty stub) {cdl['cache']}")
    elif name == "logs":
        if cdl["logs"].is_dir():
            for p in cdl["logs"].iterdir():
                if _rm(p):
                    removed.append(str(p))
        ensure_dir(cdl["logs"])
    elif name == "crawl":
        for rel in (
            "bookmark_urls.txt",
            "media_urls.txt",
            "media_urls.jsonl",
            "all_cdl_urls.txt",
        ):
            p = state / rel
            if _rm(p):
                removed.append(str(p))
        for sub in ("crawl", "failed"):
            if _rm(state / sub):
                removed.append(str(state / sub))
        for pattern in ("cdl_*.txt", "cdl_*.jsonl"):
            n = _rm_glob(state, pattern)
            if n:
                removed.append(f"{state}/{pattern} ({n} files)")
    elif name == "resolve":
        p = state / "post_resolve_cache.json"
        if _rm(p):
            removed.append(str(p))
    elif name == "downloads":
        d = cfg.models_root()
        if d.is_dir():
            for child in list(d.iterdir()):
                # Hidden entries aren't ours — e.g. Edging Heaven's .heaven-trash,
                # the only copy of files deleted in its Dangerous mode.
                if child.name.startswith("."):
                    continue
                if _rm(child):
                    removed.append(str(child))
    elif name == "state":
        # Wipe state contents but recreate cdl dirs so next CDL run is clean.
        if state.is_dir():
            for child in list(state.iterdir()):
                if _rm(child):
                    removed.append(str(child))
        ensure_dir(cfg.resolve(cfg.paths.cdl_dir) / "logs")
    else:
        raise ValueError(f"unknown clear target: {name}")

    return removed


def print_clear_menu(cfg: Config) -> None:
    table = Table(title="Clearable project data")
    table.add_column("Target")
    table.add_column("Path", overflow="fold")
    table.add_column("Status")
    for name, path, status in describe_targets(cfg):
        table.add_row(name, path, status)
    console.print(table)
    console.print(
        "[dim]Examples:[/]  simp clear history  ·  simp clear crawl logs  ·  "
        "simp clear downloads --yes"
    )
