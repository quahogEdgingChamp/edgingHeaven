"""Browser checks for the PIN lock asking every time: on opening the page, and
after the page was hidden (another app or tab, the screen off), however
briefly. Fake catalog only: no media files exist, /media is answered with a
generated PNG, and the state lives in a temporary folder.

Run: python3 tests/browser_lock.py
Needs Playwright. BROWSER_EXECUTABLE selects a Chromium binary."""
import os
import struct
import sys
import tempfile
import threading
import zlib
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
from playwright.sync_api import sync_playwright  # noqa: E402
from server import AppServer, MediaLibrary, RequestHandler  # noqa: E402

PIN = "2468"
passed = []


def check(label, condition, detail=""):
    if not condition:
        print("FAIL", label, detail)
        raise SystemExit(1)
    passed.append(label)
    print("ok  ", label)


def png():
    w, h = 64, 48
    rows = (b"\x00" + b"\x80\x80\x80" * w) * h
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def enter_pin(page, pin=PIN):
    page.wait_for_selector("#lockScreen:not([hidden])", timeout=10000)
    for key in pin:
        page.click(f'#lockPad [data-key="{key}"]')
    page.click('#lockPad [data-key="ok"]')
    page.wait_for_function("state.libraryReady && el('lockScreen').hidden && !state.locked", timeout=10000)


def hide(page):
    """What the browser does when the phone switches to another app."""
    page.evaluate("""() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    }""")


def show(page):
    page.evaluate("""() => {
        delete document.hidden;
        delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
    }""")


def server_unlocked(context, url):
    return context.request.get(f"{url}/api/lock").json()["unlocked"]


