# simp — SimpCity bookmarks → images & videos

Pull bookmarked (or named) model threads from SimpCity, crawl them for media, then download via **cyberdrop-dl** (bunkr / gofile / goonbox / …) plus a built-in direct downloader (forum attachments / jpg* / pixhost / imgbox).

---

## Useful commands

Always from the project dir with the venv on:

```bash
cd ~/git/simp && source .venv/bin/activate
```

### Where files go (`whereto.txt`)

Put **one** path in `whereto.txt`:

```text
/run/media/qwerty/Lexar/baza
```

Media lands in:

```text
/run/media/qwerty/Lexar/baza/<model-name>/
```

Leave `whereto.txt` blank (only `#` comments) → default `./downloads/<model-name>/`.  
Optional: `models_subdir = "models"` in `config.toml` if you want an extra `models/` folder.

### Auth & bookmarks

```bash
simp check-auth                          # session still valid?
simp bookmarks                           # list all bookmarked models
simp bookmarks --page 1                  # only bookmark list page 1
simp bookmarks --pages 2-4
simp bookmarks --limit 10
simp bookmarks --json
```

### Estimate size (no download)

```bash
simp scrape --page 1                     # crawl + size estimate
simp scrape --pages 3-5 --no-estimate    # crawl only
df -h /run/media/qwerty/Lexar            # free space on Lexar
```

### Download

```bash
# bookmark list pages
simp download --page 1
simp download --pages 2-4
simp download --page 1 --limit 3         # first 3 models on that page
simp download --skip-crawl               # reuse last media_urls.jsonl
simp download --page 1 --no-estimate
simp download --page 1 --full-crawl     # re-crawl threads from page 1 (ignore crawl cache)

# one or more thread URLs (sequential — one finishes, then the next)
simp thread "https://simpcity.cr/threads/ramierah.347998/"
simp thread \
  "https://simpcity.cr/threads/model-a.111/" \
  "https://simpcity.cr/threads/model-b.222/"
```

Threads are crawled incrementally: `state/crawl/` remembers each thread's links and
last page, so the next run only fetches from that page on (plus any page that failed).
Use `--full-crawl` after changing `images` / `videos` / `exclude_extensions`.

Repeat runs skip finished direct downloads without re-requesting them
(`state/done/<model>.jsonl` maps each URL to its file). Two different files with the
same name are kept apart: the second gets `_<hash>` appended.

The run ends with a summary and exits 1 if anything failed.

### Retry failures

```bash
simp retry                    # everything listed in state/failed/
simp retry sofia-gomez        # just these models
```

Failed direct files and failed cyberdrop-dl runs are recorded per model in
`state/failed/<model>.jsonl`; the file disappears once nothing is left failing.

Do **not** run two `simp`/`cyberdrop-dl` jobs that share `state/cdl/cyberdrop.db` at the same time.

### Clear / reset

```bash
simp clear                               # list targets + sizes
simp clear history                       # “already downloaded” memory (CDL db + direct index) → start fresh
simp clear cache logs
simp clear crawl resolve                 # crawl = URL lists, crawl cache, failed lists
simp clear downloads --yes               # delete media under models_root (destructive)
simp clear state --yes
simp clear history cache logs crawl
```

### Retry videos only (cyberdrop-dl)

```bash
cyberdrop-dl download \
  -i state/cdl_sofia-gomez.txt \
  -o /run/media/qwerty/Lexar/baza/sofia-gomez \
  --db state/cdl/cyberdrop.db \
  --cache-file state/cdl/cache.json \
  --logs.folder state/cdl/logs \
  --ui disabled \
  --cookies cookies/simpcity.txt

# force re-download even if history says done
cyberdrop-dl download \
  -i state/cdl_sofia-gomez.txt \
  -o /run/media/qwerty/Lexar/baza/sofia-gomez \
  --db state/cdl/cyberdrop.db \
  --cache-file state/cdl/cache.json \
  --logs.folder state/cdl/logs \
  --ui disabled \
  --cookies cookies/simpcity.txt \
  --ignore-history
```

### Watch progress

