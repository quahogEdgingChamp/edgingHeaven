import json
import sys
import time
from pathlib import Path

import httpx
import pytest

import simp.cli as cli
from simp.bookmarks import Bookmark
from simp.config import Config, load_config
from simp.thread import CrawlLinks

THREAD = "https://simpcity.cr/threads/model.123/"


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "build_client", lambda cfg: httpx.Client())
    monkeypatch.setattr(cli, "assert_logged_in", lambda *args: None)
    monkeypatch.setattr(cli, "collect_targets", lambda *args, **kwargs: [Bookmark(THREAD, "Model")])
    return Config(root=tmp_path)


@pytest.mark.parametrize("command", ["thread", "scrape", "download"])
@pytest.mark.parametrize("partial", [False, True])
def test_crawl_failures_exit_nonzero(cfg, monkeypatch, command, partial):
    def crawl(*args, **kwargs):
        if partial:
            return CrawlLinks(failed_pages=[2])
        raise RuntimeError("thread unreachable")

    monkeypatch.setattr(cli, "crawl_thread", crawl)
    argv = [command, "--no-estimate"] + ([THREAD] if command == "thread" else [])
    args = cli._parser().parse_args(argv)
    assert args.func(args, cfg) == 1
    if command != "thread":
        rows = [json.loads(line) for line in (cfg.root / "state/media_urls.jsonl").read_text().splitlines()]
        assert rows[0]["crawl_failed"] is True
        args = cli._parser().parse_args(["download", "--skip-crawl", "--no-estimate"])
        assert args.func(args, cfg) == 1


def test_config_and_whereto_are_relative_to_config_folder(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    (data / "config.toml").write_text('[paths]\nmodels_subdir = ""\n')
    (data / "whereto.txt").write_text("media\n")
    monkeypatch.chdir(tmp_path)
    cfg = load_config(Path("data/config.toml"))
    assert cfg.root == data
    assert cfg.models_root() == data / "media"
    monkeypatch.chdir(data)
    assert cfg.models_root() == data / "media"


def test_missing_explicit_config_is_a_readable_error(tmp_path, capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["-c", str(tmp_path / "missing.toml"), "check-auth"])
    assert exc.value.code == 2
    assert "Config file not found" in capsys.readouterr().out


@pytest.mark.parametrize("partial", [False, True])
def test_web_queue_reads_real_cli_crawl_failure(tmp_path, monkeypatch, partial):
    # Exercise the app's actual queue and CLI in a child process. Only the remote
    # forum is replaced; no real credentials, downloads, or running service.
    repo = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(repo))
    from simpjobs import SimpJobs

    root = tmp_path / "data"
    root.mkdir()
    (root / "config.toml").write_text('[scrape]\ndelay_min=0\ndelay_max=0\n')
    binary = tmp_path / "simp-test"
    binary.write_text(
        f"#!{sys.executable}\n"
        "import httpx\n"
        "import simp.cli as cli\n"
        "def host(request):\n"
        "    if request.url.path == '/account/bookmarks':\n"
        "        return httpx.Response(200, text='<html>Bookmarks</html>')\n"
        f"    if {partial!r} and 'page-' not in request.url.path:\n"
        "        return httpx.Response(200, text='<div class=pageNav-main><a href=page-2>2</a></div>')\n"
        "    return httpx.Response(404)\n"
        "cli.build_client = lambda cfg: httpx.Client(base_url=cfg.site.base_url, transport=httpx.MockTransport(host))\n"
        "cli.main()\n"
    )
    binary.chmod(0o700)
    jobs = SimpJobs(root, binary)
    job = jobs.submit({"action": "thread", "urls": [THREAD]})
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status = jobs.status()["jobs"][0]
        if status["status"] not in {"queued", "running"}:
            break
        time.sleep(0.02)
    else:
        jobs.cancel(job["id"])
        pytest.fail("CLI did not finish")
    assert status["status"] == "failed", jobs.log(job["id"], 0)
    assert status["exitCode"] == 1
    assert "1 incomplete crawl(s)" in status["summary"]
    assert "rerun the original command" in jobs.log(job["id"], 0)["text"]
