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

document.addEventListener("DOMContentLoaded", () => {
  cacheDom();
  bindEvents();
  loadState().catch((error) => {
    console.error(error);
    controls.libraryMeta.textContent = "Could not load the library.";
    setStatus("Startup failed. Check the server terminal for details.");
  });
});

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
    "unratedOnly",
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
    "toktinderUnratedOnly",
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
  controls.swipeDrawerToggle.addEventListener("click", () => toggleDrawer("swipe"));
  controls.swipeDrawerClose.addEventListener("click", closeDrawers);
  controls.swipeFocusToggle.addEventListener("click", toggleFocusMode);
  controls.toktinderLikeButton.addEventListener("click", () => rateToktinderCurrent("like"));
  controls.toktinderDislikeButton.addEventListener("click", () => rateToktinderCurrent("dislike"));
  controls.toktinderSkipButton.addEventListener("click", skipToktinderCurrent);
  controls.toktinderDrawerToggle.addEventListener("click", () => toggleDrawer("toktinder"));
  controls.toktinderDrawerClose.addEventListener("click", closeDrawers);
  controls.toktinderFocusToggle.addEventListener("click", toggleFocusMode);
  controls.streamDrawerToggle.addEventListener("click", () => toggleDrawer("stream"));
  controls.streamDrawerClose.addEventListener("click", closeDrawers);
  controls.streamFocusToggle.addEventListener("click", toggleFocusMode);
  controls.escalationDrawerToggle.addEventListener("click", () => toggleDrawer("escalation"));
  controls.escalationDrawerClose.addEventListener("click", closeDrawers);
  controls.escalationFocusToggle.addEventListener("click", toggleFocusMode);
  controls.drawerBackdrop.addEventListener("click", closeDrawers);

  controls.unratedOnly.addEventListener("change", async (event) => {
    state.settings.unratedOnly = event.target.checked;
    rebuildSwipeDeck();
    renderSwipe();
    queueSettingsSave();
  });

  controls.swipeFoldersAllButton.addEventListener("click", () => {
    state.settings.swipeFolders = [];
    renderFolderFilters();
    rebuildSwipeDeck();
    renderSwipe();
    queueSettingsSave();
  });

  controls.toktinderUnratedOnly.addEventListener("change", (event) => {
    state.settings.toktinderUnratedOnly = event.target.checked;
    rebuildToktinderDeck();
    renderToktinder();
    queueSettingsSave();
  });

  controls.toktinderFoldersAllButton.addEventListener("click", () => {
    state.settings.toktinderFolders = [];
    renderFolderFilters();
    rebuildToktinderDeck();
    renderToktinder();
    queueSettingsSave();
  });

  controls.streamFoldersAllButton.addEventListener("click", () => {
    state.settings.streamFolders = [];
    renderFolderFilters();
    refreshStreamMedia(true);
    queueSettingsSave();
  });

  controls.escalationFoldersAllButton.addEventListener("click", () => {
    state.settings.escalationFolders = [];
    renderFolderFilters();
    if (state.currentMode === "escalation") {
      startEscalation();
    }
    queueSettingsSave();
  });

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

  controls.audioToggleButton.addEventListener("click", toggleVideoAudio);
  controls.toktinderAudioToggleButton.addEventListener("click", toggleVideoAudio);
  controls.escalationAudioToggleButton.addEventListener("click", toggleVideoAudio);

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
    refreshStreamVideos();
  });

  controls.clipStartSeconds.addEventListener("change", (event) => {
    state.settings.clipStartSeconds = clampNumber(Number(event.target.value), 0, 3600);
    event.target.value = state.settings.clipStartSeconds;
    queueSettingsSave();
    refreshStreamVideos();
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
    if (state.currentMode === "toktinder") {
      playToktinderVideo();
    }
  });
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
      stopStream();
      stopEscalation();
      pauseAllVideos();
      pauseToktinderVideo();
    } else if (state.currentMode === "stream") {
      startStream();
      playAllVideos();
    } else if (state.currentMode === "escalation") {
      startEscalation();
    } else if (state.currentMode === "toktinder") {
      playToktinderVideo();
    }
  });

  syncFocusMode();
}

