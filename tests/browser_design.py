"""Browser regression checks for the interface, using only the test library.

No source media is changed: ratings, duels, seen times and thumbnails go to a
temporary data directory, and trash/restore requests are blocked.
Requires an existing Playwright install.

Run: python3 tests/browser_design.py --media-dir /mnt/edging-heaven/testing
BROWSER_EXECUTABLE optionally selects an installed Chromium executable.
AXE_SCRIPT optionally points to a local axe.min.js for WCAG checks.
"""
import argparse
import os
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright  # noqa: E402
from server import AppServer, MediaLibrary, RequestHandler  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--media-dir", type=Path, required=True)
parser.add_argument("--shots", type=Path, default=None, help="save screenshots (media hidden) here")
args = parser.parse_args()
if args.media_dir.resolve() != Path("/mnt/edging-heaven/testing"):
    parser.error("This check is restricted to /mnt/edging-heaven/testing")
if not args.media_dir.is_dir():
    parser.error("The test library is unavailable")

MODES = ["home", "swipe", "toktinder", "feed", "rediscover", "duel", "escalation", "mosaic", "session", "gallery", "ranked", "dangerous",
         "beat", "redlight", "dice", "ladder", "spotlight", "highlights", "downloads", "bookmarks",
         "dgrid", "djunk", "dsimilar", "dfolders"]
VIEWPORTS = [(1440, 900), (1920, 1080), (1180, 820), (820, 1180), (390, 844), (360, 640), (320, 568), (844, 390)]
HIDE_MEDIA = "img, video { opacity: 0 !important; }"

# Buttons that must be reachable, and must not sit on a clip's own controls.
LAYOUT_CHECK = r"""() => {
  const vis = n => { if (!n) return null; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' ? r : null; };
  const hit = (a, b) => a && b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const panel = document.querySelector('.mode-panel.active');
  const buttons = [...panel.querySelectorAll('.swipe-actions button, .dangerous-actions button, .duel-actions button, .gallery-footer button'),
                   ...document.querySelectorAll('.stage-toolbar.active button, #modeMenuButton, #themeButton')];
  const clipped = buttons.filter(b => { const r = vis(b); return r && (r.bottom > innerHeight + 1 || r.right > innerWidth + 1 || r.left < -1 || r.top < -1); }).map(b => b.id || b.className);
  const zones = [];
  const t = document.getElementById('toktinderTransport'); if (panel.contains(t)) zones.push(vis(t));
  panel.querySelectorAll('.dangerous-card > video:not([hidden])').forEach(v => { const r = vis(v); if (r) zones.push({left: r.left, right: r.right, top: r.bottom - 48, bottom: r.bottom}); });
  const covering = [...panel.querySelectorAll('.swipe-actions button, .dangerous-actions button')].filter(b => zones.some(z => hit(vis(b), z))).map(b => b.id);
  return {
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    clipped, covering,
    inactiveMedia: document.querySelectorAll('.mode-panel:not(.active) video[src], .mode-panel:not(.active) img[src]').length,
    topbar: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
  };
}"""

NEST_FOLDERS = """() => {
  const map = f => f ? f.split('_')[0] + '/' + f.split('_').slice(1).join('_') : f;
  for (const k of ['images', 'videos']) state.library[k].forEach(i => { i.folder = map(i.folder); });
  state.library.folders = [...new Set([...state.library.images, ...state.library.videos].map(i => i.folder))].sort();
  state.librarySignature = librarySignature() + ':nested';
  invalidateMediaPools();
  renderFolderFilters();
}"""

