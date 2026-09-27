/* ==========================================================================
   Video start sequencing

   The old code called play() from inside `loadedmetadata`, straight after
   assigning currentTime. At that point the element has metadata but not a
   decoded frame, and the seek has not landed, so the browser would start the
   *audio* of the new clip while the previous frame was still on screen —
   worst over Tailscale, where the range request takes a moment. Everything
   now goes through loadVideoSource() + playWhenReady(): seek, wait for the
   seek to land and a frame to exist, then play.
   ========================================================================== */

let videoLoadToken = 0;

function loadVideoSource(video, item) {
  const token = String((videoLoadToken += 1));
  // Stop the outgoing clip before anything else, so its audio can never
  // overlap the incoming one.
  video.pause();
  video.dataset.loadToken = token;
  video.dataset.path = item.path;
  video.playbackRate = 1;
  video.preload = "auto";
  video.src = mediaUrl(item.path);
  video.load();
  return token;
}

function isCurrentLoad(video, token) {
  return video.dataset.loadToken === token;
}

function playWhenReady(video, token, seekTo) {
  if (!video.getAttribute("src") || !isCurrentLoad(video, token)) {
    return;
  }

  if (video.preload === "none" && video.readyState === 0) {
    // Nothing is being fetched at all, so no readiness event would ever fire.
    // Do this before any seek: load() rewinds currentTime.
    video.preload = "metadata";
    video.load();
  }

  let started = false;
  const start = () => {
    if (started || !isCurrentLoad(video, token) || document.hidden ||
        (video.closest(".mode-panel") && !video.closest(".mode-panel").classList.contains("active"))) {
      return;
    }
    started = true;
    video.play().catch(() => {});
  };

  const whenDecoded = () => {
    if (!isCurrentLoad(video, token)) {
      return;
    }
    // HAVE_CURRENT_DATA: there is a frame for the current position, so
    // picture and sound come up together.
    if (video.readyState >= 2) {
      start();
      return;
    }
    // `loadeddata` is the readyState 2 event. `canplay` is readyState 3 and
    // may never arrive, because a preload="metadata" element stops buffering
    // once it has the header.
    video.addEventListener("loadeddata", start, { once: true });
    video.addEventListener("canplay", start, { once: true });
  };

  // `null`/`undefined` mean "start wherever you are". Number(null) is 0, so
  // testing the number alone used to rewind every resumed clip to the start:
  // scrolling back up the feed restarted the clip instead of continuing it.
  const target = seekTo === null || seekTo === undefined ? NaN : Number(seekTo);
  const needsSeek = Number.isFinite(target) && Math.abs(video.currentTime - target) > 0.05;
  if (needsSeek) {
    video.addEventListener("seeked", whenDecoded, { once: true });
    try {
      video.currentTime = target;
    } catch (error) {
      whenDecoded();
    }
  } else {
    whenDecoded();
  }

  // A seek past a damaged keyframe can leave `seeked` unfired forever.
  // Play anyway rather than sitting on a frozen frame.
  window.setTimeout(start, 1500);
}

function releaseVideo(video) {
  if (!video) {
    return;
  }
  video.pause();
  video.removeAttribute("src");
  video.removeAttribute("data-path");
  delete video.dataset.loadToken;
  try {
    video.load();
  } catch (error) {
    /* teardown only */
  }
}

/* ==========================================================================
   Unreadable files

   A truncated download or a half-copied file shows up as a broken image or a
   video that never decodes. Rather than leaving it on screen, report it to
   the server (which drops it from the catalog for good) and move on.
   ========================================================================== */

const BROKEN_STREAK_LIMIT = 15;

function reportBrokenMedia(path) {
  if (!path || state.brokenPaths.has(path)) {
    return false;
  }
  state.brokenPaths.add(path);
  state.brokenStreak += 1;
  state.brokenCount += 1;
  removeLibraryItem(path);
  syncBrokenSummary();
  postJson("/api/broken", { path }).catch((error) => console.debug("broken report failed", error));
  return true;
}

function noteMediaLoaded() {
  state.brokenStreak = 0;
}

function brokenStreakExhausted(mode) {
  if (state.brokenStreak < BROKEN_STREAK_LIMIT) {
    return false;
  }
  setStatus(
    `Skipped ${BROKEN_STREAK_LIMIT} unreadable files in a row. The drive may be disconnected — rescan from Settings.`
  );
  state.brokenStreak = 0;
  return true;
}

