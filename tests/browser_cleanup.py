"""Browser checks for the Dangerous section: Grid, Junk, Look-alikes and Folders,
and Swipe's order, Love, frame strip, speed, goal and Blitz. Files are really
moved to trash and brought back with Undo, on a temporary copy of three
test-library folders (the test library itself is never written to). A resized
look-alike and a tiny "screenshot" are made in the browser from test pictures.
Last, the same Grid page against a server from before these modes.

Run: python3 tests/browser_cleanup.py --media-dir /mnt/edging-heaven/testing
Needs Playwright. BROWSER_EXECUTABLE optionally selects a Chromium binary.
"""
import argparse
import base64
import json
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright  # noqa: E402
import server as server_module  # noqa: E402
from server import AppServer, MediaLibrary, RequestHandler  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--media-dir", type=Path, required=True)
args = parser.parse_args()
if args.media_dir.resolve() != Path("/mnt/edging-heaven/testing"):
    parser.error("This check is restricted to /mnt/edging-heaven/testing")
if not args.media_dir.is_dir():
    parser.error("The test library is unavailable")

passed = []


def check(label, condition, detail=""):
    assert condition, f"{label} failed. {detail}"
    passed.append(label)


def on_disk(root):
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and ".heaven-trash" not in p.parts}


with tempfile.TemporaryDirectory(prefix="heaven-cleanup-") as tmp:
    tmp = Path(tmp)
    folders = sorted(path for path in args.media_dir.iterdir() if path.is_dir())[:3]
    lib = tmp / "library"
    for folder in folders:
        shutil.copytree(folder, lib / folder.name)
    a, b, c = (folder.name for folder in folders)
    loose = lib / a / "Loose Files (Bunkr)"
    loose.mkdir()
    for n, picture in enumerate(sorted((lib / c).glob("*.jp*g"))[:3]):
        shutil.copy(picture, loose / f"loose_{n}.jpg")
    library = MediaLibrary(lib, tmp / "data" / "state.json")
    server = AppServer(("127.0.0.1", 0), RequestHandler, library)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"
    requests = []
    errors = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("BROWSER_EXECUTABLE"), args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        page = context.new_page()
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" and "Failed to load resource" not in msg.text else None)
        page.on("dialog", lambda dialog: dialog.accept())
        page.on("request", lambda request: requests.append(request.url.split(url, 1)[-1]) if request.method == "POST" else None)
        page.goto(url)
        page.wait_for_function("state.libraryReady && state.library.images.length > 0")

        # ---- a look-alike (60 % size, re-saved) and a tiny screenshot, made from a test picture
        original = f"{a}/{sorted(p.name for p in (lib / a).glob('*.jp*g'))[-1]}"
        made = page.evaluate("""async (path) => {
          const image = new Image(); image.src = mediaUrl(path); await image.decode();
          const small = document.createElement('canvas');
          small.width = Math.round(image.naturalWidth * 0.6); small.height = Math.round(image.naturalHeight * 0.6);
          small.getContext('2d').drawImage(image, 0, 0, small.width, small.height);
          const shot = document.createElement('canvas'); shot.width = 160; shot.height = 120;
          const g = shot.getContext('2d'); g.fillStyle = '#446'; g.fillRect(0, 0, 160, 120); g.fillStyle = '#fff'; g.fillRect(20, 20, 60, 40);
          return { small: small.toDataURL('image/jpeg', 0.7), shot: shot.toDataURL('image/png') };
        }""", original)
        copy = f"{a}/resaved_copy.jpg"
        shot = f"{b}/Screenshot-2025-10-19.png"
        (lib / copy).write_bytes(base64.b64decode(made["small"].split(",", 1)[1]))
        (lib / shot).write_bytes(base64.b64decode(made["shot"].split(",", 1)[1]))
        page.evaluate("() => rescanLibrary()")
        page.wait_for_function(f"state.library.images.some(i => i.path === {json.dumps(copy)})")

        # ---- the section
        nav = page.evaluate("""() => [...document.querySelectorAll('#workspaceLinks > *')]
          .map(n => n.classList.contains('nav-label') ? '#' + n.textContent : n.dataset.mode)""")
        at = nav.index("#Dangerous")
        check("the sidebar has a Dangerous section with five modes", nav[at + 1:at + 6] == ["dangerous", "dgrid", "djunk", "dsimilar", "dfolders"], nav)
        check("Sort & rate no longer holds a deleting mode", "dangerous" not in nav[nav.index("#Sort & rate"):at], nav)
        red = page.evaluate("""() => {
          const probe = document.createElement('i'); probe.style.color = 'var(--danger)'; document.body.append(probe);
          const want = getComputedStyle(probe).color; probe.remove();
          return ['dangerous', 'dgrid', 'djunk', 'dsimilar', 'dfolders'].every(m =>
            getComputedStyle(document.querySelector(`.workspace-link[data-mode="${m}"]`)).color === want);
        }""")
        check("every Dangerous entry is red", red)

        # ---- Grid: mark two, the other ten are kept, Undo brings all back
        page.evaluate("() => setMode('dgrid')")
        page.wait_for_function("el('dgridGrid').children.length > 0")
        tiles = page.evaluate("[...el('dgridGrid').children].map(t => t.dataset.path)")
        check("Grid deals a page of 12", len(tiles) == 12, len(tiles))
        page.click("#dgridGrid .sweep-tile:nth-child(1) .sweep-hit")
        page.click("#dgridGrid .sweep-tile:nth-child(3) .sweep-hit")
        check("tapping marks a tile", page.evaluate("el('dgridGrid').querySelectorAll('.is-marked').length") == 2)
        check("the button says what will happen", page.inner_text("#dgridCommit").strip() == "Delete 2 · keep 10", page.inner_text("#dgridCommit"))
        # Space on the focused tile is its own click: one toggle, not two.
        page.keyboard.press(" ")
        check("Space on a focused tile toggles it once", page.evaluate("el('dgridGrid').querySelectorAll('.is-marked').length") == 1)
        page.keyboard.press(" ")
        before = on_disk(lib)
        page.click("#dgridCommit")
        page.wait_for_function("!cleanup.busy && !el('dgridGrid').querySelector('.is-marked')")
        gone = before - on_disk(lib)
        check("the two marked files moved to the trash", gone == {tiles[0], tiles[2]}, gone)
        check("in one request", sum(1 for r in requests if r.startswith("/api/trash-many")) == 1, requests)
        check("the other ten are kept here", set(library.dangerous_kept_payload()) == set(tiles) - gone)
        nxt = page.evaluate("[...el('dgridGrid').children].map(t => t.dataset.path)")
        check("the next page follows", nxt and not set(nxt) & set(tiles))
        check("the meter counts it", "2 deleted" in page.inner_text("#dgridMode [data-cleanup-meter]"), page.inner_text("#dgridMode [data-cleanup-meter]"))
        page.evaluate("() => document.activeElement.blur()")
        page.keyboard.press("ArrowRight")
        page.keyboard.press("x")
        check("arrows and X mark from the keyboard", page.evaluate("[...el('dgridGrid').children].findIndex(t => t.classList.contains('is-marked'))") == 1)
        page.keyboard.press("x")
        page.click("#dgridUndo")
        page.wait_for_function(f"el('dgridGrid').children[0]?.dataset.path === {json.dumps(tiles[0])}")
        check("Undo puts the files back", on_disk(lib) == before)
        check("and forgets the keeps", library.dangerous_kept_payload() == {})
        check("and shows that page again, marked as it was",
              page.evaluate("[...el('dgridGrid').children].filter(t => t.classList.contains('is-marked')).map(t => t.dataset.path)") == [tiles[0], tiles[2]])
        page.click("#dgridGrid .sweep-tile:nth-child(2) .sweep-open")
        check("the corner button opens a file big", page.evaluate("!el('cleanupViewer').hidden"))
        page.click("#cleanupViewerMark")
        check("and can mark it there", page.evaluate(f"sweepState('dgrid').marked.has({json.dumps(tiles[1])})"))
        page.keyboard.press("Escape")
        check("Escape closes it", page.evaluate("el('cleanupViewer').hidden"))

        # ---- Look-alikes: fingerprints, a set with the original first, delete the copy
        page.evaluate("() => setMode('dsimilar')")
        page.wait_for_function("similar.built && !similar.running && !similar.building", timeout=90000)
        stored = json.loads((tmp / "data" / "fingerprints.json").read_text())
        photos = sum(1 for p in on_disk(lib) if p.endswith((".jpg", ".jpeg", ".png")))
        check("every photo is fingerprinted and saved on the server", len(stored) == photos, (len(stored), photos))
        sets = page.evaluate("similar.sets.map(s => s.items.map(i => i.path))")
        ours = [s for s in sets if copy in s]
        check("the re-saved copy is in a set with its original", ours and original in ours[0], sets)
        check("the original counts as the best copy", ours[0][0] == original, ours[0])
        page.evaluate(f"() => {{ similar.index = similar.sets.findIndex(s => s.items.some(i => i.path === {json.dumps(copy)})); pickSetDefaults(); renderSimilar(); }}")
        check("only the best copy is kept by default", page.evaluate("[...similar.keep]") == [original])
        page.click(f'#dsimilarGrid .sweep-tile[data-path="{copy}"] .sweep-hit')
        check("tapping switches a copy to keep", page.evaluate(f"similar.keep.has({json.dumps(copy)})"))
        page.click(f'#dsimilarGrid .sweep-tile[data-path="{copy}"] .sweep-hit')
        page.click(f'#dsimilarGrid .sweep-tile[data-path="{original}"] .sweep-hit')
        check("the last kept copy cannot be marked too", page.evaluate(f"similar.keep.has({json.dumps(original)})"))
        before = on_disk(lib)
        page.click("#dsimilarCommit")
        page.wait_for_function("!cleanup.busy")
        check("Delete removes the copies and keeps the best", before - on_disk(lib) == {copy} and original in on_disk(lib))
        check("the set is done", not page.evaluate(f"similar.sets.some(s => s.items.some(i => i.path === {json.dumps(copy)}))"))
        page.click("#dsimilarUndo")
        page.wait_for_function(f"currentSet()?.items.some(i => i.path === {json.dumps(copy)})")
        check("Undo brings the copy and its set back", copy in on_disk(lib))
        reloaded = MediaLibrary(lib, tmp / "data" / "state.json")
        check("fingerprints survive a restart", len(reloaded.fingerprints_payload()) == photos)

        # ---- Junk: the screenshot comes first, with its reasons
        page.evaluate("() => setMode('djunk')")
        page.wait_for_function("el('djunkGrid').children.length > 0")
        first = page.evaluate("el('djunkGrid').children[0].dataset.path")
        badges = page.evaluate("[...el('djunkGrid').children[0].querySelectorAll('.sweep-badge')].map(b => b.textContent)")
        check("Junk shows the likeliest junk first", first == shot, first)
        check("with why it is there", {"Low resolution 160×120", "Screenshot"} <= set(badges) and any(b.startswith("Tiny file, ") for b in badges), badges)
        check("nothing is marked for you", page.evaluate("el('djunkGrid').querySelectorAll('.is-marked').length") == 0)
        page.click("#djunkGrid .sweep-tile:nth-child(1) .sweep-hit")
        page.click("#djunkCommit")
        page.wait_for_function("!cleanup.busy")
        check("marking and Delete removes it", shot not in on_disk(lib))

        # ---- Folders: keep and undo, delete and undo
        # Junk kept what it left unmarked; start the folders from a clean slate.
        page.evaluate("async () => { const paths = [...dangerousKept.paths]; await postJson('/api/dangerous-kept', { paths, kept: false }); dangerousKept.paths.clear(); }")
        page.evaluate("() => setMode('dfolders')")
        page.wait_for_function("folderSweep.list.length > 0 && !el('dfoldersHead').hidden")
        sizes = page.evaluate("folderSweep.list.map(g => g.bytes)")
        check("folders come biggest first", sizes == sorted(sizes, reverse=True), sizes)
        check("a subfolder is its own decision", page.evaluate(f"folderSweep.list.some(g => g.folder === {json.dumps(a + '/Loose Files (Bunkr)')})"))
        page.evaluate(f"() => {{ folderSweep.index = folderSweep.list.findIndex(g => g.folder === {json.dumps(a + '/Loose Files (Bunkr)')}); pickFolderSamples(); renderFolders(); }}")
        check("it shows samples and the model", page.evaluate("el('dfoldersGrid').children.length") == 3 and page.evaluate("el('dfoldersModel').textContent") == a, page.evaluate("[el('dfoldersGrid').children.length, el('dfoldersModel').textContent]"))
        loose_files = {f"{a}/Loose Files (Bunkr)/loose_{n}.jpg" for n in range(3)}
        page.click("#dfoldersKeep")
        page.wait_for_function("!cleanup.busy")
        check("Keep folder keeps every file in it", loose_files <= set(library.dangerous_kept_payload()))
        page.click("#dfoldersUndo")
        page.wait_for_function(f"currentFolder()?.folder === {json.dumps(a + '/Loose Files (Bunkr)')}")
        check("Undo forgets those keeps", not loose_files & set(library.dangerous_kept_payload()))
        requests.clear()
        page.click("#dfoldersDelete")
        page.wait_for_function("!cleanup.busy")
        check("Delete folder (after the confirm) moves every file", not loose_files & on_disk(lib))
        page.click("#dfoldersUndo")
        page.wait_for_function("!cleanup.busy && currentFolder() !== null")
        page.wait_for_function(f"currentFolder()?.folder === {json.dumps(a + '/Loose Files (Bunkr)')}")
        check("Undo restores the whole folder in one request", loose_files <= on_disk(lib) and sum(1 for r in requests if r.startswith("/api/restore-many")) == 1, requests)
        page.click("#dfoldersToGrid")
        page.wait_for_function("state.currentMode === 'dgrid' && el('dgridGrid').children.length > 0")
        check("Sort in Grid opens just that folder", set(page.evaluate("[...el('dgridGrid').children].map(t => t.dataset.path)")) == loose_files)

        # ---- Swipe: order, Love, frame strip, speed, goal, Blitz
        page.evaluate("() => { state.settings.dgridFolders = []; state.settings.dangerousHideKept = false; state.settings.dangerousKind = 'all'; state.settings.dangerousOrder = 'biggest'; setMode('dangerous'); startDangerous(true); }")
        page.wait_for_function("dangerous.items.length > 0")
        sizes = page.evaluate("dangerous.items.map(i => i.size)")
        check("Biggest first deals the biggest file first", sizes == sorted(sizes, reverse=True))
        page.evaluate("() => { state.settings.dangerousOrder = 'junk'; startDangerous(true); }")
        check("Junk first starts with a suspect", page.evaluate("junkScore(dangerous.items[0]) >= junkScore(dangerous.items.at(-1)) && junkScore(dangerous.items[0]) > 0"))
        page.evaluate("() => { state.settings.dangerousOrder = 'random'; state.settings.dangerousKind = 'photo'; startDangerous(true); }")
        loved = page.evaluate("dangerous.items[dangerous.index].path")
        page.evaluate("() => document.activeElement.blur()")
        page.keyboard.press("ArrowUp")
        page.wait_for_function(f"dangerousKept.paths.has({json.dumps(loved)})")
        page.wait_for_timeout(200)
        check("↑ keeps and Loves", library.state["ratings"].get(loved) == "love")
        page.keyboard.press("u")
        page.wait_for_function(f"!dangerousKept.paths.has({json.dumps(loved)})")
        page.wait_for_timeout(200)
        check("Undo takes the Love back too", loved not in library.state["ratings"])
        check("the Love button is there", page.evaluate("!el('dangerousLove').hidden"))

        page.evaluate("() => { state.settings.dangerousKind = 'video'; startDangerous(true); }")
        page.wait_for_function("el('dangerousFrames').querySelectorAll('canvas').length === 6", timeout=45000)
        check("a clip gets a strip of six frames", True)
        page.click("#dangerousFrames .frame-cell:nth-child(4)")
        page.wait_for_timeout(300)
        duration = page.evaluate("el('dangerousVideo').duration")
        at = page.evaluate("el('dangerousVideo').currentTime")
        check("tapping a frame jumps there", abs(at - duration * 3.5 / 6) < 1.5, (at, duration))
        page.click("#dangerousSpeed")
        check("the speed button plays faster", page.evaluate("el('dangerousVideo').playbackRate") == 1.5)
        page.click("#dangerousSpeed")
        page.click("#dangerousSpeed")

        page.evaluate("() => { state.settings.cleanupGoalGb = 0.5; renderCleanupMeters(); }")
        check("a goal shows as a bar", page.evaluate("!!document.querySelector('#dangerousMode [data-cleanup-meter] .meter-bar')"))

        page.evaluate("() => document.activeElement.blur()")
        page.keyboard.press("b")
        check("B starts a Blitz", page.evaluate("blitz.running && !el('dangerousBlitz').hidden"))
        page.keyboard.press("ArrowRight")
        page.wait_for_function("blitz.count === 1 && !dangerous.busy")
        page.keyboard.press("ArrowRight")
        page.wait_for_function("blitz.count === 2 && !dangerous.busy")
        page.evaluate("() => { blitz.endsAt = Date.now() + 300; }")
        page.wait_for_function("!blitz.running", timeout=5000)
        toast = page.inner_text("#workspaceToast")
        check("it ends with a score", toast.startswith("Blitz over: 2 files"), toast)
        page.wait_for_timeout(1200)
        check("and keeps the best score", library.state["settings"].get("blitzBest") == 2, library.state["settings"].get("blitzBest"))

        check("no page errors", not errors, errors)

        # ---- on a phone: a few big tiles, and clips play in them
        phone = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, reduced_motion="reduce")
        mobile = phone.new_page()
        mobile.on("pageerror", lambda err: errors.append(str(err)))
        mobile.goto(url)
        mobile.wait_for_function("state.libraryReady && state.library.images.length > 0")
        mobile.evaluate("() => { state.settings.dgridHideKept = false; state.settings.dgridKind = 'all'; state.settings.dgridOrder = 'name'; setMode('dgrid'); }")
        mobile.wait_for_function("el('dgridGrid').children.length > 0")
        size = mobile.evaluate("""() => { const tiles = [...el('dgridGrid').children];
          const box = tiles[0].getBoundingClientRect();
          return { count: tiles.length, width: box.width, height: box.height,
                   columns: getComputedStyle(el('dgridGrid')).gridTemplateColumns.split(' ').length }; }""")
        check("a phone page is 4 big tiles in 2 columns", size["count"] == 4 and size["columns"] == 2 and size["width"] > 160 and size["height"] > 250, size)
        mobile.evaluate("() => { state.settings.dgridKind = 'videos'; refreshMode('dgrid'); }")
        mobile.wait_for_function("el('dgridGrid').querySelectorAll('.sweep-tile.is-playing').length >= 2", timeout=30000)
        clips = mobile.evaluate("""() => [...el('dgridGrid').querySelectorAll('.tile-clip')].map(v => ({ src: !!v.getAttribute('src'), muted: v.muted, paused: v.paused, t: v.currentTime }))""")
        check("clips play in their tiles, muted, from past the start",
              all(c["muted"] for c in clips) and sum(1 for c in clips if not c["paused"]) >= 2 and all(c["t"] > 0 for c in clips if c["src"]), clips)
        check("at most 4 play at once on a phone", sum(1 for c in clips if c["src"]) <= 4, clips)
        mobile.click("#dgridGrid .sweep-tile:nth-child(1) .sweep-open")
        check("opening one pauses the tiles", mobile.evaluate("[...el('dgridGrid').querySelectorAll('.tile-clip')].every(v => v.paused)"))
        mobile.click("#cleanupViewerClose")
        mobile.wait_for_function("[...el('dgridGrid').querySelectorAll('.tile-clip[src]')].some(v => !v.paused)", timeout=10000)
        check("and closing it plays them again", True)
        mobile.evaluate("() => { state.settings.cleanupPhoneTiles = 2; renderSweep('dgrid'); }")
        two = mobile.evaluate("({ n: el('dgridGrid').children.length, w: el('dgridGrid').children[0].getBoundingClientRect().width })")
        check("2 per page gives full-width tiles", two["n"] == 2 and two["w"] > 330, two)
        mobile.evaluate("() => { state.settings.cleanupClipPreviews = false; renderSweep('dgrid'); }")
        check("with clip previews off nothing streams", mobile.evaluate("[...el('dgridGrid').querySelectorAll('.tile-clip')].every(v => !v.getAttribute('src'))"))
        # Focus on every new mode: tiles fill the screen, the floating tools
        # never cover a tile's open button, and they do not fade.
        mobile.evaluate("() => { state.settings.cleanupClipPreviews = true; state.settings.cleanupPhoneTiles = 4; }")
        for mode in ("dgrid", "djunk", "dsimilar", "dfolders"):
            mobile.evaluate(f"() => setMode('{mode}')")
            mobile.wait_for_timeout(600)
            mobile.click(f"#{mode}FocusToggle")
            layout = mobile.evaluate("""(mode) => {
              const bar = document.querySelector('.topbar').getBoundingClientRect();
              const opens = [...document.querySelectorAll(`#${mode}Grid .sweep-open`)].map(b => b.getBoundingClientRect());
              const covered = opens.some(o => o.top < bar.bottom && o.bottom > bar.top && o.left < bar.right && o.right > bar.left);
              return { immersive: document.body.classList.contains('immersive'),
                       nav: getComputedStyle(document.querySelector('.workspace-nav')).display,
                       covered, tiles: opens.length,
                       overflow: document.documentElement.scrollWidth > innerWidth };
            }""", mode)
            check(f"{mode}: Focus goes full screen without covering a tile",
                  layout["immersive"] and layout["nav"] == "none" and not layout["covered"] and not layout["overflow"], layout)
            mobile.wait_for_timeout(3600)
            check(f"{mode}: its tools do not fade", float(mobile.evaluate("getComputedStyle(document.querySelector('.topbar')).opacity")) == 1)
            mobile.click(f"#{mode}FocusToggle")
            check(f"{mode}: and Focus comes back out", not mobile.evaluate("document.body.classList.contains('immersive')"))
        phone.close()
        check("no page errors on the phone", not errors, errors)

        # ---- the same page against a server from before these modes
        server_module.FEATURES.remove("cleanup")
        try:
            page.reload()
            page.wait_for_function("state.libraryReady && !state.features.has('cleanup')")
            page.evaluate("() => { state.settings.dgridHideKept = false; setMode('dgrid'); }")
            page.wait_for_function("el('dgridGrid').children.length > 0")
            target = page.evaluate("el('dgridGrid').children[0].dataset.path")
            requests.clear()
            page.click("#dgridGrid .sweep-tile:nth-child(1) .sweep-hit")
            page.click("#dgridCommit")
            page.wait_for_function("!cleanup.busy")
            check("an old server still deletes, one file per request",
                  target not in on_disk(lib) and "/api/trash" in requests and not any(r.startswith("/api/trash-many") for r in requests), requests)
            page.click("#dgridUndo")
            page.wait_for_function(f"el('dgridGrid').children[0]?.dataset.path === {json.dumps(target)}")
            check("and Undo restores one by one", target in on_disk(lib))
            page.evaluate("() => setMode('dsimilar')")
            page.wait_for_function("!el('dsimilarScan').hidden")
            check("Look-alikes says fingerprints will not be saved", "restart" in page.inner_text("#dsimilarScanNote"))
        finally:
            server_module.FEATURES.append("cleanup")
        check("no page errors on the old server", not errors, errors)
        browser.close()
    server.shutdown()

print("PASS:")
for label in passed:
    print(f"  {label}")
