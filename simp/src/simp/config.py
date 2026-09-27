from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .hosts import DEFAULT_EXCLUDE_EXT

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


@dataclass
class SiteConfig:
    base_url: str = "https://simpcity.cr"
    user_agent: str = (
        "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"
    )


@dataclass
class AuthConfig:
    cookies_file: str = "cookies/simpcity.txt"
    browser: str | None = None
    browser_profile: str | None = None


@dataclass
class PathsConfig:
    download_dir: str = "downloads"
    state_dir: str = "state"
    # cyberdrop-dl db/cache/logs live here (project-local, not ~/.local)
    cdl_dir: str = "state/cdl"
    urls_export: str = "state/bookmark_urls.txt"
    media_export: str = "state/media_urls.txt"
    # Optional one-line path file. If set, media goes to <path>/models/<slug>/
    whereto_file: str = "whereto.txt"
    models_subdir: str = "models"


@dataclass
class ScrapeConfig:
    delay_min: float = 1.0
    delay_max: float = 2.5
    concurrency: int = 4
    include_watched: bool = False
    skip_title_contains: list[str] = field(default_factory=list)
    thread_url_must_contain: str = "/threads/"


@dataclass
class DownloadConfig:
    use_cyberdrop_dl: bool = True
    cyberdrop_dl_bin: str = "cyberdrop-dl"
    use_direct: bool = True
    images: bool = True
    videos: bool = True
    skip_existing: bool = True
    # Skip these extensions everywhere (direct + CDL). Lowercase with dot.
    # Empty list = keep every file type.
    exclude_extensions: list[str] = field(
        default_factory=lambda: sorted(DEFAULT_EXCLUDE_EXT)
    )


@dataclass
class Config:
    site: SiteConfig = field(default_factory=SiteConfig)
    auth: AuthConfig = field(default_factory=AuthConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)
    scrape: ScrapeConfig = field(default_factory=ScrapeConfig)
    download: DownloadConfig = field(default_factory=DownloadConfig)
    root: Path = field(default_factory=Path.cwd)

    def resolve(self, path: str | Path) -> Path:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = self.root / p
        return p

    def read_whereto(self) -> Path | None:
        """
        Read whereto.txt: first non-empty, non-# line = download root.
        Returns None if missing/blank → fall back to paths.download_dir.
        """
        path = self.resolve(self.paths.whereto_file)
        if not path.is_file():
            return None
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            # strip optional quotes
            if (line.startswith('"') and line.endswith('"')) or (
                line.startswith("'") and line.endswith("'")
            ):
                line = line[1:-1].strip()
            if not line:
                continue
            return Path(line).expanduser().resolve()
        return None

    def media_root(self) -> Path:
        """
        Root that contains models/<slug>/.
        From whereto.txt if set, else project download_dir.
        """
        custom = self.read_whereto()
        if custom is not None:
            return custom
        return self.resolve(self.paths.download_dir)

    def models_root(self) -> Path:
        """Directory under which each model folder lives."""
        root = self.media_root()
        custom = self.read_whereto()
        if custom is not None:
            # Empty string = put models directly under whereto (no extra layer).
            # Only default to "models" when the field is missing/None.
            raw = self.paths.models_subdir
            if raw is None:
                sub = "models"
            else:
                sub = str(raw).strip().strip("/\\")
            return root / sub if sub else root
        # Default ./downloads/<slug> — no extra models/ layer (keeps old layout)
        return root


def _section(data: dict[str, Any], name: str) -> dict[str, Any]:
    raw = data.get(name, {})
    return raw if isinstance(raw, dict) else {}


def load_config(path: Path | None = None) -> Config:
    """Load config.toml from path, or fall back to defaults + config.example.toml."""
    root = Path.cwd()
    cfg_path = path or (root / "config.toml")
    data: dict[str, Any] = {}
    if cfg_path.is_file():
        with cfg_path.open("rb") as fh:
            data = tomllib.load(fh)
        root = cfg_path.parent
    elif (root / "config.example.toml").is_file() and path is None:
        # Still allow running with defaults; example is documentation only.
        pass

    site = SiteConfig(**{k: v for k, v in _section(data, "site").items() if k in SiteConfig.__dataclass_fields__})
    auth = AuthConfig(**{k: v for k, v in _section(data, "auth").items() if k in AuthConfig.__dataclass_fields__})
    paths = PathsConfig(**{k: v for k, v in _section(data, "paths").items() if k in PathsConfig.__dataclass_fields__})
    scrape = ScrapeConfig(**{k: v for k, v in _section(data, "scrape").items() if k in ScrapeConfig.__dataclass_fields__})
    download = DownloadConfig(**{k: v for k, v in _section(data, "download").items() if k in DownloadConfig.__dataclass_fields__})

    return Config(site=site, auth=auth, paths=paths, scrape=scrape, download=download, root=root)
