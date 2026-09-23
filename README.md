# Edging Heaven

Small self-hosted media browser for a local folder of photos and videos. It runs as a Python server on your computer, opens in any browser, and can also be opened from your phone on the same network.

## Features

- Eleven modes, grouped the same way in the sidebar, the overview and the phone mode picker:
  - **Sort & rate:** `Photo deck`, `Video deck`, `Feed`, `Rediscover`, `Dangerous`
  - **Sit back:** `Escalation` (which now includes the old Stream mode), `Mosaic`, `Session`
  - **Your library:** `Gallery`, `Collection`, `Duel`
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
- `Show: All / Unrated / Liked` in every mode, so Escalation, Mosaic, Session,
  Feed, Duel and Rediscover can play only what you kept. `Play your favorites`
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
- No build step and no external Python packages

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
    Mosaic, Session, Gallery, Collection. Dangerous has no number key on purpose
  - Decks, Rediscover, Dangerous: `←` pass/delete, `→` keep, `↓` skip, `U` undo
  - Feed: `↑` `↓` previous/next clip, `←` pass, `→` keep, `Space` play/pause
  - Duel: `←` left wins, `→` right wins, `↓` new pair, `U` undo
  - Session: `Space` start/stop, `E` edge (instant hold)
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

### Mosaic

- 4, 6 or 9 clips at once; tap a tile to move the sound to it

### Gallery

- Paged contact sheet with search, quick `All / Unrated / Liked` filter, kind
  and sort in the control center, and a preview with swipe (or ←/→) to move and
  swipe down (or Esc) to close

### Collection

- What you kept: stats, `Play what you kept` shortcuts, top folders by keep
  rate (with `Browse`), and a grid sorted by newest/oldest kept, folder, name,
  size or `Duel rank`

### Dangerous

- Random photos and videos. Swipe left / `←` moves the **original file** into
  `<media folder>/.heaven-trash/<token>/media`; right keeps it; down skips; `U` undoes
- Control center: media type, only-unrated, folders, sound
- `Settings → Review trash` restores files, including after restarts. Nothing
  is permanently erased by the app; read-only drives keep Delete disabled

## Activate on qwertyserver

The current service must restart to load Python changes. The original Lexar installation used a read-only mount. To enable deletion, run:

```bash
sudo python3 /home/qwerty/git/edgingHeaven/deploy/enable-dangerous.py
```

This checks the expected UUID/mount, backs up `/etc/fstab` to `/etc/fstab.before-dangerous`, changes only that entry to `rw`, remounts the drive, restarts the existing service, verifies the new API, and updates the system documentation. It does not delete media or install packages. Reproduction, rollback, and the verified deployment state are in `~/infomds/EDGING-HEAVEN.md` and `~/infomds/MANIFEST.md`.

## Checks

```bash
python3 -m unittest discover -s tests -v
node --check static/app.js
```

The tests cover drive reconnection, trash/restart/restore, overwrite and traversal protection, byte-range equivalence of the virtual MP4 layout, duel ratings, seen times, and stored video thumbnails. Actual phone hardware and remote-network speed still need device testing.

## Notes

- Ratings, duel rankings and settings are stored in `data/state.json`; seen times in `data/seen.json`; video stills in `data/thumbs/` (safe to delete — they are remade on demand).
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
