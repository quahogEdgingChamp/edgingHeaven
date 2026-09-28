"""Browser checks for using a download while it runs: new files join the
library as they land, decks and Dangerous take them without being reshuffled,
the Arriving grid and Sort in Dangerous, Dangerous keeping without rating,
its red way in, and the drive-full hold with Resume.

The library is a temporary copy of two folders of the test library (the test
library itself is never written to). The stand-in simp from test_simp_jobs.py
"downloads" more copies of test pictures into it. Free space is simulated.

Run: python3 tests/browser_live.py --media-dir /mnt/edging-heaven/testing
Needs Playwright. BROWSER_EXECUTABLE optionally selects a Chromium binary;
AXE_SCRIPT optionally points to axe.min.js for WCAG checks of the Downloads page.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import threading
from collections import namedtuple
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright  # noqa: E402
import simpjobs  # noqa: E402
from server import AppServer, MediaLibrary, RequestHandler  # noqa: E402
from test_simp_jobs import FAKE_SIMP, GOOD_COOKIES  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--media-dir", type=Path, required=True)
args = parser.parse_args()
if args.media_dir.resolve() != Path("/mnt/edging-heaven/testing"):
    parser.error("This check is restricted to /mnt/edging-heaven/testing")
if not args.media_dir.is_dir():
    parser.error("The test library is unavailable")

GB = 1024**3
Usage = namedtuple("Usage", "total used free")
drive = {"free": 50 * GB}
simpjobs.shutil.disk_usage = lambda path: Usage(100 * GB, 0, drive["free"])
simpjobs.WATCH_SECONDS = 1
passed = []


def check(label, condition, detail=""):
    assert condition, f"{label} failed. {detail}"
    passed.append(label)


with tempfile.TemporaryDirectory(prefix="heaven-live-") as tmp:
    tmp = Path(tmp)
    folders = sorted(path for path in args.media_dir.iterdir() if path.is_dir())
    library_dir = tmp / "library"
    for folder in folders[:2]:
        shutil.copytree(folder, library_dir / folder.name)
    library = MediaLibrary(library_dir, tmp / "data" / "state.json")
    root = tmp / "data" / "scrprsimp"
    (root / "cookies").mkdir(parents=True)
    (root / "cookies" / "simpcity.txt").write_text(GOOD_COOKIES)
    (root / "config.toml").write_text(f'[paths]\nmodels_subdir = ""\n[download]\nmin_free_bytes = {3 * GB}\n')
    (root / "whereto.txt").write_text(f"{library_dir}\n")
    (root / "drip-source").mkdir()
    for n, picture in enumerate(sorted(folders[2].glob("*.jp*g"))[:6]):
        shutil.copy(picture, root / "drip-source" / f"{n}.jpg")
    fake = tmp / "fake-simp"
    fake.write_text(FAKE_SIMP.replace("{python}", sys.executable))
    fake.chmod(0o755)
    simp = simpjobs.SimpJobs(root, fake, add_files=library.add_new_files)
    server = AppServer(("127.0.0.1", 0), RequestHandler, library, simp=simp)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"

    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("BROWSER_EXECUTABLE"), args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        # Deleting is not part of this check; nothing may be moved to trash.
        context.route("**/api/trash", lambda route: route.abort() if route.request.method == "POST" else route.continue_())
        page = context.new_page()
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("dialog", lambda dialog: dialog.accept())
        page.goto(url)
        page.wait_for_function("state.libraryReady && state.library.images.length > 0")
        # Count full reloads of the library from here on.
        page.evaluate("() => { window.fullLoads = 0; const load = loadState; loadState = async (...a) => { window.fullLoads++; return load(...a); }; }")

        # ---- Dangerous is red wherever you can enter it
        red = page.evaluate("""() => {
          const danger = getComputedStyle(document.body).getPropertyValue('--danger').trim();
          const link = getComputedStyle(document.querySelector('.workspace-link[data-mode="dangerous"]')).color;
          const probe = document.createElement('i'); probe.style.color = danger; document.body.append(probe);
          const want = getComputedStyle(probe).color; probe.remove();
          return {link, want};
        }""")
        check("the Dangerous entry is red", red["link"] == red["want"], red)

        # ---- decks and Dangerous before the download
        page.evaluate("() => { state.settings.dangerousHideKept = true; setMode('swipe'); }")
        page.wait_for_timeout(300)
        swipe_before = page.evaluate("state.swipeItems.map(i => i.path)")
        page.keyboard.press("ArrowDown")  # skip one, so the deck has a position to keep
        swipe_index = page.evaluate("state.swipeIndex")
        page.evaluate("() => setMode('dangerous')")
        page.wait_for_function("dangerous.items.length > 0")
        on_screen = page.evaluate("dangerous.items[dangerous.index].path")

        # ---- a download starts while you are in Dangerous
        started = page.evaluate("""() => postJson('/api/simp/jobs', {action: 'thread', urls: ['https://simpcity.cr/threads/drip.9/']})""")
        job_id = started["job"]["id"]
        page.wait_for_function("state.library.images.some(i => i.folder === 'drip')", timeout=20000)
        check("new files reach the open page while the job runs", simp._job(job_id)["status"] == "running")
        check("without reloading the whole library", page.evaluate("window.fullLoads") == 0, page.evaluate("window.fullLoads"))
        check("Dangerous keeps its place", page.evaluate("dangerous.items[dangerous.index].path") == on_screen)
        page.wait_for_function("dangerous.items.slice(dangerous.index + 1).some(i => i.folder === 'drip')", timeout=5000)
        check("and gets the new files later in its deck", True)
        swipe_after = page.evaluate("state.swipeItems.map(i => i.path)")
        check("the photo deck is not reshuffled",
              [path for path in swipe_after if path in set(swipe_before)] == swipe_before and page.evaluate("state.swipeIndex") == swipe_index)
        check("and has the new photos after the current card",
              any(path.startswith("drip/") for path in swipe_after[swipe_index + 1:]) and not any(path.startswith("drip/") for path in swipe_after[:swipe_index + 1]))

        # ---- watching it arrive on the Downloads page
        page.evaluate("() => setMode('downloads')")
        page.wait_for_function("!el('dlArrivals').hidden && el('dlArrivalsGrid').children.length > 0", timeout=15000)
        check("the Arriving grid shows the new files", page.inner_text("#dlArrivalsTitle").startswith("Arriving:"), page.inner_text("#dlArrivalsTitle"))
        page.wait_for_function("[...el('dlArrivalsGrid').querySelectorAll('img')].some(i => i.complete && i.naturalWidth > 0)", timeout=10000)
        page.click("#dlArrivalsGrid .gallery-tile")
        check("tapping one opens it", page.evaluate("!controls.galleryLightbox.hidden"))
        page.keyboard.press("Escape")

        # ---- Sort in Dangerous: that model only; keeping is not a rating
        page.click("#dlArrivalsDangerous")
        page.wait_for_function("state.currentMode === 'dangerous' && dangerous.items.length > 0", timeout=5000)
        check("Sort in Dangerous deals only that model", page.evaluate("dangerous.items.every(i => i.folder === 'drip')"))
        first = page.evaluate("dangerous.items[dangerous.index].path")
        page.keyboard.press("ArrowRight")
        page.wait_for_function(f"dangerousKept.paths.has({json.dumps(first)})", timeout=5000)
        second = page.evaluate("dangerous.items[dangerous.index].path")
        # ↑ Loves by default (tests/browser_cleanup.py); switched off it only keeps.
        page.evaluate("() => { state.settings.dangerousUpLoves = false; }")
        page.keyboard.press("ArrowUp")
        page.wait_for_function(f"dangerousKept.paths.has({json.dumps(second)})", timeout=5000)
        check("Keep, and ↑ with Love switched off, remember the file without rating it",
              library.state["ratings"] == {} and set(library.dangerous_kept_payload()) == {first, second}, library.state["ratings"])
        page.keyboard.press("u")
        page.wait_for_function(f"!dangerousKept.paths.has({json.dumps(second)})", timeout=5000)
        check("Undo forgets the keep", set(library.dangerous_kept_payload()) == {first})
        page.evaluate("() => startDangerous(true)")
        check("a kept file does not come up again", first not in page.evaluate("dangerous.items.map(i => i.path)"))
        (root / "release").write_text("go")
        page.wait_for_function(f"() => fetchJson('/api/simp/status').then(s => s.jobs.find(j => j.id === {json.dumps(job_id)}).status === 'done')", timeout=20000)

        # ---- the drive reaches its reserve
        page.evaluate("""() => postJson('/api/simp/jobs', {action: 'thread', urls: ['https://simpcity.cr/threads/full-model.1/']})""")
        page.evaluate("""() => postJson('/api/simp/jobs', {action: 'thread', urls: ['https://simpcity.cr/threads/other.2/']})""")
        page.evaluate("() => setMode('downloads')")
        page.wait_for_function("!el('dlHeld').hidden", timeout=20000)
        drive["free"] = 2 * GB
        page.evaluate("() => refreshDownloads()")
        page.wait_for_function("el('dlResume').disabled", timeout=10000)
        check("a full drive holds the downloads and waits for room", "waiting for space" in page.inner_text("#dlHeldText"), page.inner_text("#dlHeldText"))
        badges = page.evaluate("[...document.querySelectorAll('#dlJobs .dl-badge')].map(b => b.textContent)")
        check("the stopped job says Drive full", "Drive full" in badges and badges.count("Waiting for space") == 2, badges)
        if os.environ.get("AXE_SCRIPT"):
            page.add_script_tag(path=os.environ["AXE_SCRIPT"])
            violations = page.evaluate("async () => (await axe.run(el('downloadsMode'), {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa']}})).violations.map(v => v.id)")
            check("Downloads with arrivals and a hold passes axe", not violations, violations)
        drive["free"] = 30 * GB
        page.evaluate("() => refreshDownloads()")
        page.wait_for_function("!el('dlResume').disabled", timeout=10000)
        page.click("#dlResume")
        page.wait_for_function("el('dlHeld').hidden", timeout=30000)
        check("Resume runs them once there is room", True)
        browser.close()

    assert not errors, "\n".join(errors)
    print(f"{len(passed)} live-download checks passed:")
    for label in passed:
        print(f"  {label}")
