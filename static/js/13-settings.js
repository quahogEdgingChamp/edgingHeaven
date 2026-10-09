/* ------------------------------------------------------------------------ */

function bindSessionEvents() {
  controls.sessionVideo.addEventListener("loadedmetadata", playSessionClip);
  controls.sessionToggleButton.addEventListener("click", toggleSession);
  controls.sessionHudStart.addEventListener("click", startSession);
  controls.sessionEdgeButton.addEventListener("click", edgeSession);
  controls.sessionRestartButton.addEventListener("click", () => {
    startSession();
    closeDrawers();
  });

  const reshape = () => {
    renderSessionPips();
    syncSessionHud();
  };
  bindRangeSetting(controls.sessionRounds, "sessionRounds", (value) => `${value}`, reshape);
  bindRangeSetting(controls.sessionBuildSeconds, "sessionBuildSeconds", (value) => `${value}s`, reshape);
  bindRangeSetting(controls.sessionHoldSeconds, "sessionHoldSeconds", (value) => `${value}s`, reshape);
  bindRangeSetting(
    controls.sessionVideoVolume,
    "sessionVideoVolume",
    (value) => `${Math.round(value * 100)}%`,
    applySessionAudio
  );

  bindSegmented(controls.sessionIncludeVideos, "sessionMedia", (value) => {
    state.settings.sessionIncludeVideos = value === "mixed";
    syncSegmented(
      controls.sessionIncludeVideos,
      "sessionMedia",
      state.settings.sessionIncludeVideos ? "mixed" : "photos"
    );
    refreshSessionMedia(true);
    queueSettingsSave();
  });
}

function bindGalleryEvents() {
  controls.gallerySearch.addEventListener("input", (event) => {
    window.clearTimeout(state.gallery.searchTimer);
    const value = event.target.value;
    state.gallery.searchTimer = window.setTimeout(() => {
      state.gallery.search = value;
      renderGallery(true);
    }, 200);
  });

  controls.galleryPrevPage.addEventListener("click", () => {
    state.gallery.page -= 1;
    renderGallery(false);
  });
  controls.galleryNextPage.addEventListener("click", () => {
    state.gallery.page += 1;
    renderGallery(false);
  });

  bindSegmented(controls.galleryKind, "galleryKind", (value) => {
    state.settings.galleryKind = ["all", "photos", "videos"].includes(value) ? value : "all";
    syncSegmented(controls.galleryKind, "galleryKind", state.settings.galleryKind);
    renderGallery(true);
    queueSettingsSave();
  });

  controls.gallerySort.addEventListener("change", (event) => {
    state.settings.gallerySort = event.target.value;
    renderGallery(true);
    queueSettingsSave();
  });

  controls.lightboxClose.addEventListener("click", closeLightbox);
  controls.lightboxPrev.addEventListener("click", () => stepLightbox(-1));
  controls.lightboxNext.addEventListener("click", () => stepLightbox(1));
  controls.lightboxLike.addEventListener("click", () => rateLightboxItem("like"));
  controls.lightboxLove.addEventListener("click", () => rateLightboxItem("love"));
  controls.lightboxMark.addEventListener("click", markFromLightbox);
  controls.lightboxDislike.addEventListener("click", () => rateLightboxItem("dislike"));
  controls.galleryLightbox.addEventListener("click", (event) => {
    // Clicking the backdrop, but not the media or the controls, closes it.
    if (event.target === controls.galleryLightbox) {
      closeLightbox();
    }
  });
}

