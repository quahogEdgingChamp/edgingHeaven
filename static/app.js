const state = {
  library: { images: [], videos: [], counts: {} },
  settings: {},
  swipeItems: [],
  swipeIndex: 0,
  toktinderItems: [],
  toktinderIndex: 0,
  streamPhotoTimer: null,
  streamVideoSlots: [],
  escalationTimer: null,
  escalationBurstTimer: null,
  escalationRecentPaths: [],
  escalationSessionStartedAt: 0,
  escalationCurrentIntervalMs: 0,
  currentMode: "swipe",
  libraryReady: false,
  mediaChoices: [],
  currentMediaDirectory: "",
  setupVisible: false,
  themePanelVisible: false,
  activeDrawer: null,
  focusMode: false,
  audioUnlocked: false,
  brokenPaths: new Set(),
  brokenStreak: 0,
  brokenCount: 0,
  history: { swipe: [], toktinder: [] },
  seekDragging: false,
  seekThrottle: 0,
  streamRebuildTimer: null,
  preloader: null,
  session: {
    running: false,
    phases: [],
    index: 0,
    elapsedMs: 0,
    tickTimer: null,
    mediaTimer: null,
    recentPaths: [],
  },
  gallery: { items: [], page: 0, search: "", searchTimer: null, observer: null, lightboxIndex: -1 },
  mosaic: { tiles: [], audioIndex: 0 },
  feed: { items: [], rendered: 0, activeIndex: -1, scrollBound: false, scrollFrame: 0, dirty: true },
  drag: {
    active: false,
    mode: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    deltaX: 0,
    deltaY: 0,
  },
};

const controls = {};
let settingsSaveTimer = null;
const THEME_OPTIONS = [
  { value: "velvet", label: "Velvet Night" },
  { value: "ember", label: "Ember Room" },
  { value: "afterglow", label: "Afterglow" },
  { value: "paper", label: "Paper Light" },
  { value: "sage", label: "Sage Studio" },
  { value: "slate", label: "Slate Office" },
];
const THEMES = new Set(THEME_OPTIONS.map((theme) => theme.value));

// Every mode that owns a slide-over panel, and every mode whose stage can go
// full-bleed. Gallery has no focus mode: it is a browsing grid, not a stage.
const DRAWER_MODES = [
  "swipe",
  "toktinder",
  "stream",
  "escalation",
  "session",
  "gallery",
  "mosaic",
  "feed",
];
const FOCUS_MODES = ["swipe", "toktinder", "stream", "escalation", "session", "mosaic", "feed"];
const FOLDER_MODES = DRAWER_MODES;

document.addEventListener("DOMContentLoaded", () => {
  cacheDom();
  bindEvents();
  loadState().catch((error) => {
    console.error(error);
    controls.libraryMeta.textContent = "Could not load the library.";
    setStatus("Startup failed. Check the server terminal for details.");
  });
  setTimeout(checkLibraryConnection, 5000);
});

async function checkLibraryConnection() {
  try {
    if (!document.hidden) {
      const status = await fetchJson("/api/library-status");
      if (
        status.libraryReady !== state.libraryReady ||
        (status.mediaDirectory || "") !== state.currentMediaDirectory ||
        status.updatedAt !== state.library.updatedAt
      ) {
        await loadState();
      }
    }
  } catch (error) {
    console.debug("Waiting for the library connection", error);
  } finally {
    setTimeout(checkLibraryConnection, 5000);
  }
}

function cacheDom() {
  [
    "setupPanel",
    "setupMessage",
    "mediaDirInput",
    "mediaDirApplyButton",
    "mediaDirChoices",
    "themePanel",
    "themeSummary",
    "themeChoices",
    "modeSwitch",
    "mainContent",
    "libraryMeta",
    "imageCount",
    "videoCount",
    "ratingCount",
    "changeLibraryButton",
    "themeButton",
    "rescanButton",
    "brokenSummary",
    "clearBrokenButton",
    "swipeCard",
    "swipeImage",
    "swipeName",
    "swipeFolder",
    "swipeStatus",
    "swipeDrawer",
    "swipeDrawerToggle",
    "swipeDrawerClose",
    "swipeFocusToggle",
    "swipeFoldersAllButton",
    "swipeFolderSummary",
    "swipeFolderFilters",
    "swipeRatingFilter",
    "swipeUndoButton",
    "shuffleButton",
    "swipeResetModeButton",
    "resetRatingsButton",
    "skipButton",
    "dislikeButton",
    "likeButton",
    "toktinderCard",
    "toktinderVideo",
    "toktinderName",
    "toktinderFolder",
    "toktinderStatus",
    "toktinderDrawer",
    "toktinderDrawerToggle",
    "toktinderDrawerClose",
    "toktinderFocusToggle",
    "toktinderFoldersAllButton",
    "toktinderFolderSummary",
    "toktinderFolderFilters",
    "toktinderRatingFilter",
    "toktinderUndoButton",
    "toktinderTransport",
    "toktinderPlayToggle",
    "toktinderSeek",
    "toktinderTime",
    "toktinderDuration",
    "toktinderAudioToggleButton",
    "toktinderAudioHint",
    "toktinderShuffleButton",
    "toktinderResetModeButton",
    "toktinderSkipButton",
    "toktinderDislikeButton",
    "toktinderLikeButton",
    "streamPhoto",
    "streamPhotoName",
    "streamPhotoFolder",
    "streamDrawer",
    "streamDrawerToggle",
    "streamDrawerClose",
    "streamFocusToggle",
    "streamFoldersAllButton",
    "streamFolderSummary",
    "streamFolderFilters",
    "videoOverlay",
    "photoInterval",
    "photoIntervalValue",
    "videoSlots",
    "videoSlotsValue",
    "videoVolume",
    "videoVolumeValue",
    "audioToggleButton",
    "audioHint",
    "clipStartMode",
    "clipStartSeconds",
    "refreshStreamButton",
    "escalationStage",
    "escalationPhoto",
    "escalationVideo",
    "escalationName",
    "escalationFolder",
    "escalationStatus",
    "escalationPhaseBadge",
    "escalationTelemetry",
    "escalationDrawer",
    "escalationDrawerToggle",
    "escalationDrawerClose",
    "escalationFocusToggle",
    "escalationFoldersAllButton",
    "escalationFolderSummary",
    "escalationFolderFilters",
    "escalationBaseInterval",
    "escalationBaseIntervalValue",
    "escalationMinInterval",
    "escalationMinIntervalValue",
    "escalationRampSeconds",
    "escalationRampSecondsValue",
    "escalationMaxSpeed",
    "escalationMaxSpeedValue",
    "escalationVideoVolume",
    "escalationVideoVolumeValue",
    "escalationAudioToggleButton",
    "escalationAudioHint",
    "escalationRestartButton",
    "sessionStage",
    "sessionPhoto",
    "sessionVideo",
    "sessionCue",
    "sessionCountdown",
    "sessionBarFill",
    "sessionRoundPips",
    "sessionName",
    "sessionFolder",
    "sessionStatus",
    "sessionToggleButton",
    "sessionDrawer",
    "sessionDrawerToggle",
    "sessionDrawerClose",
    "sessionFocusToggle",
    "sessionFoldersAllButton",
    "sessionFolderSummary",
    "sessionFolderFilters",
    "sessionRounds",
    "sessionRoundsValue",
    "sessionBuildSeconds",
    "sessionBuildSecondsValue",
    "sessionHoldSeconds",
    "sessionHoldSecondsValue",
    "sessionIncludeVideos",
    "sessionVideoVolume",
    "sessionVideoVolumeValue",
    "sessionAudioToggleButton",
    "sessionAudioHint",
    "sessionRestartButton",
    "galleryGrid",
    "gallerySearch",
    "galleryPrevPage",
    "galleryNextPage",
    "galleryPageInfo",
    "galleryDrawer",
    "galleryDrawerToggle",
    "galleryDrawerClose",
    "galleryFoldersAllButton",
    "galleryFolderSummary",
    "galleryFolderFilters",
    "galleryRatingFilter",
    "galleryKind",
    "gallerySort",
    "galleryLightbox",
    "lightboxImage",
    "lightboxVideo",
    "lightboxName",
    "lightboxFolder",
    "lightboxPrev",
    "lightboxNext",
    "lightboxLike",
    "lightboxDislike",
    "lightboxClose",
    "mosaicStage",
    "mosaicStatus",
    "mosaicShuffleButton",
    "mosaicDrawer",
    "mosaicDrawerToggle",
    "mosaicDrawerClose",
    "mosaicFocusToggle",
    "mosaicFoldersAllButton",
    "mosaicFolderSummary",
    "mosaicFolderFilters",
    "mosaicTiles",
    "mosaicSwapSeconds",
    "mosaicSwapSecondsValue",
    "mosaicIncludePhotos",
    "mosaicVolume",
    "mosaicVolumeValue",
    "mosaicAudioToggleButton",
    "mosaicAudioHint",
    "feedScroller",
    "feedDrawer",
    "feedDrawerToggle",
    "feedDrawerClose",
    "feedFocusToggle",
    "feedFoldersAllButton",
    "feedFolderSummary",
    "feedFolderFilters",
    "feedRatingFilter",
    "feedVolume",
    "feedVolumeValue",
    "feedAudioToggleButton",
    "feedAudioHint",
    "feedShuffleButton",
    "drawerBackdrop",
  ].forEach((id) => {
    controls[id] = document.getElementById(id);
  });
}

