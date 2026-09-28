# Edging Heaven

Small self-hosted media browser for a local folder of photos and videos. It runs as a Python server on your computer, opens in any browser, and can also be opened from your phone on the same network.

## Features

- Seventeen modes, grouped the same way in the sidebar, the overview and the phone mode picker:
  - **Sort & rate:** `Photo deck`, `Video deck`, `Feed`, `Rediscover`, `Dangerous`
  - **Sit back:** `Escalation` (which now includes the old Stream mode), `Session`,
    `Beat`, `Red light`, `Dice`, `Mosaic`
  - **Your best:** `Ladder`, `Spotlight`, `Highlights`
  - **Your library:** `Gallery`, `Collection`, `Duel`, and the `Bookmarks` and `Downloads` pages
- Two levels of keep: **Keep** and **Love** (swipe up, `↑` or `L`). Love counts
  as kept everywhere; `Show` gains a `Loved` option in every mode
- **Marked moments:** press `B` (or **Mark**) at the start and end of a moment
  in a clip. Highlights plays only those; Escalation, Session, Mosaic and the
  timed modes start clips at them
- **Session history** in Collection (every Session / Beat / Red light / Dice /
  Ladder / Spotlight run of a minute or more), and a **page per model**
  (top-level folder) with its best files and one-tap Spotlight / Ladder / Duel
