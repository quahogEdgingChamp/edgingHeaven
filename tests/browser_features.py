"""Browser checks for Love, marked moments, the six timed modes, model pages,
session history, panic, the PIN lock, toy sync and Downloads.

Uses only the test library, like browser_design.py: ratings, marks, sessions
and the PIN go to a temporary data directory, trash/restore are blocked, and
the toy is a mock Intiface server on a free local port. Downloads run the
stand-in simp from test_simp_jobs.py, which writes only into the temporary
directory; nothing reaches SimpCity or the test library.

Run: python3 tests/browser_features.py --media-dir /mnt/edging-heaven/testing
Needs Playwright and, for the toy check, the `websockets` package.
BROWSER_EXECUTABLE optionally selects an installed Chromium executable.
"""
import argparse
import asyncio
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright  # noqa: E402
from server import AppServer, MediaLibrary, RequestHandler  # noqa: E402
import simpjobs  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_simp_jobs import FAKE_SIMP, GOOD_COOKIES  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--media-dir", type=Path, required=True)
args = parser.parse_args()
if args.media_dir.resolve() != Path("/mnt/edging-heaven/testing"):
    parser.error("This check is restricted to /mnt/edging-heaven/testing")
if not args.media_dir.is_dir():
    parser.error("The test library is unavailable")


class MockIntiface:
    """Just enough of the Buttplug v3 server to pair one vibrator."""

    def __init__(self):
        self.scalars = []
        self.stops = 0
        self.port = None
        ready = threading.Event()
        threading.Thread(target=self._run, args=(ready,), daemon=True).start()
        ready.wait(10)

    def _run(self, ready):
        from websockets.asyncio.server import serve

        async def handler(socket):
            try:
                await serve_client(socket)
            except Exception:  # the page closed the socket mid-reply
                pass

        async def serve_client(socket):
            async for raw in socket:
                replies = []
                for message in json.loads(raw):
                    (kind, body), = message.items()
                    ident = body.get("Id", 0)
                    if kind == "RequestServerInfo":
                        replies.append({"ServerInfo": {"Id": ident, "ServerName": "mock", "MessageVersion": 3, "MaxPingTime": 0}})
                    elif kind == "RequestDeviceList":
                        replies.append({"DeviceList": {"Id": ident, "Devices": [{"DeviceName": "Mock vibe", "DeviceIndex": 0,
                            "DeviceMessages": {"ScalarCmd": [{"StepCount": 20, "FeatureDescriptor": "", "ActuatorType": "Vibrate"}], "StopDeviceCmd": {}}}]}})
                    else:
                        if kind == "ScalarCmd":
                            self.scalars.append(body["Scalars"][0]["Scalar"])
                        elif kind == "StopAllDevices":
                            self.stops += 1
                        replies.append({"Ok": {"Id": ident}})
                await socket.send(json.dumps(replies))

        async def main():
            async with serve(handler, "127.0.0.1", 0) as server:
                self.port = server.sockets[0].getsockname()[1]
                ready.set()
                await asyncio.Future()

        asyncio.run(main())


passed = []


def check(label, condition, detail=""):
    assert condition, f"{label} failed. {detail}"
    passed.append(label)