function bindEvents() {
  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  controls.mediaDirApplyButton.addEventListener("click", () => {
    chooseMediaDirectory(controls.mediaDirInput.value);
  });

  controls.mediaDirInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      chooseMediaDirectory(event.target.value);
    }
  });

  controls.changeLibraryButton.addEventListener("click", () => {
    state.setupVisible = !state.setupVisible;
    state.themePanelVisible = false;
    syncLibraryChrome();
  });

  controls.themeButton.addEventListener("click", () => {
    state.themePanelVisible = !state.themePanelVisible;
    state.setupVisible = false;
    syncLibraryChrome();
  });

  controls.rescanButton.addEventListener("click", async () => {
    await rescanLibrary();
  });

  controls.likeButton.addEventListener("click", () => rateCurrent("like"));
  controls.dislikeButton.addEventListener("click", () => rateCurrent("dislike"));
  controls.skipButton.addEventListener("click", skipCurrent);
  DRAWER_MODES.forEach((mode) => {
    controls[`${mode}DrawerToggle`].addEventListener("click", () => toggleDrawer(mode));
    controls[`${mode}DrawerClose`].addEventListener("click", closeDrawers);
  });
  FOCUS_MODES.forEach((mode) => {
    controls[`${mode}FocusToggle`].addEventListener("click", toggleFocusMode);
  });
  FOLDER_MODES.forEach((mode) => {
    controls[`${mode}FoldersAllButton`].addEventListener("click", () => {
      state.settings[`${mode}Folders`] = [];
      invalidateMediaPools();
      renderFolderFilters();
      refreshMode(mode);
      queueSettingsSave();
    });
  });
  controls.toktinderLikeButton.addEventListener("click", () => rateToktinderCurrent("like"));
  controls.toktinderDislikeButton.addEventListener("click", () => rateToktinderCurrent("dislike"));
  controls.toktinderSkipButton.addEventListener("click", skipToktinderCurrent);
  controls.drawerBackdrop.addEventListener("click", closeDrawers);

  bindRatingFilter("swipe");
  bindRatingFilter("toktinder");
  bindSessionEvents();
  bindGalleryEvents();
  bindMosaicEvents();
  bindFeedEvents();
  controls.swipeUndoButton.addEventListener("click", () => undoLastAction("swipe"));
  controls.toktinderUndoButton.addEventListener("click", () => undoLastAction("toktinder"));
  controls.clearBrokenButton.addEventListener("click", clearBrokenFiles);

  controls.shuffleButton.addEventListener("click", () => {
    shuffleArray(state.swipeItems);
    state.swipeIndex = 0;
    renderSwipe();
  });

  controls.resetRatingsButton.addEventListener("click", async () => {
    await resetSavedData();
  });
  controls.swipeResetModeButton.addEventListener("click", async () => {
    await resetModeData("swipe");
  });
  controls.toktinderResetModeButton.addEventListener("click", async () => {
    await resetModeData("toktinder");
  });

  controls.refreshStreamButton.addEventListener("click", () => {
    refreshStreamMedia(true);
  });

  [
    "audioToggleButton",
    "toktinderAudioToggleButton",
    "escalationAudioToggleButton",
    "sessionAudioToggleButton",
    "mosaicAudioToggleButton",
    "feedAudioToggleButton",
  ].forEach((key) => controls[key].addEventListener("click", toggleVideoAudio));

  controls.toktinderShuffleButton.addEventListener("click", () => {
    shuffleArray(state.toktinderItems);
    state.toktinderIndex = 0;
    renderToktinder();
  });

  bindRangeSetting(controls.photoInterval, "photoInterval", (value) => `${value}s`);
  bindRangeSetting(controls.videoSlots, "videoCount", (value) => `${value}`);
  bindRangeSetting(controls.videoVolume, "videoVolume", (value) => `${Math.round(value * 100)}%`);
  bindRangeSetting(controls.escalationBaseInterval, "escalationBaseInterval", (value) => `${value}s`);
  bindRangeSetting(controls.escalationMinInterval, "escalationMinInterval", (value) => `${value}s`);
  bindRangeSetting(controls.escalationRampSeconds, "escalationRampSeconds", (value) => `${value}s`);
  bindRangeSetting(controls.escalationMaxSpeed, "escalationMaxSpeed", (value) => `${Number(value).toFixed(1)}x`);
  bindRangeSetting(
    controls.escalationVideoVolume,
    "escalationVideoVolume",
    (value) => `${Math.round(value * 100)}%`
  );

  controls.clipStartMode.addEventListener("change", (event) => {
    state.settings.clipStartMode = event.target.value;
    queueSettingsSave();
    queueStreamVideoRefresh();
  });

  controls.clipStartSeconds.addEventListener("change", (event) => {
    state.settings.clipStartSeconds = clampNumber(Number(event.target.value), 0, 3600);
    event.target.value = state.settings.clipStartSeconds;
    queueSettingsSave();
    queueStreamVideoRefresh();
  });

  controls.swipeCard.addEventListener("pointerdown", onSwipePointerDown);
  controls.swipeCard.addEventListener("pointermove", onSwipePointerMove);
  controls.swipeCard.addEventListener("pointerup", onSwipePointerUp);
  controls.swipeCard.addEventListener("pointercancel", resetSwipeCard);
  controls.toktinderCard.addEventListener("pointerdown", onSwipePointerDown);
  controls.toktinderCard.addEventListener("pointermove", onSwipePointerMove);
  controls.toktinderCard.addEventListener("pointerup", onSwipePointerUp);
  controls.toktinderCard.addEventListener("pointercancel", resetSwipeCard);
  controls.toktinderVideo.addEventListener("loadedmetadata", () => {
    syncToktinderVideoShape();
    if (state.currentMode === "toktinder" && !document.hidden) {
      applyToktinderAudio();
      playWhenReady(controls.toktinderVideo, controls.toktinderVideo.dataset.loadToken, null);
    }
  });
  bindMediaErrorHandlers();
  bindToktinderTransport();
  controls.escalationVideo.addEventListener("loadedmetadata", configureEscalationVideo);
  controls.escalationVideo.addEventListener("ended", () => {
    if (state.currentMode === "escalation") {
      refreshEscalationMedia(true);
    }
  });

  controls.escalationRestartButton.addEventListener("click", () => {
    startEscalation();
  });

  window.addEventListener("keydown", (event) => {
    if (!controls.galleryLightbox.hidden) {
      if (event.key === "Escape") {
        closeLightbox();
      } else if (event.key === "ArrowLeft") {
        stepLightbox(-1);
      } else if (event.key === "ArrowRight") {
        stepLightbox(1);
      }
      return;
    }
    if (event.key === "Escape" && state.activeDrawer) {
      closeDrawers();
      return;
    }
    if (event.key === "Escape" && state.focusMode) {
      setFocusMode(false);
      return;
    }
    if (
      event.key.toLowerCase() === "f" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "")
    ) {
      event.preventDefault();
      toggleFocusMode();
      return;
    }
    if (!isDeckMode(state.currentMode)) {
      return;
    }
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "")) {
      return;
    }
    if (event.key.toLowerCase() === "u") {
      event.preventDefault();
      undoLastAction(state.currentMode);
      return;
    }
    if (state.currentMode === "toktinder" && event.key === " ") {
      event.preventDefault();
      toggleToktinderPlayback();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      rateDeckItem(state.currentMode, "dislike");
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      rateDeckItem(state.currentMode, "like");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      skipDeckItem(state.currentMode);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      quietAllModes();
    } else if (state.currentMode === "stream") {
      startStream();
    } else if (state.currentMode === "escalation") {
      startEscalation();
    } else if (state.currentMode === "toktinder") {
      playToktinderVideo();
    } else if (state.currentMode === "session") {
      enterSession();
    } else if (state.currentMode === "mosaic") {
      startMosaic();
    } else if (state.currentMode === "feed") {
      startFeed();
    }
  });

  syncFocusMode();
}

function bindRangeSetting(element, settingKey, formatValue, onChange) {
  const output = controls[`${element.id}Value`];
  const handler = (event) => {
    const raw = event.target.value;
    const value = element.step && element.step.includes(".") ? Number(raw) : parseInt(raw, 10);
    state.settings[settingKey] = value;
    output.textContent = formatValue(value);
    queueSettingsSave();

    if (settingKey === "photoInterval") {
      restartPhotoTimer();
    }
    if (settingKey === "videoCount") {
      queueStreamVideoRefresh();
    }
    if (settingKey === "videoVolume") {
      applyVideoVolume();
    }
    if (
      [
        "escalationBaseInterval",
        "escalationMinInterval",
        "escalationRampSeconds",
        "escalationMaxSpeed",
        "escalationVideoVolume",
      ].includes(settingKey)
    ) {
      applyEscalationAudio();
      if (state.currentMode === "escalation") {
        startEscalation();
      }
    }
    if (onChange) {
      onChange(value);
    }
  };

  element.addEventListener("input", handler);
}

async function loadState() {
  const payload = await fetchJson("/api/state");
  state.library = payload.library || { images: [], videos: [], folders: [], counts: {} };
  state.libraryReady = !!payload.libraryReady;
  state.mediaChoices = Array.isArray(payload.mediaChoices) ? payload.mediaChoices : [];
  state.currentMediaDirectory = payload.mediaDirectory || "";
  state.settings = { ...payload.settings };
  state.settings.videoCount = clampNumber(Number(state.settings.videoCount ?? 2), 0, 2);
  state.settings.theme = sanitizeTheme(state.settings.theme);
  state.settings.swipeFolders = sanitizeFolderSelection(state.settings.swipeFolders, state.library.folders || []);
  state.settings.toktinderFolders = sanitizeFolderSelection(
    state.settings.toktinderFolders,
    state.library.folders || []
  );
  state.settings.streamFolders = sanitizeFolderSelection(state.settings.streamFolders, state.library.folders || []);
  state.settings.escalationFolders = sanitizeFolderSelection(
    state.settings.escalationFolders,
    state.library.folders || []
  );
  // Migrate the old boolean into the three-way filter the first time a
  // library saved by an older build is opened.
  state.settings.swipeRatingFilter = sanitizeRatingFilter(
    state.settings.swipeRatingFilter,
    state.settings.unratedOnly
  );
  state.settings.toktinderRatingFilter = sanitizeRatingFilter(
    state.settings.toktinderRatingFilter,
    state.settings.toktinderUnratedOnly
  );
  state.brokenCount = Number(payload.brokenCount || 0);
  invalidateMediaPools();
  sanitizeModeSettings();
  state.settings.escalationBaseInterval = clampNumber(Number(state.settings.escalationBaseInterval ?? 12), 4, 24);
  state.settings.escalationMinInterval = clampNumber(Number(state.settings.escalationMinInterval ?? 2), 1, 8);
  state.settings.escalationRampSeconds = clampNumber(Number(state.settings.escalationRampSeconds ?? 90), 20, 240);
  state.settings.escalationMaxSpeed = clampNumber(Number(state.settings.escalationMaxSpeed ?? 2.2), 1, 3);
  state.settings.escalationVideoVolume = clampNumber(Number(state.settings.escalationVideoVolume ?? 0.32), 0, 1);

  renderThemeChoices();
  syncLibraryChrome();
  syncCounts();
  syncControls();
  renderMediaChoices();
  renderFolderFilters();
  applyTheme();
  syncAudioButton();
  rebuildSwipeDeck();
  renderSwipe();
  rebuildToktinderDeck();
  renderToktinder();
  refreshStreamMedia(false);
  state.feed.dirty = true;
  if (state.currentMode === "escalation") {
    startEscalation();
  } else {
    clearEscalationMedia();
    renderEscalationIdle();
  }

  if (state.currentMode === "gallery") {
    renderGallery(true);
  } else if (state.currentMode === "feed") {
    rebuildFeed();
  } else if (state.currentMode === "mosaic") {
    startMosaic();
  } else if (state.currentMode === "session") {
    refreshSessionMedia(true);
  }
}

function syncCounts() {
  const counts = state.libraryReady ? state.library.counts || {} : {};
  const format = (value) => Number(value || 0).toLocaleString();
  controls.imageCount.textContent = `${format(counts.images)} images`;
  controls.videoCount.textContent = `${format(counts.videos)} videos`;
  controls.ratingCount.textContent = `${format(counts.liked)} liked`;
}

function syncControls() {
  syncRatingFilter("swipe");
  syncRatingFilter("toktinder");
  syncModeControls();
  syncUndoButtons();
  syncBrokenSummary();
  syncThemeControls();
  controls.photoInterval.value = String(state.settings.photoInterval ?? 14);
  controls.photoIntervalValue.textContent = `${controls.photoInterval.value}s`;
  controls.videoSlots.value = String(clampNumber(Number(state.settings.videoCount ?? 2), 0, 2));
  controls.videoSlotsValue.textContent = controls.videoSlots.value;
  controls.videoVolume.value = String(state.settings.videoVolume ?? 0.18);
  controls.videoVolumeValue.textContent = `${Math.round((state.settings.videoVolume ?? 0) * 100)}%`;
  controls.clipStartMode.value = state.settings.clipStartMode ?? "random";
  controls.clipStartSeconds.value = String(state.settings.clipStartSeconds ?? 0);
  controls.escalationBaseInterval.value = String(state.settings.escalationBaseInterval ?? 12);
  controls.escalationBaseIntervalValue.textContent = `${controls.escalationBaseInterval.value}s`;
  controls.escalationMinInterval.value = String(state.settings.escalationMinInterval ?? 2);
  controls.escalationMinIntervalValue.textContent = `${controls.escalationMinInterval.value}s`;
  controls.escalationRampSeconds.value = String(state.settings.escalationRampSeconds ?? 90);
  controls.escalationRampSecondsValue.textContent = `${controls.escalationRampSeconds.value}s`;
  controls.escalationMaxSpeed.value = String(state.settings.escalationMaxSpeed ?? 2.2);
  controls.escalationMaxSpeedValue.textContent = `${Number(controls.escalationMaxSpeed.value).toFixed(1)}x`;
  controls.escalationVideoVolume.value = String(state.settings.escalationVideoVolume ?? 0.32);
  controls.escalationVideoVolumeValue.textContent = `${Math.round(
    (state.settings.escalationVideoVolume ?? 0) * 100
  )}%`;
}