function bindRangeSetting(element, settingKey, formatValue) {
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
      refreshStreamVideos();
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
  state.settings.toktinderUnratedOnly = !!state.settings.toktinderUnratedOnly;
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
  if (state.currentMode === "escalation") {
    startEscalation();
  } else {
    clearEscalationMedia();
    renderEscalationIdle();
  }
}

function syncCounts() {
  const counts = state.libraryReady ? state.library.counts || {} : {};
  controls.imageCount.textContent = `${counts.images || 0} images`;
  controls.videoCount.textContent = `${counts.videos || 0} videos`;
  controls.ratingCount.textContent = `${counts.liked || 0} liked`;
}

function syncControls() {
  controls.unratedOnly.checked = !!state.settings.unratedOnly;
  controls.toktinderUnratedOnly.checked = !!state.settings.toktinderUnratedOnly;
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
      unratedKey: "unratedOnly",
      mediaType: "image",
      emptyTitle: "No photos match the current filter",
      emptyStatus: "Try changing the folder filter, turning off unrated-only, or rescanning.",
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
      unratedKey: "toktinderUnratedOnly",
      mediaType: "video",
      emptyTitle: "No videos match the current filter",
      emptyStatus: "Try changing the folder filter, turning off unrated-only, or rescanning.",
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

  const selectedFolders = normalizedFolderSelection(config.foldersKey);
  const allItems = state.library[config.sourceKey] || [];
  state[config.itemsKey] = allItems.filter((item) => {
    if (!matchesFolderSelection(item, selectedFolders)) {
      return false;
    }
    if (!state.settings[config.unratedKey]) {
      return true;
    }
    return !item.rating;
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
    controls[config.nameControl].textContent = config.emptyTitle;
    controls[config.folderControl].textContent = "";
    controls[config.statusControl].textContent = config.emptyStatus;
    return;
  }

  setDeckMedia(mode, item);
  controls[config.nameControl].textContent = item.name;
  controls[config.folderControl].textContent = item.folder || "Library root";
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

  const canonicalItem = (state.library[config.sourceKey] || []).find((entry) => entry.path === item.path);
  if (canonicalItem) {
    canonicalItem.rating = rating;
  }

  if (state.settings[config.unratedKey]) {
    state[config.itemsKey].splice(state[config.indexKey], 1);
    if (state[config.indexKey] >= state[config.itemsKey].length) {
      state[config.indexKey] = 0;
    }
  } else if (state[config.itemsKey].length > 1) {
    state[config.indexKey] = (state[config.indexKey] + 1) % state[config.itemsKey].length;
  }

  syncCountsFromLibrary();
  renderDeck(mode);
}

function skipDeckItem(mode) {
  const config = deckConfig(mode);
  if (!config || !state[config.itemsKey].length) {
    return;
  }
  state[config.indexKey] = (state[config.indexKey] + 1) % state[config.itemsKey].length;
  renderDeck(mode);
}

function setDeckMedia(mode, item) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  if (config.mediaType === "image") {
    controls[config.mediaControl].src = mediaUrl(item.path);
    controls[config.mediaControl].alt = item.name;
    return;
  }

  controls.toktinderVideo.pause();
  clearToktinderVideoShape();
  controls.toktinderVideo.dataset.path = item.path;
  controls.toktinderVideo.src = mediaUrl(item.path);
  controls.toktinderVideo.loop = true;
  controls.toktinderVideo.playsInline = true;
  applyToktinderAudio();
  controls.toktinderVideo.load();
  if (state.currentMode === "toktinder" && !document.hidden) {
    playToktinderVideo();
  }
}