function removeLibraryItem(path) {
  invalidateMediaPools();
  ["images", "videos"].forEach((key) => {
    if (Array.isArray(state.library[key])) {
      state.library[key] = state.library[key].filter((item) => item.path !== path);
    }
  });

  ["swipe", "toktinder"].forEach((mode) => {
    const config = deckConfig(mode);
    const items = state[config.itemsKey];
    const removedBefore = items.filter(
      (item, index) => item.path === path && index < state[config.indexKey]
    ).length;
    state[config.itemsKey] = items.filter((item) => item.path !== path);
    state[config.indexKey] = clampNumber(
      state[config.indexKey] - removedBefore,
      0,
      Math.max(0, state[config.itemsKey].length - 1)
    );
    state.history[mode] = state.history[mode].filter((entry) => entry.path !== path);
  });

  state.escalationRecentPaths = state.escalationRecentPaths.filter((entry) => entry !== path);
  syncCountsFromLibrary();
  syncUndoButtons();
}

// Over Tailscale a dropped request looks exactly like a corrupt file. Give
// every element one silent retry before condemning the path, so a flaky link
// cannot quietly delete half a library.
const retryCounts = new Map();

function retryOrCondemn(element, onGiveUp) {
  const path = element.dataset.path;
  const src = element.getAttribute("src");
  if (!path || !src) {
    return false;
  }

  const attempts = (retryCounts.get(path) || 0) + 1;
  retryCounts.set(path, attempts);
  if (attempts === 1) {
    // Re-request the same file once; a cache-buster avoids a cached failure.
    element.setAttribute("src", `${mediaUrl(path)}&retry=1`);
    if (element.tagName === "VIDEO") {
      element.load();
    }
    return false;
  }

  retryCounts.delete(path);
  if (!reportBrokenMedia(path)) {
    return false;
  }
  onGiveUp();
  return true;
}

function mediaErrorIsFatal(video) {
  const error = video.error;
  if (!error) {
    return false;
  }
  // 1 = aborted (we switched clips), 2 = network. Neither means the file is
  // bad. 3 = decode, 4 = unsupported: those are the corrupt ones.
  return error.code === 3 || error.code === 4;
}

function bindMediaErrorHandlers() {
  controls.swipeImage.addEventListener("error", () => handleDeckMediaFailure("swipe"));
  controls.swipeImage.addEventListener("load", () => {
    // Some decoders report success on a truncated file but produce no pixels.
    if (!controls.swipeImage.naturalWidth) {
      handleDeckMediaFailure("swipe");
      return;
    }
    retryCounts.delete(controls.swipeImage.dataset.path);
    noteMediaLoaded();
    preloadNextDeckImage("swipe");
  });

  controls.toktinderVideo.addEventListener("error", () => handleDeckMediaFailure("toktinder"));
  controls.toktinderVideo.addEventListener("loadeddata", () => {
    retryCounts.delete(controls.toktinderVideo.dataset.path);
    noteMediaLoaded();
  });

  const escalationRecover = () => {
    if (state.currentMode === "escalation") {
      refreshEscalationMedia(true);
    }
  };

  controls.escalationPhoto.addEventListener("error", () => {
    if (brokenStreakExhausted("escalation")) {
      return;
    }
    retryOrCondemn(controls.escalationPhoto, escalationRecover);
  });
  controls.escalationPhoto.addEventListener("load", () => {
    retryCounts.delete(controls.escalationPhoto.dataset.path);
    noteMediaLoaded();
  });

  controls.escalationVideo.addEventListener("error", () => {
    if (!mediaErrorIsFatal(controls.escalationVideo) || brokenStreakExhausted("escalation")) {
      return;
    }
    retryOrCondemn(controls.escalationVideo, escalationRecover);
  });
  controls.escalationVideo.addEventListener("loadeddata", () => {
    retryCounts.delete(controls.escalationVideo.dataset.path);
    noteMediaLoaded();
  });
}

function handleDeckMediaFailure(mode) {
  const config = deckConfig(mode);
  const media = controls[config.mediaControl];
  if (config.mediaType === "video" && !mediaErrorIsFatal(media)) {
    return;
  }
  if (brokenStreakExhausted(mode)) {
    return;
  }
  retryOrCondemn(media, () => renderDeck(mode));
}

async function clearBrokenFiles() {
  try {
    setStatus("Restoring skipped files...");
    await postJson("/api/clear-broken", {});
    state.brokenPaths = new Set();
    state.brokenStreak = 0;
    await loadState({ rebuild: true });
    setStatus("Skipped files restored.");
  } catch (error) {
    console.error(error);
    setStatus("Could not restore skipped files.");
  }
}

function syncBrokenSummary() {
  const count = Number(state.brokenCount || 0);
  controls.brokenSummary.textContent = count
    ? `${count.toLocaleString()} unreadable ${count === 1 ? "file is" : "files are"} hidden from every mode.`
    : "No files have been skipped.";
  controls.clearBrokenButton.disabled = !count;
}