function isDeckMode(mode) {
  return mode === "swipe" || mode === "toktinder";
}

function deckConfig(mode) {
  if (mode === "swipe") {
    return {
      itemsKey: "swipeItems",
      indexKey: "swipeIndex",
      sourceKey: "images",
      foldersKey: "swipeFolders",
      filterKey: "swipeRatingFilter",
      mediaType: "image",
      emptyTitle: "No photos match the current filter",
      emptyStatus: "Nothing matches. Widen the folder filter, switch Show to All, or rescan.",
      nameControl: "swipeName",
      folderControl: "swipeFolder",
      statusControl: "swipeStatus",
      mediaControl: "swipeImage",
    };
  }

  if (mode === "toktinder") {
    return {
      itemsKey: "toktinderItems",
      indexKey: "toktinderIndex",
      sourceKey: "videos",
      foldersKey: "toktinderFolders",
      filterKey: "toktinderRatingFilter",
      mediaType: "video",
      emptyTitle: "No videos match the current filter",
      emptyStatus: "Nothing matches. Widen the folder filter, switch Show to All, or rescan.",
      nameControl: "toktinderName",
      folderControl: "toktinderFolder",
      statusControl: "toktinderStatus",
      mediaControl: "toktinderVideo",
    };
  }

  return null;
}

function rebuildDeck(mode) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  state.history[mode] = [];
  syncUndoButtons();

  const selectedFolders = normalizedFolderSelection(config.foldersKey);
  const allItems = state.library[config.sourceKey] || [];
  state[config.itemsKey] = allItems.filter((item) => {
    if (!matchesFolderSelection(item, selectedFolders)) {
      return false;
    }
    return matchesRatingFilter(item, ratingFilterValue(config.filterKey));
  });
  shuffleArray(state[config.itemsKey]);
  state[config.indexKey] = 0;
}

function currentDeckItem(mode) {
  const config = deckConfig(mode);
  if (!config || !state[config.itemsKey].length) {
    return null;
  }
  return state[config.itemsKey][state[config.indexKey]];
}

function renderDeck(mode) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  const item = currentDeckItem(mode);
  resetSwipeCard(mode);

  if (!item) {
    clearDeckMedia(mode);
    setLabel(controls[config.nameControl], config.emptyTitle);
    setLabel(controls[config.folderControl], "");
    controls[config.statusControl].textContent = config.emptyStatus;
    return;
  }

  setDeckMedia(mode, item);
  setLabel(controls[config.nameControl], item.name);
  setLabel(controls[config.folderControl], item.folder || "Library root");
  controls[config.statusControl].textContent =
    `${state[config.indexKey] + 1} / ${state[config.itemsKey].length} in current deck`;
}

async function rateDeckItem(mode, rating) {
  const config = deckConfig(mode);
  const item = currentDeckItem(mode);
  if (!config || !item) {
    return;
  }

  try {
    await postJson("/api/rating", { path: item.path, rating });
  } catch (error) {
    console.error(error);
    setStatus("Could not save the rating.");
    return;
  }

  const previousRating = item.rating ?? null;
  const canonicalItem = (state.library[config.sourceKey] || []).find((entry) => entry.path === item.path);
  if (canonicalItem) {
    canonicalItem.rating = rating;
  }
  item.rating = rating;

  // A rating can push the item out of the current filter (rate something
  // while on "Unrated", dislike something while on "Liked").
  const stillVisible = matchesRatingFilter(item, ratingFilterValue(config.filterKey));
  const index = state[config.indexKey];
  pushHistory(mode, {
    kind: "rate",
    path: item.path,
    previousRating,
    index,
    removed: !stillVisible,
    item,
  });

  if (!stillVisible) {
    state[config.itemsKey].splice(index, 1);
    if (state[config.indexKey] >= state[config.itemsKey].length) {
      state[config.indexKey] = 0;
    }
  } else if (state[config.itemsKey].length > 1) {
    state[config.indexKey] = (index + 1) % state[config.itemsKey].length;
  }

  syncCountsFromLibrary();
  renderDeck(mode);
}

function skipDeckItem(mode) {
  const config = deckConfig(mode);
  if (!config || !state[config.itemsKey].length) {
    return;
  }
  pushHistory(mode, { kind: "skip", index: state[config.indexKey] });
  state[config.indexKey] = (state[config.indexKey] + 1) % state[config.itemsKey].length;
  renderDeck(mode);
}

function setDeckMedia(mode, item) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  if (config.mediaType === "image") {
    controls[config.mediaControl].dataset.path = item.path;
    controls[config.mediaControl].src = mediaUrl(item.path);
    controls[config.mediaControl].alt = item.name;
    return;
  }

  clearToktinderVideoShape();
  controls.toktinderVideo.loop = true;
  controls.toktinderVideo.playsInline = true;
  applyToktinderAudio();
  loadVideoSource(controls.toktinderVideo, item);
  syncToktinderTransport();
}

function clearDeckMedia(mode) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  if (config.mediaType === "image") {
    controls[config.mediaControl].removeAttribute("src");
    controls[config.mediaControl].removeAttribute("data-path");
    controls[config.mediaControl].alt = "";
    return;
  }

  clearToktinderVideoShape();
  releaseVideo(controls.toktinderVideo);
  syncToktinderTransport();
}

function swipeCardControl(mode) {
  if (mode === "swipe") {
    return controls.swipeCard;
  }
  if (mode === "toktinder") {
    return controls.toktinderCard;
  }
  return null;
}

function rebuildSwipeDeck() {
  rebuildDeck("swipe");
}

function rebuildToktinderDeck() {
  rebuildDeck("toktinder");
}

function currentSwipeItem() {
  return currentDeckItem("swipe");
}

function currentToktinderItem() {
  return currentDeckItem("toktinder");
}

function renderSwipe() {
  renderDeck("swipe");
}

function renderToktinder() {
  renderDeck("toktinder");
}

async function rateCurrent(rating) {
  await rateDeckItem("swipe", rating);
}

async function rateToktinderCurrent(rating) {
  await rateDeckItem("toktinder", rating);
}

function skipCurrent() {
  skipDeckItem("swipe");
}

function skipToktinderCurrent() {
  skipDeckItem("toktinder");
}

function syncCountsFromLibrary() {
  const allItems = [...(state.library.images || []), ...(state.library.videos || [])];
  state.library.counts = {
    ...(state.library.counts || {}),
    liked: allItems.filter((item) => item.rating === "like").length,
    disliked: allItems.filter((item) => item.rating === "dislike").length,
    unrated: allItems.filter((item) => !item.rating).length,
  };
  syncCounts();
}

function setMode(mode) {
  state.currentMode = mode;
  closeDrawers();
  document.querySelectorAll(".mode-button").forEach((button) => {
    const isActive = button.dataset.mode === mode;
    button.classList.toggle("active", isActive);
    if (isActive) {
      scrollModeIntoView(button);
    }
  });
  document.querySelectorAll(".mode-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${mode}Mode`);
  });

  // Silence everything first, then bring up only the mode being entered.
  // Leaving this to per-mode branches is how clips used to keep playing
  // underneath another mode.
  quietAllModes();

  if (mode === "stream") {
    startStream();
  } else if (mode === "escalation") {
    startEscalation();
  } else if (mode === "toktinder") {
    playToktinderVideo();
  } else if (mode === "session") {
    enterSession();
  } else if (mode === "gallery") {
    renderGallery(false);
  } else if (mode === "mosaic") {
    startMosaic();
  } else if (mode === "feed") {
    startFeed();
  }
}

function scrollModeIntoView(button) {
  const nav = controls.modeSwitch;
  if (!nav || nav.scrollWidth <= nav.clientWidth) {
    return;
  }
  const target = button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2;
  nav.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
}

function quietAllModes() {
  stopStream();
  stopEscalation();
  pauseSession();
  stopMosaic();
  pauseFeed();
  pauseAllVideos();
  pauseToktinderVideo();
}

function refreshMode(mode) {
  if (mode === "swipe") {
    rebuildSwipeDeck();
    renderSwipe();
  } else if (mode === "toktinder") {
    rebuildToktinderDeck();
    renderToktinder();
  } else if (mode === "stream") {
    refreshStreamMedia(true);
  } else if (mode === "escalation") {
    if (state.currentMode === "escalation") {
      startEscalation();
    } else {
      renderEscalationIdle();
    }
  } else if (mode === "session") {
    refreshSessionMedia(true);
  } else if (mode === "gallery") {
    renderGallery(true);
  } else if (mode === "mosaic") {
    if (state.currentMode === "mosaic") {
      startMosaic();
    }
  } else if (mode === "feed") {
    if (state.currentMode === "feed") {
      rebuildFeed();
    }
  }
}

function toggleFocusMode() {
  setFocusMode(!state.focusMode);
}

function setFocusMode(enabled) {
  state.focusMode = enabled;
  syncFocusMode();
}

function syncFocusMode() {
  document.body.classList.toggle("focus-mode", state.focusMode);
  const label = state.focusMode ? "Exit Focus" : "Focus Mode";
  FOCUS_MODES.forEach((mode) => {
    const button = controls[`${mode}FocusToggle`];
    button.textContent = label;
    button.classList.toggle("active", state.focusMode);
  });
}

function syncThemeControls() {
  const value = sanitizeTheme(state.settings.theme);
  const currentTheme = THEME_OPTIONS.find((theme) => theme.value === value) || THEME_OPTIONS[0];
  controls.themeSummary.textContent = `Current theme: ${currentTheme.label}.`;
  controls.themeChoices.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeChoice === value);
  });
}

function clearToktinderVideoShape() {
  delete controls.toktinderCard.dataset.videoShape;
}

function syncToktinderVideoShape() {
  const { videoWidth, videoHeight } = controls.toktinderVideo;
  if (!videoWidth || !videoHeight) {
    clearToktinderVideoShape();
    return;
  }

  const ratio = videoWidth / videoHeight;
  let shape = "portrait";
  if (ratio > 1.08) {
    shape = "landscape";
  } else if (ratio >= 0.92) {
    shape = "square";
  }

  controls.toktinderCard.dataset.videoShape = shape;
}

function applyTheme() {
  document.body.dataset.theme = sanitizeTheme(state.settings.theme);
}

function renderThemeChoices() {
  controls.themeChoices.innerHTML = "";
  THEME_OPTIONS.forEach((theme) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button choice-button";
    button.dataset.themeChoice = theme.value;
    button.textContent = theme.label;
    button.addEventListener("click", () => {
      state.settings.theme = theme.value;
      state.themePanelVisible = false;
      syncThemeControls();
      applyTheme();
      syncLibraryChrome();
      queueSettingsSave();
    });
    controls.themeChoices.appendChild(button);
  });
}

async function rescanLibrary() {
  if (!state.libraryReady) {
    controls.setupMessage.textContent = "Choose a media folder first.";
    return;
  }

  try {
    setStatus("Rescanning library...");
    await postJson("/api/rescan", {});
    await loadState();
  } catch (error) {
    console.error(error);
    setStatus("Rescan failed.");
  }
}