function bindMosaicEvents() {
  controls.mosaicShuffleButton.addEventListener("click", startMosaic);

  bindSegmented(controls.mosaicTiles, "mosaicTiles", (value) => {
    state.settings.mosaicTiles = clampNumber(Number(value), 4, 9);
    syncSegmented(controls.mosaicTiles, "mosaicTiles", state.settings.mosaicTiles);
    startMosaic();
    queueSettingsSave();
  });

  bindSegmented(controls.mosaicIncludePhotos, "mosaicMedia", (value) => {
    state.settings.mosaicIncludePhotos = value === "mixed";
    syncSegmented(
      controls.mosaicIncludePhotos,
      "mosaicMedia",
      state.settings.mosaicIncludePhotos ? "mixed" : "videos"
    );
    startMosaic();
    queueSettingsSave();
  });

  controls.mosaicSwapAllButton.addEventListener("click", () => {
    state.mosaic.tiles.forEach((tile) => swapMosaicTile(tile));
  });

  controls.mosaicPauseButton.addEventListener("click", toggleMosaicPause);

  bindRangeSetting(controls.mosaicSwapSeconds, "mosaicSwapSeconds", (value) => `${value}s`);
  bindRangeSetting(
    controls.mosaicVolume,
    "mosaicVolume",
    (value) => `${Math.round(value * 100)}%`,
    applyMosaicAudio
  );
}

function bindFeedEvents() {
  controls.feedShuffleButton.addEventListener("click", () => {
    rebuildFeed();
    closeDrawers();
  });

  bindRangeSetting(
    controls.feedVolume,
    "feedVolume",
    (value) => `${Math.round(value * 100)}%`,
    applyFeedAudio
  );

  bindSegmented(controls.feedAutoAdvance, "feedEnd", (value) => {
    state.settings.feedAutoAdvance = value === "advance";
    syncSegmented(controls.feedAutoAdvance, "feedEnd", value);
    controls.feedScroller.querySelectorAll("video").forEach((video) => {
      video.loop = !state.settings.feedAutoAdvance;
    });
    syncDrawerSummaries();
    queueSettingsSave();
  });
}

function sanitizeModeSettings() {
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

  // Order (42-smart.js); the timed modes' keys are checked in sanitizePlaySettings.
  SMART_LEGACY_DRAWERS.forEach((mode) => {
    state.settings[`${mode}Order`] = pick(state.settings[`${mode}Order`], ["random", "smart"], "random");
  });

  ["session", "gallery", "mosaic", "feed", "dangerous", "duel", "rediscover", ...PLAY_MODES.filter((mode) => mode !== "spotlight")].forEach((mode) => {
    state.settings[`${mode}Folders`] = sanitizeFolderSelection(
      state.settings[`${mode}Folders`],
      state.library.folders || []
    );
  });

  state.settings.sessionRounds = clampNumber(Number(state.settings.sessionRounds ?? 5), 2, 10);
  state.settings.sessionBuildSeconds = clampNumber(Number(state.settings.sessionBuildSeconds ?? 60), 20, 180);
  state.settings.sessionHoldSeconds = clampNumber(Number(state.settings.sessionHoldSeconds ?? 15), 5, 60);
  state.settings.sessionVideoVolume = clampNumber(Number(state.settings.sessionVideoVolume ?? 0.3), 0, 1);
  state.settings.sessionIncludeVideos = state.settings.sessionIncludeVideos !== false;

  state.settings.galleryRatingFilter = sanitizeRatingFilter(state.settings.galleryRatingFilter, false);
  state.settings.galleryKind = pick(state.settings.galleryKind, ["all", "photos", "videos"], "all");
  state.settings.gallerySort = pick(
    state.settings.gallerySort,
    ["name", "newest", "oldest", "largest", "random"],
    "name"
  );

  state.settings.mosaicTiles = pick(Number(state.settings.mosaicTiles), [4, 6, 9], 4);
  state.settings.mosaicSwapSeconds = clampNumber(Number(state.settings.mosaicSwapSeconds ?? 12), 4, 60);
  state.settings.mosaicVolume = clampNumber(Number(state.settings.mosaicVolume ?? 0.3), 0, 1);
  state.settings.mosaicIncludePhotos = !!state.settings.mosaicIncludePhotos;

  state.settings.feedRatingFilter = sanitizeRatingFilter(state.settings.feedRatingFilter, false);
  ["escalation", "session", "mosaic", ...PLAY_MODES].forEach((mode) => {
    state.settings[`${mode}RatingFilter`] = sanitizeRatingFilter(state.settings[`${mode}RatingFilter`], false);
  });
  // Each timed mode keeps its own numbers in range (see PLAY_SETTING_RANGES).
  sanitizePlaySettings();
  state.settings.dangerousKind = pick(state.settings.dangerousKind, ["all", "photo", "video"], "all");
  state.settings.duelKind = pick(state.settings.duelKind, ["photos", "videos", "all"], "photos");
  state.settings.duelRatingFilter = RATING_FILTERS.includes(state.settings.duelRatingFilter) ? state.settings.duelRatingFilter : "liked";
  state.settings.rediscoverKind = pick(state.settings.rediscoverKind, ["all", "photos", "videos"], "all");
  state.settings.rediscoverRatingFilter = sanitizeRatingFilter(state.settings.rediscoverRatingFilter, false);
  state.settings.dangerousHideKept = state.settings.dangerousHideKept !== false;
  DANGER_KEPT_MODES.forEach((mode) => { state.settings[`${mode}DangerKeptOnly`] = state.settings[`${mode}DangerKeptOnly`] === true; });
  state.settings.folderSets = sanitizeFolderSets(state.settings.folderSets);
  state.settings.feedVolume = clampNumber(Number(state.settings.feedVolume ?? 1), 0, 1);
  state.settings.feedAutoAdvance = !!state.settings.feedAutoAdvance;

  state.settings.balancedFolders = state.settings.balancedFolders !== false;
  state.settings.lastMode = ALL_MODES.includes(state.settings.lastMode)
    ? state.settings.lastMode
    : "swipe";
  state.settings.rankedKind = pick(state.settings.rankedKind, ["all", "photos", "videos"], "all");
  state.settings.rankedSort = pick(
    state.settings.rankedSort,
    ["recent", "oldest", "loved", "folder", "name", "largest", "duel"],
    "recent"
  );
}