function clearDeckMedia(mode) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  if (config.mediaType === "image") {
    controls[config.mediaControl].removeAttribute("src");
    controls[config.mediaControl].alt = "";
    return;
  }

  pauseToktinderVideo();
  clearToktinderVideoShape();
  controls.toktinderVideo.removeAttribute("src");
  controls.toktinderVideo.removeAttribute("data-path");
  controls.toktinderVideo.load();
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
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  document.querySelectorAll(".mode-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${mode}Mode`);
  });

  if (mode === "stream") {
    stopEscalation();
    startStream();
    pauseToktinderVideo();
    playAllVideos();
  } else if (mode === "escalation") {
    stopStream();
    pauseAllVideos();
    pauseToktinderVideo();
    startEscalation();
  } else if (mode === "toktinder") {
    stopStream();
    stopEscalation();
    pauseAllVideos();
    playToktinderVideo();
  } else {
    stopStream();
    stopEscalation();
    pauseAllVideos();
    pauseToktinderVideo();
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
  controls.swipeFocusToggle.textContent = label;
  controls.toktinderFocusToggle.textContent = label;
  controls.streamFocusToggle.textContent = label;
  controls.escalationFocusToggle.textContent = label;
  controls.swipeFocusToggle.classList.toggle("active", state.focusMode);
  controls.toktinderFocusToggle.classList.toggle("active", state.focusMode);
  controls.streamFocusToggle.classList.toggle("active", state.focusMode);
  controls.escalationFocusToggle.classList.toggle("active", state.focusMode);
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
  const swipeOpen = state.activeDrawer === "swipe";
  const toktinderOpen = state.activeDrawer === "toktinder";
  const streamOpen = state.activeDrawer === "stream";
  const escalationOpen = state.activeDrawer === "escalation";

  controls.swipeDrawer.classList.toggle("open", swipeOpen);
  controls.swipeDrawer.setAttribute("aria-hidden", String(!swipeOpen));
  controls.swipeDrawerToggle.classList.toggle("active", swipeOpen);

  controls.toktinderDrawer.classList.toggle("open", toktinderOpen);
  controls.toktinderDrawer.setAttribute("aria-hidden", String(!toktinderOpen));
  controls.toktinderDrawerToggle.classList.toggle("active", toktinderOpen);

  controls.streamDrawer.classList.toggle("open", streamOpen);
  controls.streamDrawer.setAttribute("aria-hidden", String(!streamOpen));
  controls.streamDrawerToggle.classList.toggle("active", streamOpen);

  controls.escalationDrawer.classList.toggle("open", escalationOpen);
  controls.escalationDrawer.setAttribute("aria-hidden", String(!escalationOpen));
  controls.escalationDrawerToggle.classList.toggle("active", escalationOpen);

  const drawerOpen = swipeOpen || toktinderOpen || streamOpen || escalationOpen;
  controls.drawerBackdrop.hidden = !drawerOpen;
  controls.drawerBackdrop.classList.toggle("open", drawerOpen);
  document.body.classList.toggle("drawer-open", drawerOpen);
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
  controls.escalationName.textContent = "Waiting for media";
  controls.escalationFolder.textContent = "";
  controls.escalationStatus.textContent = "Building pressure...";
  controls.escalationPhaseBadge.textContent = "Warmup";
  controls.escalationTelemetry.textContent = "Swap 12.0s • 1.0x";
}