- **Privacy:** an optional server-enforced **PIN lock**, a **panic key** (`` ` ``
  or a three-finger tap) that silences everything behind a blank page, a plain
  tab title, and blanking the page when you switch away
- **Downloads** from SimpCity on the server: paste thread links, pull pages of
  your bookmarks, **New posts** on a model page, retry failures, follow the live
  output and cancel. The server runs [simp](scrprsimp/README.md) (in `scrprsimp/`)
  one job at a time and rescans when a job ends. **Bookmarks** shows every SimpCity
  bookmark with three pictures (your own photos for models you already have)
- **Toy sync** through Intiface Central (Buttplug protocol) — the running mode
  drives the intensity; holds and stops turn it off
- Crossfades between pictures in Escalation, Session and the timed modes
- A control center per mode (**Adjust**, or `A`), with two tabs:
  - **Tune** — a plain-English readback of what the mode will do, preset cards
    where several knobs interact, sliders with a filled track, one sound switch,
    and a sticky footer with the mode's main action and `Defaults`
  - **Folders** — the library as a tree: tick a group to take everything under
    it, `Only` to narrow to one branch, `All` / `None` / `Invert`, sort A–Z or by
    file count, search, a live "N of M folders · X files" meter, **saved sets**
    (name a selection once, apply it in any mode with one tap) and
    `Use this selection in every mode`
  - On a phone it is a bottom sheet you can drag down to close; on a wide
    screen (1280px+) it docks beside the stage so changes are visible live and
    the keyboard keeps working
- `Show: All / Unrated / Liked / Loved` in every mode, so Escalation, Mosaic, Session,
  Feed, Duel, Rediscover and the timed modes can play only what you kept. `Play your favorites`
  shortcuts on the overview and in Collection set this up in one tap
- One-row header: the active mode's tools (Undo, Focus, Adjust…) sit in the top
  bar, so the stage gets the room. Phones show the mode name as the mode picker
- Phones held sideways, and Focus mode, go full screen: the stage fills the
  display, tools float over it and fade after a few idle seconds. Focus also
  requests real browser fullscreen where allowed (not iOS)
- The screen stays awake in the lean-back modes (Screen Wake Lock, HTTPS only)
- Ratings feel instant: the card flies off the way you swiped and the save
  happens behind it; a failed save brings the card back and says so. Phones
  that support it give a short vibration
- Gallery video tiles show a still frame. There is no ffmpeg on the server, so
  the browser grabs one frame (two at a time, only for tiles on screen) and the
  server keeps it; every later visit, on any device, just loads a small JPEG
- Three themes: `Tidal` (deep blue, mint — default), `Velvet` (warm black,
  rose), `Fern` (light). Media stages stay dark in all of them
- Folder-balanced shuffling (`Settings → Shuffle`), undo in every deck,
  unreadable files skipped automatically, loading states with Retry/Skip
- Installable (`Add to Home Screen`) with a web manifest
- Only the active mode holds media; leaving a mode releases every clip
- JSON-backed persistence for ratings, duel rankings, settings, saved folder
  sets and seen times; LAN/Tailscale-friendly range requests and a virtual
  fast-start MP4 layout (originals unchanged)
- No build step and no external Python packages (simp, the optional downloader,
  keeps its packages in its own venv, `scrprsimp/.venv`, and runs as a separate process)

## Supported Media

- Images: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.avif`
- Videos: `.mp4`, `.webm`, `.mov`, `.m4v`, `.avi`, `.mkv`

## Run It

1. Put your media anywhere convenient, including an external drive.
2. Start the server:

```bash
python3 server.py
```

3. Open the printed local URL in a browser on the same computer.
4. Choose your media folder in the setup screen, unless you already passed `--media-dir`.
5. To open it from your phone, use the printed LAN URL while both devices are on the same Wi-Fi network.

Optional flags:

```bash
python3 server.py --media-dir "/path/to/media" --host 0.0.0.0 --port 8420 --data-dir ./data
```

## Modes And Controls

### Global

- `Overview`: the wordmark, `Overview` in the sidebar, or the mode picker on phones
- `Settings` (gear): library path and stats, theme, shuffle style, skipped
  files, `Change folder`, `Rescan library`, trash review, keyboard reference,
  and `Clear all likes + dislikes` (also clears duel rankings)
- `Focus`: every stage mode; full screen with floating tools
- Keyboard:
  - `M` mode picker · `A` open/close controls · `F` focus · `Esc` close / leave focus
  - `1`–`9`, `0`: Photo deck, Video deck, Feed, Rediscover, Duel, Escalation,
    Mosaic, Session, Gallery, Collection. Dangerous has no number key on purpose;
    the six newer modes are in the mode picker (`M`)
  - Decks, Rediscover: `←` pass, `→` keep, `↑` love, `↓` skip, `U` undo
  - Dangerous: `←` delete, `→` or `↑` keep (not a rating), `↓` skip, `U` undo
  - Feed: `↑` `↓` previous/next clip, `←` pass, `→` keep, `L` love, `Space` play/pause
  - `B`: mark a moment (Video deck, Feed, Rediscover, video preview)
  - Duel: `←` left wins, `→` right wins, `↓` new pair, `U` undo
  - Session, Beat, Red light, Dice: `Space` start/stop, `E` edge
  - Ladder, Highlights: `Space` pause, `←` `→` step; Spotlight `N` another model; Dice `D` draw now
  - `L` in any timed mode loves what is on screen
  - `` ` ``: panic (again, or a double tap, to come back)
  - Mosaic: `Space` pause/resume the wall; Video deck: `Space` play/pause

### Photo deck / Video deck

- Swipe right to keep, left to pass, down to skip — or the buttons / arrow keys
- Show `All` / `Unrated` / `Liked`, `Shuffle deck`, per-deck ratings reset
- Video deck has a scrub bar; tap the clip to pause

### Feed

- Vertical snap-scrolling clips. Tap to pause, double-tap to keep in place,
  `Pass` / `Keep` rate and move on. When a clip ends it loops or rolls on

### Rediscover

- A mixed deck ordered by neglect: files never shown anywhere in the app come
  first (folder-balanced), then the ones you have not seen for longest. A badge
  says "Never seen" or "Last seen 3 weeks ago"
- Every file shown in any mode counts as seen. Seen times are sent in batches
  and kept in `seen.json` next to `state.json`
- Keep / Pass / Skip rate exactly like the decks; `Deal again` re-sorts

### Duel

- Two files side by side (stacked on a phone). Tap the better one. Each pick is
  an Elo match (K=40 for a file's first ten duels, then 24), stored with the
  ratings. Pairs favour files with few duels against close ratings, so the
  order sharpens quickly
- Compare photos, videos or both; `Kept only` (default), `All` or `Unrated`
- The control center shows the top eight; Collection can sort by `Duel rank`
- `U` undoes the last pick; `Reset duel ranking` forgets them all

### Escalation (now includes Stream)

- Photos and clips swap on a timer. Presets: `Steady` (no ramp, corner clips —
  the old Stream mode), `Slow burn`, `Standard`, `Overload`
- `Speed up over time` on: the swap interval shrinks, video speed rises and
  late in the ramp it hot-seeks in bursts. Off: a constant pace
- `Corner clips` 0–2: small muted-until-sound-on videos over the stage

### Session

- Paced build/hold rounds; builds shorten and holds lengthen. The media freezes
  and dims on a hold
- `Edge` (toolbar, or `E`): cuts the build short for an instant hold, then
  resumes the rest of the build. During a hold it adds ten seconds. The session
  summary shows the time and number of edges

### Beat

- A metronome (Web Audio clicks: Click, Wood or Thump) that climbs from a start
  BPM to a peak over the length you set, gliding inside 20–45 s stretches, with
  random **stops** (silence, the picture freezes and dims). Then an open finish
- The picture swaps every N beats; the frame pulses on each beat, and phones
  that support it can vibrate on the beat
- `Edge` / `E`: an instant 20 s stop, then the beat comes back a notch slower
- Presets: Slow burn, Standard, Overload. Metronome volume and clip volume are separate

### Red light

- Go and stop at random: every green and every red is a fresh random length in
  your ranges, and green shows no countdown. Optional 2 s warning and tones
- When the time is up the last green ends in **Finish**, **Denied**, or a coin toss
- `Edge` / `E`: a full-length stop

### Dice

- Every 20–45 s (your range) a card changes the rules: Faster, Slower, Hold,
  Eyes on this one, Clips only, Loved only, Edge-then-hold, Back to the start
- After a minimum time each draw also rolls the finish odds; a **Finish allowed**
  card ends the run on an open finish. Card types can be switched off

### Ladder

- Your keeps in rising Duel rank: the top N by rank (unranked keeps fill the
  rest, loved first), weakest first and your #1 last, each step shorter than the
  one before. The top step stays until you stop

### Spotlight

- One model (a top-level folder and everything in it): mostly photos at first,
  more and more clips as the ramp goes on. Pick a model or **Surprise me**,
  weighted towards the models you keep most

### Highlights

- Only your marked moments, back to back: shuffled, best duel rank first, or
  newest files first; each played 1–5 times. `Remove` deletes a moment

### Mosaic

- 4, 6 or 9 clips at once; tap a tile to move the sound to it

### Gallery

- Paged contact sheet with search, quick `All / Unrated / Liked` filter, kind
  and sort in the control center, and a preview with swipe (or ←/→) to move and
  swipe down (or Esc) to close

### Collection

- What you kept: stats (kept, loved, this week, size, how much you have looked
  at), `Play what you kept` shortcuts, kept per day, **Sessions** (count, minutes,
  longest, day streak, edges per session, minutes per day, recent runs), top
  models (with `Browse`), and a grid sorted by newest/oldest kept, loved first,
  folder, name, size or `Duel rank`
- A model's name opens its **page**: files, kept, loved, looked at, duel-ranked,
  marked moments, its sub-folders, its best files, and Spotlight / Ladder /
  Duel / Browse for exactly that model

### Downloads

- Runs `simp` (SimpCity → media, `scrprsimp/`) on the server. Jobs:
  **Thread links** (up to 20, one per line; a page or post link in the thread
  works too), **Bookmarks** (pages `1`, `2-4`, `1,3,8` or `all`, and "at most" N
  models), **Retry** for models with failed files, **Check login**, and **New
  posts**, which reads a known thread from the last page simp saw. **New posts**
  is also on a model's page in Collection, once simp has downloaded that model
  from its thread link
- One job runs at a time; the rest wait. The running job's output streams on the
  page; **Cancel** stops simp and cyberdrop-dl together
- **Use it while it downloads:** every ~10 s the server adds the files that have
  finished to the library (only the folder being written, no full rescan). Open
  pages fetch just those additions, so decks and Dangerous keep their place and
  get the new files after the one on screen. **Arriving** shows the newest files of
  the job; **Sort in Dangerous** opens Dangerous on that model's files. Direct
  images arrive one by one; files fetched by cyberdrop-dl (Bunkr, PixelDrain, …)
  arrive together when that stage of the job ends, because they are checked for
  duplicates first in `<drive>/.<library>.simp-incoming/`, outside the library
- **No duplicate copies:** a new file identical (same bytes, SHA-256) to one
  already in that model's folder is not kept, whatever its name or URL. Each
  model is checked on its own; the same photo under two models stays in both.
  Resized or re-encoded copies count as different files. Details:
  [Content verification](scrprsimp/README.md#content-verification-photos-and-videos).
  Duplicates from before this check were removed once on 2026-09-28 (11,315
  copies, 11.27 GiB; ratings, marks and kept flags stayed on the copy kept)
- A thread crawl that could not read every page ends the job as **Failed**, even
  though the files it did find were downloaded; submit it again to fill the gaps
- **Drive reserve:** simp keeps 3 GiB free on the drive. A job that reaches it ends
  as **Drive full**; it and the downloads waiting behind it are held until
  **Resume** (needs more than 4 GiB free). Resuming never downloads a file twice
- **Upload cookies.txt**: a Netscape-format export from a browser logged in to
  SimpCity. It is the login; stored mode 600 next to `state.json`, never served
- simp's config, cookies, download history and job logs live in
  `<data dir>/scrprsimp/`. Setup, the server's config and the traps (FAT32,
  read-only home, deleted files staying deleted) are in `deploy/EDGING-HEAVEN.md`
  and `scrprsimp/README.md`. `simp clear` is intentionally not on the page

### Bookmarks

- Every model thread you bookmarked on SimpCity, as a card with three pictures:
  your own photos (loved and kept first) for a model you have, or small pictures
  simp saved from the thread for one you don't. Shows files and keeps per model
- **Refresh from SimpCity** runs `simp bookmarks --save` as a download job (the
  first time about 10–15 minutes for ~140 bookmarks; later only what is new). The
  list fills in while it runs
- Search, `All / Not yet / In library`, **Download** or **New posts**, **Open**
  (the model page), **SimpCity** (the thread), and **Download the rest** — mind the
  free space on the drive before using that one
- Pictures are stored in `<data dir>/scrprsimp/state/previews/` and served by this
  server; the page never loads anything from SimpCity itself

### Privacy (Settings)

- **PIN lock** (off until you set one): 4–12 digits. The server then refuses
  every API and media request without an unlock cookie, so nothing loads before
  the PIN. Each device stays unlocked for 30 days or until **Lock now**. The PIN
  is stored only as a salted PBKDF2 hash; wrong PINs back off (5 free, then 30 s
  doubling to 15 min). Changing or removing it needs the current PIN
- **Panic**: `` ` `` or a three-finger tap stops every mode, turns the toy off
  and covers the page with a blank "Notes" page; double-tap or `` ` `` to return
- **Plain tab title and icon**, and **Blank the page when I switch away** (so the
  phone's app switcher shows the blank page)

### Toy (Settings)

- Start Intiface Central (free) on the device next to the toy, pair the toy
  there, then **Connect** here (default `ws://127.0.0.1:12345`). Escalation,
  Session, Beat, Red light, Dice, Ladder, Spotlight and Highlights set the
  intensity; holds, stops, leaving the mode and panic turn it off. **Max
  intensity** scales everything

### Dangerous

- For clearing space, not for rating. Random photos and videos. Swipe left / `←`
  moves the **original file** into `<media folder>/.heaven-trash/<token>/media`;
  right (or `↑`) keeps it; down skips; `U` undoes
- **Keep is not a like.** It only remembers that you kept the file here, so with
  `Hide files I already kept here` (on by default) it does not come up again. Kept
  files are stored as `dangerousKept` in `state.json`, separate from ratings
- Its way in is red everywhere (sidebar, mode picker, overview, title), so it is
  never mistaken for a mode that only looks
- Control center: media type, hide kept files, folders, sound
- `Settings → Review trash` restores files, including after restarts.
  `Settings → Empty trash` (after a confirm) permanently erases every trashed
  file, its ratings and its video still; that is the only permanent delete.
  Read-only drives keep Delete disabled

## Activate on qwertyserver

The current service must restart to load Python changes. The original Lexar installation used a read-only mount. To enable deletion, run:

```bash
sudo python3 /home/qwerty/git/edgingHeaven/deploy/enable-dangerous.py
```

This checks the expected UUID/mount, backs up `/etc/fstab` to `/etc/fstab.before-dangerous`, changes only that entry to `rw`, remounts the drive, restarts the existing service, verifies the new API, and updates the system documentation. It does not delete media or install packages. Reproduction, rollback, and the verified deployment state are in `~/infomds/EDGING-HEAVEN.md` and `~/infomds/MANIFEST.md`.

## Checks

```bash
python3 -m unittest discover -s tests -v
for f in static/js/*.js; do node --check "$f"; done
scrprsimp/.venv/bin/python -m pytest -q scrprsimp/tests   # simp itself
```

The tests cover drive reconnection, trash/restart/restore, overwrite and traversal protection, byte-range equivalence of the virtual MP4 layout, duel ratings, seen times, stored video thumbnails, Love ratings, marked moments, session history, the PIN lock over real HTTP (locked API and media, backoff, change/remove, hashed storage), and Downloads
against a stand-in simp (validation, one job at a time, cancelling the whole process group, log offsets,
cookies, the PIN). Actual phone hardware and remote-network speed still need device testing.

`tests/browser_live.py` checks using a download while it runs (files arriving
without reshuffling, Arriving, Sort in Dangerous, Keep without rating, Drive full
and Resume) on a temporary copy of two test-library folders:
`python3 tests/browser_live.py --media-dir /mnt/edging-heaven/testing`.

`tests/browser_features.py` drives Love, marking, Highlights, Session clip
playback, Beat, Red light, Dice, Ladder, Spotlight, crossfades, session history,
model pages, panic, toy sync (against a mock Intiface server), the PIN lock and
the Downloads page (stand-in simp writing only to a temporary folder) in Chromium, with the same rules as the design check below (testing library
only, temporary data, trash blocked). It needs Playwright and `websockets`.

```bash
python3 tests/browser_features.py --media-dir /mnt/edging-heaven/testing
```

## Notes

- Ratings, duel rankings, marked moments, session history, settings and the PIN hash are stored in `data/state.json`; seen times in `data/seen.json`; video stills in `data/thumbs/` (safe to delete — they are remade on demand).
- The page's code is split into ordered plain scripts in `static/js/` (no build step). They share one global scope, in file order, so the browser tests can call `setMode()`, `state`, etc. directly.
- Forgot the PIN: stop the server, set `"lock": null` and `"lockTokens": {}` in `state.json`, start it again.
- If you switch to a different media directory, saved ratings are cleared so the state matches the new library.
- The app scans folders recursively, so very large libraries can take longer to refresh.
- If a previously selected drive is disconnected, the app shows the saved path as unavailable. While the page is open, it checks every 5 seconds and rescans automatically when that folder returns. Ratings survive reconnecting the same library. The operating system must mount the drive at the same path first.
- `--media-dir` can point to a disconnected drive: the server starts and waits for that folder to become available.
- Sound unlock is per browser session. On phones and some desktop browsers, autoplay with sound is blocked until you tap `Enable Sound`.
- The app is local-first. Anyone who can reach the LAN URL can open the gallery, so only run it on trusted networks.

## Design regression checks

`tests/browser_design.py` drives the real app in Chromium using **only**
`/mnt/edging-heaven/testing`, with a temporary data directory and trash/restore
blocked. It checks every mode at eight viewport sizes (normal and focus) for
clipped or overflowing controls, buttons covering video controls, and media
left in hidden modes; then the keyboard map, the docked control center, the
folder tree (only / invert / none / all / saved sets / copy to every mode),
Escalation presets and corner clips, Session edge, Duel pick + undo,
Rediscover + seen tracking, gallery thumbnails, themes, touch swipes,
drag-to-close sheets, preview swipes and the landscape-phone layout.

```bash
python3 tests/browser_design.py --media-dir /mnt/edging-heaven/testing
```

`BROWSER_EXECUTABLE` can point to an existing Chromium binary. Optional
`AXE_SCRIPT` points to a local `axe.min.js` for WCAG 2 A/AA checks (overview,
mode picker, control center, settings in all three themes). `--shots DIR`
saves screenshots with media hidden.
