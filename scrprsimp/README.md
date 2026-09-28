# simp — SimpCity bookmarks → images & videos

Pull bookmarked (or named) model threads from SimpCity, crawl them for media, then download via **cyberdrop-dl** (bunkr / gofile / goonbox / …) plus a built-in direct downloader (forum attachments / jpg* / pixhost / imgbox).

---

## Where it runs

simp lives in the Edging Heaven repo as `scrprsimp/` and runs on qwertyserver.
Normally you don't type any of the commands below: Edging Heaven's **Downloads**
page starts them (see `../README.md` → Downloads) and shows their output.

| | On qwertyserver |
|---|---|
| Code and venv | `~/git/edgingHeaven/scrprsimp/`, `scrprsimp/.venv/` (simp + cyberdrop-dl-patched) |
| `config.toml`, `whereto.txt`, `cookies/`, `state/` | `~/.local/share/edging-heaven/scrprsimp/` (the service may only write there) |
| Media | `/mnt/edging-heaven/baza/<model>/` |
| Job output from the page | `~/.local/share/edging-heaven/scrprsimp/jobs/<id>.log` |

Only one simp or cyberdrop-dl run may use `state/cdl/cyberdrop.db` at a time:
don't run simp by hand while the page shows a job running, and don't run it on
the desktop any more (its history lives on the server now).

---

## Useful commands

By hand on the server: from the data dir (simp reads `./config.toml`), with the venv on:

```bash
cd ~/.local/share/edging-heaven/scrprsimp && source ~/git/edgingHeaven/scrprsimp/.venv/bin/activate
```

### Where files go (`whereto.txt`)

Put **one** path in `whereto.txt`:

```text
/mnt/edging-heaven/baza
```

Media lands in:

```text
/mnt/edging-heaven/baza/<model-name>/
```

Leave `whereto.txt` blank (only `#` comments) → default `./downloads/<model-name>/`.  
Optional: `models_subdir = "models"` in `config.toml` if you want an extra `models/` folder.
Relative paths in `whereto.txt` resolve against the config folder, as other
configured paths do. An explicit `-c` path must exist; a typo stops the command.

### Auth & bookmarks

```bash
simp check-auth                          # session still valid?
simp bookmarks                           # list all bookmarked models
simp bookmarks --page 1                  # only bookmark list page 1
simp bookmarks --pages 2-4
simp bookmarks --limit 10
simp bookmarks --json
simp bookmarks --save                    # state/bookmarks.json + 3 preview pictures per model not downloaded yet
simp bookmarks --save --previews 5       # (Edging Heaven's Bookmarks page runs the first one)
```

### Estimate size (no download)