function refreshEscalationMedia(force) {
  const mediaItems = getEscalationMediaItems();

  if (!mediaItems.length) {
    clearEscalationMedia();
    controls.escalationName.textContent = "No escalation media available";
    controls.escalationFolder.textContent = "";
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

  pauseEscalationVideo();
  controls.escalationVideo.removeAttribute("src");
  controls.escalationVideo.removeAttribute("data-path");
  controls.escalationVideo.playbackRate = 1;
  controls.escalationVideo.load();

  controls.escalationStage.dataset.activeKind = "photo";
  controls.escalationStage.dataset.path = item.path;
  controls.escalationPhoto.dataset.path = item.path;
  controls.escalationPhoto.src = mediaUrl(item.path);
  controls.escalationPhoto.alt = item.name;
  controls.escalationName.textContent = item.name;
  controls.escalationFolder.textContent = item.folder || "Library root";
}

function loadEscalationVideoClip(chosen) {
  const video = controls.escalationVideo;
  if (!chosen) {
    if (state.escalationBurstTimer) {
      window.clearInterval(state.escalationBurstTimer);
      state.escalationBurstTimer = null;
    }
    pauseEscalationVideo();
    video.removeAttribute("src");
    video.removeAttribute("data-path");
    video.playbackRate = 1;
    video.load();
    return;
  }

  if (state.escalationBurstTimer) {
    window.clearInterval(state.escalationBurstTimer);
    state.escalationBurstTimer = null;
  }

  pauseEscalationVideo();
  controls.escalationStage.dataset.activeKind = "video";
  controls.escalationStage.dataset.path = chosen.path;
  controls.escalationPhoto.removeAttribute("src");
  controls.escalationPhoto.removeAttribute("data-path");
  controls.escalationPhoto.alt = "";
  video.dataset.path = chosen.path;
  video.src = mediaUrl(chosen.path);
  video.loop = false;
  video.playsInline = true;
  applyEscalationAudio();
  video.load();

  controls.escalationName.textContent = chosen.name;
  controls.escalationFolder.textContent = chosen.folder || "Library root";
}

function configureEscalationVideo() {
  if (state.currentMode !== "escalation" || !controls.escalationVideo.src) {
    return;
  }

  const video = controls.escalationVideo;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const progress = getEscalationProgress();
  const speed = currentEscalationSpeed(progress);
  const hotStart =
    duration > 0
      ? duration * (0.35 + Math.random() * 0.5)
      : 0;

  try {
    video.currentTime = clampNumber(hotStart, 0, Math.max(0, duration - 0.4));
  } catch (error) {
    console.error(error);
  }

  video.playbackRate = speed;
  applyEscalationAudio();
  restartEscalationBurst(duration, progress);
  updateEscalationTelemetry(progress);
  playEscalationVideo();
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
  controls.escalationVideo.removeAttribute("src");
  controls.escalationVideo.removeAttribute("data-path");
  controls.escalationVideo.playbackRate = 1;
  controls.escalationVideo.load();
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
    controls.streamPhotoName.textContent = "No stream photo available";
    controls.streamPhotoFolder.textContent = "";
    return;
  }
  const item = pickRandom(images, controls.streamPhoto.dataset.path);
  if (!item) {
    return;
  }
  controls.streamPhoto.dataset.path = item.path;
  controls.streamPhoto.src = mediaUrl(item.path);
  controls.streamPhoto.alt = item.name;
  controls.streamPhotoName.textContent = item.name;
  controls.streamPhotoFolder.textContent = item.folder || "Library root";
}

function refreshStreamVideos() {
  const overlay = controls.videoOverlay;
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
      mountedVideo.currentTime = Number.isFinite(start) ? start : 0;
      mountedVideo.play().catch(() => {});
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
    video.removeAttribute("src");
    return;
  }
  const chosen = pickRandom(videos, video.dataset.path);
  if (!chosen) {
    return;
  }
  video.dataset.path = chosen.path;
  video.src = mediaUrl(chosen.path);
  video.loop = false;
  video.playsInline = true;
  video.muted = !state.audioUnlocked || Number(state.settings.videoVolume) === 0;
  video.load();
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
  controls.audioToggleButton.textContent = label;
  controls.audioHint.textContent = hint;
  controls.toktinderAudioToggleButton.textContent = label;
  controls.toktinderAudioHint.textContent = hint;
  controls.escalationAudioToggleButton.textContent = label;
  controls.escalationAudioHint.textContent = hint;
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
      "That folder is unavailable right now. Reconnect the drive or choose another folder.";
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
  renderFolderFilter("swipe");
  renderFolderFilter("toktinder");
  renderFolderFilter("stream");
  renderFolderFilter("escalation");
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

  renderFolderFilters();
  if (mode === "swipe") {
    rebuildSwipeDeck();
    renderSwipe();
  } else if (mode === "toktinder") {
    rebuildToktinderDeck();
    renderToktinder();
  } else if (mode === "escalation") {
    if (state.currentMode === "escalation") {
      startEscalation();
    } else {
      renderEscalationIdle();
    }
  } else {
    refreshStreamMedia(true);
  }
  queueSettingsSave();
}

function normalizedFolderSelection(settingKey) {
  return sanitizeFolderSelection(state.settings[settingKey], state.library.folders || []);
}

function matchesFolderSelection(item, selectedFolders) {
  return !selectedFolders.length || selectedFolders.includes(item.folder || "");
}

function getStreamImages() {
  const selectedFolders = normalizedFolderSelection("streamFolders");
  return (state.library.images || []).filter((item) => matchesFolderSelection(item, selectedFolders));
}

function getStreamVideos() {
  const selectedFolders = normalizedFolderSelection("streamFolders");
  return (state.library.videos || []).filter((item) => matchesFolderSelection(item, selectedFolders));
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
  return [
    ...getEscalationImages().map((item) => ({ ...item, kind: "photo" })),
    ...getEscalationVideos().map((item) => ({ ...item, kind: "video" })),
  ];
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