with tempfile.TemporaryDirectory(prefix="heaven-features-") as tmp:
    library = MediaLibrary(args.media_dir, Path(tmp) / "state.json")
    # Downloads: a stand-in simp that "downloads" into tmp/downloads, and a
    # known thread for every model of the test library.
    simp_root = Path(tmp) / "scrprsimp"
    (simp_root / "state" / "crawl").mkdir(parents=True)
    (simp_root / "config.toml").write_text('[paths]\nmodels_subdir = ""\n')
    (simp_root / "whereto.txt").write_text(f"{Path(tmp) / 'downloads'}\n")
    (Path(tmp) / "downloads").mkdir()
    for folder in sorted(path.name for path in args.media_dir.iterdir() if path.is_dir()):
        (simp_root / "state" / "crawl" / f"simpcity.cr_{folder}.1.json").write_text(
            json.dumps({"thread": f"https://simpcity.cr/threads/{folder}.1/", "last_page": 3, "links": []}))
    # Bookmarks: one model the test library has, one it doesn't (with two
    # pictures copied from the test library as its previews), and one link
    # that is not a SimpCity thread.
    have_model = sorted(path.name for path in args.media_dir.iterdir() if path.is_dir())[0]
    (simp_root / "bookmark_rows.json").write_text(json.dumps([
        {"url": f"https://simpcity.cr/threads/{have_model}.1/", "title": have_model.replace("_", " ").title(), "model": have_model, "previews": []},
        {"url": "https://simpcity.cr/threads/new-model.5/", "title": "New Model", "model": "new-model", "previews": ["0.jpg", "1.png"]},
        {"url": "https://elsewhere.example/x/", "title": "Odd One", "model": "odd", "previews": []},
    ]))
    shots = simp_root / "state" / "previews" / "new-model"
    shots.mkdir(parents=True)
    pictures = sorted(args.media_dir.glob("*/*.jp*g"))
    (shots / "0.jpg").write_bytes(pictures[0].read_bytes())
    (shots / "1.png").write_bytes(pictures[1].read_bytes())
    fake_simp = Path(tmp) / "fake-simp"
    fake_simp.write_text(FAKE_SIMP.replace("{python}", sys.executable))
    fake_simp.chmod(0o755)
    simpjobs.CANCEL_STEPS = ((simpjobs.signal.SIGINT, 0.5), (simpjobs.signal.SIGTERM, 0.5), (simpjobs.signal.SIGKILL, 2))
    simp = simpjobs.SimpJobs(simp_root, fake_simp)
    server = AppServer(("127.0.0.1", 0), RequestHandler, library, simp=simp)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"

    # Keep a few files and duel them, so Ladder and model pages have something.
    catalog = library.library_payload()
    images, videos = catalog["images"], catalog["videos"]
    for item in images[:14] + videos[:6]:
        library.set_rating(item["path"], "like")
    for winner, loser in zip(images[:7], images[7:14]):
        library.record_duel(winner["path"], loser["path"])
    library.set_rating(images[0]["path"], "love")

    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=os.environ.get("BROWSER_EXECUTABLE"),
            args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
        )

        def new_page(context):
            context.route("**/api/trash", lambda route: route.abort() if route.request.method == "POST" else route.continue_())
            context.route("**/api/restore", lambda route: route.abort())
            page = context.new_page()
            page.on("pageerror", lambda err: errors.append(f"{err}\n{err.stack}"))
            # 401s while locked, the 403 of a deliberately wrong PIN and the 400
            # of a deliberately refused download link are expected.
            page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" and not any(code in msg.text for code in ("400", "401", "403")) else None)
            page.on("dialog", lambda dialog: dialog.accept())
            return page

        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = new_page(context)
        page.goto(url)
        page.wait_for_function("state.libraryReady && state.library.images.length > 0")

        # ---- Love
        page.evaluate("""() => { state.settings.swipeRatingFilter = 'all'; setMode('swipe'); }""")
        page.wait_for_timeout(300)
        loved_path = page.evaluate("currentDeckItem('swipe').path")
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(600)
        check("love from the deck (↑)", library.state["ratings"].get(loved_path) == "love")
        counts = page.evaluate("state.library.counts")
        check("loved counts as kept", counts["loved"] >= 2 and counts["liked"] >= counts["loved"], counts)
        page.evaluate("() => setRatingFilter('swipe', 'loved')")
        deck = page.evaluate("state.swipeItems.map(i => i.rating)")
        check("Show: Loved", deck and all(r == "love" for r in deck), deck)
        page.evaluate("() => setRatingFilter('swipe', 'all')")

        # ---- Marking in Video deck (B at start, B at end)
        page.evaluate("() => setMode('toktinder')")
        page.wait_for_function("controls.toktinderVideo.readyState >= 1 && controls.toktinderVideo.duration > 3", timeout=15000)
        clip = page.evaluate("currentDeckItem('toktinder').path")
        page.evaluate("() => { controls.toktinderVideo.currentTime = 1; }")
        page.wait_for_timeout(300)
        page.keyboard.press("b")
        page.evaluate("() => { controls.toktinderVideo.currentTime = 3; }")
        page.wait_for_timeout(300)
        page.keyboard.press("b")
        page.wait_for_timeout(600)
        spans = library.marks_payload().get(clip)
        check("mark a moment with B", spans and 0.5 <= spans[0][0] <= 1.5 and 2.5 <= spans[0][1] <= 3.5, spans)
        ticks = page.evaluate("controls.toktinderSeekMarks.children.length")
        check("marked moments show on the seek bar", ticks == 1, ticks)

        # ---- Highlights plays the marked span
        library.set_marks(videos[1]["path"], [[2, 4]])
        page.evaluate("() => loadMarks(true)")
        page.evaluate("() => setMode('highlights')")
        page.wait_for_function("highlights.moments.length >= 2 && !el('highlightsStage').querySelector('.ps-video').paused", timeout=15000)
        moment = page.evaluate("({start: currentMoment().start, end: currentMoment().end, t: el('highlightsStage').querySelector('.ps-video').currentTime})")
        check("Highlights starts at the mark", moment["start"] - 0.5 <= moment["t"] <= moment["end"] + 0.5, moment)
        first = page.evaluate("highlights.index")
        page.keyboard.press("ArrowRight")
        check("Highlights next moment", page.evaluate("highlights.index") == (first + 1) % page.evaluate("highlights.moments.length"))

        # ---- Session plays clips it loads mid-session (was a frozen frame)
        page.evaluate("() => { state.settings.sessionIncludeVideos = true; setMode('session'); startSession(); }")
        page.wait_for_function("""() => { for (let i = 0; i < 12 && controls.sessionStage.dataset.activeKind !== 'video'; i++) refreshSessionMedia(true);
                                    return controls.sessionStage.dataset.activeKind === 'video'; }""", timeout=15000)
        page.wait_for_function("!controls.sessionVideo.paused && controls.sessionVideo.currentTime > 0", timeout=15000)
        check("Session clips play", True)
        page.evaluate("() => stopSession()")

        # ---- Beat: clicks scheduled, picture swaps, pulse, edge = stop + freeze
        page.evaluate("() => { state.settings.beatSwapBeats = 2; state.settings.beatStartBpm = 150; state.settings.beatPeakBpm = 160; setMode('beat'); }")
        page.click("#beatHudStart")
        page.wait_for_function("beat.beatCount > 6", timeout=10000)
        swapped = page.evaluate("beat.stage.recent.length")
        check("Beat schedules clicks and swaps on the beat", swapped >= 2, swapped)
        check("Beat compact HUD shows the tempo", "bpm" in page.inner_text("#beatCue"))
        page.keyboard.press("e")
        page.wait_for_timeout(200)
        state = page.evaluate("({phase: beatPhase().kind, frozen: el('beatStage').dataset.frozen, hud: el('beatStage').dataset.hud})")
        check("Beat edge: instant stop, frozen, big HUD", state == {"phase": "stop", "frozen": "true", "hud": "full"}, state)
        count = page.evaluate("beat.beatCount")
        page.wait_for_timeout(700)
        check("no clicks during a stop", page.evaluate("beat.beatCount") == count)
        page.keyboard.press(" ")
        check("Beat stops", page.evaluate("!beat.running"))

        # ---- Red light: red freezes, green resumes, ending
        page.evaluate("() => setMode('redlight')")
        page.click("#redlightHudStart")
        page.wait_for_function("redlight.running && redlight.stage.item", timeout=10000)
        page.evaluate("() => setRedlightPhase('red', 1)")
        check("red light freezes", page.evaluate("redlight.stage.frozen && el('redlightStage').dataset.phase === 'hold'"))
        page.wait_for_function("redlight.phase === 'green'", timeout=5000)
        check("green follows red", page.evaluate("!redlight.stage.frozen"))
        page.evaluate("() => { state.settings.redlightEnding = 'deny'; redlight.clock.elapsed = state.settings.redlightMinutes * 60000; redlight.phaseSeconds = 0; }")
        page.wait_for_function("redlight.phase === 'deny'", timeout=5000)
        check("time up ends in the chosen ending", page.inner_text("#redlightCue") == "Denied")
        page.evaluate("() => stopRedlight()")

        # ---- Dice: cards change the rules
        page.evaluate("() => setMode('dice')")
        page.click("#diceHudStart")
        page.wait_for_function("dice.running && dice.stage.item", timeout=10000)
        page.evaluate("() => { for (let i = 0; i < 6; i++) { dice.stage.freeze(false); dice.rule = null; drawDiceCard(); } }")
        check("Dice draws cards", page.evaluate("dice.draws") == 6 and page.is_visible("#diceCard"))
        page.evaluate("() => { dice.stage.freeze(false); dice.rule = null; }")
        page.keyboard.press("e")
        check("Dice edge holds", page.evaluate("dice.stage.frozen && dice.edges === 1"))
        page.evaluate("() => { state.settings.diceFinishOdds = 1; state.settings.diceMinMinutes = 0; dice.stage.freeze(false); dice.rule = null; drawDiceCard(); }")
        check("finish card", page.evaluate("dice.ending") == "finish")
        page.evaluate("() => stopDice()")

        # ---- Ladder: ranked keeps, weakest first, best last
        page.evaluate("() => setMode('ladder')")
        page.wait_for_timeout(300)
        page.click("#ladderHudStart")
        page.wait_for_function("ladder.running && ladder.stage.item", timeout=10000)
        order = page.evaluate("ladder.steps.map(i => duelRating(i.path)).filter(r => r.n).map(r => r.r)")
        check("Ladder climbs by duel rank", order == sorted(order) and len(order) >= 7, order)
        page.keyboard.press("ArrowRight")
        check("Ladder steps up", page.evaluate("ladder.index") == 1)
        page.evaluate("() => stopLadder()")

        # ---- Spotlight: one model only
        page.evaluate("() => setMode('spotlight')")
        page.click("#spotlightHudStart")
        page.wait_for_function("spotlight.running && spotlight.stage.item", timeout=10000)
        info = page.evaluate("({model: spotlight.model, folder: spotlight.stage.item.folder})")
        check("Spotlight plays the chosen model", info["folder"] == info["model"] or info["folder"].startswith(info["model"] + "/"), info)
        page.evaluate("() => stopSpotlight()")

        # ---- Crossfade: a ghost appears on a swap and is cleaned up
        page.evaluate("() => setMode('escalation')")
        page.wait_for_timeout(1500)
        page.evaluate("() => refreshEscalationMedia(true)")
        ghosts = page.evaluate("controls.escalationStage.querySelectorAll('.xfade-ghost').length")
        page.wait_for_timeout(2000)
        left = page.evaluate("controls.escalationStage.querySelectorAll('.xfade-ghost').length")
        check("crossfade ghost appears and clears", ghosts <= 1 and left == 0, (ghosts, left))

        # ---- Collection: model page and session history
        library.add_session({"mode": "beat", "seconds": 600, "edges": 2})
        library.add_session({"mode": "session", "seconds": 300, "edges": 0})
        page.evaluate("() => { sessionHistory = null; setMode('ranked'); }")
        page.wait_for_function("!el('sessionHistory').hidden", timeout=5000)
        # The Red light check above fast-forwarded to its end, so it logged one too.
        recent = page.evaluate("[...el('sessionRecent').children].map(li => li.querySelector('strong').textContent)")
        check("session history shows", recent[:2] == ["Session", "Beat"] and "Red light" in recent, recent)
        page.click("#rankedFolders .ranked-model-link")
        page.wait_for_function("!el('rankedModelPage').hidden", timeout=5000)
        check("model page opens with its best files", page.evaluate("el('modelGrid').children.length") > 0)
        page.wait_for_selector("#modelUpdate:not([hidden])", timeout=5000)
        model = page.evaluate("state.ranked.model")
        page.click("#modelUpdate")
        page.wait_for_function("downloads.status?.jobs?.length === 1", timeout=5000)
        job = page.evaluate("downloads.status.jobs[0]")
        check("model page: New posts queues that model's thread",
              job["args"] == ["thread", "--slow-later", f"https://simpcity.cr/threads/{model}.1/"] and job["label"] == f"New posts: {model}", job)
        page.click("#modelBack")
        check("model page back", page.evaluate("el('rankedModelPage').hidden"))

        # ---- Downloads (stand-in simp; see the top of this file)
        page.evaluate("() => setMode('downloads')")
        page.wait_for_function("!el('dlForms').hidden && el('dlJobs').children.length === 1", timeout=5000)
        page.wait_for_function("downloads.status.jobs[0].status === 'error'", timeout=10000)
        check("no cookies yet: the login shows as failed", "Signed out" in page.inner_text("#dlStats"), page.inner_text("#dlStats"))
        page.set_input_files("#dlCookieFile", files=[{"name": "cookies.txt", "mimeType": "text/plain", "buffer": GOOD_COOKIES.encode()}])
        page.wait_for_function("downloads.status?.auth?.ok === true", timeout=10000)
        check("uploading cookies.txt checks the login", "Signed in" in page.inner_text("#dlStats"))
        page.fill("#dlUrls", "https://example.com/threads/x.1/")
        page.click("#dlThreadGo")
        page.wait_for_function("el('workspaceToast').textContent.includes('Not a SimpCity thread link')", timeout=5000)
        check("a non-SimpCity link is refused", page.evaluate("downloads.status.jobs.length") == 2)
        page.fill("#dlUrls", "https://simpcity.cr/threads/brand-new.77/page-3")
        page.click("#dlThreadGo")
        page.wait_for_function("downloads.status.jobs[0].label === 'Download brand-new' && downloads.status.jobs[0].status === 'done'", timeout=10000)
        page.wait_for_function("el('dlLog').textContent.includes('Summary:')", timeout=10000)
        check("a thread downloads and its output shows", "$ simp thread https://simpcity.cr/threads/brand-new.77/" in page.inner_text("#dlLog"))
        check("the finished job is listed as done", page.inner_text("#dlJobs li:first-child .dl-badge") == "Done")
        check("the new thread joins the known ones",
              "brand-new" in page.inner_text("#dlThreads") and (Path(tmp) / "downloads" / "brand-new" / "new.jpg").is_file())
        page.fill("#dlUrls", "https://simpcity.cr/threads/slow.5/")
        page.click("#dlThreadGo")
        page.wait_for_selector("#dlCancel:not([hidden])", timeout=10000)
        page.wait_for_function("el('dlLog').textContent.includes('crawling slow thread')", timeout=10000)
        check("the running job's output follows live", True)
        page.click("#dlCancel")
        page.wait_for_function("downloads.status.jobs[0].status === 'cancelled'", timeout=15000)
        check("cancel stops the running job", page.inner_text("#dlJobs li:first-child .dl-badge") == "Cancelled")

        # ---- Bookmarks (same stand-in simp)
        page.evaluate("() => setMode('bookmarks')")
        page.wait_for_function("!el('bmEmpty').hidden && el('bmEmpty').textContent.includes('No bookmarks yet')", timeout=5000)
        check("bookmarks start empty", True)
        page.click("#bmRefresh")
        page.wait_for_function("el('bmGrid').children.length === 3", timeout=15000)
        check("Refresh from SimpCity fills the grid", page.inner_text("#bmStats").split()[:1] == ["3"], page.inner_text("#bmStats"))
        page.wait_for_function("""() => [...el('bmGrid').querySelectorAll('.bm-card:nth-child(-n+2) img')].every(i => i.complete && i.naturalWidth > 0)""", timeout=15000)
        cards = page.evaluate("""() => [...el('bmGrid').children].map(card => ({
            title: card.querySelector('.bm-title').textContent,
            meta: card.querySelector('.subtle').textContent,
            sources: [...card.querySelectorAll('img')].map(i => new URL(i.src).pathname),
            buttons: [...card.querySelectorAll('button, a')].map(b => b.textContent)}))""")
        check("a model you have shows three of its own photos and what you kept",
              cards[0]["sources"] == ["/media"] * 3 and cards[0]["meta"].startswith("In library") and cards[0]["buttons"] == ["New posts", "Open", "SimpCity"], cards[0])
        check("a model you don't have shows its saved previews",
              cards[1]["sources"] == ["/api/simp/previews/new-model/0.jpg", "/api/simp/previews/new-model/1.png"] and cards[1]["buttons"] == ["Download", "SimpCity"], cards[1])
        check("a non-thread link gets no Download button", cards[2]["buttons"] == [] and cards[2]["meta"].endswith("Not downloaded yet"), cards[2])
        page.click('#bmFilter [data-bm-filter="missing"]')
        check("filter: not downloaded", page.evaluate("el('bmGrid').children.length") == 2)
        page.fill("#bmSearch", "new mod")
        page.wait_for_function("el('bmGrid').children.length === 1", timeout=5000)
        page.click("#bmGrid .bm-card button")
        page.wait_for_function("downloads.status.jobs[0].label === 'Download new-model'", timeout=10000)
        check("Download on a bookmark queues its thread", True)
        page.fill("#bmSearch", "")
        page.click('#bmFilter [data-bm-filter="have"]')
        page.wait_for_function("el('bmGrid').children.length === 1", timeout=5000)
        page.click("#bmGrid .bm-card button:has-text('Open')")
        page.wait_for_function(f"state.currentMode === 'ranked' && state.ranked.model === {json.dumps(have_model)}", timeout=5000)
        check("Open goes to that model's page", True)

        # ---- Panic
        page.evaluate("() => setMode('escalation')")
        page.wait_for_timeout(800)
        page.keyboard.press("`")
        state = page.evaluate("({cover: !el('panicCover').hidden, title: document.title, playing: [...document.querySelectorAll('video')].some(v => !v.paused)})")
        check("panic covers, retitles and silences", state == {"cover": True, "title": "Notes", "playing": False}, state)
        page.keyboard.press("`")
        check("panic off", page.evaluate("el('panicCover').hidden && document.title.includes('Escalation')"))

        # ---- Toy: handshake, levels while Escalation runs, stop on leaving
        try:
            mock = MockIntiface()
        except Exception as error:  # websockets missing
            mock = None
            print(f"  (toy check skipped: {error})")
        if mock and mock.port:
            page.evaluate(f"() => {{ state.settings.toyUrl = 'ws://127.0.0.1:{mock.port}'; toyConnect(); }}")
            page.wait_for_function("toy.status === 'connected' && toy.devices.size === 1", timeout=5000)
            page.evaluate("() => { state.settings.escalationRamp = true; setMode('escalation'); }")
            page.wait_for_timeout(2500)
            check("toy gets levels from Escalation", len(mock.scalars) >= 1 and 0 < max(mock.scalars) <= 0.7, mock.scalars)
            page.evaluate("() => setMode('gallery')")
            page.wait_for_timeout(300)
            check("toy stops when the mode is left", mock.stops >= 1, mock.stops)
            page.evaluate("() => toyDisconnect()")

        # ---- PIN lock: this device sets it, a fresh browser must enter it
        page.evaluate("() => { state.themePanelVisible = true; syncLibraryChrome(); }")
        page.fill("#pinNew", "2468")
        page.click("#pinSave")
        page.wait_for_function("el('privacyCard').dataset.pin === 'on'", timeout=5000)
        check("this device stays unlocked after setting a PIN", page.evaluate("!state.locked"))

        stranger = browser.new_context(viewport={"width": 390, "height": 844})
        other = new_page(stranger)
        other.goto(url)
        other.wait_for_selector("#lockScreen:not([hidden])", timeout=10000)
        check("another browser sees the lock screen", other.evaluate("!state.libraryReady && document.title === 'Notes'"))
        for key in "1357":
            other.click(f'#lockPad [data-key="{key}"]')
        other.click('#lockPad [data-key="ok"]')
        other.wait_for_function("el('lockMessage').textContent.includes('Wrong')", timeout=5000)
        for key in "2468":
            other.keyboard.press(key)
        other.keyboard.press("Enter")
        other.wait_for_function("state.libraryReady && el('lockScreen').hidden", timeout=10000)
        check("the right PIN unlocks and loads the library", other.evaluate("state.library.images.length") > 0)
        stranger.close()

        browser.close()

    assert not errors, "\n".join(errors)
    print(f"{len(passed)} feature checks passed:")
    for label in passed:
        print(f"  {label}")