```bash
simp scrape --page 1                     # crawl + size estimate
simp scrape --pages 3-5 --no-estimate    # crawl only
df -h /mnt/edging-heaven            # free space on Lexar
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

Forum page requests can overlap: `scrape.page_concurrency` defaults to **2**,
with a maximum of **4**. `delay_min` / `delay_max` still pace the start of each
additional page request. This helps when responses are slow without launching
every page at once. Set `page_concurrency = 1` for sequential crawling.
Links retain their page order regardless of which response finishes first.
Direct downloads separately use `scrape.concurrency` (up to four workers), with
only a worker-sized set of tasks queued. Models and cyberdrop-dl runs remain
sequential, including jobs started from the web app.

A picture posted inside a link to a host cyberdrop-dl handles (SimpCity shows a
goonbox picture as its `simp6.cuckcapital.cr` file linked to its `goonbox.cr/img/…`
page) is downloaded once, through the link. Crawls before this fetched both, so
older models can have each such picture twice: in the model folder and in
`… (GoonBox)`.

Repeat runs skip finished direct downloads without re-requesting them
(`state/done/<model>.jsonl` maps each URL to its file). Two different files with the
same name are kept apart: the second gets `_<hash>` appended.

### Content verification (photos and videos)

`download.deduplicate = true` is the default. New files are compared by **SHA-256
of their complete contents**, within the model's folder, including its subfolders.
An identical file under another name or URL is skipped; the existing copy stays
in place. Files belonging to different models are kept separately. Existing
duplicates are not deleted by this feature.

- Known direct URLs are skipped before downloading. For a new URL, the complete
  file must first be transferred temporarily to determine its contents. A duplicate
  is discarded, and the URL is recorded against the retained file so future runs
  make no request. cyberdrop-dl keeps its own URL history.
- Images that were resized/recompressed and videos that were re-encoded are
  different files. This checks exact contents, not visual similarity or playability.
- Matching filenames or byte counts alone do not prove identity. Existing files
  of the matching size are hashed as needed; cached hashes in
  `state/content/<model>.jsonl` are reused while the file's metadata is unchanged.
  A removed file's cached hash is never enough to discard a new copy.
- Direct downloads are checked before their `.part` file becomes visible media.
  cyberdrop-dl writes to a staging folder **outside the library, on the same drive**;
  after its process ends, verified files move into the model folder. Its files
  therefore appear in the app after that stage finishes. Direct files still arrive live.
- The default staging location is `<library-parent>/.<library-name>.simp-incoming/<model>/`
  (on this server, `/mnt/edging-heaven/.baza.simp-incoming/<model>/`). The parent must
  be writable. Set `paths.cdl_staging_dir` to another location outside the library
  on the same filesystem if necessary. No extra media copy is made when publishing.
  Staged files count toward the drive's free-space reserve.
- Completed staged files left by an interruption are verified on the next
  cyberdrop-dl stage for that model. `.part` files stay staged for its resume support.
  Do not delete the staging folder while a job runs. To abandon staged downloads,
  stop jobs first, then remove that model's staging folder; completed files already
  in the library remain intact.
- `simp clear history` also clears the content hash cache; existing files will be
  hashed again when needed. `deduplicate = false` disables simp's verification;
  `skip_existing = false` also bypasses it for deliberate re-downloads.

#### Duplicates already in the library (one-off cleanup, 2026-09-28)

Files downloaded before this check existed were cleaned once by a separate script
(not part of simp). Per model folder it grouped files by size, hashed the
candidates (SHA-256), and kept one copy per identical group, preferring a copy with
a rating, mark, duel ranking or Dangerous "kept" flag, then the shallowest path. A copy
was only deleted when the retained copy carried every annotation it had. Before each
delete it re-checked the stamp (size/mtime/inode), compared both files byte for byte,
paused if a download job was queued or running, and repointed `state/done/<model>.jsonl`
URLs to the retained file so those URLs are never fetched again.

Result on `/mnt/edging-heaven/baza`: 27,049 files scanned, **11,315 duplicates deleted**
(11,248 images, 67 videos, 11.27 GiB), 9,123 retained copies verified present,
86 download-history URLs repointed. Deletions are permanent (not moved to
`.heaven-trash`). The plan, a per-file audit log (`verified`/`deleted`/`remap`) and the
scripts are in `<data dir>/scrprsimp/reports/dedupe-20260928-*/`. cyberdrop-dl's own
history (`state/cdl/cyberdrop.db`) still marks those URLs done, so it will not fetch
the deleted copies again either.

The run ends with a summary and exits 1 if downloads or thread crawls failed.
Usable links from an incomplete crawl are still downloaded, but the web app
marks the job failed and its summary reports incomplete crawls. Rerun the
original command (or submit the same download in the app) to retry missing
pages; `simp retry` only retries recorded download failures. Reusing an
incomplete export with `--skip-crawl` still reports failure.

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
  -o /mnt/edging-heaven/baza/sofia-gomez \
  --db state/cdl/cyberdrop.db \
  --cache-file state/cdl/cache.json \
  --logs.folder state/cdl/logs \
  --ui disabled \
  --cookies cookies/simpcity.txt

# force re-download even if history says done
cyberdrop-dl download \
  -i state/cdl_sofia-gomez.txt \
  -o /mnt/edging-heaven/baza/sofia-gomez \
  --db state/cdl/cyberdrop.db \
  --cache-file state/cdl/cache.json \
  --logs.folder state/cdl/logs \
  --ui disabled \
  --cookies cookies/simpcity.txt \
  --ignore-history
```

### Watch progress

```bash
watch -n 2 'du -sh /mnt/edging-heaven/baza/* 2>/dev/null | sort -h | tail -15; echo; find /mnt/edging-heaven/baza -name "*.part" 2>/dev/null | wc -l'

find /mnt/edging-heaven/baza/sofia-gomez -iname '*.mp4' | wc -l
find /mnt/edging-heaven/baza/sofia-gomez \( -iname '*.jpg' -o -iname '*.png' \) | wc -l

tail -f state/cdl/logs/downloader.log
```