async function resetSavedData() {
  const shouldReset = window.confirm(
    "Clear all saved likes and dislikes? Your folder path, theme, filters, and settings will stay as they are."
  );
  if (!shouldReset) {
    return;
  }

  try {
    setStatus("Clearing all likes and dislikes...");
    state.themePanelVisible = false;
    await postJson("/api/reset-ratings", {});
    await loadState();
    setStatus("All likes and dislikes cleared.");
  } catch (error) {
    console.error(error);
    setStatus("Could not clear likes and dislikes.");
  }
}

async function resetModeData(mode) {
  const messages = {
    swipe: {
      confirm: "Reset Tinder data? This clears saved likes and dislikes for photos only.",
      busy: "Clearing photo ratings...",
      done: "Photo ratings cleared.",
      failed: "Could not clear photo ratings.",
    },
    toktinder: {
      confirm: "Reset TindTok data? This clears saved likes and dislikes for videos only.",
      busy: "Clearing video ratings...",
      done: "Video ratings cleared.",
      failed: "Could not clear video ratings.",
    },
  };

  const config = messages[mode];
  if (!config) {
    return;
  }

  const shouldReset = window.confirm(config.confirm);
  if (!shouldReset) {
    return;
  }

  try {
    setStatus(config.busy);
    await postJson("/api/reset-mode-data", { mode });
    await loadState();
    setStatus(config.done);
  } catch (error) {
    console.error(error);
    setStatus(config.failed);
  }
}

function toggleDrawer(name) {
  if (state.activeDrawer === name) {
    closeDrawers();
    return;
  }

  state.activeDrawer = name;
  syncDrawers();
}

function closeDrawers() {
  if (!state.activeDrawer) {
    return;
  }
  state.activeDrawer = null;
  syncDrawers();
}

function syncDrawers() {
  let anyOpen = false;
  DRAWER_MODES.forEach((mode) => {
    const open = state.activeDrawer === mode;
    anyOpen = anyOpen || open;
    controls[`${mode}Drawer`].classList.toggle("open", open);
    controls[`${mode}Drawer`].setAttribute("aria-hidden", String(!open));
    controls[`${mode}DrawerToggle`].classList.toggle("active", open);
  });

  controls.drawerBackdrop.hidden = !anyOpen;
  controls.drawerBackdrop.classList.toggle("open", anyOpen);
  document.body.classList.toggle("drawer-open", anyOpen);
}

function startEscalation() {
  stopEscalation();
  state.escalationRecentPaths = [];
  state.escalationSessionStartedAt = Date.now();
  refreshEscalationMedia(true);
}

function stopEscalation() {
  if (state.escalationTimer) {
    window.clearTimeout(state.escalationTimer);
    state.escalationTimer = null;
  }
  if (state.escalationBurstTimer) {
    window.clearInterval(state.escalationBurstTimer);
    state.escalationBurstTimer = null;
  }
  state.escalationCurrentIntervalMs = 0;
  state.escalationSessionStartedAt = 0;
  pauseEscalationVideo();
}

function renderEscalationIdle() {
  setLabel(controls.escalationName, "Waiting for media");
  setLabel(controls.escalationFolder, "");
  controls.escalationStatus.textContent = "Building pressure...";
  controls.escalationPhaseBadge.textContent = "Warmup";
  controls.escalationTelemetry.textContent = "Swap 12.0s • 1.0x";
}

function refreshEscalationMedia(force) {
  const mediaItems = getEscalationMediaItems();

  if (!mediaItems.length) {
    clearEscalationMedia();
    setLabel(controls.escalationName, "No escalation media available");
    setLabel(controls.escalationFolder, "");
    controls.escalationStatus.textContent =
      "Add images or videos, or widen the folder filter to start the ramp.";
    controls.escalationPhaseBadge.textContent = "Idle";
    controls.escalationTelemetry.textContent = "No media";
    return;
  }

  const currentPath = controls.escalationStage.dataset.path;
  if (!force && currentPath) {
    updateEscalationTelemetry();
    scheduleEscalationSwap();
    return;
  }

  const chosen = pickEscalationItem(mediaItems);
  if (!chosen) {
    return;
  }

  if (chosen.kind === "photo") {
    showEscalationPhoto(chosen);
  } else {
    loadEscalationVideoClip(chosen);
  }
  updateEscalationTelemetry();
  scheduleEscalationSwap();
}

function scheduleEscalationSwap() {
  if (state.currentMode !== "escalation") {
    return;
  }
  if (state.escalationTimer) {
    window.clearTimeout(state.escalationTimer);
  }
  state.escalationCurrentIntervalMs = currentEscalationIntervalMs();
  state.escalationTimer = window.setTimeout(() => {
    refreshEscalationMedia(true);
  }, state.escalationCurrentIntervalMs);
}

function showEscalationPhoto(item) {
  if (!item) {
    controls.escalationPhoto.removeAttribute("src");
    controls.escalationPhoto.alt = "";
    return;
  }

  if (state.escalationBurstTimer) {
    window.clearInterval(state.escalationBurstTimer);
    state.escalationBurstTimer = null;
  }

  releaseVideo(controls.escalationVideo);

  controls.escalationStage.dataset.activeKind = "photo";
  controls.escalationStage.dataset.path = item.path;
  controls.escalationPhoto.dataset.path = item.path;
  controls.escalationPhoto.src = mediaUrl(item.path);
  controls.escalationPhoto.alt = item.name;
  setLabel(controls.escalationName, item.name);
  setLabel(controls.escalationFolder, item.folder || "Library root");
}

function loadEscalationVideoClip(chosen) {
  const video = controls.escalationVideo;
  if (!chosen) {
    if (state.escalationBurstTimer) {
      window.clearInterval(state.escalationBurstTimer);
      state.escalationBurstTimer = null;
    }
    releaseVideo(video);
    return;
  }

  if (state.escalationBurstTimer) {
    window.clearInterval(state.escalationBurstTimer);
    state.escalationBurstTimer = null;
  }

  controls.escalationStage.dataset.activeKind = "video";
  controls.escalationStage.dataset.path = chosen.path;
  controls.escalationPhoto.removeAttribute("src");
  controls.escalationPhoto.removeAttribute("data-path");
  controls.escalationPhoto.alt = "";
  video.loop = false;
  video.playsInline = true;
  applyEscalationAudio();
  loadVideoSource(video, chosen);

  setLabel(controls.escalationName, chosen.name);
  setLabel(controls.escalationFolder, chosen.folder || "Library root");
}

function configureEscalationVideo() {
  if (state.currentMode !== "escalation" || !controls.escalationVideo.src) {
    return;
  }

  const video = controls.escalationVideo;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const progress = getEscalationProgress();
  const speed = currentEscalationSpeed(progress);
  const hotStart = clampNumber(
    duration > 0 ? duration * (0.35 + Math.random() * 0.5) : 0,
    0,
    Math.max(0, duration - 0.4)
  );

  video.playbackRate = speed;
  applyEscalationAudio();
  restartEscalationBurst(duration, progress);
  updateEscalationTelemetry(progress);
  // Land the seek and decode a frame before the sound starts.
  playWhenReady(video, video.dataset.loadToken, hotStart);
}

function restartEscalationBurst(duration, progress) {
  if (state.escalationBurstTimer) {
    window.clearInterval(state.escalationBurstTimer);
    state.escalationBurstTimer = null;
  }
  if (progress < 0.58 || duration < 8) {
    return;
  }

  const burstProgress = clampNumber((progress - 0.58) / 0.42, 0, 1);
  const cadence = Math.round(lerp(460, 110, burstProgress));
  state.escalationBurstTimer = window.setInterval(() => {
    if (state.currentMode !== "escalation" || document.hidden || !controls.escalationVideo.src) {
      return;
    }

    const video = controls.escalationVideo;
    const maxTime = Math.max(duration * 0.4, duration - 0.6);
    const minTime = duration * 0.35;
    if (maxTime <= minTime) {
      return;
    }

    const forwardJump = duration * lerp(0.04, 0.14, burstProgress) * (0.8 + Math.random() * 0.9);
    let target = video.currentTime + forwardJump;
    if (target >= maxTime || Math.random() > lerp(0.82, 0.42, burstProgress)) {
      target = minTime + Math.random() * (maxTime - minTime);
    }

    try {
      video.currentTime = clampNumber(target, minTime, maxTime);
    } catch (error) {
      console.error(error);
    }
  }, cadence);
}

function updateEscalationTelemetry(progress = getEscalationProgress()) {
  const intervalMs = currentEscalationIntervalMs(progress);
  const speed = currentEscalationSpeed(progress);
  const phase = escalationPhaseLabel(progress);
  const burstActive = progress >= 0.58 && !!controls.escalationVideo.src;

  controls.escalationPhaseBadge.textContent = phase;
  controls.escalationTelemetry.textContent = `Swap ${(intervalMs / 1000).toFixed(1)}s • ${speed.toFixed(1)}x${
    burstActive ? " • Burst" : ""
  }`;
  if (controls.escalationVideo.src) {
    controls.escalationStatus.textContent = `${phase} active. Hot-seeking and compressing clips as the swap timer drops.`;
  } else if (controls.escalationPhoto.src) {
    controls.escalationStatus.textContent = `${phase} active. Mixing stills between video bursts while the swap timer tightens.`;
  }
}

function escalationPhaseLabel(progress) {
  if (progress >= 0.82) {
    return "Burst Mode";
  }
  if (progress >= 0.58) {
    return "Overclock";
  }
  if (progress >= 0.28) {
    return "Drive";
  }
  return "Warmup";
}

function currentEscalationIntervalMs(progress = getEscalationProgress()) {
  const minSeconds = clampNumber(Number(state.settings.escalationMinInterval ?? 2), 1, 12);
  const baseSeconds = Math.max(minSeconds, clampNumber(Number(state.settings.escalationBaseInterval ?? 12), 1, 30));
  const eased = 1 - (1 - progress) ** 2;
  return lerp(baseSeconds * 1000, minSeconds * 1000, eased);
}

function currentEscalationSpeed(progress = getEscalationProgress()) {
  const maxSpeed = clampNumber(Number(state.settings.escalationMaxSpeed ?? 2.2), 1, 3);
  const eased = progress ** 1.15;
  return lerp(1, maxSpeed, eased);
}

function getEscalationProgress() {
  const rampMs = clampNumber(Number(state.settings.escalationRampSeconds ?? 90), 20, 300) * 1000;
  if (!state.escalationSessionStartedAt) {
    return 0;
  }
  return clampNumber((Date.now() - state.escalationSessionStartedAt) / rampMs, 0, 1);
}

function clearEscalationMedia() {
  stopEscalation();
  state.escalationRecentPaths = [];
  controls.escalationStage.dataset.activeKind = "idle";
  controls.escalationStage.removeAttribute("data-path");
  controls.escalationPhoto.removeAttribute("src");
  controls.escalationPhoto.removeAttribute("data-path");
  controls.escalationPhoto.alt = "";
  releaseVideo(controls.escalationVideo);
}

function startStream() {
  restartPhotoTimer();
  refreshStreamVideos();
}

function stopStream() {
  if (state.streamPhotoTimer) {
    window.clearInterval(state.streamPhotoTimer);
    state.streamPhotoTimer = null;
  }
}

function restartPhotoTimer() {
  stopStream();
  if (state.currentMode !== "stream" || !getStreamImages().length) {
    return;
  }
  state.streamPhotoTimer = window.setInterval(() => {
    showRandomPhoto();
  }, Number(state.settings.photoInterval) * 1000);
}

