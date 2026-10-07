"""Browser checks for Survivor and the Dangerous payoff (burn/shred, streak,
rewards, toy). Fake catalog only: no media files exist, /media is answered
with a generated flat-colour PNG, and every trash/restore call is answered by
the test itself, so nothing on any drive is touched.

Run: python3 tests/browser_thrill.py [screenshot dir]
Needs Playwright and websockets. BROWSER_EXECUTABLE selects a Chromium binary."""
import hashlib
import json
import os
import struct
import sys
import tempfile
import threading
import zlib
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="heaven-thrill-shots-"))
SHOTS.mkdir(exist_ok=True)
sys.path.insert(0, str(APP))
from playwright.sync_api import sync_playwright  # noqa: E402
from server import AppServer, MediaLibrary, RequestHandler  # noqa: E402
from websockets.sync.server import serve as ws_serve  # noqa: E402

passed = []


def check(label, condition, detail=""):
    if not condition:
        print("FAIL", label, detail)
        raise SystemExit(1)
    passed.append(label)
    print("ok  ", label)


def png(path):
    digest = hashlib.md5(path.encode()).digest()
    w, h = 64, 48
    rows = b""
    for y in range(h):
        rows += b"\x00" + bytes([digest[0], (digest[1] + y * 3) % 256, digest[2]]) * w
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


# ---- a fake Intiface server: records every ScalarCmd level ----
toy_levels = []


def intiface(ws):
    for raw in ws:
        for message in json.loads(raw):
            kind, body = next(iter(message.items()))
            if kind == "RequestServerInfo":
                ws.send(json.dumps([{"ServerInfo": {"Id": body["Id"], "ServerName": "fake", "MessageVersion": 3, "MaxPingTime": 0}}]))
            elif kind == "RequestDeviceList":
                ws.send(json.dumps([{"DeviceList": {"Id": body["Id"], "Devices": [{"DeviceIndex": 0, "DeviceName": "Fake toy", "DeviceMessages": {"ScalarCmd": [{"ActuatorType": "Vibrate"}]}}]}}]))
            elif kind == "ScalarCmd":
                toy_levels.append(body["Scalars"][0]["Scalar"])
                ws.send(json.dumps([{"Ok": {"Id": body["Id"]}}]))
            elif kind == "StopAllDevices":
                toy_levels.append(0)
                ws.send(json.dumps([{"Ok": {"Id": body["Id"]}}]))
            else:
                ws.send(json.dumps([{"Ok": {"Id": body.get("Id", 0)}}]))


ws_server = ws_serve(intiface, "127.0.0.1", 0)
threading.Thread(target=ws_server.serve_forever, daemon=True).start()
ws_port = ws_server.socket.getsockname()[1]

