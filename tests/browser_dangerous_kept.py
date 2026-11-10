"""Browser checks for the Dangerous modes and files you already kept there.

"Hide files I already kept here" (Swipe, Grid, Junk; "…kept whole" in
Folders) comes back on by itself every time the app is opened, or unlocked
with the PIN after coming back to it. Switched off during a visit, Swipe
deals kept files after the ones not decided yet, and each one says so on
the card (a KEPT tag, and a note with one tap to hide them again).
Runs on a temporary copy of two synthetic test-library folders; trash is
never used.

Run: python3 tests/browser_dangerous_kept.py [--media-dir DIR]
Needs Playwright. BROWSER_EXECUTABLE optionally selects a Chromium binary.
"""
import argparse
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright  # noqa: E402
import synthetic_library  # noqa: E402
from server import AppServer, MediaLibrary, RequestHandler  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--media-dir", type=Path, default=None, help="a test library; default: build one (tests/synthetic_library.py)")
args = parser.parse_args()
# Only a marked test library is accepted, never the real one.
args.media_dir = synthetic_library.ensure(args.media_dir)

PIN = "2468"
SWITCHES = ["dangerousHideKept", "dgridHideKept", "djunkHideKept", "dfoldersHideKept"]
passed = []


def check(label, condition, detail=""):
    assert condition, f"{label} failed. {detail}"
    passed.append(label)