function refreshStreamMedia(forcePhoto) {
  if (forcePhoto || !controls.streamPhoto.src) {
    showRandomPhoto();
  }
  refreshStreamVideos();
  if (state.currentMode === "stream") {
    restartPhotoTimer();
  }
}

function showRandomPhoto() {
  const images = getStreamImages();
  if (!images.length) {
    controls.streamPhoto.removeAttribute("src");
    setLabel(controls.streamPhotoName, "No stream photo available");
    setLabel(controls.streamPhotoFolder, "");
    return;
  }
  const item = pickRandom(images, controls.streamPhoto.dataset.path);
  if (!item) {
    return;
  }
  controls.streamPhoto.dataset.path = item.path;
  controls.streamPhoto.src = mediaUrl(item.path);
  controls.streamPhoto.alt = item.name;
  setLabel(controls.streamPhotoName, item.name);
  setLabel(controls.streamPhotoFolder, item.folder || "Library root");
}

function queueStreamVideoRefresh() {
  // The Count slider fires on every pixel of a drag. Rebuilding the overlay
  // on each one stacks half-loaded <video> elements, and their audio comes
  // up on top of each other.
  window.clearTimeout(state.streamRebuildTimer);
  state.streamRebuildTimer = window.setTimeout(refreshStreamVideos, 220);
}

function refreshStreamVideos() {
  window.clearTimeout(state.streamRebuildTimer);
  const overlay = controls.videoOverlay;
  // Detached media elements can keep playing audio for a beat. Stop them
  // explicitly before dropping them.
  state.streamVideoSlots.forEach(({ video }) => releaseVideo(video));
  overlay.querySelectorAll("video").forEach((video) => releaseVideo(video));
  overlay.innerHTML = "";
  state.streamVideoSlots = [];

  const count = clampNumber(Number(state.settings.videoCount), 0, 2);
  for (let index = 0; index < count; index += 1) {
    const fragment = document.getElementById("videoSlotTemplate").content.cloneNode(true);
    const slot = fragment.querySelector(".video-slot");
    const video = fragment.querySelector("video");
    slot.classList.add(`corner-${index}`);
    overlay.appendChild(fragment);
    const mountedSlot = overlay.lastElementChild;
    const mountedVideo = mountedSlot.querySelector("video");

    mountedVideo.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(mountedVideo.duration) ? mountedVideo.duration : 0;
      const fixedStart = clampNumber(Number(state.settings.clipStartSeconds), 0, 3600);
      const maxStart = Math.max(0, duration - 0.25);
      const start =
        state.settings.clipStartMode === "fixed"
          ? Math.min(fixedStart, maxStart)
          : Math.random() * maxStart;
      playWhenReady(
        mountedVideo,
        mountedVideo.dataset.loadToken,
        Number.isFinite(start) ? start : 0
      );
    });

    mountedVideo.addEventListener("loadeddata", noteMediaLoaded);

    mountedVideo.addEventListener("error", () => {
      if (reportBrokenMedia(mountedVideo.dataset.path) && !brokenStreakExhausted("stream")) {
        loadRandomVideoClip(mountedVideo);
      }
    });

    mountedVideo.addEventListener("ended", () => {
      loadRandomVideoClip(mountedVideo);
    });

    state.streamVideoSlots.push({ video: mountedVideo });
    applyVideoVolume();
    loadRandomVideoClip(mountedVideo);
  }
}

function loadRandomVideoClip(video) {
  const videos = getStreamVideos();
  if (!videos.length) {
    releaseVideo(video);
    return;
  }
  const chosen = pickRandom(videos, video.dataset.path);
  if (!chosen) {
    return;
  }
  video.loop = false;
  video.playsInline = true;
  video.volume = clampNumber(Number(state.settings.videoVolume), 0, 1);
  video.muted = !state.audioUnlocked || Number(state.settings.videoVolume) === 0;
  loadVideoSource(video, chosen);
}

function applyVideoVolume() {
  const volume = clampNumber(Number(state.settings.videoVolume), 0, 1);
  state.streamVideoSlots.forEach(({ video }) => {
    video.volume = volume;
    video.muted = !state.audioUnlocked || volume === 0;
  });
}

function applyToktinderAudio() {
  controls.toktinderVideo.volume = 1;
  controls.toktinderVideo.muted = !state.audioUnlocked;
}

function applyEscalationAudio() {
  controls.escalationVideo.volume = clampNumber(Number(state.settings.escalationVideoVolume ?? 0.32), 0, 1);
  controls.escalationVideo.muted =
    !state.audioUnlocked || Number(state.settings.escalationVideoVolume ?? 0.32) === 0;
}

function pauseAllVideos() {
  state.streamVideoSlots.forEach(({ video }) => video.pause());
}

function playAllVideos() {
  state.streamVideoSlots.forEach(({ video }) => {
    video.play().catch(() => {});
  });
}

function pauseToktinderVideo() {
  controls.toktinderVideo.pause();
}

function pauseEscalationVideo() {
  controls.escalationVideo.pause();
}

function playToktinderVideo() {
  if (state.currentMode !== "toktinder" || !controls.toktinderVideo.src) {
    return;
  }
  applyToktinderAudio();
  controls.toktinderVideo.play().catch(() => {});
}

function playEscalationVideo() {
  if (state.currentMode !== "escalation" || !controls.escalationVideo.src) {
    return;
  }
  applyEscalationAudio();
  controls.escalationVideo.play().catch(() => {});
}

function toggleVideoAudio() {
  state.audioUnlocked = !state.audioUnlocked;
  syncAudioButton();
  applyVideoVolume();
  applyToktinderAudio();
  applyEscalationAudio();
  applySessionAudio();
  applyMosaicAudio();
  applyFeedAudio();
  playAllVideos();
  playToktinderVideo();
  playEscalationVideo();
}

function onSwipePointerDown(event) {
  const mode = event.currentTarget.dataset.swipeMode;
  if (!currentDeckItem(mode)) {
    return;
  }
  state.drag.active = true;
  state.drag.mode = mode;
  state.drag.pointerId = event.pointerId;
  state.drag.startX = event.clientX;
  state.drag.startY = event.clientY;
  state.drag.deltaX = 0;
  state.drag.deltaY = 0;
  event.currentTarget.setPointerCapture(event.pointerId);
}

function onSwipePointerMove(event) {
  if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
    return;
  }
  const card = swipeCardControl(state.drag.mode);
  if (!card) {
    return;
  }
  state.drag.deltaX = event.clientX - state.drag.startX;
  state.drag.deltaY = event.clientY - state.drag.startY;
  const rotation = state.drag.deltaX * 0.04;
  card.style.transform = `translate(${state.drag.deltaX}px, ${Math.max(0, state.drag.deltaY)}px) rotate(${rotation}deg)`;
  const horizontalIntent = Math.abs(state.drag.deltaX) >= Math.abs(state.drag.deltaY) * 0.9;
  card.classList.toggle("likeing", horizontalIntent && state.drag.deltaX > 35);
  card.classList.toggle("disliking", horizontalIntent && state.drag.deltaX < -35);
}

function onSwipePointerUp(event) {
  if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
    return;
  }
  const mode = state.drag.mode;
  const deltaX = state.drag.deltaX;
  const deltaY = state.drag.deltaY;
  resetSwipeCard(mode);
  if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) {
    if (mode === "toktinder") {
      toggleToktinderPlayback();
    }
    return;
  }
  if (deltaY > 120 && deltaY > Math.abs(deltaX) * 1.15) {
    skipDeckItem(mode);
  } else if (deltaX > 110) {
    rateDeckItem(mode, "like");
  } else if (deltaX < -110) {
    rateDeckItem(mode, "dislike");
  }
}

function resetSwipeCard(mode = state.drag.mode) {
  if (mode && typeof mode === "object") {
    mode = mode.currentTarget?.dataset?.swipeMode || state.drag.mode;
  }
  const card = swipeCardControl(mode);
  if (card) {
    card.style.transform = "";
    card.classList.remove("likeing", "disliking");
  }
  state.drag.active = false;
  state.drag.mode = null;
  state.drag.pointerId = null;
  state.drag.startX = 0;
  state.drag.startY = 0;
  state.drag.deltaX = 0;
  state.drag.deltaY = 0;
}

function queueSettingsSave() {
  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(async () => {
    try {
      await postJson("/api/settings", state.settings);
    } catch (error) {
      console.error(error);
    }
  }, 220);
}