with tempfile.TemporaryDirectory(prefix="heaven-thrill-") as tmp:
    tmp = Path(tmp)
    (tmp / "library").mkdir()
    lib = MediaLibrary(tmp / "library", tmp / "data" / "state.json")
    images = []
    MB = 1024 * 1024
    # Big model: 12 photos of 100 MB; small model: 6 photos; a subfolder.
    for i in range(12):
        images.append({"path": f"Alpha/a{i:02d}.jpg", "folder": "Alpha", "size": 100 * MB, "mtime": 1000 + i})
    for i in range(4):
        images.append({"path": f"Alpha/Loose Files (Bunkr)/l{i}.jpg", "folder": "Alpha/Loose Files (Bunkr)", "size": 50 * MB, "mtime": 900 + i})
    for i in range(6):
        images.append({"path": f"Beta/b{i}.jpg", "folder": "Beta", "size": 10 * MB, "mtime": 800 + i})
    images.append({"path": "Gamma/loved.jpg", "folder": "Gamma", "size": 1 * MB, "mtime": 1, "rating": "love"})
    images.append({"path": "Gamma/loved2.jpg", "folder": "Gamma", "size": 1 * MB, "mtime": 2, "rating": "love"})
    lib.state["ratings"]["Gamma/loved.jpg"] = "love"
    lib.state["ratings"]["Gamma/loved2.jpg"] = "love"
    lib.catalog = {"images": images, "videos": [], "updatedAt": "x"}
    by_path = {item["path"]: item for item in images}
    server = AppServer(("127.0.0.1", 0), RequestHandler, lib)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"

    trashed = []      # every path the page asked to trash
    restored = []
    tokens = {}

    def route_media(route):
        from urllib.parse import urlparse, parse_qs
        path = parse_qs(urlparse(route.request.url).query)["path"][0]
        route.fulfill(status=200, content_type="image/png", body=png(path))

    def route_trash_many(route):
        body = json.loads(route.request.post_data)
        out = []
        for path in body["paths"]:
            token = f"t{len(tokens)}"
            tokens[token] = path
            trashed.append(path)
            out.append({"path": path, "token": token})
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "trashed": out, "failed": [], "updatedAt": f"u{len(trashed)}"}))

    def route_trash(route):
        body = json.loads(route.request.post_data)
        token = f"t{len(tokens)}"
        tokens[token] = body["path"]
        trashed.append(body["path"])
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "token": token, "path": body["path"], "updatedAt": "u"}))

    def route_restore_many(route):
        body = json.loads(route.request.post_data)
        items = []
        for token in body["tokens"]:
            path = tokens[token]
            restored.append(path)
            items.append({**by_path[path], "kind": "image"})
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "items": items, "failed": [], "updatedAt": "r"}))

    def route_restore(route):
        body = json.loads(route.request.post_data)
        path = tokens[body["token"]]
        restored.append(path)
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "path": path, "item": {**by_path[path], "kind": "image"}, "updatedAt": "r"}))

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("BROWSER_EXECUTABLE") or None)
        context = browser.new_context(viewport={"width": 1280, "height": 860})
        page = context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.route("**/media?*", route_media)
        page.route("**/api/trash-many", route_trash_many)
        page.route("**/api/trash", lambda r: route_trash(r) if r.request.method == "POST" else r.continue_())
        page.route("**/api/restore-many", route_restore_many)
        page.route("**/api/restore", route_restore)
        page.goto(url)
        page.wait_for_function("() => state.library && state.library.images && state.library.images.length > 0")
        page.evaluate("() => { state.audioUnlocked = false; }")

        # ---- the shell knows Survivor ----
        nav = page.eval_on_selector_all("#workspaceLinks .workspace-link", "els => els.map(e => e.dataset.mode)")
        check("Survivor is in the sidebar after Swipe", nav[nav.index("dangerous") + 1] == "survivor", nav)
        check("Survivor link is red like Dangerous", page.eval_on_selector('.workspace-link[data-mode="survivor"]', "e => getComputedStyle(e).color") == page.eval_on_selector('.workspace-link[data-mode="dangerous"]', "e => getComputedStyle(e).color"))
        sections = page.evaluate("() => DANGEROUS_MODES.map(m => document.querySelectorAll(`#${m}Drawer [data-setting=rewardEveryMb]`).length)")
        check("Rewards section in all six Dangerous drawers", sections == [1] * 6, sections)
        check("Survivor drawer has no folder-tree tab", page.locator("#survivorFolderPanel").count() == 0)

        # ---- Survivor ----
        page.click('.workspace-link[data-mode="survivor"]')
        page.wait_for_selector("#survivorArena:not([hidden])")
        check("Biggest model chosen by default", page.text_content("#survivorModel") == "Alpha")
        status = page.text_content("#survivorStatus")
        check("Status: round 1, 16 left down to 8", "Round 1" in status and "16 left, down to 8" in status, status)
        options = page.eval_on_selector_all("#survivorFolder option", "os => os.map(o => o.textContent)")
        check("Folder list: models, subfolder under its model, loved-only Gamma left out", options[0].startswith("Alpha") and "Loose Files" in options[1] and options[2].startswith("Beta") and not any(o.startswith("Gamma") for o in options), options)
        page.wait_for_function("() => [...document.querySelectorAll('#survivorArena img')].every(i => i.complete && i.naturalWidth)")
        page.screenshot(path=str(SHOTS / "survivor-desktop.png"))
        pair = page.evaluate("() => survivor.pair.map(i => i.path)")
        page.click("#survivorLeft")
        page.wait_for_selector(".burn-ghost", timeout=2000)
        check("Loser burns on a pick", page.locator(".burn-ghost").count() == 1)
        page.wait_for_timeout(280)
        page.screenshot(path=str(SHOTS / "survivor-burn.png"))
        page.wait_for_function("() => !survivor.busy")
        check("Right side (loser) went to trash", trashed == [pair[1]], trashed)
        check("Winner has one win", page.evaluate(f"() => survivor.wins.get({json.dumps(pair[0])})") == 1)
        check("Arena shrank to 15", page.evaluate("() => survivor.arena.length") == 15)
        loser_mb = f"{by_path[pair[1]]['size'] / MB:.1f} MB"
        check("Freed meter counts it", f"Freed {loser_mb}" in page.text_content("#survivorMode [data-cleanup-meter]"), loser_mb)
        # Undo
        page.click("#survivorUndo")
        page.wait_for_function("() => survivor.arena.length === 16")
        check("Undo restores the loser", restored == [pair[1]], restored)
        check("Undo takes the win back", page.evaluate(f"() => survivor.wins.get({json.dumps(pair[0])}) || 0") == 0)
        # Keys: ← → ↑ and X
        page.keyboard.press("ArrowRight")
        page.wait_for_function("() => !survivor.busy && survivor.arena.length === 15")
        page.keyboard.press("ArrowUp")
        page.wait_for_function("() => !survivor.busy")
        check("↑ both stay: nobody deleted, both got a win", page.evaluate("() => survivor.arena.length") == 15 and len(trashed) == 2)
        before = len(trashed)
        page.keyboard.press("x")
        page.wait_for_function("() => !survivor.busy && survivor.arena.length === 13")
        check("X both go: two deleted", len(trashed) == before + 2)
        check("Round 1 pairs the files with fewest wins first", page.evaluate("() => survivor.pair.every(i => (survivor.wins.get(i.path) || 0) === 0)"))

        # ---- the streak ----
        page.keyboard.press("ArrowLeft")
        page.wait_for_function("() => !survivor.busy")
        combo = page.evaluate("() => ({ hidden: el('thrillCombo')?.hidden, text: el('thrillCombo')?.textContent, streak: thrill.streak })")
        check("Quick deletes build a purge streak shown on screen", combo["streak"] >= 2 and combo["hidden"] is False and "×" in combo["text"], combo)

        # ---- rewards: 500 MB by default; Alpha files are 100 MB ----
        page.evaluate("() => { state.settings.rewardEveryMb = 250; queueSettingsSave(); thrillSettingChanged('rewardEveryMb'); }"); page.wait_for_timeout(400)
        given = page.evaluate("() => thrill.rewardsGiven")
        check("Changing the rate does not pay out what was freed before", given == page.evaluate("() => Math.floor(cleanup.freed / (250 * MB))"))
        page.keyboard.press("ArrowLeft")
        page.wait_for_function("() => !survivor.busy")
        page.keyboard.press("ArrowLeft")
        page.wait_for_function("() => !survivor.busy")
        page.keyboard.press("ArrowLeft")
        page.wait_for_function("() => !survivor.busy")
        page.wait_for_selector("#rewardOverlay:not([hidden])", timeout=3000)
        check("A reward plays once enough is freed", True)
        page.wait_for_function("() => el('rewardImage').complete && el('rewardImage').naturalWidth")
        src = page.get_attribute("#rewardImage", "src")
        check("Reward shows a Loved file", "Gamma%2Floved" in src, src)
        page.screenshot(path=str(SHOTS / "reward.png"))
        count = len(trashed)
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("x")
        page.wait_for_timeout(300)
        check("Keys during a reward never delete underneath", len(trashed) == count)
        page.keyboard.press("Escape")
        check("Escape ends the reward", page.is_hidden("#rewardOverlay"))
        page.evaluate("() => { thrill.banked = Math.max(thrill.banked, 1); syncRewardReady(); }")
        check("A waiting reward shows a Reward button in the tool bar", page.is_visible(".stage-toolbar[data-mode=survivor] [data-reward-play]"))
        page.screenshot(path=str(SHOTS / "reward-tool.png"))
        page.keyboard.press("r")
        page.wait_for_selector("#rewardOverlay:not([hidden])")
        check("R plays it; the button hides while it plays", page.is_hidden(".stage-toolbar[data-mode=survivor] [data-reward-play]"))
        page.click("#rewardDone")
        page.evaluate("() => { thrill.banked = 0; syncRewardReady(); }")
        # Undo does not earn twice
        given = page.evaluate("() => thrill.rewardsGiven")
        page.click("#survivorUndo")
        page.wait_for_function("() => !cleanup.busy && !survivor.busy")
        page.keyboard.press("ArrowLeft")
        page.wait_for_function("() => !survivor.busy")
        check("Delete, undo, delete again earns nothing new", page.evaluate("() => thrill.rewardsGiven") == given and page.is_hidden("#rewardOverlay"))

        # ---- run Survivor to the end on Beta (6 → 3) ----
        page.click("#survivorDrawerToggle")
        page.select_option("#survivorFolder", "Beta")
        page.keyboard.press("Escape")
        page.wait_for_function("() => survivor.start === 6 && survivor.target === 3")
        for _ in range(3):
            page.keyboard.press("ArrowLeft")
            page.wait_for_function("() => !survivor.busy")
        page.wait_for_selector("#survivorDone:not([hidden])")
        check("No Champion badge on a tie", page.locator("#survivorGrid .sweep-badge", has_text="Champion").count() == 0)
        check("Ends at the target with the survivors", page.locator("#survivorGrid .sweep-tile").count() == 3)
        page.screenshot(path=str(SHOTS / "survivor-done.png"))
        page.click("#survivorKeepLove")
        page.wait_for_function("() => survivor.settled")
        kept = page.evaluate("() => [...dangerousKept.paths].filter(p => p.startsWith('Beta/'))")
        loved = [p for p, r in lib.state["ratings"].items() if p.startswith("Beta/") and r == "love"]
        check("Keep all, Love the top 3: kept and loved on the server", len(loved) == 3 and len(kept) == 3, (kept, loved))
        page.click("#survivorUndo")
        page.wait_for_function("() => !survivor.settled && !survivor.busy && !cleanup.busy")
        loved = [p for p, r in lib.state["ratings"].items() if p.startswith("Beta/") and r == "love"]
        check("Undo takes the Loves back", loved == [], loved)
        page.click("#survivorCutAgain")
        check("Cut again: 3 down to 2", page.evaluate("() => [survivor.start, survivor.target]") == [3, 2])

        # ---- toy ----
        page.evaluate(f"() => {{ state.settings.toyUrl = 'ws://127.0.0.1:{ws_port}'; toyConnect(); }}")
        page.wait_for_function("() => toyConnected() && toy.devices.size")
        page.evaluate("() => { thrill.toyLevel = 0; state.settings.toyCleanup = 'delete'; state.settings.toyCleanupStep = 0.1; queueSettingsSave(); }"); page.wait_for_timeout(400)
        page.keyboard.press("ArrowLeft")  # Beta: 3 → 2, last fight
        page.wait_for_function("() => !survivor.busy")
        page.wait_for_timeout(250)
        level = page.evaluate("() => thrill.toyLevel")
        check("A delete pushes the toy up one step", abs(level - 0.1) < 1e-9, level)
        check("Intiface got the level (scaled by Max intensity 70%)", 0.07 in toy_levels, toy_levels[-5:])
        page.click('.workspace-link[data-mode="dangerous"]')
        page.wait_for_selector("#dangerousImage:not([hidden])")
        page.wait_for_function("() => el('dangerousImage').complete && el('dangerousImage').naturalWidth")
        page.keyboard.press("ArrowRight")  # keep
        page.wait_for_function("() => !dangerous.busy")
        check("A keep brings it down a step", abs(page.evaluate("() => thrill.toyLevel")) < 1e-9)
        page.evaluate("() => { state.settings.toyCleanup = 'keep'; queueSettingsSave(); }"); page.wait_for_timeout(400)
        page.keyboard.press("ArrowRight")
        page.wait_for_function("() => !dangerous.busy")
        check("Keeps mode: a keep pushes it up", abs(page.evaluate("() => thrill.toyLevel") - 0.1) < 1e-9)
        page.evaluate("() => { state.settings.toyCleanupHurry = true; queueSettingsSave(); armHurry(); }")
        page.wait_for_timeout(3300)
        check("Waiting over 3 s stops the toy", page.evaluate("() => thrill.toyIdle") and toy_levels[-1] == 0, toy_levels[-3:])
        page.keyboard.press("ArrowRight")
        page.wait_for_function("() => !dangerous.busy")
        check("Next decision resumes at half, plus a step", abs(page.evaluate("() => thrill.toyLevel") - 0.15) < 1e-9, page.evaluate("() => thrill.toyLevel"))
        page.evaluate("() => { state.settings.toyCleanupHurry = false; state.settings.toyCleanup = 'delete'; queueSettingsSave(); }"); page.wait_for_timeout(400)
        page.click('.workspace-link[data-mode="dgrid"]')
        page.wait_for_timeout(300)
        page.click('.workspace-link[data-mode="dangerous"]')
        check("Leaving the mode stopped the toy (quietAllModes)", 0 in toy_levels)

        # ---- Swipe: burn, shred, plain ----
        # An auto reward would (rightly) swallow the arrow keys below.
        page.evaluate("() => { state.settings.rewardEveryMb = 0; queueSettingsSave(); thrillSettingChanged('rewardEveryMb'); endReward(); }"); page.wait_for_timeout(400)
        page.wait_for_function("() => el('dangerousImage').complete && el('dangerousImage').naturalWidth")
        page.keyboard.press("ArrowLeft")
        page.wait_for_selector(".burn-ghost.is-burn", timeout=2000)
        check("Swipe delete burns the card", page.locator(".burn-ghost.is-burn canvas").count() == 1)
        page.wait_for_timeout(500)
        burn = page.evaluate("""() => {
          const ghost = document.querySelector('.burn-ghost.is-burn');
          if (!ghost) return null;
          const canvas = ghost.querySelector('canvas');
          const box = ghost.getBoundingClientRect(), outer = canvas.getBoundingClientRect();
          const scale = canvas.width / outer.width;
          const x = Math.round((box.left - outer.left) * scale), y = Math.round((box.top - outer.top) * scale);
          const w = Math.round(box.width * scale), h = Math.round(box.height * scale);
          const data = canvas.getContext('2d').getImageData(x, y, w, h).data;
          let gone = 0, fire = 0, picture = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 8) gone++;
            else if (data[i] > 200 && data[i + 1] > 60 && data[i + 2] < 140) fire++;
            else picture++;
          }
          const n = data.length / 4;
          return { gone: gone / n, fire: fire / n, picture: picture / n };
        }""")
        check("Mid-burn: part burnt away, a glowing edge, part still there", burn and burn["gone"] > 0.03 and burn["fire"] > 0.003 and burn["picture"] > 0.2, burn)
        page.screenshot(path=str(SHOTS / "swipe-burn.png"))
        page.wait_for_function("() => !document.querySelector('.burn-ghost')", timeout=4000)
        check("Burn cleans up after itself", True)
        page.wait_for_function("() => !dangerous.busy")
        check("Card shows again after the next file comes", not page.evaluate("() => el('dangerousCard').classList.contains('is-burnt')"))
        page.evaluate("() => { state.settings.thrillEffect = 'shred'; queueSettingsSave(); }"); page.wait_for_timeout(400)
        page.wait_for_timeout(1300)
        page.wait_for_function("() => el('dangerousImage').complete && el('dangerousImage').naturalWidth")
        page.keyboard.press("ArrowLeft")
        page.wait_for_selector(".burn-ghost.is-shred", timeout=2000)
        check("Shred lays one canvas over the card", page.locator(".burn-ghost.is-shred canvas").count() == 1)
        page.wait_for_timeout(150)
        page.screenshot(path=str(SHOTS / "swipe-shred.png"))
        page.wait_for_function("() => !dangerous.busy")
        page.evaluate("() => { state.settings.thrillEffect = 'off'; queueSettingsSave(); }"); page.wait_for_timeout(400)
        page.wait_for_timeout(1300)
        page.keyboard.press("ArrowLeft")
        page.wait_for_timeout(200)
        check("Plain: no ghost", page.locator(".burn-ghost").count() == 0, page.evaluate("() => [...document.querySelectorAll('.burn-ghost')].map(g => g.className + ' ' + g.style.cssText)"))
        page.evaluate("() => { state.settings.thrillEffect = 'burn'; queueSettingsSave(); }"); page.wait_for_timeout(400)

        # ---- Sounds: rendered offline, every effect with and without the moan ----
        levels = page.evaluate("""async () => {
          const out = {};
          for (const sound of ['moan', 'effects']) for (const effect of ['burn', 'shred', 'off']) {
            state.settings.thrillSound = sound;
            const context = new OfflineAudioContext(1, 44100 * 2.5, 44100);
            playDeleteSound(context, { effect, weight: 0.5, streak: 12, milestone: effect === 'burn' });
            const data = (await context.startRendering()).getChannelData(0);
            let peak = 0, sum = 0, bad = false;
            for (const v of data) { if (!Number.isFinite(v)) bad = true; peak = Math.max(peak, Math.abs(v)); sum += v * v; }
            out[sound + '/' + effect] = { peak, rms: Math.sqrt(sum / data.length), bad };
          }
          const context = new OfflineAudioContext(1, 44100 * 2.5, 44100);
          moan(context, 0, 1);
          const data = (await context.startRendering()).getChannelData(0);
          let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v));
          out.moanOnly = { peak };
          state.settings.thrillSound = 'moan';
          return out;
        }""")
        print("     sound levels:", {k: round(v["peak"], 2) for k, v in levels.items()})
        check("Every delete sound renders, audible and not clipping", all(not v.get("bad") and 0.05 < v["peak"] <= 1.0 for v in levels.values()), levels)
        check("The moan is a real part of the mix", levels["moanOnly"]["peak"] > 0.1, levels["moanOnly"])
        page.evaluate("() => { state.settings.thrillSound = true; sanitizePlaySettings(); }")
        check("Old on/off sound setting reads as Moan", page.evaluate("() => state.settings.thrillSound") == "moan")
        page.evaluate("() => { state.settings.thrillSound = false; sanitizePlaySettings(); }")
        check("Old off reads as Silent", page.evaluate("() => state.settings.thrillSound") == "off")
        page.evaluate("() => { state.settings.thrillSound = 'moan'; queueSettingsSave(); }"); page.wait_for_timeout(400)

        # ---- Grid: marked tiles burn on commit ----
        page.click('.workspace-link[data-mode="dgrid"]')
        page.wait_for_selector("#dgridGrid .sweep-tile")
        page.wait_for_function("() => [...document.querySelectorAll('#dgridGrid img')].slice(0, 3).every(i => i.complete && i.naturalWidth)")
        tiles = page.locator("#dgridGrid .sweep-tile .sweep-hit")
        tiles.nth(0).click()
        tiles.nth(1).click()
        page.click("#dgridCommit")
        page.wait_for_selector(".burn-ghost", timeout=2000)
        check("Grid: each marked tile burns", page.locator(".burn-ghost").count() == 2)
        page.wait_for_function("() => !cleanup.busy")

        # ---- settings: shared across drawers, saved on the server ----
        page.click("#dgridDrawerToggle")
        page.click('#dgridDrawer [data-setting="rewardSeconds"] [data-value="60"]')
        check("A payoff setting syncs every Dangerous drawer", page.evaluate("() => DANGEROUS_MODES.every(m => document.querySelector(`#${m}Drawer [data-setting=rewardSeconds] [data-value='60']`).classList.contains('active') || document.querySelector(`#${m}Drawer [data-setting=rewardSeconds] [data-value='60']`).getAttribute('aria-pressed') === 'true')"))
        page.wait_for_timeout(1500)
        check("…and is saved on the server", lib.state["settings"].get("rewardSeconds") == 60, lib.state["settings"].get("rewardSeconds"))
        check("Best streak is saved", lib.state["settings"].get("thrillBestStreak", 0) >= 2, lib.state["settings"].get("thrillBestStreak"))
        page.click('#dgridDrawer [data-setting="thrillSound"] [data-value="effects"]')
        page.wait_for_timeout(1500)
        check("Sound choice is a three-way control, saved on the server", lib.state["settings"].get("thrillSound") == "effects", lib.state["settings"].get("thrillSound"))
        page.locator('#dgridDrawer [data-setting="thrillSound"]').scroll_into_view_if_needed()
        page.screenshot(path=str(SHOTS / "drawer-feedback.png"))
        page.click('#dgridDrawer [data-setting="thrillSound"] [data-value="moan"]')
        page.keyboard.press("Escape")

        # ---- phone ----
        phone = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        mp = phone.new_page()
        mp.on("pageerror", lambda e: errors.append(str(e)))
        mp.route("**/media?*", route_media)
        mp.goto(url)
        mp.wait_for_function("() => state.library && state.library.images.length > 0")
        mp.evaluate("() => setMode('survivor')")
        mp.wait_for_selector("#survivorArena:not([hidden])")
        mp.wait_for_function("() => [...document.querySelectorAll('#survivorArena img')].every(i => i.complete && i.naturalWidth)")
        mp.screenshot(path=str(SHOTS / "survivor-phone.png"))
        width = mp.evaluate("() => document.documentElement.scrollWidth")
        check("Phone: no sideways scroll", width <= 390, width)
        mp.evaluate("() => { state.settings.rewardEveryMb = 500; thrill.banked = 2; syncRewardReady(); }")
        mp.screenshot(path=str(SHOTS / "reward-ready-phone.png"))
        mp.evaluate("() => playReward(false)")
        mp.wait_for_selector("#rewardOverlay:not([hidden])")
        mp.wait_for_timeout(400)
        mp.screenshot(path=str(SHOTS / "reward-phone.png"))
        mp.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
        browser.close()

    real_errors = [e for e in errors if "favicon" not in e]
    check("No page errors", not real_errors, real_errors)
    print(f"\n{len(passed)} checks passed")
ws_server.shutdown()
