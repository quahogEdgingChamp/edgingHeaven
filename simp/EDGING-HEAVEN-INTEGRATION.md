# simp → Edging Heaven: run the downloader on the server, control it from the website

Handoff notes for a new chat. Written 2026-09-27 on the desktop (`fedora`).
Facts marked **verified** were checked on that date; **unverified** ones must be
checked on `qwertyserver` first. SSH from the assistant failed with `Permission denied (publickey)`, since the key
needs your agent or passphrase, so nothing on the server itself was read.

## The goal

Right now simp runs on the desktop and writes to the Lexar drive plugged in there.
The drive then goes back to the server. The goal:

1. **Move simp to the server** (`qwertyserver`), next to Edging Heaven, so it
   downloads straight onto the Lexar where Edging Heaven serves it.
2. **Drive it from the Edging Heaven website**: add models / thread URLs, pull new
   posts for a model, pull bookmark pages, see progress and failures, retry. No
   SSH, no carrying the drive around.

## The two projects

| | simp | Edging Heaven |
|---|---|---|
| Repo | `~/git/simp` (not a git repo yet) | `~/git/edgingHeaven` → Forgejo `https://qwertyserver.tailc27f97.ts.net:8447/qwerty/edgingHeaven.git` |
| What | CLI: SimpCity bookmarks/threads → crawl → download (built-in direct downloader + `cyberdrop-dl`) | Self-hosted photo/video browser for `baza/`, 17 modes, ratings, PIN lock |
| Stack | Python ≥3.11, venv: httpx, bs4, lxml, rich, browser-cookie3; `cyberdrop-dl-patched` via pipx | Python stdlib only (`server.py`, `ThreadingHTTPServer`), plain JS in `static/js/NN-*.js`, **no build step and no external packages** by design |
| Docs | `README.md` in the repo | `README.md`, `deploy/EDGING-HEAVEN.md`; on the server `~/infomds/EDGING-HEAVEN.md`, `HOSTING.md`, `MANIFEST.md` |