with tempfile.TemporaryDirectory(prefix="heaven-design-") as tmp:
    library = MediaLibrary(args.media_dir, Path(tmp) / "state.json")
    server = AppServer(("127.0.0.1", 0), RequestHandler, library)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"
    passed = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                executable_path=os.environ.get("BROWSER_EXECUTABLE"),
                args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
            )
            errors = []

            def new_context(**options):
                context = browser.new_context(reduced_motion="reduce", **options)
                # This suite can never move a test file to trash or restore one.
                context.route("**/api/trash", lambda route: route.abort() if route.request.method == "POST" else route.continue_())
                context.route("**/api/restore", lambda route: route.abort())
                page = context.new_page()
                page.on("pageerror", lambda err: errors.append(str(err)))
                page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
                page.on("dialog", lambda dialog: dialog.accept("Test set") if dialog.type == "prompt" else dialog.accept())
                page.goto(url)
                page.wait_for_function("state.libraryReady && state.library.images.length > 0")
                return context, page

            def audit(page, label):
                axe = os.environ.get("AXE_SCRIPT")
                if not axe:
                    return
                page.add_script_tag(path=axe)
                violations = page.evaluate(
                    "async () => (await axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa']}})).violations"
                    ".map(v => ({id: v.id, targets: v.nodes.map(n => n.target)}))"
                )
                assert not violations, (label, violations)

            def shot(page, name):
                if args.shots:
                    args.shots.mkdir(parents=True, exist_ok=True)
                    page.add_style_tag(content=HIDE_MEDIA)
                    page.screenshot(path=str(args.shots / f"{name}.png"))

            context, page = new_context(viewport={"width": 1440, "height": 900})

            # 1. Every mode at every size: nothing clipped, nothing overflowing,
            # no buttons on top of video controls, hidden modes hold no media.
            issues = []
            for width, height in VIEWPORTS:
                page.set_viewport_size({"width": width, "height": height})
                for mode in MODES:
                    page.evaluate("(m) => setMode(m)", mode)
                    page.wait_for_timeout(120)
                    for focus in ((False, True) if mode not in ("home", "gallery", "ranked", "downloads", "bookmarks") else (False,)):
                        if focus:
                            page.evaluate("setFocusMode(true)")
                            page.wait_for_timeout(60)
                        issue = page.evaluate(LAYOUT_CHECK)
                        if issue["overflow"] or issue["clipped"] or issue["covering"] or issue["inactiveMedia"]:
                            issues.append((width, height, mode, focus, issue))
                        if width <= 767 and mode != "home" and not focus and issue["topbar"] > 64:
                            issues.append((width, height, mode, "topbar too tall", issue["topbar"]))
                        if focus:
                            page.evaluate("setFocusMode(false)")
            assert not issues, issues
            passed.append(f"{len(VIEWPORTS) * len(MODES)} mode/viewport layouts (normal + focus)")

            page.set_viewport_size({"width": 1440, "height": 900})
            page.evaluate("setMode('home')")
            audit(page, "overview dark")
            shot(page, "overview-desktop")

            # 2. Keyboard: number keys follow ALL_MODES, M opens the picker, A the controls.
            page.keyboard.press("1")
            assert page.evaluate("state.currentMode") == "swipe"
            page.keyboard.press("5")
            assert page.evaluate("state.currentMode") == "duel"
            page.keyboard.press("m")
            assert page.locator("#modeLauncher").is_visible()
            page.wait_for_timeout(250)
            audit(page, "mode picker")
            page.keyboard.press("Escape")
            page.wait_for_timeout(250)
            assert page.locator("#modeLauncher").is_hidden()
            page.keyboard.press("1")
            page.keyboard.press("a")
            assert page.evaluate("state.activeDrawer") == "swipe"
            # Docked at this width: the stage keeps its keys while the panel is open.
            assert page.evaluate("document.body.classList.contains('drawer-docked')")
            page.wait_for_function("controls.swipeImage.complete && controls.swipeImage.naturalWidth > 0")
            with page.expect_response("**/api/rating"):
                page.keyboard.press("ArrowRight")
            assert page.evaluate("state.history.swipe.length") == 1
            with page.expect_response("**/api/rating"):
                page.keyboard.press("u")
            page.wait_for_function("state.history.swipe.length === 0")
            page.keyboard.press("Escape")
            assert page.evaluate("state.activeDrawer") is None
            passed.append("keyboard map, docked controls, rate + undo")

            # 3. The control center: tabs, folder tree, only / invert / none / all, sets.
            page.evaluate(NEST_FOLDERS)
            page.evaluate("setMode('mosaic'); toggleDrawer('mosaic')")
            page.locator('#mosaicDrawer [data-tab="folders"]').click()
            assert page.locator("#mosaicFolderPanel").is_visible()
            assert page.locator("#mosaicTunePanel").is_hidden()
            groups = page.locator("#mosaicFolderFilters .fp-row.is-group")
            assert groups.count() >= 3, groups.count()
            total_folders = page.evaluate("state.library.folders.length")
            first_group = groups.first
            first_group.locator(".fp-only").click()
            only = page.evaluate("effectiveFolderSelection('mosaic').size")
            assert 0 < only < total_folders, only
            assert page.locator("#mosaicFolderBadge").inner_text() == f"{only}/{total_folders}"
            page.locator('#mosaicFolderPanel [data-fp="invert"]').click()
            assert page.evaluate("effectiveFolderSelection('mosaic').size") == total_folders - only
            page.locator("#mosaicFoldersNoneButton").click()
            assert page.evaluate("state.folderCleared.mosaic && effectiveFolderSelection('mosaic').size === 0")
            first_group.locator(".fp-toggle").click()
            assert page.evaluate("effectiveFolderSelection('mosaic').size") == only
            page.locator("#mosaicFolderPanel .fp-save").click()
            assert page.evaluate("state.settings.folderSets.some(s => s.name === 'Test set')")
            page.locator("#mosaicFoldersAllButton").click()
            assert page.locator("#mosaicFolderBadge").inner_text() == "All"
            page.locator("#mosaicFolderPanel .fp-set button").first.click()
            assert page.evaluate("effectiveFolderSelection('mosaic').size") == only
            audit(page, "control center folders")
            page.locator("#mosaicFolderSearch").fill(page.evaluate("state.library.folders[0].split('/').pop()"))
            page.wait_for_timeout(250)
            assert page.locator("#mosaicFolderFilters .fp-row").count() >= 1
            page.locator("#mosaicFoldersSyncButton").click()
            assert page.evaluate("normalizedFolderSelection('duelFolders').length") == only
            page.locator("#mosaicFoldersAllButton").click()
            page.locator("#mosaicFoldersSyncButton").click()
            page.locator('#mosaicDrawer [data-tab="tune"]').click()
            assert page.locator("#mosaicTunePanel").is_visible()
            audit(page, "control center tune")
            page.keyboard.press("Escape")
            passed.append("control center tabs, folder tree, only/invert/none/all, saved sets, copy to every mode")

            # 4. Escalation absorbed Stream: Steady preset turns the ramp off and adds corner clips.
            page.evaluate("setMode('escalation'); toggleDrawer('escalation')")
            page.locator('#escalationPreset [data-preset="steady"]').click()
            assert page.evaluate("state.settings.escalationRamp") is False
            assert page.locator("#escalationRampControls").is_hidden()
            page.wait_for_function("document.querySelectorAll('#videoOverlay video').length === 2")
            page.wait_for_function("controls.escalationPhaseBadge.textContent === 'Steady'")
            page.locator('#escalationPreset [data-preset="standard"]').click()
            assert page.evaluate("state.settings.escalationRamp && state.settings.escalationCorners === 0")
            page.keyboard.press("Escape")
            passed.append("escalation steady/ramp presets + corner clips")

            # 5. Session: start, edge (instant hold), stop.
            page.evaluate("setMode('session')")
            page.locator("#sessionHudStart").click()
            assert page.evaluate("state.session.running")
            page.keyboard.press("e")
            assert page.evaluate("currentSessionPhase().kind") == "hold"
            assert page.evaluate("state.session.edges") == 1
            page.keyboard.press(" ")
            assert not page.evaluate("state.session.running")
            passed.append("session start / edge / stop")

            # 6. Duel: pick, the ranking moves, undo restores it.
            page.evaluate("setMode('duel'); setRatingFilter('duel', 'all')")
            page.wait_for_function("duel.pair.length === 2")
            left = page.evaluate("duel.pair[0].path")
            with page.expect_response("**/api/duel"):
                page.keyboard.press("ArrowLeft")
            page.wait_for_function("(p) => duel.ratings[p] && duel.ratings[p].r > 1500", arg=left)
            with page.expect_response("**/api/duel-restore"):
                page.keyboard.press("u")
            page.wait_for_function("(p) => !duel.ratings[p]", arg=left)
            passed.append("duel pick + undo")

            # 7. Rediscover: never-seen first, keep saves, seen times reach the server.
            page.evaluate("setMode('rediscover')")
            page.wait_for_function("rediscover.items.length > 0")
            assert page.locator("#rediscoverBadge").inner_text() == "Never seen"
            with page.expect_response("**/api/rating"):
                page.keyboard.press("ArrowRight")
            with page.expect_response("**/api/seen"):
                page.evaluate("flushSeen()")
            assert library.seen_payload(), "seen times were not stored"
            passed.append("rediscover order, keep, seen tracking")

            # 8. Gallery: video tiles get a still, which the server then keeps.
            page.evaluate("setMode('gallery'); setRatingFilter('gallery', 'all'); state.settings.galleryKind = 'videos'; renderGallery(true)")
            with page.expect_response(lambda r: "/api/thumb" in r.url and r.status == 200, timeout=30000):
                pass
            page.wait_for_function("document.querySelectorAll('#galleryGrid .gallery-tile.has-thumb').length > 0", timeout=30000)
            stored = page.evaluate("fetch(thumbUrl(document.querySelector('.gallery-tile.has-thumb').dataset.path)).then(r => r.status)")
            assert stored == 200, stored
            page.locator("#galleryGrid .gallery-tile").first.click()
            assert page.locator("#galleryLightbox").is_visible()
            assert page.locator("#lightboxCount").inner_text().startswith("1 /")
            page.keyboard.press("ArrowRight")
            assert page.locator("#lightboxCount").inner_text().startswith("2 /")
            page.keyboard.press("Escape")
            assert page.locator("#galleryLightbox").is_hidden()
            page.evaluate("state.settings.galleryKind = 'all'; renderGallery(true)")
            passed.append("gallery video thumbnails generated + stored, preview navigation")

            # 9. Themes.
            page.evaluate("setMode('home')")
            page.locator("#themeButton").click()
            for theme in ("velvet", "light", "dark"):
                page.locator(f'[data-theme-choice="{theme}"]').click()
                assert page.locator("body").get_attribute("data-theme") == theme
                audit(page, f"settings {theme}")
            page.keyboard.press("Escape")
            passed.append("three themes")
            context.close()

            # 10. Touch: phone layout, swipe gestures, sheet drag-to-close, preview swipes.
            mobile, touch = new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
            touch.locator('.home-mode[data-mode="swipe"]').tap()
            touch.wait_for_function("controls.swipeImage.complete && controls.swipeImage.naturalWidth > 0")
            cdp = mobile.new_cdp_session(touch)

            def drag(selector, dx, dy):
                box = touch.locator(selector).bounding_box()
                x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
                for step in range(1, 9):
                    cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + dx * step / 8, "y": y + dy * step / 8}]})
                    touch.wait_for_timeout(25)
                cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                touch.wait_for_timeout(400)

            drag("#swipeCard", 180, 0)
            touch.wait_for_function("state.history.swipe.length === 1 && state.history.swipe[0].kind === 'rate'")
            drag("#swipeCard", 0, 200)
            touch.wait_for_function("state.history.swipe.length === 2 && state.history.swipe[1].kind === 'skip'")
            touch.locator("#swipeDrawerToggle").tap()
            touch.wait_for_timeout(350)
            assert touch.evaluate("state.activeDrawer") == "swipe"
            drag("#swipeDrawer .drawer-header", 0, 160)
            assert touch.evaluate("state.activeDrawer") is None
            touch.locator("#modeMenuButton").tap()
            touch.locator('.launcher-card[data-mode="gallery"]').tap()
            touch.wait_for_timeout(250)
            touch.locator("#galleryGrid .gallery-tile").first.tap()
            before = touch.evaluate("state.gallery.lightboxIndex")
            drag("#galleryLightbox .lightbox-media", -200, 0)
            assert touch.evaluate("state.gallery.lightboxIndex") == before + 1
            drag("#galleryLightbox .lightbox-media", 0, 220)
            assert touch.locator("#galleryLightbox").is_hidden()
            passed.append("touch: deck swipes, sheet drag-to-close, preview swipes")
            mobile.close()

            # 11. Phone held sideways: stage modes go full screen.
            land, sideways = new_context(viewport={"width": 844, "height": 390}, is_mobile=True, has_touch=True)
            sideways.evaluate("setMode('toktinder')")
            assert sideways.evaluate("document.body.classList.contains('immersive')")
            box = sideways.locator("#toktinderCard").bounding_box()
            assert box["height"] > 360, box
            sideways.evaluate("setMode('home')")
            assert not sideways.evaluate("document.body.classList.contains('immersive')")
            passed.append("landscape phone full-screen stages")
            land.close()

            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
    print("PASS:\n  " + "\n  ".join(passed))
