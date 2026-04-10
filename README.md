# Edging Heaven

Small self-hosted media browser for a local folder of photos and videos. It runs as a Python server on your computer, opens in any browser, and can also be opened from your phone on the same network.

## Features

- Four browser modes:
  - `Tinder`: swipe-style photo deck for rating images
  - `TindTok`: swipe-style video deck for rating videos
  - `Stream`: rotating fullscreen photos with up to 2 corner videos
  - `Escalation`: accelerating photo/video playback that ramps from slow-burn into burst-mode overload
- Web-based library setup and switching:
  - start with `python3 server.py`
  - pick the media folder in the browser
  - switch libraries later with `Change Folder`
  - quick-pick suggestions for common folders and mounted drives
- Per-mode folder filters for `Tinder`, `TindTok`, `Stream`, and `Escalation`
- `Show only unrated` filters for both swipe decks
- Shared appearance system with 6 themes:
  - `Velvet Night`
  - `Ember Room`
  - `Afterglow`
  - `Paper Light`
  - `Sage Studio`
  - `Slate Office`
- Focus mode for cleaner fullscreen browsing across all modes
- Shuffle controls for both swipe decks
- JSON-backed persistence for:
  - saved ratings
  - theme selection
  - folder filters
  - stream playback settings
  - escalation playback settings
  - last selected media directory
- LAN-friendly playback with HTTP range support for videos
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

- `Change Folder`: reopen the folder picker and switch libraries
- `Hub`: open the shared global panel for themes and library-wide actions
- `Rescan Library`: available inside the hub
- `Clear All Likes + Dislikes`: available inside the hub and clears saved ratings for all photos and videos without changing the current folder, theme, filters, or settings
- `Focus Mode`: available in all 4 modes
- Keyboard:
  - `F`: toggle focus mode
  - `Escape`: close the active drawer or exit focus mode

### Tinder

- Photo-only swipe deck
- Rate with buttons, keyboard, mouse drag, or touch drag
- Keyboard:
  - `Left Arrow`: pass / `dislike`
  - `Right Arrow`: keep / `like`
  - `Down Arrow`: skip
- Controls:
  - folder filter
  - `Show only unrated photos`
  - `Shuffle Deck`
  - `Reset Photo Ratings`

### TindTok

- Video-only swipe deck
- Same swipe controls and keyboard shortcuts as `Tinder`
- Controls:
  - folder filter
  - `Show only unrated videos`
  - `Enable Sound` / `Mute Videos`
  - `Shuffle Deck`
  - `Reset Video Ratings`

### Stream

- Random rotating photos from the filtered image pool
- Up to 2 corner videos from the filtered video pool
- Controls:
  - folder filter
  - `Interval`: 3 to 60 seconds between photo changes
  - `Count`: 0 to 2 corner videos
  - `Volume`: shared stream video volume
  - `Enable Sound` / `Mute Videos`
  - `Clip Start`: random point or fixed second
  - `Refresh Stream`

### Escalation

- Accelerating fullscreen playback built to intensify over time
- Uses a filtered image backdrop plus a foreground video lane
- Videos hot-seek into later timestamps on load, ramp playback speed, and enter burst-style timestamp skipping near the end of the ramp
- Controls:
  - folder filter
  - `Start Interval`
  - `Fastest Interval`
  - `Ramp Length`
  - `Top Speed`
  - `Volume`: Escalation-only video volume
  - `Enable Sound` / `Mute Videos`
  - `Restart Escalation`

## Notes

- Ratings and settings are stored in `data/state.json`.
- If you switch to a different media directory, saved ratings are cleared so the state matches the new library.
- The app scans folders recursively, so very large libraries can take longer to refresh.
- If a previously selected drive is disconnected, the app will show the saved path as unavailable until you reconnect it or choose another folder.
- Sound unlock is per browser session. On phones and some desktop browsers, autoplay with sound is blocked until you tap `Enable Sound`.
- The app is local-first. Anyone who can reach the LAN URL can open the gallery, so only run it on trusted networks.