with tempfile.TemporaryDirectory(prefix="heaven-lock-") as tmp:
    tmp = Path(tmp)
    (tmp / "library").mkdir()
    lib = MediaLibrary(tmp / "library", tmp / "data" / "state.json")
    images = [{"path": f"Alpha/a{i}.jpg", "folder": "Alpha", "size": 1000, "mtime": 1000 + i} for i in range(6)]
    lib.catalog = {"images": images, "videos": [], "updatedAt": "x"}
    lib.set_pin(PIN)
    server = AppServer(("127.0.0.1", 0), RequestHandler, lib)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("BROWSER_EXECUTABLE") or None)
        context = browser.new_context(viewport={"width": 412, "height": 915}, has_touch=True, is_mobile=True)
        context.route("**/media?*", lambda route: route.fulfill(status=200, content_type="image/png", body=png()))
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(url)
        enter_pin(page)
        check("a fresh browser asks for the PIN and it unlocks", server_unlocked(context, url))

        # ---- Opening the page again asks again, even seconds later
        page.reload()
        enter_pin(page)
        check("a reload asks for the PIN again", True)

        # ---- Leaving for another app, even for a moment
        hide(page)
        check("hiding the page covers it with the lock screen at once",
              page.evaluate("state.locked && !el('lockScreen').hidden"))
        page.wait_for_function("true", timeout=500)
        check("the server forgot this device on leaving", not server_unlocked(context, url))
        show(page)
        check("coming back still shows the lock screen", page.evaluate("state.locked && !el('lockScreen').hidden"))
        status = page.evaluate("fetch('/api/state').then(r => r.status)")
        check("the API refuses until the PIN is entered", status == 401, status)
        enter_pin(page)
        check("the PIN unlocks after coming back", server_unlocked(context, url))

        # ---- Another tab of the same browser cannot skip it either
        hide(page)
        other = context.new_page()
        other.on("pageerror", lambda error: errors.append(str(error)))
        other.goto(url)
        other.wait_for_selector("#lockScreen:not([hidden])", timeout=10000)
        check("a second tab after leaving shows the lock screen", other.evaluate("!state.libraryReady"))
        enter_pin(other)

        # ---- Closing the tab locks the server side too
        other.close()
        page.close()
        check("closing the tab leaves this device locked", not server_unlocked(context, url))

        # ---- The phone: the field never takes the focus (no keyboard over the pad)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url)
        page.wait_for_selector("#lockScreen:not([hidden])", timeout=10000)
        check("phone: the PIN field is not focused", page.evaluate("document.activeElement !== el('lockInput')"))
        enter_pin(page)
        page.close()

        # ---- A PC: the keyboard enters the PIN however it is typed
        desk = browser.new_context(viewport={"width": 1280, "height": 900})
        desk.route("**/media?*", lambda route: route.fulfill(status=200, content_type="image/png", body=png()))
        page = desk.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))

        def dots():
            return page.evaluate("document.querySelectorAll('#lockDots .filled').length")

        def unlocked():
            page.wait_for_function("state.libraryReady && el('lockScreen').hidden && !state.locked", timeout=10000)
            return True

        def key(k, code):
            # A key as a layout or Num Lock state sends it (the page only sees key and code).
            page.evaluate("([k, c]) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', "
                          "{ key: k, code: c, bubbles: true, cancelable: true }))", [k, code])

        # Typed straight away, while the page is still loading: nothing goes to the mode keys.
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("typeof state !== 'undefined' && state.locked", timeout=10000)
        mode = page.evaluate("state.currentMode")
        page.keyboard.type(PIN)
        check("PC: the lock is up before the library loads", page.evaluate("!state.libraryReady"))
        check("PC: digits typed at once fill the PIN, not the mode keys", dots() == 4 and page.evaluate("state.currentMode") == mode,
              (dots(), page.evaluate("state.currentMode"), mode))
        check("PC: the PIN field has the keyboard", page.evaluate("document.activeElement === el('lockInput')"))
        page.keyboard.press("Enter")
        check("PC: Enter unlocks", unlocked())

        # A wrong PIN: says so, empties, the field keeps the keyboard.
        page.reload()
        page.wait_for_selector("#lockScreen:not([hidden])", timeout=10000)
        page.keyboard.type("1111")
        page.keyboard.press("Enter")
        page.wait_for_function("el('lockMessage').textContent !== 'Enter your PIN'")
        check("PC: a wrong PIN empties the field and keeps the focus",
              dots() == 0 and page.input_value("#lockInput") == "" and page.evaluate("document.activeElement === el('lockInput')"))
        page.keyboard.press("Backspace")
        # Numpad with Num Lock off (keys say End, ArrowDown, …) and a top row that types symbols (AZERTY).
        for k, code in (("ArrowDown", "Numpad2"), ("'", "Digit4"), ("ArrowRight", "Numpad6"), ("_", "Digit8")):
            key(k, code)
        check("PC: Num Lock off and symbol rows still give digits", page.input_value("#lockInput") == PIN, page.input_value("#lockInput"))
        page.keyboard.press("Backspace")
        check("PC: Backspace deletes one", dots() == 3)
        page.keyboard.type("8")
        key("Enter", "NumpadEnter")
        check("PC: numpad Enter unlocks", unlocked())

        # After leaving the tab: a click elsewhere on the screen gives the field the keyboard back.
        hide(page)
        show(page)
        page.evaluate("document.activeElement.blur()")
        page.mouse.click(40, 40)
        check("PC: a click on the lock screen focuses the field", page.evaluate("document.activeElement === el('lockInput')"))
        page.keyboard.type(PIN)
        page.keyboard.press("Enter")
        check("PC: the keyboard unlocks after coming back", unlocked())
        desk.close()

        # ---- Without a PIN, hiding changes nothing
        lib.clear_pin()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url)
        page.wait_for_function("state.libraryReady", timeout=10000)
        hide(page)
        show(page)
        check("with no PIN set, leaving and coming back does not lock",
              page.evaluate("!state.locked && el('lockScreen').hidden"))

        check("no page errors", not errors, errors)
        browser.close()
    server.shutdown()

print(f"\n{len(passed)} checks passed")
