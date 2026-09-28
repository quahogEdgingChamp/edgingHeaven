from __future__ import annotations

import http.cookiejar
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from rich.console import Console

from .config import Config

console = Console()


def _domain_matches(cookie_domain: str, host: str) -> bool:
    cd = (cookie_domain or "").lstrip(".").lower()
    host = host.lower()
    return host == cd or host.endswith("." + cd)


def load_netscape_cookies(path: Path, host: str) -> httpx.Cookies:
    """Load a Netscape cookies.txt into httpx.Cookies filtered to host."""
    if not path.is_file():
        raise FileNotFoundError(
            f"Cookies file not found: {path}\n"
            "Export while logged into SimpCity (Netscape cookies.txt), "
            "or set auth.browser in config.toml."
        )

    jar = http.cookiejar.MozillaCookieJar(str(path))
    # ignore_discard / ignore_expires keep session cookies usable offline.
    jar.load(ignore_discard=True, ignore_expires=True)

    cookies = httpx.Cookies()
    for c in jar:
        if not _domain_matches(c.domain, host):
            # Keep broad forum mirrors (simpcity.*) so a .su export works on .cr.
            if "simpcity" in host and "simpcity" in (c.domain or "").lower():
                pass
            else:
                continue
        cookies.set(
            c.name,
            c.value,
            domain=c.domain,
            path=c.path or "/",
        )
    if not any(True for _ in cookies.jar):
        raise RuntimeError(
            f"No cookies for host {host!r} in {path}. "
            "Make sure you exported cookies while logged into SimpCity."
        )
    return cookies


def load_browser_cookies(browser: str, host: str, profile: str | None = None) -> httpx.Cookies:
    """Pull cookies from a local browser profile via browser-cookie3."""
    try:
        import browser_cookie3
    except ImportError as exc:
        raise RuntimeError(
            "browser-cookie3 is required for auth.browser. "
            "pip install browser-cookie3"
        ) from exc

    loaders = {
        "firefox": browser_cookie3.firefox,
        "chrome": browser_cookie3.chrome,
        "chromium": browser_cookie3.chromium,
        "brave": browser_cookie3.brave,
        "edge": browser_cookie3.edge,
    }
    key = browser.lower().strip()
    if key not in loaders:
        raise ValueError(f"Unsupported browser {browser!r}. Choose: {', '.join(loaders)}")

    kwargs: dict[str, Any] = {"domain_name": "simpcity"}
    if profile:
        # firefox uses `profile`, chrome-family uses `cookie_file` differently;
        # pass profile name where supported.
        try:
            jar = loaders[key](domain_name="simpcity", profile_name=profile)
        except TypeError:
            jar = loaders[key](**kwargs)
    else:
        jar = loaders[key](**kwargs)

    cookies = httpx.Cookies()
    for c in jar:
        if "simpcity" not in (c.domain or "").lower() and not _domain_matches(c.domain, host):
            continue
        cookies.set(c.name, c.value, domain=c.domain, path=c.path or "/")
    if not any(True for _ in cookies.jar):
        raise RuntimeError(
            f"No SimpCity cookies found in {browser}. Log in via that browser first."
        )
    return cookies


def build_client(cfg: Config) -> httpx.Client:
    host = urlparse(cfg.site.base_url).hostname or "simpcity.cr"
    if cfg.auth.browser:
        cookies = load_browser_cookies(cfg.auth.browser, host, cfg.auth.browser_profile)
    else:
        cookies = load_netscape_cookies(cfg.resolve(cfg.auth.cookies_file), host)

    headers = {
        "User-Agent": cfg.site.user_agent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": cfg.site.base_url.rstrip("/") + "/",
    }
    return httpx.Client(
        base_url=cfg.site.base_url.rstrip("/"),
        cookies=cookies,
        headers=headers,
        follow_redirects=True,
        timeout=httpx.Timeout(60.0, connect=30.0),
        http2=True,
    )


def assert_logged_in(client: httpx.Client, cfg: Config) -> None:
    """Hit bookmarks; fail fast if session is dead."""
    from .util import looks_like_login_page

    r = client.get("/account/bookmarks")
    r.raise_for_status()
    if looks_like_login_page(r.text) or "/login" in str(r.url):
        raise RuntimeError(
            "Session looks logged-out. Re-export cookies while logged into "
            f"{cfg.site.base_url} and try again."
        )
    # Edging Heaven reads this line (and the error above) from job logs to
    # show whether the cookies still work.
    console.print(f"Signed in to {cfg.site.base_url}")