```bash
watch -n 2 'du -sh /run/media/qwerty/Lexar/baza/* 2>/dev/null | sort -h | tail -15; echo; find /run/media/qwerty/Lexar/baza -name "*.part" 2>/dev/null | wc -l'

find /run/media/qwerty/Lexar/baza/sofia-gomez -iname '*.mp4' | wc -l
find /run/media/qwerty/Lexar/baza/sofia-gomez \( -iname '*.jpg' -o -iname '*.png' \) | wc -l

tail -f state/cdl/logs/downloader.log
```

### Tracking / grep

```bash
rg '"thread_page": 7' state/cdl_sofia-gomez.jsonl
cut -c1-120 state/bookmark_urls.txt
```

---

## First-time setup

```bash
cd ~/git/simp
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
pipx install cyberdrop-dl-patched   # bunkr/gofile/goonbox/…
cp config.example.toml config.toml  # tweak base_url if needed
```

### Auth (pick one)

**A. cookies.txt (recommended)**

1. Log into SimpCity in your browser.
2. Export Netscape cookies (“Get cookies.txt LOCALLY” / Firefox “cookies.txt”).
3. Save as `cookies/simpcity.txt`.

**B. Live browser profile** — in `config.toml`:

```toml
[auth]
browser = "firefox"   # or chrome / chromium / brave / edge
```

Then: `simp check-auth`

---

## Layout

```
<whereto>/<slug>/              # media (from whereto.txt), or ./downloads/<slug>/
state/
  bookmark_urls.txt
  media_urls.jsonl
  media_urls.txt
  cdl_<slug>.txt               # host URLs for cyberdrop-dl
  cdl_<slug>.jsonl             # same + thread page provenance
  post_resolve_cache.json
  crawl/<host>_<thread>.json   # per-thread links + last page crawled
  done/<model>.jsonl           # direct downloads: URL → filename
  failed/<model>.jsonl         # what `simp retry` reruns
  cdl/
    cyberdrop.db               # download history (skip/resume)
    cache.json
    logs/
cookies/simpcity.txt
whereto.txt
config.toml
```

---

## How downloads work

| Source | Handler |
|--------|---------|
| Bunkr, GoFile, Cyberdrop, Pixeldrain, Mega, Saint, Turbo, GoonBox, Erome, … | `cyberdrop-dl` |
| `/attachments/`, jpg5/6/7, pixhost, imgbox, simp CDN | built-in direct HTTP |

### Pipeline (`simp download`)

```
1. Auth          cookies → logged-in session
2. Bookmarks     /account/bookmarks (--page / --pages / --limit)
3. Resolve       post bookmarks → parent /threads/… (cached)
4. Crawl         every selected thread, resuming at the last page seen
5. Write state   URL lists on disk
6. Estimate      HEAD direct URLs → ~size known + album TBD
7. Download      per model: direct hosts, then cyberdrop-dl
```

Crawl finishes and saves URLs **before** the heavy download pass.  
`simp scrape` = steps through estimate.  
`simp download --skip-crawl` reuses the last `media_urls.jsonl`.

Direct files log like:

```text
[ok] grettagrand | thread p.7 | image | bbimage | jpg5.su | foo.jpg (12345 B)
```

---

## Notes

- Be polite — default delay is 2–4s between page fetches (avoids 429s).
- Re-export cookies when `check-auth` fails.
- Domain mirrors rotate; set `site.base_url` in `config.toml`.
- Photos → direct downloader; most videos → cyberdrop-dl (`state/cdl_*.txt`). If you only see photos, check `state/cdl/logs/downloader.log`.
- Archives skipped by default: `.zip` `.rar` `.7z` `.tar` `.gz` … (`exclude_extensions` in `config.toml`; `[]` keeps everything, though cyberdrop-dl's `--no-non-media` still drops archives inside albums).
- Image-host viewer pages (e.g. `jpg5.su/img/…`) are opened and the full image on them is downloaded; a page with no image (dead/parked host) is reported as failed instead of being saved as a fake `.jpg`.
- If `whereto.txt` points at an unmounted drive, `download` / `thread` / `retry` stop with “is the drive mounted?” rather than writing anywhere else.
- CDL history lives in `state/cdl/cyberdrop.db` (not next to the files). Deleting model folders does **not** clear that memory — use `simp clear history`.
- Bunkr/turbo `503` / timeouts are host flakiness; retry the same `cdl_*.txt` later.
