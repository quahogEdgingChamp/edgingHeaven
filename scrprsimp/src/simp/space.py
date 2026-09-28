"""Keeping free space on the download drive (download.min_free_bytes).

Every downloader checks before it starts a model, before each file (with the
size the host announced) and while writing. When a file would cross the
reserve, it is not kept, nothing is recorded as failed, and DriveFull stops
the run: what was not fetched is simply fetched by the next run.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from .config import Config


class DriveFull(Exception):
    """Stopped because the download drive reached the configured reserve."""


def free_bytes(path: Path) -> int | None:
    """Free space on the drive that holds path (or its nearest existing parent)."""
    for candidate in (path, *path.parents):
        try:
            return shutil.disk_usage(candidate).free
        except OSError:
            continue
    return None


def gib(n: int) -> str:
    return f"{n / 1024**3:.1f} GB"


def check_space(cfg: Config, path: Path, need: int = 0) -> None:
    """Raise DriveFull if writing `need` more bytes under path would leave
    less than the reserve free."""
    reserve = cfg.download.min_free_bytes
    if not reserve:
        return
    free = free_bytes(path)
    if free is not None and free - need < reserve:
        raise DriveFull(f"Drive nearly full: {gib(free)} free, keeping {gib(reserve)} spare.")