function syncModeControls() {
  const setRange = (key, formatValue) => {
    controls[key].value = String(state.settings[key]);
    controls[`${key}Value`].textContent = formatValue(state.settings[key]);
  };

  setRange("sessionRounds", (value) => `${value}`);
  setRange("sessionBuildSeconds", (value) => `${value}s`);
  setRange("sessionHoldSeconds", (value) => `${value}s`);
  setRange("sessionVideoVolume", (value) => `${Math.round(value * 100)}%`);
  syncSegmented(
    controls.sessionIncludeVideos,
    "sessionMedia",
    state.settings.sessionIncludeVideos ? "mixed" : "photos"
  );
  renderSessionPips();
  syncSessionHud();
  syncSessionControls();

  syncSegmented(controls.galleryRatingFilter, "ratingFilter", state.settings.galleryRatingFilter);
  syncSegmented(controls.galleryKind, "galleryKind", state.settings.galleryKind);
  controls.gallerySort.value = state.settings.gallerySort;

  syncSegmented(controls.mosaicTiles, "mosaicTiles", state.settings.mosaicTiles);
  syncSegmented(
    controls.mosaicIncludePhotos,
    "mosaicMedia",
    state.settings.mosaicIncludePhotos ? "mixed" : "videos"
  );
  setRange("mosaicSwapSeconds", (value) => `${value}s`);
  setRange("mosaicVolume", (value) => `${Math.round(value * 100)}%`);

  syncSegmented(controls.feedAutoAdvance, "feedEnd", state.settings.feedAutoAdvance ? "advance" : "loop");
  setRange("feedVolume", (value) => `${Math.round(value * 100)}%`);
  syncSegmented(document.getElementById("dangerousKind"), "dangerousKind", state.settings.dangerousKind || "all");
  syncSegmented(document.getElementById("duelKind"), "duelKind", state.settings.duelKind || "photos");
  syncSegmented(document.getElementById("rediscoverKind"), "rediscoverKind", state.settings.rediscoverKind || "all");
  document.getElementById("dangerousHideKept").setAttribute("aria-checked", String(!!state.settings.dangerousHideKept));
  PLAY_MODES.forEach((mode) => syncSettingControls(el(`${mode}Drawer`)));
  paintRanges();
}

