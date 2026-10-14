"""Browser checks for download settings per model: which pages of one
model's thread, photos or videos, at most how many new files, newest first,
saved on the server for that model (POST /api/simp/rules) and applied by the
server to every download of it. Edited under Settings per model on the
Downloads page, and in the sheet behind Download settings on a model page,
Settings on a bookmark and on a known thread. Only shown when the server says
it keeps them (status.modelRules); jobs never carry option fields.

No media at all: the server runs from this checkout on an empty temporary
library and data folder, and every /api/simp/* request is answered by the
test, so no job ever runs and SimpCity is never contacted. Rule and job
requests are recorded and their payloads compared exactly.

Run: python3 tests/browser_downloads.py [screenshot dir]
Needs Playwright. BROWSER_EXECUTABLE optionally selects a Chromium binary;
AXE_SCRIPT optionally points to axe.min.js for WCAG checks in all three themes.
"""
import copy
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

APP = Path(__file__).resolve().parents[1]
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="heaven-downloads-shots-"))
SHOTS.mkdir(parents=True, exist_ok=True)
from playwright.sync_api import sync_playwright  # noqa: E402

GB = 1024**3
ALPHA = "https://simpcity.cr/threads/alpha.1/"
BETA = "https://simpcity.cr/threads/beta.2/"
GAMMA = "https://simpcity.cr/threads/gamma-ray.3/"
DELTA = "https://simpcity.cr/threads/delta.4/"
ZETA = "https://simpcity.cr/threads/zeta.6/"
ETA = "https://simpcity.cr/threads/eta-star.77/"
OPTION_FIELDS = {"threadPages", "only", "maxFiles", "order"}
passed = []


def check(label, condition, detail=""):
    if not condition:
        print("FAIL", label, detail)
        raise SystemExit(1)
    passed.append(label)
    print("ok  ", label)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


# ---- what the stubbed server says ----
RULES = {
    "delta": {"threadPages": "1-3", "only": "videos", "updatedAt": "2026-10-09T10:00:00Z"},
    "zeta": {"only": "images", "url": ZETA, "updatedAt": "2026-10-09T11:00:00Z"},
}
status = {
    "installed": True, "configured": True, "targetReady": True, "target": "/nowhere/downloads",
    "jobs": [], "failed": [], "later": [],
    "threads": [
        {"model": "alpha", "url": ALPHA, "lastPage": 12, "unreadPages": 0},
        {"model": "beta", "url": BETA, "lastPage": None, "unreadPages": 0},
        {"model": "delta", "url": DELTA, "lastPage": 12, "unreadPages": 9},
    ],
    "cookies": {"present": True}, "auth": {"ok": True},
    "freeBytes": 50 * GB, "reserveBytes": 0, "resumeBytes": 0,
    "rules": copy.deepcopy(RULES),
}
bookmarks = {
    "bookmarks": [
        {"model": "gamma-ray", "title": "Gamma Ray", "url": GAMMA, "previews": []},
        {"model": "alpha", "title": "Alpha", "url": ALPHA, "previews": []},
        {"model": "delta", "title": "Delta", "url": DELTA, "previews": []},
    ],
    "updatedAt": "2026-10-01T10:00:00Z", "complete": True,
}
posted = []        # every POST /api/simp/jobs body, in order
rule_posts = []    # every POST /api/simp/rules body, in order
fetched = []       # every GET path under /api/simp/
reject = {}        # threadPages value → 400 message, to test server errors


def slug(url):
    return re.sub(r"\.\d+$", "", url.rstrip("/").rsplit("/", 1)[-1])


def route_simp(route):
    request = route.request
    path = urlparse(request.url).path
    if request.method == "GET":
        fetched.append(path)
    if path == "/api/simp/status":
        body = status
    elif path == "/api/simp/bookmarks":
        body = bookmarks
    elif path == "/api/simp/rules" and request.method == "POST":
        payload = json.loads(request.post_data)
        rule_posts.append(payload)
        if payload.get("threadPages") in reject:
            route.fulfill(status=400, content_type="application/json", body=json.dumps({"error": reject[payload["threadPages"]]}))
            return
        model = payload.get("model") or slug(payload["url"])
        fields = {key: payload[key] for key in OPTION_FIELDS if key in payload}
        rules = status.setdefault("rules", {})
        if fields:
            rules[model] = {**fields, "updatedAt": "2026-10-10T12:00:00Z", **({"url": payload["url"]} if "url" in payload else {})}
        else:
            rules.pop(model, None)
        body = {"ok": True, "model": model, "rule": rules.get(model), "rules": rules}
    elif path == "/api/simp/jobs" and request.method == "POST":
        payload = json.loads(request.post_data)
        posted.append(payload)
        body = {"job": {"id": f"{len(posted):012x}", "label": f"Job {len(posted)}", "status": "queued", "action": payload["action"]}}
    else:
        body = {}
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


