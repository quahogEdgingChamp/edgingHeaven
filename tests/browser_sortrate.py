"""Sort & rate: Tune -> "Only files I kept in Dangerous" and "Move to trash" + Undo,
in the photo deck, video deck, Feed and Rediscover, in headless Chromium.

Trash runs against a temporary copy of two test-library folders, never the
test library itself.

Run: python3 tests/browser_sortrate.py --media-dir /mnt/edging-heaven/testing
"""
import argparse
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
from playwright.sync_api import sync_playwright  # noqa: E402
from server import AppServer, MediaLibrary, RequestHandler  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--media-dir", type=Path, required=True)
parser.add_argument("--shots", type=Path, default=None, help="Folder for screenshots")
args = parser.parse_args()
if args.media_dir.resolve() != Path("/mnt/edging-heaven/testing"):
    parser.error("This check is restricted to /mnt/edging-heaven/testing")
SRC = args.media_dir
OUT = args.shots
fails = []
def check(name, ok):
    print(("  ok   " if ok else "  FAIL ") + name)
    if not ok: fails.append(name)
with tempfile.TemporaryDirectory() as tmp:
    media = Path(tmp) / "media"
    folders = sorted(p for p in SRC.iterdir() if p.is_dir())[:2]
    for f in folders: shutil.copytree(f, media / f.name)
    lib = MediaLibrary(media, Path(tmp) / "data" / "state.json")
    cat = lib.library_payload()
    imgs, vids = [i["path"] for i in cat["images"]], [v["path"] for v in cat["videos"]]
    print(len(imgs), "images", len(vids), "videos")
    kept_imgs, kept_vids = imgs[:3], vids[:2]
    for p in kept_imgs + kept_vids: lib.set_dangerous_kept(p, True)
    lib.set_rating(kept_imgs[0], "like")
    srv = AppServer(("127.0.0.1", 0), RequestHandler, lib)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_port}"
    errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get("BROWSER_EXECUTABLE"), args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
        ctx = b.new_context(viewport={"width": 390, "height": 844}, reduced_motion="reduce", has_touch=True, is_mobile=True)
        pg = ctx.new_page(); pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(url); pg.wait_for_function("state.libraryReady")
        pg.add_style_tag(content="img, video { opacity: 0 !important; }")
        # --- the switch, each mode
        pg.evaluate("() => setMode('swipe')"); pg.wait_for_timeout(300)
        check("switch visible when server has dangerousKept", pg.evaluate("() => !el('swipeDangerKeptOnly').hidden"))
        n_all = pg.evaluate("() => state.swipeItems.length")
        pg.evaluate("() => toggleDrawer('swipe')"); pg.wait_for_timeout(300)
        pg.click("#swipeDangerKeptOnly"); pg.wait_for_timeout(500)
        deck = pg.evaluate("() => state.swipeItems.map((i) => i.path)")
        check(f"photo deck: only kept in Dangerous ({len(deck)} of {n_all})", sorted(deck) == sorted(kept_imgs))
        check("switch shows on", pg.get_attribute("#swipeDangerKeptOnly", "aria-checked") == "true")
        check("summary says so", "kept in Dangerous" in pg.inner_text("#swipeSummary"))
        pg.click('#swipeRatingFilter [data-rating-filter="unrated"]'); pg.wait_for_timeout(300)
        deck = pg.evaluate("() => state.swipeItems.map((i) => i.path)")
        check("combines with Show: Unrated", sorted(deck) == sorted(kept_imgs[1:]))
        pg.click('#swipeRatingFilter [data-rating-filter="all"]'); pg.wait_for_timeout(300)
        if OUT: pg.screenshot(path=str(OUT / "sortrate-drawer.png"))
        pg.evaluate("() => closeDrawers()")
        for mode in ("toktinder", "feed", "rediscover"):
            pg.evaluate(f"() => setMode('{mode}')"); pg.wait_for_timeout(700)
            pg.evaluate(f"() => setDangerKeptOnly('{mode}', true)"); pg.wait_for_timeout(700)
            got = pg.evaluate({"toktinder": "() => state.toktinderItems.map((i) => i.path)",
                               "feed": "() => state.feed.items.map((i) => i.path)",
                               "rediscover": "() => rediscover.items.map((i) => i.path)"}[mode])
            want = kept_vids if mode != "rediscover" else kept_imgs + kept_vids
            check(f"{mode}: only kept in Dangerous ({len(got)})", sorted(got) == sorted(want))
        # --- persists across a reload
        pg.wait_for_timeout(1500)
        pg.reload(); pg.wait_for_function("state.libraryReady"); pg.wait_for_timeout(800)
        check("settings survive a reload", pg.evaluate("() => DANGER_KEPT_MODES.every((m) => state.settings[`${m}DangerKeptOnly`])"))
        pg.evaluate("() => setMode('swipe')"); pg.wait_for_timeout(600)
        check("deck dealt with the switch after reload", sorted(pg.evaluate("() => state.swipeItems.map((i) => i.path)")) == sorted(kept_imgs))
        # --- trash + undo in each mode
        for mode, cur in (("swipe", "currentDeckItem('swipe')"), ("toktinder", "currentDeckItem('toktinder')"),
                          ("feed", "state.feed.items[state.feed.activeIndex]"), ("rediscover", "currentRediscoverItem()")):
            pg.evaluate(f"() => setMode('{mode}')"); pg.wait_for_timeout(800)
            path = pg.evaluate(f"() => {cur}?.path")
            count = pg.evaluate("() => state.library.images.length + state.library.videos.length")
            pg.evaluate(f"() => toggleDrawer('{mode}')"); pg.wait_for_timeout(300)
            pg.click(f"#{mode}TrashButton"); pg.wait_for_timeout(800)
            gone = pg.evaluate(f"(p) => !state.library.images.concat(state.library.videos).some((i) => i.path === p) && {cur}?.path !== p", path)
            check(f"{mode}: trash removes {path.split('/')[-1]} from the page", gone)
            check(f"{mode}: file left the folder", not (media / path).exists())
            check(f"{mode}: toast offers Undo", pg.is_visible("#workspaceToast .toast-action"))
            if mode == "swipe" and OUT: pg.screenshot(path=str(OUT / "sortrate-toast.png"))
            pg.evaluate("() => closeDrawers()"); pg.wait_for_timeout(200)
            pg.click("#workspaceToast .toast-action"); pg.wait_for_timeout(1000)
            check(f"{mode}: Undo restores the file", (media / path).exists())
            check(f"{mode}: and shows it again", pg.evaluate(f"() => {cur}?.path") == path)
            check(f"{mode}: library count back", pg.evaluate("() => state.library.images.length + state.library.videos.length") == count)
        check("no page errors", not errors)
        if errors: print(errors)
    print("FAILED:", fails) if fails else print("all passed")
sys.exit(1 if fails else 0)
