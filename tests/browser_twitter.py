"""Browser checks for Twitter / X accounts per model: the Twitter section on
the Downloads page (Add, Edit, Download, Download all), the sheet that edits
one model's account (photos and videos / photos / videos, at most N, reposts,
Remove), and the Twitter buttons on a model page. Only shown when the server
says it has them (status.twitter).

No media at all: the server runs from this checkout on an empty temporary
library and data folder, and every /api/simp/* request is answered by the
test, so no job ever runs and Twitter is never contacted. Account and job
requests are recorded and their payloads compared exactly.

Run: python3 tests/browser_twitter.py [screenshot dir]
Needs Playwright. BROWSER_EXECUTABLE optionally selects a Chromium binary.
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
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="heaven-twitter-shots-"))
SHOTS.mkdir(parents=True, exist_ok=True)
from playwright.sync_api import sync_playwright  # noqa: E402

GB = 1024**3
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


ACCOUNTS = {"delta": {"handle": "Delta_X", "only": "videos", "maxFiles": 40, "updatedAt": "2026-11-14T10:00:00Z"}}
RUNS = {"delta": {"handle": "Delta_X", "checkedAt": "2026-11-14T09:00:00Z", "new": 12, "failed": 2, "reachedEnd": True}}
status = {
    "installed": True, "configured": True, "targetReady": True, "target": "/nowhere/downloads",
    "jobs": [], "failed": [], "later": [],
    "threads": [{"model": "delta", "url": "https://simpcity.cr/threads/delta.4/", "lastPage": 3, "unreadPages": 0}],
    "cookies": {"present": True}, "auth": {"ok": True},
    "freeBytes": 50 * GB, "reserveBytes": 0, "resumeBytes": 0, "modelRules": True, "rules": {},
}
posted = []        # every POST /api/simp/jobs body
account_posts = []  # every POST /api/simp/twitter body
reject = {}        # handle → 400 message


def route_simp(route):
    request = route.request
    path = urlparse(request.url).path
    if path == "/api/simp/status":
        body = status
    elif path == "/api/simp/bookmarks":
        body = {"bookmarks": [], "complete": True}
    elif path == "/api/simp/twitter" and request.method == "POST":
        payload = json.loads(request.post_data)
        account_posts.append(payload)
        if payload.get("handle") in reject:
            route.fulfill(status=400, content_type="application/json", body=json.dumps({"error": reject[payload["handle"]]}))
            return
        accounts = status.setdefault("twitterAccounts", {})
        model = payload["model"]
        if payload.get("handle"):
            accounts[model] = {"handle": payload["handle"], **({"only": payload["only"]} if payload.get("only") else {}),
                               **({"maxFiles": payload["maxFiles"]} if payload.get("maxFiles") else {}),
                               **({"reposts": True} if payload.get("reposts") else {}), "updatedAt": "2026-11-14T12:00:00Z"}
        else:
            accounts.pop(model, None)
        body = {"ok": True, "model": model, "account": accounts.get(model), "accounts": accounts}
    elif path == "/api/simp/jobs" and request.method == "POST":
        payload = json.loads(request.post_data)
        posted.append(payload)
        body = {"job": {"id": f"{len(posted):012x}", "label": f"Job {len(posted)}", "status": "queued", "action": payload["action"]}}
    else:
        body = {}
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


with tempfile.TemporaryDirectory(prefix="heaven-twitter-") as tmp:
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

            def load(twitter_on):
                if twitter_on:
                    status.update(twitter=True, twitterAccounts=copy.deepcopy(ACCOUNTS), twitterRuns=copy.deepcopy(RUNS))
                else:
                    for key in ("twitter", "twitterAccounts", "twitterRuns"):
                        status.pop(key, None)
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

            def sheet_open():
                page.wait_for_function("() => !el('twDialog').hidden && el('twDialog').classList.contains('open')")

            def sheet_closed():
                page.wait_for_function("() => el('twDialog').hidden")

            def row(model):
                return page.locator("#twAccounts li", has=page.locator("strong", has_text=re.compile(f"^{re.escape(model)}$")))

            def model_page(model):
                page.evaluate(f"() => {{ setMode('ranked'); openModelPage({json.dumps(model)}); }}")
                page.wait_for_selector("#modelUpdate:not([hidden]), #modelTwitter:not([hidden])", timeout=5000)
                page.wait_for_timeout(300)

            # ---------- an old server: nothing of it shows ----------
            load(False)
            downloads_page()
            page.wait_for_timeout(300)
            check("Old server: no Twitter section", page.is_hidden("#dlTwitterSection"))
            model_page("delta")
            check("Old server: no Twitter buttons on a model page",
                  page.is_hidden("#modelTwitter") and page.is_hidden("#modelTwitterGo") and page.is_hidden("#modelTwitterLine"))

            # ---------- the Downloads page ----------
            load(True)
            downloads_page()
            page.wait_for_selector("#dlTwitterSection:not([hidden])")
            check("Twitter section shown, saved account listed with what it takes",
                  row("delta").locator(".dl-rule-brief").text_content() == "@Delta_X · videos only · at most 40 new files")
            check("…and its last download", row("delta").locator(".subtle").text_content().startswith("Last download")
                  and "12 new files" in row("delta").locator(".subtle").text_content()
                  and "2 failed" in row("delta").locator(".subtle").text_content())
            check("Download all hidden with one account", page.is_hidden("#twAll"))

            # Add with a bad link: says so, no sheet.
            page.fill("#twAddHandle", "https://evil.example/anna")
            page.click("#twAddGo")
            check("Add: a link that is not Twitter is refused in words",
                  "not a Twitter" in page.text_content("#twAddHint") and page.is_hidden("#twDialog"))
            # Add with only a link: the folder is named after the account.
            page.fill("#twAddHandle", "https://x.com/Anna_X/media?s=20")
            page.click("#twAddGo")
            sheet_open()
            check("Add: sheet for a model named after the account", page.text_content("#twDialogTitle") == "Anna_X")
            check("Add: the account is filled in", page.input_value("#twHandle") == "@Anna_X")
            check("Add: nothing saved yet", "No account saved" in page.text_content("#twDialogMeta") and page.is_hidden("#twRemove"))
            check("Readback for the default", page.text_content("#twReadback") == "From @Anna_X: photos and videos · everything new")
            page.click("#twOnly [data-only='videos']")
            page.fill("#twMax", "20")
            check("Readback follows the choices", page.text_content("#twReadback") == "From @Anna_X: videos only · at most 20 new files per download")
            check("Type buttons say which is on", page.get_attribute("#twOnly [data-only='videos']", "aria-pressed") == "true"
                  and page.get_attribute("#twOnly [data-only='']", "aria-pressed") == "false")
            page.screenshot(path=str(SHOTS / "sheet-add.png"))
            n = len(account_posts)
            page.click("#twSave")
            check("Save sends the account and choices",
                  wait_new(account_posts, n) == {"model": "Anna_X", "handle": "Anna_X", "only": "videos", "maxFiles": 20, "reposts": False},
                  account_posts[n:])
            sheet_closed()
            page.wait_for_selector("#twAccounts li:nth-child(2)")
            check("The new account is listed", row("Anna_X").locator(".dl-rule-brief").text_content() == "@Anna_X · videos only · at most 20 new files"
                  and row("Anna_X").locator(".subtle").text_content() == "Not downloaded yet.")
            check("Add fields are cleared after saving", page.input_value("#twAddHandle") == "")
            check("Download all shown with two accounts", page.is_visible("#twAll"))

            # A bad account in the sheet: no request, says why.
            row("delta").locator("button", has_text="Edit").click()
            sheet_open()
            check("Edit: the saved account fills the sheet", page.input_value("#twHandle") == "@Delta_X"
                  and page.input_value("#twMax") == "40" and page.get_attribute("#twOnly [data-only='videos']", "aria-pressed") == "true")
            check("Edit: Remove shown for a saved account", page.is_visible("#twRemove"))
            page.fill("#twHandle", "x.com/home")
            check("A page of x.com is not an account", "not a Twitter / X account" in page.text_content("#twReadback")
                  and page.get_attribute("#twHandle", "aria-invalid") == "true")
            n = len(account_posts)
            page.click("#twSave")
            page.wait_for_timeout(300)
            check("…and nothing is sent", len(account_posts) == n)
            page.fill("#twHandle", "@Delta_X")
            page.click("#twOnly [data-only='']")
            page.fill("#twMax", "")
            page.click("#twReposts")
            check("Reposts switch", page.get_attribute("#twReposts", "aria-checked") == "true"
                  and page.text_content("#twReadback").endswith("· with reposts"))
            n, j = len(account_posts), len(posted)
            page.click("#twGo")
            check("Save and download: account first", wait_new(account_posts, n)
                  == {"model": "delta", "handle": "Delta_X", "only": "", "maxFiles": 0, "reposts": True}, account_posts[n:])
            check("…then that model's Twitter job", wait_new(posted, j) == {"action": "twitter", "models": ["delta"]}, posted[j:])
            sheet_closed()
            check("Focus goes back to the Edit button", page.evaluate("() => document.activeElement?.dataset.twitterModel") == "delta")

            j = len(posted)
            row("Anna_X").locator("button", has_text="Download").click()
            check("Download on a row", wait_new(posted, j) == {"action": "twitter", "models": ["Anna_X"]})
            j = len(posted)
            page.click("#twAll")
            check("Download all", wait_new(posted, j) == {"action": "twitter", "models": []})

            # The server's refusal reaches the page and keeps the sheet open.
            row("Anna_X").locator("button", has_text="Edit").click()
            sheet_open()
            reject["Anna_X"] = "Not a Twitter / X account. Paste its link (https://x.com/name) or @name."
            page.click("#twSave")
            page.wait_for_function("() => document.body.textContent.includes('Paste its link (https://x.com/name)')")
            check("A server refusal keeps the sheet open", page.is_visible("#twDialog"))
            reject.clear()
            page.keyboard.press("Escape")
            sheet_closed()
            check("Esc closes the sheet", page.is_hidden("#twDialog"))

            # ---------- the model page ----------
            model_page("delta")
            check("Model page: Twitter posts and the account line",
                  page.is_visible("#modelTwitterGo") and page.text_content("#modelTwitterLine") == "Twitter: @Delta_X · with reposts")
            j = len(posted)
            page.click("#modelTwitterGo")
            check("Model page: Twitter posts downloads it", wait_new(posted, j) == {"action": "twitter", "models": ["delta"]})
            page.click("#modelTwitter")
            sheet_open()
            check("Model page: the sheet is that model's", page.text_content("#twDialogTitle") == "delta")
            n = len(account_posts)
            page.click("#twRemove")
            check("Remove asks first, and says the files stay", "Files already downloaded stay" in confirms[-1], confirms[-1:])
            check("Remove sends an empty account", wait_new(account_posts, n) == {"model": "delta", "handle": ""})
            sheet_closed()
            page.wait_for_function("() => el('modelTwitterGo').hidden")
            check("Model page after Remove: only the Twitter / X button", page.is_visible("#modelTwitter")
                  and page.is_hidden("#modelTwitterLine"))
            model_page("someone-new")
            check("A model with no SimpCity thread still gets Twitter / X", page.is_visible("#modelTwitter") and page.is_hidden("#modelUpdate"))

            # ---------- a phone ----------
            narrow = browser.new_context(viewport={"width": 360, "height": 740}, is_mobile=True, has_touch=True)
            small = narrow.new_page()
            small.on("pageerror", lambda e: errors.append(str(e)))
            small.route("**/api/simp/**", route_simp)
            small.goto(url)
            small.wait_for_function("() => state.libraryReady && state.features.has('simp')")
            small.evaluate("() => setMode('downloads')")
            small.wait_for_selector("#dlTwitterSection:not([hidden])")
            small.locator("#dlTwitterSection").scroll_into_view_if_needed()
            small.wait_for_timeout(200)
            small.screenshot(path=str(SHOTS / "phone-section.png"))
            overflow = small.evaluate("() => [...document.querySelectorAll('#dlTwitterSection *')].filter(n => n.getClientRects().length && n.getBoundingClientRect().right > 360.5).map(n => n.id || n.className || n.tagName)")
            check("360 px: nothing in the Twitter section sticks out", not overflow, overflow)
            small.locator("#twAccounts button", has_text="Edit").first.click()
            small.wait_for_function("() => el('twDialog').classList.contains('open')")
            small.wait_for_timeout(250)
            small.screenshot(path=str(SHOTS / "phone-sheet.png"))
            overflow = small.evaluate("() => [...document.querySelectorAll('#twDialog *')].filter(n => n.getBoundingClientRect().right > 360.5).map(n => n.className || n.tagName)")
            check("360 px: nothing in the sheet sticks out", not overflow, overflow)
            check("No page errors", not errors, errors)
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)

print(f"\n{len(passed)} checks passed. Screenshots: {SHOTS}")