with tempfile.TemporaryDirectory(prefix="heaven-kept-") as tmp:
    tmp = Path(tmp)
    folders = sorted(path for path in args.media_dir.iterdir() if path.is_dir())[:2]
    lib = tmp / "library"
    for folder in folders:
        shutil.copytree(folder, lib / folder.name)
    model = folders[0].name
    library = MediaLibrary(lib, tmp / "data" / "state.json")
    server = AppServer(("127.0.0.1", 0), RequestHandler, library)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"
    errors = []
    trash_calls = []

    def server_switches():
        return {key: library.state["settings"][key] for key in SWITCHES}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("BROWSER_EXECUTABLE"), args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 412, "height": 915}, has_touch=True, is_mobile=True, reduced_motion="reduce")
        # Never trash anything, even by accident.
        context.route("**/api/trash", lambda route: (trash_calls.append(1), route.abort()))
        context.route("**/api/restore", lambda route: (trash_calls.append(1), route.abort()))

        def new_page():
            page = context.new_page()
            page.on("pageerror", lambda err: errors.append(str(err)))
            page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" and "Failed to load resource" not in msg.text else None)
            return page

        def open_swipe(page=None):
            page = page or new_page()
            page.goto(url)
            page.wait_for_function("state.libraryReady && state.library.images.length > 0")
            page.evaluate(f"() => {{ sortModelInDangerous({model!r}); }}")
            page.wait_for_function("state.currentMode === 'dangerous' && dangerousKept.loaded && dangerous.items.length > 0")
            return page

        def deck(page):
            return page.evaluate("dangerous.items.map(i => i.path)")

        def switch_all_off(page):
            # The way the switches do it: in the page, then saved.
            page.evaluate(f"() => {{ {SWITCHES!r}.forEach((key) => {{ state.settings[key] = false; }}); queueSettingsSave(); }}")
            page.wait_for_timeout(600)

        def wait_saved(page):
            # Settings are saved after a short debounce.
            page.wait_for_timeout(600)

        # ---- keep three files in Swipe, the way the phone does it
        page = open_swipe()
        files = deck(page)
        check("Sort in Dangerous deals only that model", files and all(p.startswith(model + "/") for p in files), files)
        check("hiding kept files is on after Sort in Dangerous", page.evaluate("state.settings.dangerousHideKept === true"))
        kept = []
        for _ in range(3):
            kept.append(page.evaluate("dangerous.items[dangerous.index].path"))
            page.click("#dangerousKeep")
            page.wait_for_function("!dangerous.busy")
        check("the keeps are saved on the server", set(kept) <= set(library.dangerous_kept_payload()), library.dangerous_kept_payload())
        check("a freshly kept file shows no KEPT tag (hiding is on)", page.evaluate("el('dangerousKeptTag').textContent === '' && el('dangerousKeptNote').hidden"))
        page.close()

        # ---- reopen with hiding on: the kept three never come back
        page = open_swipe()
        again = deck(page)
        check("reopened with hiding on: kept files are not dealt", not set(kept) & set(again), again)
        check("and every other file is", set(again) == set(files) - set(kept))
        check("no KEPT tag on an unsorted file", page.evaluate("el('dangerousKeptTag').textContent === '' && el('dangerousKeptNote').hidden"))

        # ---- switched off during a visit: kept files come last, and say so
        page.click("#dangerousDrawerToggle")
        page.click("#dangerousHideKept")
        check("the switch turns hiding off", page.evaluate("state.settings.dangerousHideKept === false && el('dangerousHideKept').getAttribute('aria-checked') === 'false'"))
        page.click("#dangerousDrawerClose")
        order = deck(page)
        n = len(order) - len(kept)
        check("with hiding off every file is dealt", set(order) == set(files), order)
        check("files not kept yet come first, kept ones last", set(order[:n]) == set(files) - set(kept) and set(order[n:]) == set(kept), order)
        check("an unsorted card has no KEPT tag", page.evaluate("el('dangerousKeptTag').textContent === '' && el('dangerousKeptNote').hidden"))
        page.evaluate(f"() => {{ dangerous.index = {n}; renderDangerous(); }}")
        check("a kept file says KEPT on the card", page.evaluate("el('dangerousKeptTag').textContent") == "KEPT")
        check("and the note with Hide kept files shows", page.evaluate("!el('dangerousKeptNote').hidden && el('dangerousKeptNote').offsetHeight > 0"))
        box = page.locator("#dangerousKeptNote").bounding_box()
        check("the note fits the phone screen", box and box["x"] >= 0 and box["x"] + box["width"] <= 412, box)
        page.screenshot(path=str(Path(os.environ.get("SHOT_DIR", tmp)) / "kept-note.png"))
        page.click("#dangerousKeptHide")
        check("Hide kept files turns hiding back on", page.evaluate("state.settings.dangerousHideKept === true && el('dangerousHideKept').getAttribute('aria-checked') === 'true'"))
        after = deck(page)
        check("and re-deals without the kept files", not set(kept) & set(after) and set(after) == set(files) - set(kept), after)
        check("the note is gone", page.evaluate("el('dangerousKeptNote').hidden && el('dangerousKeptTag').textContent === ''"))
        wait_saved(page)
        check("the server has hiding on again", library.state["settings"]["dangerousHideKept"] is True)

        # ---- all four switched off, then the app is opened again
        switch_all_off(page)
        check("all four are off on the server", not any(server_switches().values()), server_switches())
        page.close()
        page = new_page()
        page.goto(url)
        page.wait_for_function("state.libraryReady && state.library.images.length > 0")
        check("opening the app turns all four back on", page.evaluate(f"{SWITCHES!r}.every((key) => state.settings[key] === true)"))
        wait_saved(page)
        check("and saves that", all(server_switches().values()), server_switches())
        page.evaluate("() => setMode('dangerous')")
        page.wait_for_function("state.currentMode === 'dangerous' && dangerousKept.loaded && dangerous.items.length > 0")
        check("Swipe's switch shows on", page.evaluate("el('dangerousHideKept').getAttribute('aria-checked')") == "true")
        check("Swipe leaves the kept files out", not set(kept) & set(deck(page)), deck(page))
        page.evaluate("() => setMode('dgrid')")
        page.wait_for_function("state.currentMode === 'dgrid' && sweepState('dgrid').built")
        check("Grid's switch shows on", page.evaluate("document.querySelector('[data-setting=dgridHideKept]').getAttribute('aria-checked')") == "true")
        check("Grid leaves the kept files out", not set(kept) & set(page.evaluate("sweepState('dgrid').items.map(i => i.path)")))

        # ---- a switch turned off stays off for the rest of the visit
        page.evaluate("() => { state.settings.dgridHideKept = false; queueSettingsSave(); MODE_HANDLERS.dgrid.refresh(); }")
        page.wait_for_function("sweepState('dgrid').built")
        check("off during a visit, Grid shows kept files too", set(kept) <= set(page.evaluate("sweepState('dgrid').items.map(i => i.path)")))
        wait_saved(page)
        page.evaluate("() => loadState()")  # the connection poll's reload is not an opening
        check("a background reload leaves it off", page.evaluate("state.settings.dgridHideKept === false"))
        page.close()

        # ---- with a PIN: leaving the app and unlocking again counts as opening it
        library.set_pin(PIN)

        def enter_pin(page):
            page.wait_for_selector("#lockScreen:not([hidden])", timeout=10000)
            for key in PIN:
                page.click(f'#lockPad [data-key="{key}"]')
            page.click('#lockPad [data-key="ok"]')
            page.wait_for_function("state.libraryReady && el('lockScreen').hidden && !state.locked", timeout=10000)

        page = new_page()
        page.goto(url)
        enter_pin(page)
        page.wait_for_function("state.library.images.length > 0", timeout=10000)
        check("unlocking on open turns hiding on", page.evaluate(f"{SWITCHES!r}.every((key) => state.settings[key] === true)"))
        page.evaluate(f"() => {{ sortModelInDangerous({model!r}); }}")
        page.wait_for_function("state.currentMode === 'dangerous' && dangerousKept.loaded && dangerous.items.length > 0")
        page.evaluate("() => setDangerousHideKept(false)")
        page.evaluate("() => { state.settings.dgridHideKept = false; queueSettingsSave(); }")
        page.wait_for_timeout(600)
        check("switched off before leaving", set(kept) <= set(deck(page)))
        page.evaluate("""() => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        page.wait_for_selector("#lockScreen:not([hidden])")
        page.evaluate("() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }")
        page.evaluate("() => { window.reloaded = false; const load = loadState; loadState = async (options) => { const result = await load(options); window.reloaded = true; return result; }; }")
        enter_pin(page)
        # The lock screen goes before the state has reloaded behind it.
        page.wait_for_function("window.reloaded === true", timeout=10000)
        check("coming back and unlocking turns hiding on again", page.evaluate(f"{SWITCHES!r}.every((key) => state.settings[key] === true)"))
        page.wait_for_function("state.currentMode === 'dangerous' && dangerous.items.length > 0")
        check("and Swipe deals again without the kept files", not set(kept) & set(deck(page)), deck(page))
        check("the KEPT note is gone", page.evaluate("el('dangerousKeptNote').hidden"))
        page.evaluate("() => setMode('dgrid')")
        page.wait_for_function("state.currentMode === 'dgrid' && sweepState('dgrid').built")
        check("and Grid is dealt again without them", not set(kept) & set(page.evaluate("sweepState('dgrid').items.map(i => i.path)")))
        wait_saved(page)
        check("and the server has all four on", all(server_switches().values()), server_switches())

        check("nothing touched trash", not trash_calls)
        check("no page errors", not errors, errors)
        browser.close()
    server.shutdown()

print(f"{len(passed)} checks passed:")
for label in passed:
    print(f"  ok  {label}")