### Tracking / grep

```bash
rg '"thread_page": 7' state/cdl_sofia-gomez.jsonl
cut -c1-120 state/bookmark_urls.txt
```

---

## First-time setup

On qwertyserver (what Edging Heaven expects; also in `../deploy/EDGING-HEAVEN.md`):

```bash
cd ~/git/edgingHeaven
python3 -m venv scrprsimp/.venv
scrprsimp/.venv/bin/pip install -e './scrprsimp[cdl]'   # simp + cyberdrop-dl-patched in one venv

D=~/.local/share/edging-heaven/scrprsimp
(umask 077; mkdir -p "$D/cookies" "$D/state")
sed -e 's/^redownload_missing = true/redownload_missing = false/' \
    -e 's/^max_file_bytes = 0/max_file_bytes = 4294967295/' \
    -e 's/^min_free_bytes = 0/min_free_bytes = 3221225472/' \
    scrprsimp/config.example.toml > "$D/config.toml"   # tweak base_url if needed
printf '/mnt/edging-heaven/baza\n' > "$D/whereto.txt"
```

Anywhere else, the old way still works: a venv in this folder, `pip install -e '.[cdl]'`
and `cp config.example.toml config.toml`.

### Auth (pick one)

**A. cookies.txt (recommended)**

1. Log into SimpCity in your browser.
2. Export Netscape cookies (“Get cookies.txt LOCALLY” / Firefox “cookies.txt”).
3. Upload it on Edging Heaven's Downloads page (**Upload cookies.txt**), or save it
   as `cookies/simpcity.txt` next to `config.toml`.

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
  content/<model>.jsonl        # SHA-256 cache for unchanged existing files
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
7. Download      per model: direct hosts, then cyberdrop-dl (staged, then
                 content-verified into the model folder)
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
- `redownload_missing = false` (the server's setting): a direct download whose file was
  deleted (Edging Heaven moves deletions to `.heaven-trash`) is not fetched again.
  The default `true` fetches it again.
- `max_file_bytes`: skip bigger files, direct and cyberdrop-dl alike. The server sets
  4294967295 because the Lexar is FAT32 (no file of 4 GiB or more).
  Direct downloads check decoded bytes while streaming too, so absent or compressed
  `Content-Length` headers cannot bypass the limit. Oversized partial files are removed.
- `min_free_bytes`: stop before the drive has less than this free (the server: 3 GiB).
  Checked before each model and file and while writing; cyberdrop-dl gets
  `--min-free-space`. The run stops cleanly with exit code **3**, keeps nothing
  half-written and records nothing as failed; running it again continues.
- A model folder with files but no `state/done/<model>.jsonl` (downloaded before that
  record existed) is adopted on its first run. With content verification enabled,
  files found by name still need a content comparison before their links are
  recorded. Direct links from previously covered thread pages whose file is gone
  count as deleted (not fetched again with `redownload_missing = false`).
- simp prints `Model folder: <path>` when it starts writing a model; Edging Heaven
  watches for it to add new files while the job runs.
- cyberdrop-dl keeps its own config, cache and logs in `state/cdl/appdata/`
  (`CDL_APPDATA_FOLDER`), not `~/.config`/`~/.cache`/`~/.local/state`, so it also runs
  inside Edging Heaven's sandboxed service. It needs `ffmpeg` for HLS videos.
- cyberdrop-dl exits 0 even when single files fail; those are in
  `state/cdl/logs/download_errors.csv`, and the next run of the same thread retries them.
- CDL history lives in `state/cdl/cyberdrop.db` (not next to the files). Deleting model folders does **not** clear that memory — use `simp clear history`.
- Bunkr/turbo `503` / timeouts are host flakiness; retry the same `cdl_*.txt` later.

## Tests

From `scrprsimp/`:

```bash
.venv/bin/python -m pytest -q tests
```

The tests use simulated forum responses and temporary local image servers.
They cover concurrent crawling, incremental retries, streamed size limits,
filename collisions, deleted files, and the web job queue running the real CLI
against a simulated forum. They do not use your cookies or media library.
The web app's HTTP integration tests run from the repository root:

```bash
python3 -m unittest discover -s tests -p test_simp_jobs.py -q
```
