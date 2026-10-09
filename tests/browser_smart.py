"""Smart order end to end in headless Chromium: the Order switch in each
drawer, scored decks with their "why", watch signals reaching watch.json,
more-like-this after a Love, Rediscover's revisit schedule, the duel log and
Ladder's fair ranking, and smart picks in the lean-back modes.

Runs against the synthetic library (read only: nothing is trashed); ratings
and watch rows go to a temporary data folder.

Run: python3 tests/browser_smart.py [--media-dir DIR]
"""
import argparse
import json
import os
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
from playwright.sync_api import sync_playwright  # noqa: E402
import synthetic_library  # noqa: E402
from server import AppServer, MediaLibrary, RequestHandler  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--media-dir", type=Path, default=None, help="a test library; default: build one (tests/synthetic_library.py)")
args = parser.parse_args()
media = synthetic_library.ensure(args.media_dir)
fails = []


def check(name, ok):
    print(("  ok   " if ok else "  FAIL ") + name)
    if not ok:
        fails.append(name)


with tempfile.TemporaryDirectory() as tmp:
    lib = MediaLibrary(media, Path(tmp) / "data" / "state.json")
    cat = lib.library_payload()
    images = [item["path"] for item in cat["images"]]
    # One model you keep everything from, one you pass on.
    liked = [p for p in images if p.startswith("alice_example/")]
    passed = [p for p in images if p.startswith("dana/")]
    for p in liked:
        lib.set_rating(p, "like")
    for p in passed:
        lib.set_rating(p, "dislike")
    srv = AppServer(("127.0.0.1", 0), RequestHandler, lib)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_port}"

    def api(path):
        with urllib.request.urlopen(url + path) as response:
            return json.loads(response.read())

    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("BROWSER_EXECUTABLE"),
                                     args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
        ctx = browser.new_context(viewport={"width": 1400, "height": 900}, reduced_motion="reduce")
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(url)
        pg.wait_for_function("state.libraryReady")

        # --- the switch
        pg.evaluate("() => setMode('swipe')")
        pg.wait_for_timeout(300)
        check("Order section shown (server has smart)", pg.evaluate("() => !document.querySelector('[data-smart-order=\"swipe\"]').hidden"))
        check("starts Shuffled", pg.evaluate("() => state.settings.swipeOrder") == "random")
        pg.evaluate("() => toggleDrawer('swipe')")
        pg.wait_for_timeout(300)
        pg.click('[data-smart-order="swipe"] [data-value="smart"]')
        pg.wait_for_timeout(600)
        check("click sets swipeOrder smart", pg.evaluate("() => state.settings.swipeOrder") == "smart")
        check("segment shows it", pg.get_attribute('[data-smart-order="swipe"] [data-value="smart"]', "aria-pressed") == "true"
              or "active" in (pg.get_attribute('[data-smart-order="swipe"] [data-value="smart"]', "class") or ""))
        check("summary says Smart order", "Smart order" in pg.inner_text("#swipeSummary"))
        check("status line carries a reason", " · " in pg.inner_text("#swipeStatus"))
        pg.evaluate("() => closeDrawers()")

        # --- the kept model leads, the passed one trails
        lead = pg.evaluate("""() => {
          const counts = { alice: 0, dana: 0 };
          for (let i = 0; i < 60; i += 1) {
            rebuildDeck('swipe');
            state.swipeItems.slice(0, 6).forEach((item) => {
              if (item.folder.startsWith('alice_example')) counts.alice += 1;
              if (item.folder.startsWith('dana')) counts.dana += 1;
            });
          }
          return counts;
        }""")
        check(f"kept model leads the deck {lead}", lead["alice"] > lead["dana"] * 2)
        check("passed model still appears (exploration)", lead["dana"] > 0)

        # --- watch signals: a quick skip and a slow look reach watch.json
        pg.evaluate("() => { rebuildDeck('swipe'); renderDeck('swipe'); }")
        first = pg.evaluate("() => currentDeckItem('swipe').path")
        pg.evaluate("() => skipDeckItem('swipe')")
        pg.wait_for_timeout(300)
        second = pg.evaluate("() => currentDeckItem('swipe').path")
        pg.wait_for_timeout(2800)
        pg.evaluate("() => skipDeckItem('swipe')")
        pg.evaluate("() => flushWatch()")
        pg.wait_for_timeout(500)
        watch = api("/api/watch")["watch"]
        check("quick skip stored as a skip", watch.get(first, {}).get("s") == 1)
        check("slow look stored, not a skip", watch.get(second, {}).get("v") == 1 and watch.get(second, {}).get("s") == 0
              and watch.get(second, {}).get("t", 0) >= 2.5)

        # --- leaving the mode is not a skip
        third = pg.evaluate("() => currentDeckItem('swipe').path")
        pg.evaluate("() => setMode('home')")
        pg.evaluate("() => flushWatch()")
        pg.wait_for_timeout(400)
        check("leaving the mode is not a skip", api("/api/watch")["watch"].get(third, {}).get("s") == 0)

        # --- Love pulls similar files forward
        pg.evaluate("() => setMode('swipe')")
        pg.wait_for_timeout(300)
        pg.evaluate("""() => {
          const deck = state.swipeItems;
          const at = deck.findIndex((item, i) => i >= state.swipeIndex && item.folder.startsWith('bella'));
          const [bella] = deck.splice(at, 1);
          deck.splice(state.swipeIndex, 0, bella);
          renderDeck('swipe');
        }""")
        pg.evaluate("() => rateDeckItem('swipe', 'love')")
        pg.wait_for_timeout(500)
        nxt = pg.evaluate("() => ({ folder: currentDeckItem('swipe').folder, why: smartWhy('swipe', currentDeckItem('swipe').path) })")
        check(f"after a Love the next card is like it {nxt}", nxt["folder"].startswith("bella") and nxt["why"] == "like one you just loved")
        check("status says why", "like one you just loved" in pg.inner_text("#swipeStatus"))

        # --- Feed in smart order
        pg.evaluate("() => { state.settings.feedOrder = 'smart'; smartOrderChanged('feed'); setMode('feed'); }")
        pg.wait_for_timeout(1200)
        folder_line = pg.inner_text(".feed-item-folder")
        check(f"feed shows a reason ({folder_line!r})", " · " in folder_line)
        check("feed has an open impression", pg.evaluate("() => watchState.open.has('feed')"))

        # --- Rediscover: a keep schedules a revisit
        pg.evaluate("() => { state.settings.rediscoverOrder = 'smart'; smartOrderChanged('rediscover'); setMode('rediscover'); }")
        pg.wait_for_timeout(1200)
        item = pg.evaluate("() => currentRediscoverItem()?.path")
        check("rediscover dealt", bool(item))
        check("rediscover status has a reason", " · " in pg.inner_text("#rediscoverStatus"))
        pg.evaluate("() => actRediscover('keep')")
        pg.wait_for_timeout(500)
        pg.evaluate("() => flushWatch()")
        pg.wait_for_timeout(500)
        row = api("/api/watch")["watch"].get(item, {})
        check(f"keep in Rediscover schedules a revisit in 7 days {row}", row.get("iv") == 7)

        # --- Duel log, undo, and Ladder ranked from every duel
        pg.evaluate("() => setMode('duel')")
        pg.wait_for_timeout(1200)
        pg.evaluate("() => pickDuelWinner(0)")
        pg.wait_for_timeout(1200)
        check("duel logged", len(api("/api/duel-log")["log"]) == 1)
        pg.evaluate("() => undoDuel()")
        pg.wait_for_timeout(800)
        check("undo removes it from the log", api("/api/duel-log")["log"] == [])
        for _ in range(3):
            pg.evaluate("() => pickDuelWinner(0)")
            pg.wait_for_timeout(1000)
        check("local log follows", pg.evaluate("() => duelLog.rows.length") == 3)
        pg.evaluate("() => { state.settings.ladderRank = 'fair'; setMode('ladder'); }")
        pg.wait_for_timeout(800)
        check("ladder Rank by shown", pg.evaluate("() => !document.querySelector('[data-smart-order=\"ladder\"]').hidden"))
        pg.evaluate("() => startLadder()")
        pg.wait_for_timeout(800)
        check("ladder runs ranked from every duel", pg.evaluate("() => ladder.running && ladderFair()"))
        pg.evaluate("() => stopLadder()")

        # --- lean-back modes pick in smart order without errors
        pg.evaluate("() => { ['escalation', 'session', 'mosaic', 'beat', 'spotlight'].forEach((m) => { state.settings[`${m}Order`] = 'smart'; }); }")
        for mode in ("escalation", "session", "mosaic"):
            pg.evaluate(f"() => setMode('{mode}')")
            pg.wait_for_timeout(1500)
        picked = pg.evaluate("() => smart.why.has('escalation') || smart.why.has('mosaic') || smart.why.has('session')")
        check("lean-back modes made smart picks", picked)
        model = pg.evaluate("() => surpriseModel(null)")
        check(f"Spotlight surprise picks a model ({model})", isinstance(model, str) and model != "")

        # --- persists over a reload, and Defaults resets it
        pg.evaluate("() => setMode('home')")
        pg.wait_for_timeout(600)
        pg.reload()
        pg.wait_for_function("state.libraryReady")
        check("smart order survives a reload", pg.evaluate("() => state.settings.swipeOrder") == "smart")
        pg.evaluate("() => resetModeSettings('swipe')")
        check("Defaults puts Shuffled back", pg.evaluate("() => state.settings.swipeOrder") == "random")

        # --- an older server (no 'smart') hides the switch and sends nothing
        pg.evaluate("() => { state.features.delete('smart'); syncSmartOrderControls(); }")
        check("hidden without server support", pg.evaluate("() => document.querySelector('[data-smart-order=\"swipe\"]').hidden"))
        check("smartOn off without server support", pg.evaluate("() => !smartOn('feed')"))

        check(f"no page errors {errors}", not errors)
        browser.close()
    srv.shutdown()

print("FAILED: " + ", ".join(fails) if fails else "all passed")
sys.exit(1 if fails else 0)