with tempfile.TemporaryDirectory(prefix="heaven-downloads-") as tmp:
    tmp = Path(tmp)
    (tmp / "media").mkdir()
    port = free_port()
    server = subprocess.Popen(
        [sys.executable, str(APP / "server.py"), "--data-dir", str(tmp / "data"), "--media-dir", str(tmp / "media"),
         "--port", str(port), "--host", "127.0.0.1"],
        cwd=APP, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"{url}/api/state", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise SystemExit(f"server did not start: {server.stderr.read().decode()[-2000:]}")

        errors = []
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get("BROWSER_EXECUTABLE") or None)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text and errors.append(m.text))
            confirms = []
            page.on("dialog", lambda d: (confirms.append(d.message), d.accept()))
            page.route("**/api/simp/**", route_simp)

            def load(rules_on):
                if rules_on:
                    status["modelRules"] = True
                else:
                    status.pop("modelRules", None)
                page.goto(url)
                page.wait_for_function("() => state.libraryReady && state.features.has('simp')")

            def downloads_page():
                page.evaluate("() => setMode('downloads')")
                page.wait_for_selector("#dlForms:not([hidden])")

            def wait_new(log, count_before):
                for _ in range(60):
                    if len(log) > count_before:
                        return log[-1]
                    page.wait_for_timeout(50)
                return None

            def dialog_open():
                page.wait_for_function("() => !el('dlDialog').hidden && el('dlDialog').classList.contains('open')")

            def dialog_closed():
                page.wait_for_function("() => el('dlDialog').hidden")

            def texts(selector):
                return page.eval_on_selector_all(selector, "ns => ns.map(n => n.textContent.trim())")

            def rule_row(model):
                return page.locator("#dlRules li", has=page.locator("strong", has_text=re.compile(f"^{re.escape(model)}$")))

            def thread_row(model):
                return page.locator("#dlThreads li", has=page.locator("strong", has_text=re.compile(f"^{re.escape(model)}$")))

            # ---------- an old server: no modelRules, nothing shown, nothing extra sent ----------
            load(False)
            downloads_page()
            check("Old server: no Settings per model", page.is_hidden("#dlRulesSection"))
            check("The per-job Options disclosures are gone", page.locator("#dlThreadMore, #dlBookmarksMore, details.dl-more").count() == 0)
            check("Old server: no Settings or readback on known threads",
                  page.locator("#dlThreads button", has_text="Settings").count() == 0 and page.locator("#dlThreads .dl-rule-brief").count() == 0)
            page.fill("#dlUrls", ALPHA)
            n = len(posted)
            page.click("#dlThreadGo")
            check("Old server: thread payload", wait_new(posted, n) == {"action": "thread", "urls": [ALPHA]}, posted[n:])
            n = len(posted)
            page.click("#dlBookmarksGo")
            check("Old server: bookmarks payload", wait_new(posted, n) == {"action": "bookmarks", "pages": "1", "limit": 0}, posted[n:])
            check("Old server: the confirm does not mention settings", "settings" not in confirms[-1], confirms[-1])
            page.evaluate("() => { setMode('ranked'); openModelPage('delta'); }")
            page.wait_for_selector("#modelUpdate:not([hidden])")
            check("Old server: New posts shown; Download settings and the rule line hidden",
                  page.is_hidden("#modelDownload") and page.is_hidden("#modelRule"))
            page.evaluate("() => setMode('bookmarks')")
            page.wait_for_selector("#bmGrid .bm-card")
            labels = texts("#bmGrid .bm-actions button")
            check("Old server: bookmarks have no Settings and no badge",
                  "Settings" not in labels and "Download" in labels and page.locator(".bm-rule").count() == 0, labels)

            # ---------- a server that keeps settings: the Downloads page ----------
            load(True)
            fetched.clear()
            downloads_page()
            page.wait_for_selector("#dlRulesSection:not([hidden])")
            check("Settings per model shown, right after the forms",
                  page.evaluate("() => el('dlForms').nextElementSibling.id") == "dlRulesSection")
            check("The bookmark list is not loaded until the chooser is used", "/api/simp/bookmarks" not in fetched, fetched)
            check("Saved settings listed with a readback",
                  [rule_row(m).locator(".subtle").text_content() for m in ("delta", "zeta")]
                  == ["Videos only · pages 1–3", "Photos only · not downloaded yet"])
            check("Known-thread row shows its settings",
                  thread_row("delta").locator(".dl-rule-brief").text_content() == "Downloads: videos only · pages 1–3"
                  and thread_row("alpha").locator(".dl-rule-brief").count() == 0)
            check("Known-thread rows have Settings",
                  thread_row("alpha").locator("button", has_text="Settings").get_attribute("aria-label") == "Download settings for alpha")
            check("Empty list hint hidden while there are settings", page.is_hidden("#dlRulesEmpty"))
            empty = page.evaluate("() => { const saved = downloads.status.rules; downloads.status.rules = {}; ruleEditor.listSignature = ''; renderModelRules();"
                                  " const shown = [!el('dlRulesEmpty').hidden, el('dlRulesEmpty').textContent, el('dlRules').children.length];"
                                  " downloads.status.rules = saved; renderModelRules(); return shown; }")
            check("Empty state explains settings per model", empty[0] and "Every download of that model then follows them" in empty[1] and empty[2] == 0, empty)

            # Jobs carry no options any more.
            page.fill("#dlUrls", f"{ALPHA}\n{BETA}")
            n = len(posted)
            page.click("#dlThreadGo")
            check("Thread links: plain payload", wait_new(posted, n) == {"action": "thread", "urls": [ALPHA, BETA]}, posted[n:])
            page.fill("#dlPages", "2")
            page.fill("#dlLimit", "3")
            n = len(posted)
            page.click("#dlBookmarksGo")
            check("Bookmarks: plain payload", wait_new(posted, n) == {"action": "bookmarks", "pages": "2", "limit": 3}, posted[n:])
            check("The confirm says models with settings follow them", "Models with download settings follow them (2 models)." in confirms[-1], confirms[-1])

            # ---------- the chooser ----------
            page.focus("#dlRuleModel")
            page.wait_for_function("() => [...el('dlRuleModelList').options].some((o) => o.value === 'gamma-ray')")
            check("Focusing the chooser loads bookmarks", "/api/simp/bookmarks" in fetched)
            options = page.eval_on_selector_all("#dlRuleModelList option", "os => os.map(o => o.value)")
            check("Suggestions: settings, known threads and bookmarks", options == ["alpha", "beta", "delta", "gamma-ray", "zeta"], options)
            page.fill("#dlRuleModel", "alp")
            check("A partial name shows no editor", page.is_hidden("#dlRuleEditor"))
            page.fill("#dlRuleModel", "alpha")
            page.wait_for_selector("#dlRuleEditor:not([hidden])")
            check("Editor: name and thread", page.text_content("#dlRuleName") == "alpha"
                  and page.text_content("#dlRuleMeta") == "simp has read 12 pages of this thread.")
            check("Editor: nothing saved, no Clear", "Nothing saved yet" in page.text_content("#dlRuleSaved") and page.is_hidden("#dlRuleClear"))
            check("Editor starts from defaults", page.text_content("#dlRuleEditor .dl-options-readback") == "Everything in the thread")
            page.fill("#dlRuleOptPages", "1-3, last 2")
            page.click("#dlRuleEditor .segment[data-only='videos']")
            page.fill("#dlRuleOptMax", "40")
            page.click("#dlRuleEditor .switch-row")
            readback = page.text_content("#dlRuleEditor .dl-options-readback")
            check("Readback in words", readback == "Pages 1–3, the last 2 · videos only · at most 40 new files · newest posts first", readback)
            pressed = page.eval_on_selector_all("#dlRuleEditor .segment", "bs => bs.map(b => b.getAttribute('aria-pressed'))")
            check("Segmented buttons carry aria-pressed", pressed == ["false", "false", "true"], pressed)
            check("Newest first is a checked switch", page.get_attribute("#dlRuleEditor .switch-row", "aria-checked") == "true")
            check("Nothing stored in the browser", page.evaluate("() => localStorage.getItem('eh.downloadOptions')") is None)
            n, j = len(rule_posts), len(posted)
            page.click("#dlRuleSave")
            check("Save: rule payload by model", wait_new(rule_posts, n)
                  == {"model": "alpha", "threadPages": "1-3,last 2", "only": "videos", "maxFiles": 40, "order": "newest"}, rule_posts[n:])
            page.wait_for_selector("#dlRuleClear:not([hidden])")
            check("Save starts no job", len(posted) == j)
            check("Saved line and list updated",
                  page.text_content("#dlRuleSaved") == "Saved: videos only · pages 1–3, the last 2 · at most 40 new files · newest posts first."
                  and rule_row("alpha").count() == 1)
            check("Known-thread row updated after the save",
                  thread_row("alpha").locator(".dl-rule-brief").text_content()
                  == "Downloads: videos only · pages 1–3, the last 2 · at most 40 new files · newest posts first")
            check("The editor shows what the server saved", page.input_value("#dlRuleOptPages") == "1-3,last 2")
            page.screenshot(path=str(SHOTS / "desktop-dark-rules.png"))

            # Bad page lists stop before anything is sent.
            for bad in ["abc", "3-1", "0", "last 0", "1;2"]:
                page.fill("#dlRuleOptPages", bad)
                n = len(rule_posts)
                page.click("#dlRuleSave")
                page.click("#dlRuleGo")
                page.wait_for_timeout(150)
                check(f"“{bad}” is refused before sending", len(rule_posts) == n and page.get_attribute("#dlRuleOptPages", "aria-invalid") == "true")
            check("…with a toast that says what works", "not a page list" in page.text_content("#workspaceToast"))
            check("…and an error readback", page.evaluate("() => document.querySelector('#dlRuleEditor .dl-options-readback').classList.contains('is-error')"))
            page.fill("#dlRuleOptMax", "2.5")
            page.fill("#dlRuleOptPages", "10-")
            check("A bad max is refused too", "whole number" in page.text_content("#dlRuleEditor .dl-options-readback"))
            page.fill("#dlRuleOptMax", "")
            check("Grammar: N- and a dash typed as an en dash",
                  page.evaluate("() => [parseThreadPages('10-').text, parseThreadPages('2–4').text, parseThreadPages(' All ').text, parseThreadPages('LAST 5, 1').text]")
                  == ["10-", "2-4", "", "last 5,1"])
            check("Readback: one page, to the end, last one",
                  page.evaluate("() => [threadPagesWords(parseThreadPages('4').parts), threadPagesWords(parseThreadPages('10-').parts), threadPagesWords(parseThreadPages('last 1').parts)]")
                  == ["Page 4", "Page 10 to the end", "The last page"])
            reject["9-"] = "threadPages: no such page"
            page.fill("#dlRuleOptPages", "9-")
            n = len(rule_posts)
            page.click("#dlRuleSave")
            page.wait_for_function("() => el('workspaceToast').textContent.includes('no such page')")
            check("A 400 from the server is shown", len(rule_posts) == n + 1)

            # Save and download: a known thread gets New posts.
            page.click("#dlRuleEditor .dl-options-foot .text-button")
            page.click("#dlRuleEditor .segment[data-only='images']")
            n, j = len(rule_posts), len(posted)
            page.click("#dlRuleGo")
            check("Save and download: rule first", wait_new(rule_posts, n) == {"model": "alpha", "only": "images"}, rule_posts[n:])
            check("…then New posts for a known thread", wait_new(posted, j) == {"action": "update", "model": "alpha"}, posted[j:])

            # Clear deletes the rule.
            page.wait_for_selector("#dlRuleClear:not([hidden])")
            n = len(rule_posts)
            page.click("#dlRuleClear")
            check("Clear sends the model alone", wait_new(rule_posts, n) == {"model": "alpha"}, rule_posts[n:])
            page.wait_for_selector("#dlRuleClear", state="hidden")
            check("…and it leaves the list and the editor", rule_row("alpha").count() == 0
                  and page.text_content("#dlRuleEditor .dl-options-readback") == "Everything in the thread")

            # A pasted thread link, for a model not downloaded yet.
            page.fill("#dlRuleModel", "https://simpcity.cr/threads/eta-star.77/page-3?x=1#post-9")
            page.wait_for_function("() => el('dlRuleName').textContent === 'eta-star'")
            check("A link names the folder", "From the thread link." in page.text_content("#dlRuleMeta")
                  and "simp has not read this thread yet." in page.text_content("#dlRuleMeta"))
            page.click("#dlRuleEditor .segment[data-only='videos']")
            page.fill("#dlRuleOptPages", "last 5")
            n, j = len(rule_posts), len(posted)
            page.click("#dlRuleGo")
            check("Link: rule saved by url", wait_new(rule_posts, n) == {"url": ETA, "threadPages": "last 5", "only": "videos"}, rule_posts[n:])
            check("…then the thread downloaded from the link", wait_new(posted, j) == {"action": "thread", "urls": [ETA]}, posted[j:])
            page.wait_for_function("() => [...document.querySelectorAll('#dlRules strong')].some((n) => n.textContent === 'eta-star')")
            check("…and listed", rule_row("eta-star").locator(".subtle").text_content() == "Videos only · the last 5 pages · not downloaded yet")

            # Names that match nothing; a bookmark's title.
            page.fill("#dlRuleModel", "nobody")
            page.press("#dlRuleModel", "Enter")
            check("An unknown name says so", "No model by that name" in page.text_content("#dlRuleHint") and page.is_hidden("#dlRuleEditor"))
            page.fill("#dlRuleModel", "Gamma Ray")
            page.wait_for_function("() => el('dlRuleName').textContent === 'gamma-ray'")
            check("A bookmark's title finds its model", page.text_content("#dlRuleHint") == "")

            # The list: Edit, Download, Remove.
            rule_row("zeta").locator("button", has_text="Edit").click()
            page.wait_for_function("() => el('dlRuleName').textContent === 'zeta'")
            check("Edit loads the model into the chooser", page.input_value("#dlRuleModel") == "zeta"
                  and page.get_attribute("#dlRuleEditor .segment[data-only='images']", "aria-pressed") == "true"
                  and page.evaluate("() => document.activeElement.id") == "dlRuleName")
            check("List buttons name the model", rule_row("zeta").locator("button", has_text="Remove").get_attribute("aria-label")
                  == "Remove the settings for zeta")
            j = len(posted)
            rule_row("zeta").locator("button", has_text="Download").click()
            check("Download a model with no known thread: its saved link", wait_new(posted, j) == {"action": "thread", "urls": [ZETA]}, posted[j:])
            j = len(posted)
            rule_row("delta").locator("button", has_text="Download").click()
            check("Download a model with a known thread: New posts", wait_new(posted, j) == {"action": "update", "model": "delta"}, posted[j:])
            n = len(rule_posts)
            rule_row("zeta").locator("button", has_text="Remove").click()
            check("Remove clears the rule", wait_new(rule_posts, n) == {"model": "zeta"}, rule_posts[n:])
            page.wait_for_function("() => ![...document.querySelectorAll('#dlRules strong')].some((n) => n.textContent === 'zeta')")
            check("…and the editor holding it shows defaults", page.is_hidden("#dlRuleClear")
                  and page.get_attribute("#dlRuleEditor .segment[data-only='']", "aria-pressed") == "true")

            # Settings on a known-thread row opens the sheet.
            thread_row("delta").locator("button", has_text="Settings").click()
            dialog_open()
            check("Known-thread Settings: the sheet for that model", page.text_content("#dlDialogTitle") == "delta"
                  and page.input_value("#dlDialogOptPages") == "1-3")
            page.fill("#dlDialogOptPages", "1-4")
            n = len(rule_posts)
            page.click("#dlDialogSave")
            dialog_closed()
            check("Sheet Save: rule payload", wait_new(rule_posts, n) == {"model": "delta", "threadPages": "1-4", "only": "videos"}, rule_posts[n:])
            check("Focus returns to the re-rendered Settings button",
                  page.evaluate("() => document.activeElement.dataset.ruleModel") == "delta")
            page.wait_for_function("() => [...document.querySelectorAll('#dlThreads .dl-rule-brief')].some((n) => n.textContent.endsWith('pages 1–4'))")

            # ---------- model page: Download settings ----------
            page.evaluate("() => { setMode('ranked'); openModelPage('delta'); }")
            page.wait_for_selector("#modelDownload:not([hidden])")
            check("Model page: the button says Download settings", page.text_content("#modelDownload").strip() == "Download settings")
            check("Model page: the rule is visible", page.text_content("#modelRule") == "Downloads: videos only · pages 1–4")
            page.click("#modelDownload")
            dialog_open()
            meta = page.text_content("#dlDialogMeta")
            check("Sheet says what simp knows and what is saved",
                  meta == "simp knows 12 pages of this thread; 9 of them not read yet. Saved: videos only · pages 1–4.", meta)
            check("Sheet filled from the rule, with Clear", page.input_value("#dlDialogOptPages") == "1-4"
                  and page.get_attribute("#dlDialog .segment[data-only='videos']", "aria-pressed") == "true" and page.is_visible("#dlDialogClear"))
            page.keyboard.press("Escape")
            dialog_closed()
            check("Esc closes and focus returns", page.evaluate("() => document.activeElement.id") == "modelDownload")
            page.evaluate("() => openModelPage('beta')")
            page.wait_for_function("() => !el('modelDownload').hidden && el('modelName').textContent === 'beta'")
            check("No rule: no rule line", page.is_hidden("#modelRule"))
            page.click("#modelDownload")
            dialog_open()
            check("Unread thread: the sheet says so", page.text_content("#dlDialogMeta").startswith("simp has not read this thread yet."))
            check("No rule: no Clear", page.is_hidden("#dlDialogClear"))
            page.click("#dlDialogCancel")
            dialog_closed()
            page.evaluate("() => openModelPage('alpha')")
            page.wait_for_function("() => !el('modelDownload').hidden && el('modelName').textContent === 'alpha'")
            check("New posts and Download settings side by side", page.is_visible("#modelUpdate") and page.is_visible("#modelDownload"))
            page.click("#modelDownload")
            dialog_open()
            check("Focus moves into the sheet", page.evaluate("() => el('dlDialog').contains(document.activeElement)"))
            for _ in range(16):
                page.keyboard.press("Tab")
            check("Tab stays inside the sheet", page.evaluate("() => el('dlDialog').contains(document.activeElement)"))
            page.keyboard.press("Shift+Tab")
            check("Shift+Tab too", page.evaluate("() => el('dlDialog').contains(document.activeElement)"))
            page.fill("#dlDialogOptPages", "last 3")
            page.fill("#dlDialogOptMax", "20")
            page.click("#dlDialog .switch-row")
            check("Sheet readback", page.text_content("#dlDialog .dl-options-readback") == "The last 3 pages · at most 20 new files · newest posts first")
            n, j = len(rule_posts), len(posted)
            page.click("#dlDialogSave")
            dialog_closed()
            check("Model sheet Save payload", wait_new(rule_posts, n) == {"model": "alpha", "threadPages": "last 3", "maxFiles": 20, "order": "newest"}, rule_posts[n:])
            check("…no job", len(posted) == j)
            check("Focus back on Download settings", page.evaluate("() => document.activeElement.id") == "modelDownload")
            check("The rule line appears", page.text_content("#modelRule") == "Downloads: the last 3 pages · at most 20 new files · newest posts first")
            page.screenshot(path=str(SHOTS / "desktop-dark-model.png"))
            page.click("#modelDownload")
            dialog_open()
            page.fill("#dlDialogOptPages", "abc")
            n = len(rule_posts)
            page.click("#dlDialogGo")
            page.wait_for_timeout(150)
            check("Sheet: a bad page list is refused before sending", len(rule_posts) == n and page.is_visible("#dlDialog"))
            page.fill("#dlDialogOptPages", "last 3")
            n, j = len(rule_posts), len(posted)
            page.click("#dlDialogGo")
            dialog_closed()
            check("Model sheet Save and download: rule", wait_new(rule_posts, n)
                  == {"model": "alpha", "threadPages": "last 3", "maxFiles": 20, "order": "newest"}, rule_posts[n:])
            check("…then New posts", wait_new(posted, j) == {"action": "update", "model": "alpha"}, posted[j:])
            # The server refuses: the sheet stays open and shows why.
            reject["1-2"] = "threadPages: page 1-2 is beyond the thread"
            page.click("#modelDownload")
            dialog_open()
            page.fill("#dlDialogOptPages", "1-2")
            j = len(posted)
            page.click("#dlDialogGo")
            page.wait_for_function("() => el('workspaceToast').textContent.includes('beyond the thread')")
            check("A 400 keeps the sheet open, and nothing is downloaded", page.is_visible("#dlDialog") and not page.is_disabled("#dlDialogGo") and len(posted) == j)
            n = len(rule_posts)
            page.click("#dlDialogClear")
            dialog_closed()
            check("Sheet Clear sends the model alone", wait_new(rule_posts, n) == {"model": "alpha"}, rule_posts[n:])
            page.wait_for_selector("#modelRule", state="hidden")
            check("…and the rule line goes", True)
            page.click("#modelDownload")
            dialog_open()
            page.click("#dlDialog", position={"x": 5, "y": 5})
            dialog_closed()
            check("A tap on the backdrop closes it", True)
            n = len(posted)
            page.click("#modelUpdate")
            check("New posts stays one tap", wait_new(posted, n) == {"action": "update", "model": "alpha"}, posted[n:])

            # ---------- bookmarks page: Settings ----------
            page.evaluate("() => setMode('bookmarks')")
            page.wait_for_selector("#bmGrid .bm-card")
            gamma = page.locator(".bm-card", has_text="Gamma Ray")
            delta = page.locator(".bm-card", has_text="Delta")
            check("A bookmark with settings shows them", delta.locator(".bm-rule").text_content() == "Downloads: videos only · pages 1–4")
            check("…one without does not", gamma.locator(".bm-rule").count() == 0)
            settings = gamma.locator("button", has_text="Settings")
            check("Each bookmark has Settings, labelled with the model", settings.get_attribute("aria-label") == "Download settings for Gamma Ray")
            n = len(posted)
            gamma.locator("button", has_text="Download").first.click()
            check("One-tap Download: no options in the job", wait_new(posted, n) == {"action": "thread", "urls": [GAMMA]}, posted[n:])
            settings.click()
            dialog_open()
            check("Bookmark sheet: title and meta", page.text_content("#dlDialogTitle") == "Gamma Ray"
                  and page.text_content("#dlDialogMeta") == "simp has not read this thread yet. Nothing saved yet: its downloads take everything.")
            page.click("#dlDialog .segment[data-only='videos']")
            page.fill("#dlDialogOptMax", "10")
            page.fill("#dlDialogOptPages", "1,3,4")
            n = len(rule_posts)
            page.press("#dlDialogOptPages", "Enter")
            dialog_closed()
            check("Bookmark sheet: Enter saves by model", wait_new(rule_posts, n)
                  == {"model": "gamma-ray", "threadPages": "1,3,4", "only": "videos", "maxFiles": 10}, rule_posts[n:])
            page.wait_for_function("() => [...document.querySelectorAll('.bm-rule')].some((n) => n.textContent.includes('1, 3, 4'))")
            check("…the card shows its new settings",
                  page.locator(".bm-card", has_text="Gamma Ray").locator(".bm-rule").text_content()
                  == "Downloads: videos only · pages 1, 3, 4 · at most 10 new files")
            check("…and focus is back on its Settings", page.evaluate("() => document.activeElement.getAttribute('aria-label')")
                  == "Download settings for Gamma Ray")
            page.locator(".bm-card", has_text="Gamma Ray").locator("button", has_text="Settings").click()
            dialog_open()
            n, j = len(rule_posts), len(posted)
            page.click("#dlDialogGo")
            dialog_closed()
            check("Bookmark Save and download: rule", wait_new(rule_posts, n)
                  == {"model": "gamma-ray", "threadPages": "1,3,4", "only": "videos", "maxFiles": 10}, rule_posts[n:])
            check("…then the bookmark's thread link", wait_new(posted, j) == {"action": "thread", "urls": [GAMMA]}, posted[j:])
            page.screenshot(path=str(SHOTS / "desktop-dark-bookmarks.png"))

            # ---------- looks: phone and desktop, Tidal and Fern ----------
            def theme(name):
                page.evaluate(f"() => {{ state.settings.theme = '{name}'; applyTheme(); }}")

            def axe(selector):
                return page.evaluate(f"async () => (await axe.run(document.querySelector('{selector}'), {{runOnly: {{type: 'tag', values: ['wcag2a', 'wcag2aa']}}}})).violations.map(v => v.id + ': ' + v.nodes.map(n => n.target).join(' '))")

            if os.environ.get("AXE_SCRIPT"):
                page.add_script_tag(path=os.environ["AXE_SCRIPT"])
            for name in ["dark", "velvet", "light"]:
                theme(name)
                page.evaluate("() => { setMode('ranked'); openModelPage('delta'); }")
                page.wait_for_selector("#modelDownload:not([hidden])")
                page.wait_for_selector("#modelRule:not([hidden])")
                if os.environ.get("AXE_SCRIPT"):
                    check(f"Model page passes axe in {name}", not axe("#rankedModelPage .model-actions") and not axe("#modelRule"), axe("#modelRule"))
                page.click("#modelDownload")
                dialog_open()
                page.wait_for_timeout(300)
                if os.environ.get("AXE_SCRIPT"):
                    violations = axe("#dlDialog")
                    check(f"Sheet passes axe in {name}", not violations, violations)
                if name != "velvet":
                    page.screenshot(path=str(SHOTS / f"desktop-{name}-sheet.png"))
                page.keyboard.press("Escape")
                dialog_closed()
                downloads_page()
                page.fill("#dlRuleModel", "delta")
                page.wait_for_selector("#dlRuleEditor:not([hidden])")
                if os.environ.get("AXE_SCRIPT"):
                    for selector in ["#dlForms", "#dlRulesSection", "#dlThreadsSection"]:
                        violations = axe(selector)
                        check(f"{selector} passes axe in {name}", not violations, violations)
                if name != "velvet":
                    page.locator("#dlRulesSection").screenshot(path=str(SHOTS / f"desktop-{name}-rules.png"))
                page.evaluate("() => setMode('bookmarks')")
                page.wait_for_selector(".bm-rule")
                if os.environ.get("AXE_SCRIPT"):
                    violations = axe("#bmGrid")
                    check(f"Bookmark cards pass axe in {name}", not violations, violations)
                if name != "velvet":
                    page.locator("#bmGrid").screenshot(path=str(SHOTS / f"desktop-{name}-bookmarks.png"))

            phone = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
            mobile = phone.new_page()
            mobile.on("pageerror", lambda e: errors.append(str(e)))
            mobile.route("**/api/simp/**", route_simp)
            mobile.goto(url)
            mobile.wait_for_function("() => state.libraryReady && state.features.has('simp')")
            for name in ["dark", "light"]:
                mobile.evaluate(f"() => {{ state.settings.theme = '{name}'; applyTheme(); setMode('downloads'); }}")
                mobile.wait_for_selector("#dlRulesSection:not([hidden])")
                # gamma-ray was saved by name and has no known thread: its link is its bookmark's.
                mobile.wait_for_function("() => [...document.querySelectorAll('#dlRules li')].some((li) => li.querySelector('strong').textContent === 'gamma-ray'"
                                         " && [...li.querySelectorAll('button')].some((b) => b.textContent === 'Download'))")
                check(f"Phone ({name}): a rule with only a bookmark link still has Download", True)
                mobile.fill("#dlRuleModel", "delta")
                mobile.wait_for_selector("#dlRuleEditor:not([hidden])")
                mobile.evaluate("() => { document.activeElement.blur(); el('dlRulesSection').scrollIntoView({block: 'start'}); }")
                mobile.wait_for_timeout(200)
                mobile.screenshot(path=str(SHOTS / f"phone-{name}-rules.png"))
                mobile.evaluate("() => el('dlRules').scrollIntoView({block: 'center'})")
                mobile.wait_for_timeout(100)
                mobile.screenshot(path=str(SHOTS / f"phone-{name}-rules-list.png"))
                width = mobile.evaluate("() => document.documentElement.scrollWidth")
                check(f"Phone ({name}): nothing wider than the screen", width <= 390, width)
                mobile.evaluate("() => { setMode('ranked'); openModelPage('delta'); }")
                mobile.wait_for_selector("#modelRule:not([hidden])")
                mobile.screenshot(path=str(SHOTS / f"phone-{name}-model.png"))
                mobile.click("#modelDownload")
                mobile.wait_for_function("() => el('dlDialog').classList.contains('open')")
                mobile.wait_for_timeout(350)
                box = mobile.evaluate("() => { const r = document.querySelector('#dlDialog .launcher-sheet').getBoundingClientRect(); return [r.left, r.right, Math.round(r.bottom)]; }")
                check(f"Phone ({name}): a bottom sheet, full width", box[0] == 0 and box[1] == 390 and box[2] == 844, box)
                mobile.screenshot(path=str(SHOTS / f"phone-{name}-sheet.png"))
                mobile.keyboard.press("Escape")
                mobile.wait_for_function("() => el('dlDialog').hidden")
                mobile.evaluate("() => setMode('bookmarks')")
                mobile.wait_for_selector(".bm-rule")
                mobile.evaluate("() => document.querySelector('.bm-rule').closest('.bm-card').scrollIntoView({block: 'center'})")
                mobile.wait_for_timeout(200)
                mobile.screenshot(path=str(SHOTS / f"phone-{name}-bookmarks.png"))
            narrow = browser.new_context(viewport={"width": 360, "height": 740}, is_mobile=True, has_touch=True)
            small = narrow.new_page()
            small.route("**/api/simp/**", route_simp)
            small.goto(url)
            small.wait_for_function("() => state.libraryReady && state.features.has('simp')")
            small.evaluate("() => { setMode('ranked'); openModelPage('delta'); }")
            small.wait_for_selector("#modelDownload:not([hidden])")
            small.click("#modelDownload")
            small.wait_for_function("() => el('dlDialog').classList.contains('open')")
            overflow = small.evaluate("() => [...document.querySelectorAll('#dlDialog *')].filter(n => n.getBoundingClientRect().right > 360.5).map(n => n.className || n.tagName)")
            check("360 px: nothing in the sheet sticks out", not overflow, overflow)
            small.keyboard.press("Escape")
            small.evaluate("() => setMode('downloads')")
            small.wait_for_selector("#dlRulesSection:not([hidden])")
            small.fill("#dlRuleModel", "delta")
            small.wait_for_selector("#dlRuleEditor:not([hidden])")
            overflow = small.evaluate("() => [...document.querySelectorAll('#downloadsMode *')].filter(n => n.getClientRects().length && n.getBoundingClientRect().right > 360.5).map(n => n.id || n.className || n.tagName)")
            check("360 px: nothing on the Downloads page sticks out", not overflow, overflow)
            browser.close()

        check("Jobs never carry option fields", all(not (set(job) & OPTION_FIELDS) for job in posted), posted)
        check("No page errors", not errors, errors)
    finally:
        server.terminate()
        server.wait(timeout=10)

print(f"\n{len(passed)} checks passed. Screenshots: {SHOTS}")
