/* ==========================================================================
   Mosaic — a wall of clips, one of them audible
   ========================================================================== */

function mosaicTileCount() {
  return clampNumber(Number(state.settings.mosaicTiles ?? 4), 4, 9);
}

function getMosaicItems() {
  return mediaPool(`mosaic:${!!state.settings.mosaicIncludePhotos}`, () => {
    const videos = modeSource("mosaic", "videos").map((item) => ({ ...item, kind: "video" }));
    if (!state.settings.mosaicIncludePhotos) {
      return videos;
    }
    const images = modeSource("mosaic", "images").map((item) => ({ ...item, kind: "photo" }));
    return [...videos, ...images];
  });
}

function startMosaic() {
  stopMosaic();
  state.mosaic.paused = false;
  syncMosaicPauseButton();
  const items = getMosaicItems();
  const count = mosaicTileCount();
  // A phone is too narrow for a 3x2 wall, so six tiles go 2x3 there instead.
  // Nine stays 3x3 everywhere: 2x5 would leave a ragged half-empty last row.
  const narrow = window.matchMedia("(max-width: 520px)").matches;
  const columns = count >= 9 ? 3 : count >= 6 ? (narrow ? 2 : 3) : 2;
  const rows = Math.ceil(count / columns);
  // Both tracks are pinned so every tile is an equal share of the wall. Left
  // to `auto` rows the grid sizes to whatever the clips happen to decode to.
  controls.mosaicStage.style.setProperty("--mosaic-cols", String(columns));
  controls.mosaicStage.style.setProperty("--mosaic-rows", String(rows));
  controls.mosaicStage.querySelectorAll("video").forEach(releaseVideo);
  controls.mosaicStage.innerHTML = "";
  state.mosaic.tiles = [];

  if (!items.length) {
    controls.mosaicStatus.textContent =
      "No media matches the mosaic filter. Widen the folders, or allow photos.";
    return;
  }
  controls.mosaicStatus.textContent = `${count} tiles from ${items.length.toLocaleString()} clips. Tap a tile to move the sound.`;

  const template = document.getElementById("mosaicTileTemplate");
  for (let index = 0; index < count; index += 1) {
    controls.mosaicStage.appendChild(template.content.cloneNode(true));
    const element = controls.mosaicStage.lastElementChild;
    const tile = {
      element,
      video: element.querySelector("video"),
      image: element.querySelector("img"),
      timer: null,
      index,
    };
    tile.video.addEventListener("error", () => {
      if (mediaErrorIsFatal(tile.video)) {
        reportBrokenMedia(tile.video.dataset.path);
        swapMosaicTile(tile);
      }
    });
    element.addEventListener("click", () => setMosaicAudioTile(index));
    state.mosaic.tiles.push(tile);

    tile.firstOffsetMs = (mosaicSwapMs() / count) * index;
    tile.timer = window.setTimeout(() => swapMosaicTile(tile), 40 * index);
  }
  setMosaicAudioTile(clampNumber(state.mosaic.audioIndex, 0, count - 1));
}

function stopMosaic() {
  state.mosaic.tiles.forEach((tile) => {
    window.clearTimeout(tile.timer);
    releaseVideo(tile.video);
  });
  state.mosaic.tiles = [];
  controls.mosaicStage.innerHTML = "";
}

function toggleMosaicPause() {
  state.mosaic.paused = !state.mosaic.paused;
  state.mosaic.tiles.forEach((tile) => {
    window.clearTimeout(tile.timer);
    if (state.mosaic.paused) {
      tile.video.pause();
    } else {
      tile.video.play().catch(() => {});
      scheduleMosaicSwap(tile);
    }
  });
  syncMosaicPauseButton();
  toast(state.mosaic.paused ? "Wall paused. Space resumes it." : "Wall resumed.");
}

function syncMosaicPauseButton() {
  controls.mosaicPauseButton.textContent = state.mosaic.paused ? "Resume wall" : "Pause wall";
  controls.mosaicPauseButton.classList.toggle("active", state.mosaic.paused);
}

function mosaicSwapMs() {
  return clampNumber(Number(state.settings.mosaicSwapSeconds ?? 12), 4, 60) * 1000;
}

function scheduleMosaicSwap(tile) {
  window.clearTimeout(tile.timer);
  if (state.currentMode !== "mosaic" || state.mosaic.paused) {
    return;
  }
  // Jitter keeps the tiles from drifting into lockstep; the one-off offset
  // spreads the first round of swaps across a whole cycle.
  const jitter = 0.75 + Math.random() * 0.5;
  const offset = tile.firstOffsetMs || 0;
  tile.firstOffsetMs = 0;
  tile.timer = window.setTimeout(() => swapMosaicTile(tile), mosaicSwapMs() * jitter + offset);
}

function swapMosaicTile(tile) {
  const items = getMosaicItems();
  if (!items.length) {
    return;
  }
  const taken = state.mosaic.tiles.map((entry) => entry.video.dataset.path || entry.image.dataset.path);
  const chosen = pickWithoutRepeats(items, taken, null);
  if (!chosen) {
    return;
  }

  if (chosen.kind === "photo") {
    releaseVideo(tile.video);
    tile.video.hidden = true;
    tile.image.hidden = false;
    tile.image.dataset.path = chosen.path;
    tile.image.src = mediaUrl(chosen.path);
  } else {
    tile.image.hidden = true;
    tile.image.removeAttribute("src");
    tile.image.removeAttribute("data-path");
    tile.video.hidden = false;
    tile.video.loop = true;
    tile.video.playsInline = true;
    const token = loadVideoSource(tile.video, chosen);
    tile.video.addEventListener(
      "loadedmetadata",
      () => {
        const duration = Number.isFinite(tile.video.duration) ? tile.video.duration : 0;
        playWhenReady(tile.video, token, clipStart(chosen.path, duration, () => (duration > 4 ? Math.random() * (duration - 2) : 0)));
      },
      { once: true }
    );
  }

  tile.element.title = chosen.name;
  markSeen(chosen.path);
  applyMosaicAudio();
  scheduleMosaicSwap(tile);
}

function setMosaicAudioTile(index) {
  state.mosaic.audioIndex = index;
  state.mosaic.tiles.forEach((tile, position) => {
    tile.element.classList.toggle("is-audible", position === index);
  });
  applyMosaicAudio();
}

function applyMosaicAudio() {
  const volume = clampNumber(Number(state.settings.mosaicVolume ?? 0.3), 0, 1);
  state.mosaic.tiles.forEach((tile, position) => {
    const audible = position === state.mosaic.audioIndex && state.audioUnlocked && volume > 0;
    tile.video.volume = volume;
    tile.video.muted = !audible;
  });
}