function syncAudioButton() {
  const label = state.audioUnlocked ? "Mute Videos" : "Enable Sound";
  const hint = state.audioUnlocked
    ? "Sound is unlocked for the current browser session."
    : "Mobile browsers often require a tap before videos can play with sound.";
  [
    ["audioToggleButton", "audioHint"],
    ["toktinderAudioToggleButton", "toktinderAudioHint"],
    ["escalationAudioToggleButton", "escalationAudioHint"],
    ["sessionAudioToggleButton", "sessionAudioHint"],
    ["mosaicAudioToggleButton", "mosaicAudioHint"],
    ["feedAudioToggleButton", "feedAudioHint"],
  ].forEach(([buttonKey, hintKey]) => {
    controls[buttonKey].textContent = label;
    controls[hintKey].textContent = hint;
  });
}

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
    if (started || !isCurrentLoad(video, token)) {
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

  const target = Number(seekTo);
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
    `Skipped ${BROKEN_STREAK_LIMIT} unreadable files in a row. The drive may be disconnected — rescan from the Hub.`
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

  controls.streamPhoto.addEventListener("error", () => {
    if (brokenStreakExhausted("stream")) {
      return;
    }
    retryOrCondemn(controls.streamPhoto, showRandomPhoto);
  });
  controls.streamPhoto.addEventListener("load", () => {
    retryCounts.delete(controls.streamPhoto.dataset.path);
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
    await loadState();
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

/* ==========================================================================
   Rating filter, history and undo
   ========================================================================== */

const RATING_FILTERS = ["all", "unrated", "liked"];

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
    return item.rating === "like";
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
  bindSegmented(controls[`${mode}RatingFilter`], "ratingFilter", (value) => {
    const config = deckConfig(mode);
    state.settings[config.filterKey] = sanitizeRatingFilter(value, false);
    state.history[mode] = [];
    syncRatingFilter(mode);
    syncUndoButtons();
    rebuildDeck(mode);
    renderDeck(mode);
    queueSettingsSave();
  });
}

function syncRatingFilter(mode) {
  const config = deckConfig(mode);
  syncSegmented(controls[`${mode}RatingFilter`], "ratingFilter", ratingFilterValue(config.filterKey));
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

  const canonicalItem = (state.library[config.sourceKey] || []).find(
    (item) => item.path === entry.path
  );
  if (canonicalItem) {
    canonicalItem.rating = entry.previousRating;
  }
  if (entry.item) {
    entry.item.rating = entry.previousRating;
  }

  const items = state[config.itemsKey];
  if (entry.removed && !items.some((item) => item.path === entry.path)) {
    items.splice(clampNumber(entry.index, 0, items.length), 0, canonicalItem || entry.item);
  }
  state[config.indexKey] = clampNumber(entry.index, 0, Math.max(0, items.length - 1));

  syncCountsFromLibrary();
  renderDeck(mode);
  setStatus(entry.previousRating ? "Rating restored." : "Rating cleared.");
}

/* ==========================================================================
   TindTok transport — scrub, play/pause, elapsed time
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

/* ==========================================================================
   Session — a paced build/hold cycle laid over the media

   Escalation ramps the media. This ramps the session: each round gives you a
   shorter build and a longer hold, and the media follows the phase — swaps
   speed up while building, and freeze while you are holding.
   ========================================================================== */

function sessionSettings() {
  return {
    rounds: clampNumber(Number(state.settings.sessionRounds ?? 5), 2, 10),
    build: clampNumber(Number(state.settings.sessionBuildSeconds ?? 60), 20, 180),
    hold: clampNumber(Number(state.settings.sessionHoldSeconds ?? 15), 5, 60),
    includeVideos: state.settings.sessionIncludeVideos !== false,
  };
}

function buildSessionPhases() {
  const { rounds, build, hold } = sessionSettings();
  const phases = [];
  for (let round = 0; round < rounds; round += 1) {
    const t = rounds === 1 ? 1 : round / (rounds - 1);
    phases.push({
      kind: "build",
      round: round + 1,
      seconds: Math.max(10, Math.round(lerp(build, build * 0.4, t))),
    });
    phases.push({
      kind: "hold",
      round: round + 1,
      seconds: Math.max(5, Math.round(lerp(hold * 0.5, hold, t))),
    });
  }
  // Open-ended: seconds 0 means "runs until you stop it".
  phases.push({ kind: "finish", round: rounds, seconds: 0 });
  return phases;
}

function startSession() {
  stopSessionTimers();
  state.session.phases = buildSessionPhases();
  state.session.index = 0;
  state.session.elapsedMs = 0;
  state.session.running = true;
  state.session.recentPaths = [];
  renderSessionPips();
  refreshSessionMedia(true);
  runSessionTick();
  syncSessionControls();
}

function enterSession() {
  renderSessionPips();
  if (state.session.running) {
    runSessionTick();
    if (currentSessionPhase().kind !== "hold") {
      playWhenReady(controls.sessionVideo, controls.sessionVideo.dataset.loadToken, null);
    }
  } else {
    refreshSessionMedia(true);
    syncSessionHud();
  }
  syncSessionControls();
}

function pauseSession() {
  stopSessionTimers();
  controls.sessionVideo.pause();
}

function stopSession() {
  stopSessionTimers();
  state.session.running = false;
  state.session.index = 0;
  state.session.elapsedMs = 0;
  controls.sessionVideo.pause();
  syncSessionHud();
  syncSessionControls();
}

function stopSessionTimers() {
  window.clearInterval(state.session.tickTimer);
  window.clearTimeout(state.session.mediaTimer);
  state.session.tickTimer = null;
  state.session.mediaTimer = null;
}

function toggleSession() {
  if (state.session.running) {
    stopSession();
  } else {
    startSession();
  }
}

function currentSessionPhase() {
  return state.session.phases[state.session.index] || { kind: "idle", round: 0, seconds: 0 };
}

function sessionProgress() {
  const phases = state.session.phases;
  if (!phases.length) {
    return 0;
  }
  return clampNumber(state.session.index / Math.max(1, phases.length - 1), 0, 1);
}

const SESSION_TICK_MS = 200;

function runSessionTick() {
  stopSessionTimers();
  state.session.tickTimer = window.setInterval(() => {
    if (state.currentMode !== "session" || document.hidden) {
      return;
    }
    const phase = currentSessionPhase();
    state.session.elapsedMs += SESSION_TICK_MS;
    if (phase.seconds > 0 && state.session.elapsedMs >= phase.seconds * 1000) {
      advanceSessionPhase();
      return;
    }
    syncSessionHud();
  }, SESSION_TICK_MS);
  scheduleSessionSwap();
  syncSessionHud();
}

function advanceSessionPhase() {
  if (state.session.index >= state.session.phases.length - 1) {
    state.session.elapsedMs = 0;
    syncSessionHud();
    return;
  }
  state.session.index += 1;
  state.session.elapsedMs = 0;
  const phase = currentSessionPhase();

  if (phase.kind === "hold") {
    // The picture stops with you.
    window.clearTimeout(state.session.mediaTimer);
    state.session.mediaTimer = null;
    controls.sessionVideo.pause();
  } else {
    refreshSessionMedia(true);
  }

  renderSessionPips();
  syncSessionHud();
}

function sessionSwapIntervalMs() {
  const phase = currentSessionPhase();
  if (phase.kind === "hold") {
    return 0;
  }
  if (phase.kind === "finish") {
    return 2500;
  }
  const withinPhase = phase.seconds
    ? clampNumber(state.session.elapsedMs / (phase.seconds * 1000), 0, 1)
    : 0;
  const overall = clampNumber(sessionProgress() * 0.65 + withinPhase * 0.35, 0, 1);
  return lerp(9000, 3000, overall);
}

function scheduleSessionSwap() {
  window.clearTimeout(state.session.mediaTimer);
  const interval = sessionSwapIntervalMs();
  if (!interval || state.currentMode !== "session") {
    return;
  }
  state.session.mediaTimer = window.setTimeout(() => {
    refreshSessionMedia(true);
  }, interval);
}

function getSessionMediaItems() {
  return mediaPool(`session:${sessionSettings().includeVideos}`, () => {
    const selected = normalizedFolderSelection("sessionFolders");
    const images = (state.library.images || [])
      .filter((item) => matchesFolderSelection(item, selected))
      .map((item) => ({ ...item, kind: "photo" }));
    if (!sessionSettings().includeVideos) {
      return images;
    }
    const videos = (state.library.videos || [])
      .filter((item) => matchesFolderSelection(item, selected))
      .map((item) => ({ ...item, kind: "video" }));
    return [...images, ...videos];
  });
}

function refreshSessionMedia(force) {
  const items = getSessionMediaItems();
  if (!items.length) {
    setLabel(controls.sessionName, "No media matches the session filter");
    setLabel(controls.sessionFolder, "");
    controls.sessionStatus.textContent = "Widen the folder filter to run a session.";
    return;
  }

  if (!force && controls.sessionStage.dataset.path) {
    scheduleSessionSwap();
    return;
  }

  const chosen = pickWithoutRepeats(items, state.session.recentPaths, controls.sessionStage.dataset.path);
  if (!chosen) {
    return;
  }
  state.session.recentPaths.push(chosen.path);
  if (state.session.recentPaths.length > 24) {
    state.session.recentPaths.shift();
  }

  controls.sessionStage.dataset.path = chosen.path;
  setLabel(controls.sessionName, chosen.name);
  setLabel(controls.sessionFolder, chosen.folder || "Library root");

  if (chosen.kind === "photo") {
    releaseVideo(controls.sessionVideo);
    controls.sessionStage.dataset.activeKind = "photo";
    controls.sessionPhoto.dataset.path = chosen.path;
    controls.sessionPhoto.src = mediaUrl(chosen.path);
    controls.sessionPhoto.alt = chosen.name;
  } else {
    controls.sessionStage.dataset.activeKind = "video";
    controls.sessionPhoto.removeAttribute("src");
    controls.sessionPhoto.removeAttribute("data-path");
    controls.sessionVideo.loop = true;
    controls.sessionVideo.playsInline = true;
    applySessionAudio();
    loadVideoSource(controls.sessionVideo, chosen);
  }

  scheduleSessionSwap();
}

function applySessionAudio() {
  const volume = clampNumber(Number(state.settings.sessionVideoVolume ?? 0.3), 0, 1);
  controls.sessionVideo.volume = volume;
  controls.sessionVideo.muted = !state.audioUnlocked || volume === 0;
}

function syncSessionHud() {
  const phase = currentSessionPhase();
  const stage = controls.sessionStage;
  stage.dataset.phase = state.session.running ? phase.kind : "idle";

  if (!state.session.running) {
    controls.sessionCue.textContent = "Ready";
    controls.sessionCountdown.textContent = "";
    controls.sessionBarFill.style.width = "0%";
    controls.sessionStatus.textContent = "Press Start to begin a paced session.";
    return;
  }

  const remaining = phase.seconds
    ? Math.max(0, phase.seconds - state.session.elapsedMs / 1000)
    : 0;
  const fraction = phase.seconds
    ? clampNumber(state.session.elapsedMs / (phase.seconds * 1000), 0, 1)
    : 1;

  if (phase.kind === "build") {
    const level = Math.round(lerp(3, 9, clampNumber(sessionProgress(), 0, 1)));
    controls.sessionCue.textContent = `Build — pace ${level}/10`;
  } else if (phase.kind === "hold") {
    controls.sessionCue.textContent = "Hands off";
  } else {
    controls.sessionCue.textContent = "Go";
  }

  controls.sessionCountdown.textContent = phase.seconds ? formatClock(Math.ceil(remaining)) : "";
  controls.sessionBarFill.style.width = `${Math.round(fraction * 100)}%`;

  const { rounds } = sessionSettings();
  controls.sessionStatus.textContent =
    phase.kind === "finish"
      ? "Final round — no timer."
      : `Round ${phase.round} of ${rounds}`;
}

function renderSessionPips() {
  const { rounds } = sessionSettings();
  const phase = currentSessionPhase();
  controls.sessionRoundPips.innerHTML = "";
  for (let round = 1; round <= rounds; round += 1) {
    const pip = document.createElement("span");
    pip.className = "session-pip";
    if (state.session.running && round < phase.round) {
      pip.classList.add("done");
    } else if (state.session.running && round === phase.round) {
      pip.classList.add("current");
    }
    controls.sessionRoundPips.appendChild(pip);
  }
}

function syncSessionControls() {
  controls.sessionToggleButton.textContent = state.session.running ? "Stop" : "Start";
  controls.sessionToggleButton.classList.toggle("active", state.session.running);
}

/* ==========================================================================
   Gallery — the only mode that lets you look for something specific
   ========================================================================== */

const GALLERY_PAGE_SIZE = 60;

function galleryItems() {
  const selected = normalizedFolderSelection("galleryFolders");
  const kind = state.settings.galleryKind || "all";
  const filter = ratingFilterValue("galleryRatingFilter");
  const search = state.gallery.search.trim().toLowerCase();

  const pool = [];
  if (kind !== "videos") {
    pool.push(...(state.library.images || []).map((item) => ({ ...item, kind: "photo" })));
  }
  if (kind !== "photos") {
    pool.push(...(state.library.videos || []).map((item) => ({ ...item, kind: "video" })));
  }

  const items = pool.filter((item) => {
    if (!matchesFolderSelection(item, selected)) {
      return false;
    }
    if (!matchesRatingFilter(item, filter)) {
      return false;
    }
    return !search || item.name.toLowerCase().includes(search);
  });

  const sort = state.settings.gallerySort || "name";
  if (sort === "newest") {
    items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  } else if (sort === "oldest") {
    items.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
  } else if (sort === "largest") {
    items.sort((a, b) => (b.size || 0) - (a.size || 0));
  } else if (sort === "random") {
    shuffleArray(items);
  } else {
    items.sort((a, b) => a.path.localeCompare(b.path));
  }
  return items;
}

function renderGallery(resetPage) {
  // A 12,000-tile grid is not a grid, it is a stall. Page it, and let the
  // browser fetch each tile only when it scrolls close.
  state.gallery.items = galleryItems();
  const pageCount = Math.max(1, Math.ceil(state.gallery.items.length / GALLERY_PAGE_SIZE));
  if (resetPage) {
    state.gallery.page = 0;
  }
  state.gallery.page = clampNumber(state.gallery.page, 0, pageCount - 1);

  const start = state.gallery.page * GALLERY_PAGE_SIZE;
  const slice = state.gallery.items.slice(start, start + GALLERY_PAGE_SIZE);

  if (state.gallery.observer) {
    state.gallery.observer.disconnect();
  }
  state.gallery.observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        const video = entry.target.querySelector("video");
        if (video && !video.getAttribute("src")) {
          // The media fragment asks the browser to show the frame at one
          // second, which is our poster without a thumbnailer on the server.
          video.src = `${mediaUrl(video.dataset.path)}#t=1`;
        }
        state.gallery.observer.unobserve(entry.target);
      });
    },
    { rootMargin: "300px" }
  );

  controls.galleryGrid.querySelectorAll("video").forEach(releaseVideo);
  controls.galleryGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  slice.forEach((item, offset) => {
    fragment.appendChild(buildGalleryTile(item, start + offset));
  });
  controls.galleryGrid.appendChild(fragment);
  controls.galleryGrid.querySelectorAll(".gallery-tile.is-video").forEach((tile) => {
    state.gallery.observer.observe(tile);
  });

  const total = state.gallery.items.length;
  controls.galleryPageInfo.textContent = total
    ? `${(start + 1).toLocaleString()}–${Math.min(start + GALLERY_PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()}`
    : "Nothing matches the current filter";
  controls.galleryPrevPage.disabled = state.gallery.page === 0;
  controls.galleryNextPage.disabled = state.gallery.page >= pageCount - 1;
  controls.galleryGrid.scrollTop = 0;
}

