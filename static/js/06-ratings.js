/* ==========================================================================
   Rating filter, history and undo
   ========================================================================== */

const RATING_FILTERS = ["all", "unrated", "liked", "loved"];

// Love is the top tier of keeping: everything that counts keeps counts it too.
function isKept(item) {
  return item?.rating === "like" || item?.rating === "love";
}

function sanitizeRatingFilter(value, legacyUnratedOnly) {
  if (RATING_FILTERS.includes(value)) {
    return value;
  }
  return legacyUnratedOnly ? "unrated" : "all";
}

function ratingFilterValue(settingKey) {
  return sanitizeRatingFilter(state.settings[settingKey], false);
}

function matchesRatingFilter(item, filter) {
  if (filter === "unrated") {
    return !item.rating;
  }
  if (filter === "liked") {
    return isKept(item);
  }
  if (filter === "loved") {
    return item.rating === "love";
  }
  return true;
}

function bindSegmented(container, datasetKey, onSelect) {
  const attribute = `data-${datasetKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  container.addEventListener("click", (event) => {
    const button = event.target.closest(`[${attribute}]`);
    if (button) {
      onSelect(button.dataset[datasetKey]);
    }
  });
}

function syncSegmented(container, datasetKey, value) {
  container.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset[datasetKey] === String(value));
  });
}

function bindRatingFilter(mode) {
  bindSegmented(controls[`${mode}RatingFilter`], "ratingFilter", (value) => setRatingFilter(mode, value));
}

// Every mode's "Show: All / Unrated / Liked" goes through here.
function setRatingFilter(mode, value) {
  state.settings[`${mode}RatingFilter`] = sanitizeRatingFilter(value, false);
  syncRatingFilter(mode);
  applyShowChange(mode);
}

// Show or "Only files I kept in Dangerous" changed: deal the mode again.
function applyShowChange(mode) {
  invalidateMediaPools();
  if (isDeckMode(mode)) {
    state.history[mode] = [];
    syncUndoButtons();
    rebuildDeck(mode);
    renderDeck(mode);
  } else if (mode === "feed") {
    state.feed.dirty = true;
    if (state.currentMode === "feed") {
      rebuildFeed();
    }
  } else if (state.currentMode === mode) {
    refreshMode(mode);
  }
  syncDrawerSummaries();
  queueSettingsSave();
}

function syncRatingFilter(mode) {
  const value = ratingFilterValue(`${mode}RatingFilter`);
  syncSegmented(controls[`${mode}RatingFilter`], "ratingFilter", value);
  if (mode === "gallery") {
    syncSegmented(controls.galleryQuickFilter, "ratingFilter", value);
  }
}

function pushHistory(mode, entry) {
  const log = state.history[mode];
  log.push(entry);
  if (log.length > 60) {
    log.shift();
  }
  syncUndoButtons();
}

function syncUndoButtons() {
  controls.swipeUndoButton.disabled = !state.history.swipe.length;
  controls.toktinderUndoButton.disabled = !state.history.toktinder.length;
}

async function undoLastAction(mode) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }
  const entry = state.history[mode].pop();
  syncUndoButtons();
  if (!entry) {
    return;
  }

  if (entry.kind === "skip") {
    state[config.indexKey] = clampNumber(entry.index, 0, Math.max(0, state[config.itemsKey].length - 1));
    renderDeck(mode);
    return;
  }

  try {
    await postJson("/api/rating", { path: entry.path, rating: entry.previousRating });
  } catch (error) {
    console.error(error);
    setStatus("Could not undo the last rating.");
    return;
  }

  recordRating(entry.path, entry.previousRating, entry.item);
  const canonicalItem = (state.library[config.sourceKey] || []).find((item) => item.path === entry.path);

  const items = state[config.itemsKey];
  if (entry.removed && !items.some((item) => item.path === entry.path)) {
    items.splice(clampNumber(entry.index, 0, items.length), 0, canonicalItem || entry.item);
  }
  state[config.indexKey] = clampNumber(entry.index, 0, Math.max(0, items.length - 1));

  renderDeck(mode);
  toast(entry.previousRating ? "Rating restored." : "Rating undone.");
}

/* ==========================================================================
   Video deck transport — scrub, play/pause, elapsed time
   ========================================================================== */

function bindToktinderTransport() {
  const video = controls.toktinderVideo;
  const seek = controls.toktinderSeek;

  // The card owns a swipe gesture; keep transport pointers away from it.
  ["pointerdown", "pointermove", "pointerup"].forEach((type) => {
    controls.toktinderTransport.addEventListener(type, (event) => event.stopPropagation());
  });

  controls.toktinderPlayToggle.addEventListener("click", toggleToktinderPlayback);

  const applySeek = () => {
    if (!video.src || !Number.isFinite(video.duration)) {
      return;
    }
    window.clearTimeout(state.seekThrottle);
    state.seekThrottle = 0;
    try {
      video.currentTime = clampNumber(Number(seek.value), 0, Math.max(0, video.duration - 0.05));
    } catch (error) {
      console.debug("seek failed", error);
    }
  };

  seek.addEventListener("pointerdown", () => {
    state.seekDragging = true;
  });
  ["pointerup", "pointercancel"].forEach((type) => {
    seek.addEventListener(type, () => {
      state.seekDragging = false;
      applySeek();
    });
  });

  seek.addEventListener("input", () => {
    state.seekDragging = true;
    controls.toktinderTime.textContent = formatClock(Number(seek.value));
    // Throttled, because every seek is a fresh range request to the server.
    if (!state.seekThrottle) {
      state.seekThrottle = window.setTimeout(() => {
        state.seekThrottle = 0;
        applySeek();
      }, 140);
    }
  });

  seek.addEventListener("change", () => {
    state.seekDragging = false;
    applySeek();
  });

  video.addEventListener("loadedmetadata", syncToktinderTransport);
  video.addEventListener("timeupdate", syncToktinderTransport);
  video.addEventListener("play", syncToktinderPlayButton);
  video.addEventListener("pause", syncToktinderPlayButton);
  video.addEventListener("emptied", syncToktinderTransport);
}

function toggleToktinderPlayback() {
  const video = controls.toktinderVideo;
  if (!video.src) {
    return;
  }
  if (video.paused) {
    applyToktinderAudio();
    video.play().catch(() => {});
  } else {
    video.pause();
  }
  syncToktinderPlayButton();
}

function syncToktinderPlayButton() {
  const paused = controls.toktinderVideo.paused;
  controls.toktinderPlayToggle.textContent = paused ? "Play" : "Pause";
  controls.toktinderPlayToggle.classList.toggle("active", paused);
}

function syncToktinderTransport() {
  const video = controls.toktinderVideo;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const hasClip = !!video.src && duration > 0;

  controls.toktinderTransport.hidden = !hasClip;
  if (!hasClip) {
    return;
  }

  controls.toktinderSeek.max = String(duration);
  controls.toktinderDuration.textContent = formatClock(duration);
  if (!state.seekDragging) {
    controls.toktinderSeek.value = String(video.currentTime);
    controls.toktinderTime.textContent = formatClock(video.currentTime);
  }
  syncToktinderPlayButton();
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/* ==========================================================================
   Prefetch
   ========================================================================== */

function preloadNextDeckImage(mode) {
  const config = deckConfig(mode);
  if (!config || config.mediaType !== "image") {
    return;
  }
  const items = state[config.itemsKey];
  if (items.length < 2) {
    return;
  }
  const next = items[(state[config.indexKey] + 1) % items.length];
  if (!next) {
    return;
  }
  // Held on `state` so the fetch is not cancelled when the local goes out
  // of scope. One in flight at a time is enough to hide the latency.
  state.preloader = new Image();
  state.preloader.src = mediaUrl(next.path);
}