**Where things are (verified from the edgingHeaven repo's deploy docs):**

| Item | Value |
|---|---|
| Server | `qwertyserver`, Tailscale `100.75.96.7`, SSH alias `qwertyserver` (`~/.ssh/config`) |
| Website | `https://qwertyserver.tailc27f97.ts.net:8446` → Tailscale Serve → `127.0.0.1:8420`. Private to the tailnet |
| Service | `edging-heaven.service`, runs as `qwerty`, `ExecStart=python3 server.py --host 127.0.0.1 --port 8420 --data-dir ~/.local/share/edging-heaven` |
| Drive | Lexar 116 GiB, **FAT32**, UUID `46C6-231E`, mounted at `/mnt/edging-heaven` by systemd automount |
| Library | `/mnt/edging-heaven/baza/<model>/…`. One top-level folder per model, which is exactly simp's folder-per-slug layout |
| EH state | `~/.local/share/edging-heaven/` (state.json, seen.json, thumbs/) |

**The drive today (verified):** plugged into the desktop at `/run/media/qwerty/Lexar`.
It has 68 GB free of 117 GB, and `baza/` holds 5 model folders plus `.heaven-trash`.
Its `whereto.txt` points simp there.

## Recommended design

```
browser ──tailnet──▶ Edging Heaven server.py (stdlib, 127.0.0.1:8420)
                        │  new /api/simp/* endpoints
                        │  one job at a time, subprocess, log to file
                        ▼
                     simp CLI (own venv)  ──▶ SimpCity + image hosts
                        │                        │
                        ├─ direct downloads ─────┤
                        └─ cyberdrop-dl (pipx) ──┘
                        ▼
                     /mnt/edging-heaven/baza/<model>/   ◀── EH rescans when the job ends
```

- **simp's code lives in the Edging Heaven repo** as `edgingHeaven/simp/`, so a
  `git pull` on the server deploys both. simp's own `.gitignore` still applies
  inside the subfolder, so cookies, state, `config.toml` and `.venv` stay out of git.
- **simp runs as a subprocess**, never imported into `server.py`. That keeps Edging
  Heaven stdlib-only, and simp keeps its own venv at `edgingHeaven/simp/.venv`.
- **simp's runtime data lives in Edging Heaven's writable data dir**:
  `~/.local/share/edging-heaven/simp/` holds `config.toml`, `whereto.txt`,
  `cookies/simpcity.txt` and `state/`. Run it as
  `simp -c ~/.local/share/edging-heaven/simp/config.toml …`. simp resolves relative
  paths against the config file's folder, and this directory is already in the
  service's `ReadWritePaths` (see trap 2).
- On the server `whereto.txt` contains `/mnt/edging-heaven/baza` and
  `models_subdir = ""`.

### Endpoints to add to `server.py` (proposal)

| Method + path | Does |
|---|---|
| `GET /api/simp/status` | Session OK? Current job, queue, models with failures (`state/failed/*.jsonl`), cookie file age |
| `POST /api/simp/jobs` | `{action: "thread", urls: [...]}` · `{action: "bookmarks", pages: "1-2", limit: N}` · `{action: "retry", models: [...]}` · `{action: "update", model: "<slug>"}` |
| `GET /api/simp/jobs/<id>/log?offset=N` | Incremental log text for a live progress view (poll) |
| `POST /api/simp/jobs/<id>/cancel` | Stops the job and its cyberdrop-dl child |
| `POST /api/simp/cookies` | Upload a fresh `cookies.txt` exported from the browser |

Rules:
- All of these are automatically behind the PIN lock, because `server.py` refuses
  every `/api/` path outside `PUBLIC_PATHS` without the unlock cookie. Keep them
  out of `PUBLIC_PATHS`.
- Only accept thread URLs matching `^https://simpcity\.[a-z]+/threads/[^/]+\.\d+/?$`,
  model slugs matching existing folder names, and page specs matching `^[0-9,\-]+$`.
- Build the command as an argument list, never through a shell.
- Start the job with `subprocess.Popen(..., start_new_session=True)` so cancel can
  `os.killpg(pgid, SIGTERM)` and take cyberdrop-dl with it.
- Set `NO_COLOR=1` and `COLUMNS=120` in the job's environment, and write stdout+stderr
  to `state/jobs/<id>.log`.
- Run **one job at a time** and queue the rest (see trap 5).
- When a job ends, trigger the same code path as `POST /api/rescan`, so new files appear.
- **Model page button, "Check for new posts":** Edging Heaven's per-model page is a
  top-level folder, which is a simp slug. The slug → thread URL mapping is in
  simp's `state/crawl/<host>_<slug.id>.json` (`"thread"` field). Incremental crawl
  makes this cheap: it only fetches from the last page seen.
- UI: a new `static/js/33-downloads.js` module, with a "Downloads" entry in the mode
  list or Settings, following the existing module and design conventions.

## Traps found while planning

1. **The drive is mounted read-only on the server by default.** The fstab entry is
   `ro`. `deploy/enable-dangerous.py` switches it to `rw`, and at last write-up that
   activation was "pending". simp needs `rw`. Check with
   `findmnt -rn -o OPTIONS /mnt/edging-heaven`.
2. **The Edging Heaven service is sandboxed.** It has `ProtectHome=read-only`, and
   `ReadWritePaths` covers only `~/.local/share/edging-heaven`. A subprocess inherits
   the sandbox. That's why simp's state goes under that dir. cyberdrop-dl also
   writes to `~/.config/cyberdrop-dl` and `~/.local/share/cyberdrop-dl`; both
   folders exist on the desktop. Add them to `ReadWritePaths` in
   `deploy/edging-heaven.service`, or find a cyberdrop-dl option that moves its
   app data. Which folders it really writes under the sandbox is **unverified**,
   so test it.
3. **`simp clear downloads` used to delete `.heaven-trash`**, the only copy of
   files deleted in Dangerous mode. **Fixed 2026-09-27**: hidden entries in the
   models folder are now skipped, with a test in `tests/test_clear.py`. Still,
   never expose `clear` in the web UI.
4. **Files deleted in Edging Heaven will come back.** simp's direct-download index
   (`state/done/<model>.jsonl`) treats a URL as done only while its file is still on
   disk. Deleting in Dangerous mode moves the file to `.heaven-trash`, so the next
   run downloads it again. cyberdrop-dl does not have this problem: its history in
   `state/cdl/cyberdrop.db` skips by URL no matter what's on disk. **Needed change:**
   a config option such as `download.redownload_missing = false`, off on the server,
   that makes `DownloadIndex.done()` trust the index even when the file is gone.
5. **One job at a time.** Two simp/cyberdrop-dl runs sharing `state/cdl/cyberdrop.db`
   corrupt or lock it.
6. **FAT32 limits.** No file can be 4 GB or larger. None over 2 GB exist today, but
   a long video from a host would fail. Names can't contain `<>:"/\|?*`; simp
   sanitizes them already.
7. **Cookies are a login credential.** On a headless server `auth.browser`
   (browser-cookie3) can't work, so it has to be `cookies.txt`. Store it with mode
   600. Never serve it through `/media` or commit it. When SimpCity logs the session
   out, `simp check-auth` fails, and the UI should say "upload new cookies".
8. **Move state, not just code.** Copy the desktop's `~/git/simp/state/` to the
   server. That includes `cdl/cyberdrop.db` (251 MB of "already downloaded"
   history), `done/` and `crawl/`. Also copy `cookies/simpcity.txt` and
   `config.toml`. Without the db, cyberdrop-dl re-downloads everything already on
   the drive. After the move, the server is the only place simp runs: two copies of
   the state would drift apart.
9. **Edging Heaven's scanner and in-progress downloads.** simp writes `*.part` and
   renames the file when it's done. Edging Heaven only picks known media
   extensions, so partial files stay invisible. Check that cyberdrop-dl's temp
   files also use a non-media extension (**unverified**).
10. **cyberdrop-dl makes subfolders** (`Loose Files (Bunkr)`, `<album> (PixelDrain)`)
    inside each model despite `--subfolders.no-create`. Edging Heaven handles
    nested folders, since a model is its top-level folder, so this is cosmetic.
    Decide whether you want it flat.

## Steps

1. On the server, check the **unverified** items (commands below).
2. Put simp into the repo as `edgingHeaven/simp/`, commit, push, and pull on the
   server. First confirm `git status` shows no cookies, state or `config.toml`.
3. On the server: create the venv, `pip install -e simp/`, and
   `pipx install cyberdrop-dl-patched`.
4. Create `~/.local/share/edging-heaven/simp/`, copy state, cookies and config over
   (trap 8), and set `whereto.txt` to `/mnt/edging-heaven/baza`.
5. Make the drive `rw` (Dangerous activation, trap 1) and extend `ReadWritePaths`
   (trap 2).
6. Test from the server's shell, **inside the same sandbox**:
   `systemd-run --user --pty -p ProtectHome=read-only -p ReadWritePaths=… simp -c … check-auth`,
   then one small `simp thread <url>`.
7. Add the simp change from trap 4 (`redownload_missing`).
8. Add the endpoints and the UI, with tests in the style of Edging Heaven's
   existing `tests/`: fake simp binary, temp data dir, real HTTP.
9. Restart `edging-heaven.service`, then do one real download from the phone.
10. Update the server docs (`~/infomds/EDGING-HEAVEN.md`, `HOSTING.md`,
    `MANIFEST.md`) and both READMEs. On the desktop, update
    `~/Documents/sys_info_backup/fedora-rebuild.md` if anything changed there.

### Check on the server first

```bash
ssh qwertyserver
python3 --version                                   # simp needs ≥ 3.11
which pipx cyberdrop-dl
findmnt -rn -o TARGET,OPTIONS /mnt/edging-heaven    # ro or rw?
grep 46C6-231E /etc/fstab
systemctl cat edging-heaven.service | grep -E 'Protect|ReadWrite'
cd ~/git/edgingHeaven && git status && git log --oneline -3
df -h ~                                             # room for simp's state (~300 MB) + venvs
```

## Prompt for the new chat

> Read `~/git/simp/EDGING-HEAVEN-INTEGRATION.md` and `~/git/edgingHeaven/README.md`.
> I want simp moved onto qwertyserver inside the Edging Heaven repo and controlled
> from the Edging Heaven website, as that doc describes. Start with "Check on the
> server first". I'll run the SSH commands and paste the output.