function buildGalleryTile(item, index) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = `gallery-tile${item.kind === "video" ? " is-video" : ""}`;
  tile.dataset.index = String(index);
  tile.title = item.path;

  if (item.kind === "video") {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.dataset.path = item.path;
    tile.appendChild(video);
    const badge = document.createElement("span");
    badge.className = "gallery-badge";
    badge.textContent = "Video";
    tile.appendChild(badge);
  } else {
    const image = document.createElement("img");
    image.loading = "lazy";
    image.decoding = "async";
    image.alt = "";
    image.dataset.path = item.path;
    image.src = mediaUrl(item.path);
    image.addEventListener("error", () => tile.classList.add("is-missing"));
    tile.appendChild(image);
  }

  if (item.rating) {
    const dot = document.createElement("span");
    dot.className = `gallery-rating gallery-rating-${item.rating}`;
    tile.appendChild(dot);
  }

  tile.addEventListener("click", () => openLightbox(index));
  return tile;
}

function openLightbox(index) {
  const items = state.gallery.items;
  if (!items.length) {
    return;
  }
  state.gallery.lightboxIndex = clampNumber(index, 0, items.length - 1);
  const item = items[state.gallery.lightboxIndex];

  controls.galleryLightbox.hidden = false;
  document.body.classList.add("drawer-open");

  const isVideo = item.kind === "video";
  controls.lightboxImage.hidden = isVideo;
  controls.lightboxVideo.hidden = !isVideo;

  if (isVideo) {
    controls.lightboxImage.removeAttribute("src");
    controls.lightboxVideo.muted = !state.audioUnlocked;
    loadVideoSource(controls.lightboxVideo, item);
    playWhenReady(controls.lightboxVideo, controls.lightboxVideo.dataset.loadToken, null);
  } else {
    releaseVideo(controls.lightboxVideo);
    controls.lightboxImage.src = mediaUrl(item.path);
    controls.lightboxImage.alt = item.name;
  }

  setLabel(controls.lightboxName, item.name);
  setLabel(controls.lightboxFolder, item.folder || "Library root");
  syncLightboxRating();
}

function closeLightbox() {
  controls.galleryLightbox.hidden = true;
  document.body.classList.toggle("drawer-open", !!state.activeDrawer);
  releaseVideo(controls.lightboxVideo);
  controls.lightboxImage.removeAttribute("src");
  state.gallery.lightboxIndex = -1;
}

function stepLightbox(delta) {
  if (state.gallery.lightboxIndex < 0) {
    return;
  }
  const next = state.gallery.lightboxIndex + delta;
  if (next < 0 || next >= state.gallery.items.length) {
    return;
  }
  openLightbox(next);
}

function syncLightboxRating() {
  const item = state.gallery.items[state.gallery.lightboxIndex];
  const rating = item ? item.rating : null;
  controls.lightboxLike.classList.toggle("active", rating === "like");
  controls.lightboxDislike.classList.toggle("active", rating === "dislike");
}

async function rateLightboxItem(rating) {
  const item = state.gallery.items[state.gallery.lightboxIndex];
  if (!item) {
    return;
  }
  // Tapping the active rating again clears it.
  const next = item.rating === rating ? null : rating;
  try {
    await postJson("/api/rating", { path: item.path, rating: next });
  } catch (error) {
    console.error(error);
    return;
  }

  item.rating = next;
  const canonical = [...(state.library.images || []), ...(state.library.videos || [])].find(
    (entry) => entry.path === item.path
  );
  if (canonical) {
    canonical.rating = next;
  }
  syncCountsFromLibrary();
  syncLightboxRating();

  const tile = controls.galleryGrid.querySelector(
    `.gallery-tile[data-index="${state.gallery.lightboxIndex}"]`
  );
  if (tile) {
    tile.querySelector(".gallery-rating")?.remove();
    if (next) {
      const dot = document.createElement("span");
      dot.className = `gallery-rating gallery-rating-${next}`;
      tile.appendChild(dot);
    }
  }
}

/* ==========================================================================
   Mosaic — a wall of clips, one of them audible
   ========================================================================== */

function mosaicTileCount() {
  return clampNumber(Number(state.settings.mosaicTiles ?? 4), 4, 9);
}

function getMosaicItems() {
  return mediaPool(`mosaic:${!!state.settings.mosaicIncludePhotos}`, () => {
    const selected = normalizedFolderSelection("mosaicFolders");
    const videos = (state.library.videos || [])
      .filter((item) => matchesFolderSelection(item, selected))
      .map((item) => ({ ...item, kind: "video" }));
    if (!state.settings.mosaicIncludePhotos) {
      return videos;
    }
    const images = (state.library.images || [])
      .filter((item) => matchesFolderSelection(item, selected))
      .map((item) => ({ ...item, kind: "photo" }));
    return [...videos, ...images];
  });
}

function startMosaic() {
  stopMosaic();
  const items = getMosaicItems();
  const count = mosaicTileCount();
  const columns = count >= 9 ? 3 : count >= 6 ? 3 : 2;
  controls.mosaicStage.style.setProperty("--mosaic-cols", String(columns));
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

function mosaicSwapMs() {
  return clampNumber(Number(state.settings.mosaicSwapSeconds ?? 12), 4, 60) * 1000;
}

function scheduleMosaicSwap(tile) {
  window.clearTimeout(tile.timer);
  if (state.currentMode !== "mosaic") {
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
        playWhenReady(tile.video, token, duration > 4 ? Math.random() * (duration - 2) : 0);
      },
      { once: true }
    );
  }

  tile.element.title = chosen.name;
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

/* ==========================================================================
   Feed — vertical snap scrolling, one clip at a time

   Only the clip in view and its immediate neighbours hold a src; everything
   else is released, so scrolling a long feed does not accumulate decoders.
   ========================================================================== */

const FEED_BATCH = 12;

function getFeedItems() {
  const selected = normalizedFolderSelection("feedFolders");
  const filter = ratingFilterValue("feedRatingFilter");
  return (state.library.videos || []).filter(
    (item) => matchesFolderSelection(item, selected) && matchesRatingFilter(item, filter)
  );
}

function startFeed() {
  observeFeedItems();
  if (!state.feed.items.length || state.feed.dirty) {
    rebuildFeed();
    return;
  }
  activateFeedItem(Math.max(0, state.feed.activeIndex), true);
}

function rebuildFeed() {
  state.feed.items = getFeedItems();
  shuffleArray(state.feed.items);
  state.feed.rendered = 0;
  state.feed.activeIndex = -1;
  state.feed.dirty = false;
  controls.feedScroller.querySelectorAll("video").forEach(releaseVideo);
  controls.feedScroller.innerHTML = "";

  if (!state.feed.items.length) {
    const empty = document.createElement("p");
    empty.className = "feed-empty subtle";
    empty.textContent = "No videos match the feed filter.";
    controls.feedScroller.appendChild(empty);
    return;
  }

  appendFeedBatch();
  controls.feedScroller.scrollTop = 0;
  observeFeedItems();
  // The panel may only just have become visible, so the scroller can still
  // be zero-height this frame. Start the first clip once layout settles.
  window.requestAnimationFrame(() => activateFeedItem(0, true));
}

function pauseFeed() {
  controls.feedScroller.querySelectorAll("video").forEach((video) => video.pause());
  window.cancelAnimationFrame(state.feed.scrollFrame);
  state.feed.scrollFrame = 0;
}

function appendFeedBatch() {
  const template = document.getElementById("feedItemTemplate");
  const fragment = document.createDocumentFragment();
  const end = Math.min(state.feed.rendered + FEED_BATCH, state.feed.items.length);

  for (let index = state.feed.rendered; index < end; index += 1) {
    const item = state.feed.items[index];
    const node = template.content.cloneNode(true);
    const article = node.querySelector(".feed-item");
    article.dataset.index = String(index);
    article.querySelector(".feed-item-name").textContent = item.name;
    article.querySelector(".feed-item-folder").textContent = item.folder || "Library root";

    const video = article.querySelector("video");
    video.dataset.path = item.path;
    video.playsInline = true;
    video.addEventListener("error", () => {
      if (mediaErrorIsFatal(video)) {
        reportBrokenMedia(video.dataset.path);
        state.feed.dirty = true;
      }
    });

    article.querySelector(".feed-keep").addEventListener("click", () => rateFeedItem(index, "like"));
    article.querySelector(".feed-pass").addEventListener("click", () => rateFeedItem(index, "dislike"));
    video.addEventListener("click", () => {
      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });

    fragment.appendChild(node);
  }

  state.feed.rendered = end;
  controls.feedScroller.appendChild(fragment);
}

function observeFeedItems() {
  if (state.feed.scrollBound) {
    return;
  }
  state.feed.scrollBound = true;
  controls.feedScroller.addEventListener("scroll", () => {
    if (state.feed.scrollFrame) {
      return;
    }
    state.feed.scrollFrame = window.requestAnimationFrame(() => {
      state.feed.scrollFrame = 0;
      syncFeedActiveItem();
    });
  });
}

function syncFeedActiveItem() {
  const scroller = controls.feedScroller;
  const height = scroller.clientHeight;
  if (!height) {
    return;
  }
  activateFeedItem(Math.round(scroller.scrollTop / height), false);
}

function activateFeedItem(index, force) {
  if (!Number.isFinite(index) || index < 0) {
    index = 0;
  }
  if (index === state.feed.activeIndex && !force) {
    return;
  }
  state.feed.activeIndex = index;

  controls.feedScroller.querySelectorAll(".feed-item").forEach((article) => {
    const position = Number(article.dataset.index);
    const video = article.querySelector("video");
    const distance = Math.abs(position - index);

    if (distance > 2) {
      video.preload = "none";
      releaseVideo(video);
      return;
    }
    if (!video.getAttribute("src")) {
      const item = state.feed.items[position];
      if (item) {
        video.loop = true;
        video.preload = position === index ? "auto" : "metadata";
        loadVideoSource(video, item);
      }
    }
    if (position === index) {
      video.preload = "auto";
    }
    if (position === index) {
      applyFeedAudio();
      playWhenReady(video, video.dataset.loadToken, null);
    } else {
      video.pause();
    }
  });

  if (index >= state.feed.rendered - 4 && state.feed.rendered < state.feed.items.length) {
    appendFeedBatch();
  }
}

function applyFeedAudio() {
  const volume = clampNumber(Number(state.settings.feedVolume ?? 1), 0, 1);
  controls.feedScroller.querySelectorAll("video").forEach((video) => {
    const active = Number(video.closest(".feed-item")?.dataset.index) === state.feed.activeIndex;
    video.volume = volume;
    video.muted = !active || !state.audioUnlocked || volume === 0;
  });
}

async function rateFeedItem(index, rating) {
  const item = state.feed.items[index];
  if (!item) {
    return;
  }
  try {
    await postJson("/api/rating", { path: item.path, rating });
  } catch (error) {
    console.error(error);
    return;
  }
  item.rating = rating;
  const canonical = (state.library.videos || []).find((entry) => entry.path === item.path);
  if (canonical) {
    canonical.rating = rating;
  }
  syncCountsFromLibrary();

  const article = controls.feedScroller.querySelector(`.feed-item[data-index="${index}"]`);
  if (article) {
    article.dataset.rating = rating;
  }
  scrollFeedTo(index + 1);
}

function scrollFeedTo(index) {
  const article = controls.feedScroller.querySelector(`.feed-item[data-index="${index}"]`);
  if (article) {
    article.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/* ------------------------------------------------------------------------ */

function bindSessionEvents() {
  controls.sessionToggleButton.addEventListener("click", toggleSession);
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

  bindSegmented(controls.galleryRatingFilter, "ratingFilter", (value) => {
    state.settings.galleryRatingFilter = sanitizeRatingFilter(value, false);
    syncSegmented(controls.galleryRatingFilter, "ratingFilter", state.settings.galleryRatingFilter);
    renderGallery(true);
    queueSettingsSave();
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

  bindSegmented(controls.feedRatingFilter, "ratingFilter", (value) => {
    state.settings.feedRatingFilter = sanitizeRatingFilter(value, false);
    syncSegmented(controls.feedRatingFilter, "ratingFilter", state.settings.feedRatingFilter);
    rebuildFeed();
    queueSettingsSave();
  });

  bindRangeSetting(
    controls.feedVolume,
    "feedVolume",
    (value) => `${Math.round(value * 100)}%`,
    applyFeedAudio
  );
}

function sanitizeModeSettings() {
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

  ["session", "gallery", "mosaic", "feed"].forEach((mode) => {
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
  state.settings.feedVolume = clampNumber(Number(state.settings.feedVolume ?? 1), 0, 1);
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

  syncSegmented(controls.feedRatingFilter, "ratingFilter", state.settings.feedRatingFilter);
  setRange("feedVolume", (value) => `${Math.round(value * 100)}%`);
}

function pickWithoutRepeats(items, recentPaths, avoidPath) {
  const recent = new Set(recentPaths || []);
  let candidates = items.filter((item) => !recent.has(item.path) && item.path !== avoidPath);
  if (!candidates.length) {
    candidates = items.filter((item) => item.path !== avoidPath);
  }
  if (!candidates.length) {
    candidates = items;
  }
  return candidates[Math.floor(Math.random() * candidates.length)] || null;
}

function pickRandom(items, avoidPath) {
  if (!items.length) {
    return null;
  }
  if (items.length === 1 || !avoidPath) {
    return items[Math.floor(Math.random() * items.length)];
  }
  let candidate = items[Math.floor(Math.random() * items.length)];
  for (let attempts = 0; attempts < 6 && candidate.path === avoidPath; attempts += 1) {
    candidate = items[Math.floor(Math.random() * items.length)];
  }
  return candidate;
}

function mediaUrl(path) {
  return `/media?path=${encodeURIComponent(path)}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const responsePayload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(responsePayload?.error || `Request failed: ${response.status}`);
  }
  return responsePayload;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return { error: text };
  }
}

function formatTimestamp(value) {
  if (!value) {
    return "just now";
  }
  const date = new Date(value);
  return date.toLocaleString();
}

function setLabel(control, value) {
  control.textContent = value;
  if (value) {
    control.title = value;
  } else {
    control.removeAttribute("title");
  }
}

function setStatus(message) {
  controls.swipeStatus.textContent = message;
  controls.toktinderStatus.textContent = message;
  controls.escalationStatus.textContent = message;
}

function syncLibraryChrome() {
  const setupOpen = !state.libraryReady || state.setupVisible;
  const themeOpen = state.libraryReady && state.themePanelVisible;
  controls.setupPanel.hidden = !setupOpen;
  controls.themePanel.hidden = !themeOpen;
  controls.modeSwitch.hidden = !state.libraryReady;
  controls.mainContent.hidden = !state.libraryReady;
  controls.rescanButton.disabled = !state.libraryReady;
  controls.changeLibraryButton.hidden = !state.libraryReady;
  controls.themeButton.hidden = !state.libraryReady;
  controls.changeLibraryButton.textContent = setupOpen ? "Hide Folder Picker" : "Change Folder";
  controls.themeButton.textContent = themeOpen ? "Hide Hub" : "Hub";
  controls.mediaDirInput.value = state.currentMediaDirectory || "";

  if (state.libraryReady) {
    controls.libraryMeta.textContent = `${state.currentMediaDirectory} | updated ${formatTimestamp(state.library.updatedAt)}`;
    controls.setupMessage.textContent = "Pick a folder path or tap a quick pick to switch libraries.";
    return;
  }

  stopStream();
  stopEscalation();
  pauseAllVideos();
  pauseToktinderVideo();
  if (state.currentMediaDirectory) {
    controls.libraryMeta.textContent = `${state.currentMediaDirectory} | unavailable`;
    controls.setupMessage.textContent =
      "That folder is unavailable right now. Reconnect the drive; it will load automatically. You can also choose another folder.";
  } else {
    controls.libraryMeta.textContent = "No media folder selected yet.";
    controls.setupMessage.textContent =
      "Start the server with python3 server.py, then choose your media folder here.";
  }
}

function renderMediaChoices() {
  controls.mediaDirChoices.innerHTML = "";
  if (!state.mediaChoices.length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "No quick-pick folders detected.";
    controls.mediaDirChoices.appendChild(empty);
    return;
  }

  state.mediaChoices.forEach((path) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button choice-button";
    button.textContent = path;
    button.addEventListener("click", () => {
      controls.mediaDirInput.value = path;
      chooseMediaDirectory(path);
    });
    controls.mediaDirChoices.appendChild(button);
  });
}

async function chooseMediaDirectory(pathValue) {
  const path = pathValue.trim();
  if (!path) {
    controls.setupMessage.textContent = "Enter a media folder path.";
    return;
  }

  try {
    controls.setupMessage.textContent = `Loading ${path}...`;
    await postJson("/api/media-dir", { path });
    state.setupVisible = false;
    await loadState();
  } catch (error) {
    console.error(error);
    controls.setupMessage.textContent = error.message;
  }
}

function renderFolderFilters() {
  FOLDER_MODES.forEach(renderFolderFilter);
}

function renderFolderFilter(mode) {
  const folders = state.library.folders || [];
  const container = controls[`${mode}FolderFilters`];
  const summary = controls[`${mode}FolderSummary`];
  container.innerHTML = "";

  if (!state.libraryReady || !folders.length) {
    summary.textContent = "Using all folders.";
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "No folders found yet.";
    container.appendChild(empty);
    return;
  }

  const selected = normalizedFolderSelection(`${mode}Folders`);
  summary.textContent = selected.length
    ? `Using ${selected.length} of ${folders.length} folders.`
    : `Using all ${folders.length} folders.`;

  folders.forEach((folder) => {
    const label = document.createElement("label");
    label.className = "folder-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !selected.length || selected.includes(folder);
    checkbox.addEventListener("change", () => {
      updateFolderSelection(mode, folder, checkbox.checked);
    });

    const text = document.createElement("span");
    text.textContent = folderLabel(folder);

    label.append(checkbox, text);
    container.appendChild(label);
  });
}

function updateFolderSelection(mode, folder, checked) {
  const settingKey = `${mode}Folders`;
  const folders = state.library.folders || [];
  const current = new Set(normalizedFolderSelection(settingKey).length ? normalizedFolderSelection(settingKey) : folders);

  if (checked) {
    current.add(folder);
  } else {
    current.delete(folder);
  }

  const next = folders.filter((entry) => current.has(entry));
  state.settings[settingKey] =
    next.length === 0 || next.length === folders.length ? [] : next;

  invalidateMediaPools();
  renderFolderFilters();
  refreshMode(mode);
  queueSettingsSave();
}

function normalizedFolderSelection(settingKey) {
  return sanitizeFolderSelection(state.settings[settingKey], state.library.folders || []);
}

function matchesFolderSelection(item, selectedFolders) {
  return !selectedFolders.length || selectedFolders.includes(item.folder || "");
}

let mediaPoolVersion = 0;
const mediaPools = new Map();

function invalidateMediaPools() {
  mediaPoolVersion += 1;
  mediaPools.clear();
}

function mediaPool(key, build) {
  const cached = mediaPools.get(key);
  if (cached && cached.version === mediaPoolVersion) {
    return cached.items;
  }
  const items = build();
  mediaPools.set(key, { version: mediaPoolVersion, items });
  return items;
}

function getStreamImages() {
  return mediaPool("stream:images", () => {
    const selectedFolders = normalizedFolderSelection("streamFolders");
    return (state.library.images || []).filter((item) => matchesFolderSelection(item, selectedFolders));
  });
}

function getStreamVideos() {
  return mediaPool("stream:videos", () => {
    const selectedFolders = normalizedFolderSelection("streamFolders");
    return (state.library.videos || []).filter((item) => matchesFolderSelection(item, selectedFolders));
  });
}

function getEscalationImages() {
  const selectedFolders = normalizedFolderSelection("escalationFolders");
  return (state.library.images || []).filter((item) => matchesFolderSelection(item, selectedFolders));
}

function getEscalationVideos() {
  const selectedFolders = normalizedFolderSelection("escalationFolders");
  return (state.library.videos || []).filter((item) => matchesFolderSelection(item, selectedFolders));
}

function getEscalationMediaItems() {
  return mediaPool("escalation", () => [
    ...getEscalationImages().map((item) => ({ ...item, kind: "photo" })),
    ...getEscalationVideos().map((item) => ({ ...item, kind: "video" })),
  ]);
}

function pickEscalationItem(items) {
  if (!items.length) {
    return null;
  }

  const historyCap = Math.min(Math.max(3, Math.floor(items.length / 3)), 10);
  const recentPaths = state.escalationRecentPaths.slice(-historyCap);
  let candidates = items.filter((item) => !recentPaths.includes(item.path));

  if (!candidates.length) {
    const currentPath = controls.escalationStage?.dataset.path;
    candidates = items.filter((item) => item.path !== currentPath);
  }

  if (!candidates.length) {
    candidates = items;
  }

  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  if (!chosen) {
    return null;
  }

  state.escalationRecentPaths.push(chosen.path);
  if (state.escalationRecentPaths.length > historyCap) {
    state.escalationRecentPaths.splice(0, state.escalationRecentPaths.length - historyCap);
  }
  return chosen;
}

function clampNumber(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function lerp(start, end, progress) {
  return start + (end - start) * progress;
}

function sanitizeTheme(value) {
  return THEMES.has(value) ? value : "velvet";
}

function sanitizeFolderSelection(value, availableFolders) {
  if (!Array.isArray(value) || !availableFolders.length) {
    return [];
  }

  const allowed = new Set(availableFolders);
  const filtered = value.filter((entry) => typeof entry === "string" && allowed.has(entry));
  if (!filtered.length || filtered.length === availableFolders.length) {
    return [];
  }
  return filtered;
}

function folderLabel(folder) {
  return folder || "Library root";
}

function shuffleArray(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
}
