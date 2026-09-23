const state = {
  library: { images: [], videos: [], counts: {} },
  settings: {},
  swipeItems: [],
  swipeIndex: 0,
  toktinderItems: [],
  toktinderIndex: 0,
  cornerSlots: [],
  cornerRebuildTimer: null,
  escalationTimer: null,
  escalationBurstTimer: null,
  escalationRecentPaths: [],
  escalationSessionStartedAt: 0,
  escalationCurrentIntervalMs: 0,
  currentMode: "home",
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
  librarySignature: "",
  modeRestored: false,
  // Per-mode "I unticked everything" flag; see setFolderSelection.
  folderCleared: {},
  gallery: {
    items: [],
    page: 0,
    search: "",
    searchTimer: null,
    observer: null,
    sizeObserver: null,
    lightboxIndex: -1,
  },
  ranked: { observer: null },
  launcherOpen: false,
  drawerTabs: {},
  // Folder picker view state, per mode: which groups are open, and the sort.
  folderView: {},
  mosaic: { tiles: [], audioIndex: 0, paused: false },
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
  { value: "dark", label: "Tidal", note: "Deep blue, mint", swatch: ["#0b131a", "#172631", "#9fe7c8"] },
  { value: "velvet", label: "Velvet", note: "Warm black, rose", swatch: ["#110c11", "#221822", "#ff9ab6"] },
  { value: "light", label: "Fern", note: "Soft green, light", swatch: ["#eef3f0", "#fbfdfc", "#1f5f4e"] },
];
const THEMES = new Set(THEME_OPTIONS.map((theme) => theme.value));

// Older palette names map onto the three current ones. Saved state keeps
// working; anything unrecognised lands on dark, which is what the app opens as.
const LEGACY_THEMES = {
  ember: "velvet",
  afterglow: "velvet",
  paper: "light",
  sage: "light",
  slate: "light",
};

// Every mode that owns a control center, and every mode whose stage can go
// full-bleed. Gallery has no focus mode: it is a browsing grid, not a stage.
const DRAWER_MODES = [
  "swipe",
  "toktinder",
  "escalation",
  "session",
  "gallery",
  "mosaic",
  "feed",
  "dangerous",
  "duel",
  "rediscover",
];
const FOCUS_MODES = ["swipe", "toktinder", "escalation", "session", "mosaic", "feed", "dangerous", "duel", "rediscover"];
const FOLDER_MODES = DRAWER_MODES;
// Modes whose control center has an All / Unrated / Liked "Show" filter.
const RATING_FILTER_MODES = ["swipe", "toktinder", "escalation", "session", "gallery", "mosaic", "feed", "duel", "rediscover"];
// Tab-bar order, and what the number keys map to. Ranked sits with Gallery as
// a browsing page: no drawer, no folder filter, no focus stage.
// Number-key order (1–9, then 0). Dangerous deletes files, so it has no key.
const ALL_MODES = [
  "swipe",
  "toktinder",
  "feed",
  "rediscover",
  "duel",
  "escalation",
  "mosaic",
  "session",
  "gallery",
  "ranked",
  "dangerous",
];

document.addEventListener("DOMContentLoaded", () => {
  mountControlCenters();
  cacheDom();
  bindEvents();
  initWorkspace();
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

/* Each control center gets a Tune / Folders tab pair and its own copy of the
   folder picker. Built before cacheDom() so the per-mode ids are there to
   cache. */
function mountControlCenters() {
  const template = document.getElementById("folderPickerTemplate");
  document.querySelectorAll(".drawer[data-mode]").forEach((drawer) => {
    const mode = drawer.dataset.mode;
    const picker = template.content.firstElementChild.cloneNode(true);
    picker.querySelectorAll("[data-fp-id]").forEach((node) => {
      node.id = `${mode}${node.dataset.fpId}`;
    });
    picker.id = `${mode}FolderPanel`;
    drawer.querySelector(".drawer-footer").before(picker);

    const tune = drawer.querySelector('[data-panel="tune"]');
    tune.id = `${mode}TunePanel`;
    const tabs = document.createElement("div");
    tabs.className = "drawer-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.innerHTML = `
      <button type="button" class="drawer-tab" role="tab" data-tab="tune" aria-selected="true" aria-controls="${mode}TunePanel"><svg aria-hidden="true"><use href="#i-adjust"/></svg>Tune</button>
      <button type="button" class="drawer-tab" role="tab" data-tab="folders" aria-selected="false" aria-controls="${mode}FolderPanel"><svg aria-hidden="true"><use href="#i-folder"/></svg>Folders <span class="tab-badge" id="${mode}FolderBadge">All</span></button>`;
    drawer.querySelector(".drawer-header").after(tabs);
    tabs.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-tab]");
      if (tab) {
        showDrawerTab(mode, tab.dataset.tab);
      }
    });
  });
}

function showDrawerTab(mode, name) {
  const drawer = document.getElementById(`${mode}Drawer`);
  if (!drawer) {
    return;
  }
  state.drawerTabs[mode] = name;
  drawer.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  });
  drawer.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  if (name === "folders") {
    renderFolderFilter(mode);
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
    "hubLibraryPath",
    "hubCloseButton",
    "setupCloseButton",
    "themeChoices",
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
    "balancedFolders",
    "balancedFoldersHint",
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
    "videoOverlay",
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
    "escalationRampToggle",
    "escalationRampControls",
    "escalationBaseIntervalLabel",
    "escalationCorners",
    "escalationCornersValue",
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
    "modeMenuButton",
    "modeMenuLabel",
    "modeLauncher",
    "launcherGrid",
    "launcherMeta",
    "launcherClose",
    "rankedScroller",
    "rankedStats",
    "rankedFolders",
    "rankedFolderNote",
    "rankedGrid",
    "rankedEmpty",
    "rankedKind",
    "rankedSort",
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
    "feedAutoAdvance",
    "mosaicPauseButton",
    "mosaicSwapAllButton",
    "mosaicRebuildButton",
    "drawerBackdrop",
    "sessionEdgeButton",
    "sessionEdges",
    "sessionHudStart",
    "escalationProgressFill",
    "galleryQuickFilter",
    "galleryDoneButton",
    "lightboxCount",
    "rankedPlay",
    "modeTools",
  ]
    // Every control center has the same folder picker and frame; listing
    // them by hand is just a place for typos to hide.
    .concat(
      FOLDER_MODES.flatMap((mode) => [
        `${mode}Drawer`,
        `${mode}DrawerToggle`,
        `${mode}DrawerClose`,
        `${mode}FoldersAllButton`,
        `${mode}FoldersNoneButton`,
        `${mode}FoldersSyncButton`,
        `${mode}FolderSearch`,
        `${mode}FolderSummary`,
        `${mode}FolderFilters`,
        `${mode}Summary`,
        `${mode}Preset`,
        `${mode}ResetSettingsButton`,
      ]),
      FOCUS_MODES.map((mode) => `${mode}FocusToggle`),
      RATING_FILTER_MODES.map((mode) => `${mode}RatingFilter`)
    )
    .forEach((id) => {
      controls[id] = document.getElementById(id);
    });
}

function bindEvents() {
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

  // The folder picker and the hub used to be dismissed by re-tapping the
  // topbar button that opened them. That button now lives inside the hub, so
  // each panel closes itself.
  controls.setupCloseButton.addEventListener("click", () => {
    state.setupVisible = false;
    syncLibraryChrome();
  });

  controls.hubCloseButton.addEventListener("click", () => {
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
    controls[`${mode}FoldersAllButton`].addEventListener("click", () => setFolderSelection(mode, true));
    controls[`${mode}FoldersNoneButton`].addEventListener("click", () => setFolderSelection(mode, false));
    controls[`${mode}FoldersSyncButton`].addEventListener("click", () => syncFolderSelectionEverywhere(mode));

    bindFolderPicker(mode);
    const search = controls[`${mode}FolderSearch`];
    let searchTimer = 0;
    search.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => renderFolderFilter(mode), 120);
    });
    // A search box inside a form-less panel still submits on Enter in some
    // browsers, which closes the drawer. It has already filtered as you type.
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
      }
    });
  });
  controls.toktinderLikeButton.addEventListener("click", () => rateToktinderCurrent("like"));
  controls.toktinderDislikeButton.addEventListener("click", () => rateToktinderCurrent("dislike"));
  controls.toktinderSkipButton.addEventListener("click", skipToktinderCurrent);
  controls.drawerBackdrop.addEventListener("click", closeDrawers);

  RATING_FILTER_MODES.forEach(bindRatingFilter);
  bindSegmented(controls.galleryQuickFilter, "ratingFilter", (value) => setRatingFilter("gallery", value));
  bindControlCenterChrome();
  bindSessionEvents();
  bindGalleryEvents();
  bindMosaicEvents();
  bindFeedEvents();
  bindRankedEvents();
  bindModeLauncher();
  bindDrawerControls();
  controls.swipeUndoButton.addEventListener("click", () => undoLastAction("swipe"));
  controls.toktinderUndoButton.addEventListener("click", () => undoLastAction("toktinder"));
  controls.clearBrokenButton.addEventListener("click", clearBrokenFiles);

  bindSegmented(controls.balancedFolders, "balanced", (value) => {
    state.settings.balancedFolders = value === "balanced";
    syncBalancedFolders();
    invalidateMediaPools();
    // Reshuffle what is on screen so the change is visible straight away
    // rather than at the next deck rebuild.
    reshuffleEverything();
    queueSettingsSave();
  });

  controls.shuffleButton.addEventListener("click", () => {
    shuffleBalanced(state.swipeItems);
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

  [
    "toktinderAudioToggleButton",
    "escalationAudioToggleButton",
    "sessionAudioToggleButton",
    "mosaicAudioToggleButton",
    "feedAudioToggleButton",
  ].forEach((key) => controls[key].addEventListener("click", toggleVideoAudio));

  controls.toktinderShuffleButton.addEventListener("click", () => {
    shuffleBalanced(state.toktinderItems);
    state.toktinderIndex = 0;
    renderToktinder();
  });

  bindRangeSetting(controls.escalationCorners, "escalationCorners", (value) => `${value}`);
  controls.escalationRampToggle.addEventListener("click", () => {
    state.settings.escalationRamp = state.settings.escalationRamp === false;
    afterModeSettingsChange("escalation");
  });
  bindRangeSetting(controls.escalationBaseInterval, "escalationBaseInterval", (value) => `${value}s`);
  bindRangeSetting(controls.escalationMinInterval, "escalationMinInterval", (value) => `${value}s`);
  bindRangeSetting(controls.escalationRampSeconds, "escalationRampSeconds", (value) => `${value}s`);
  bindRangeSetting(controls.escalationMaxSpeed, "escalationMaxSpeed", (value) => `${Number(value).toFixed(1)}x`);
  bindRangeSetting(
    controls.escalationVideoVolume,
    "escalationVideoVolume",
    (value) => `${Math.round(value * 100)}%`
  );

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

  window.addEventListener("keydown", handleKeydown);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      quietAllModes();
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

function isTyping() {
  const active = document.activeElement;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(active?.tagName || "") && active.type !== "range";
}

function modeForDigit(key) {
  return ALL_MODES[key === "0" ? 9 : Number(key) - 1];
}

// One keyboard map for the whole app. Order matters: overlays first, then the
// control center, then global keys, then whatever the active mode does.
function handleKeydown(event) {
  const key = event.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const modifier = event.ctrlKey || event.metaKey || event.altKey;
  const typing = isTyping();

  if (state.launcherOpen) {
    if (key === "Escape") {
      event.preventDefault();
      closeModeLauncher();
    } else if (/^[0-9]$/.test(key) && !typing && modeForDigit(key)) {
      event.preventDefault();
      setMode(modeForDigit(key));
      closeModeLauncher();
    }
    return;
  }

  if (!controls.galleryLightbox.hidden) {
    if (key === "Escape") {
      closeLightbox();
    } else if (key === "ArrowLeft") {
      stepLightbox(-1);
    } else if (key === "ArrowRight") {
      stepLightbox(1);
    }
    return;
  }

  if (key === "Escape" && state.activeDrawer) {
    closeDrawers();
    return;
  }
  if (state.themePanelVisible || state.setupVisible) {
    if (key === "Escape") {
      state.themePanelVisible = false;
      state.setupVisible = false;
      syncLibraryChrome();
      controls.themeButton.focus();
    }
    return;
  }
  if (!state.libraryReady || modifier || typing) {
    return;
  }
  // A docked control center sits beside the stage, so the stage keeps its
  // keys. An overlaid one (phone, tablet) owns the keyboard until closed.
  if (state.activeDrawer && !drawerIsDocked()) {
    return;
  }
  // Arrow keys on a focused slider or list move the slider, not the deck.
  if (key.startsWith("Arrow") && document.activeElement?.matches?.('input[type="range"], select')) {
    return;
  }

  if (lower === "m") {
    event.preventDefault();
    toggleModeLauncher();
    return;
  }
  if (lower === "a" && DRAWER_MODES.includes(state.currentMode)) {
    event.preventDefault();
    toggleDrawer(state.currentMode);
    return;
  }
  if (key === "Escape" && state.focusMode) {
    setFocusMode(false);
    return;
  }
  if (/^[0-9]$/.test(key)) {
    if (modeForDigit(key)) {
      event.preventDefault();
      setMode(modeForDigit(key));
    }
    return;
  }
  if (lower === "f") {
    event.preventDefault();
    toggleFocusMode();
    return;
  }

  const mode = state.currentMode;
  if (mode === "feed") {
    const actions = {
      ArrowDown: () => scrollFeedTo(state.feed.activeIndex + 1),
      j: () => scrollFeedTo(state.feed.activeIndex + 1),
      ArrowUp: () => scrollFeedTo(Math.max(0, state.feed.activeIndex - 1)),
      k: () => scrollFeedTo(Math.max(0, state.feed.activeIndex - 1)),
      ArrowRight: () => rateFeedItem(state.feed.activeIndex, "like"),
      ArrowLeft: () => rateFeedItem(state.feed.activeIndex, "dislike"),
      " ": toggleFeedPlayback,
    };
    if (actions[lower]) {
      event.preventDefault();
      actions[lower]();
    }
    return;
  }
  if (mode === "session") {
    if (key === " ") {
      event.preventDefault();
      toggleSession();
    } else if (lower === "e") {
      event.preventDefault();
      edgeSession();
    }
    return;
  }
  if (mode === "mosaic" && key === " ") {
    event.preventDefault();
    toggleMosaicPause();
    return;
  }
  if (mode === "duel") {
    const action = { ArrowLeft: () => pickDuelWinner(0), ArrowRight: () => pickDuelWinner(1), ArrowDown: nextDuel, u: undoDuel }[lower];
    if (action) {
      event.preventDefault();
      action();
    }
    return;
  }
  if (mode === "rediscover") {
    const action = { ArrowLeft: "pass", ArrowRight: "keep", ArrowDown: "skip" }[key];
    if (action) {
      event.preventDefault();
      actRediscover(action);
    } else if (lower === "u") {
      event.preventDefault();
      undoRediscover();
    } else if (key === " ") {
      event.preventDefault();
      const video = document.getElementById("rediscoverVideo");
      if (!video.hidden) video.paused ? video.play().catch(() => {}) : video.pause();
    }
    return;
  }
  if (mode === "dangerous") {
    const action = { ArrowLeft: "delete", ArrowRight: "keep", ArrowDown: "skip" }[key];
    if (action) {
      event.preventDefault();
      actDangerous(action);
    } else if (lower === "u") {
      event.preventDefault();
      undoDangerous();
    }
    return;
  }
  if (!isDeckMode(mode)) {
    return;
  }
  if (lower === "u") {
    event.preventDefault();
    undoLastAction(mode);
    return;
  }
  if (mode === "toktinder" && key === " ") {
    event.preventDefault();
    toggleToktinderPlayback();
    return;
  }
  if (key === "ArrowLeft") {
    event.preventDefault();
    rateDeckItem(mode, "dislike");
  } else if (key === "ArrowRight") {
    event.preventDefault();
    rateDeckItem(mode, "like");
  } else if (key === "ArrowDown") {
    event.preventDefault();
    skipDeckItem(mode);
  }
}

function bindRangeSetting(element, settingKey, formatValue, onChange) {
  const output = controls[`${element.id}Value`];
  const handler = (event) => {
    const raw = event.target.value;
    const value = element.step && element.step.includes(".") ? Number(raw) : parseInt(raw, 10);
    state.settings[settingKey] = value;
    output.textContent = formatValue(value);
    queueSettingsSave();

    if (settingKey === "escalationCorners") {
      queueCornerRefresh();
      return;
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

// `rebuild: true` says the caller deliberately changed the library (rescan,
// folder switch, ratings reset), so every deck may be thrown away. The
// five-second connection poll calls loadState() without it: a drive that
// re-mounts re-scans and lands here, and reshuffling the deck or the feed
// underneath someone mid-browse is not a refresh, it is losing their place.
async function loadState({ rebuild = false } = {}) {
  const payload = await fetchJson("/api/state");
  state.library = payload.library || { images: [], videos: [], folders: [], counts: {} };
  hydrateLibraryNames(state.library);
  state.libraryReady = !!payload.libraryReady;
  state.canTrash = !!payload.canTrash;
  state.mediaChoices = Array.isArray(payload.mediaChoices) ? payload.mediaChoices : [];
  state.currentMediaDirectory = payload.mediaDirectory || "";
  state.settings = { ...payload.settings };
  state.settings.escalationCorners = clampNumber(Number(state.settings.escalationCorners ?? 0), 0, 2);
  state.settings.escalationRamp = state.settings.escalationRamp !== false;
  // Stream was folded into Escalation (Steady preset + corner clips).
  if (state.settings.lastMode === "stream") state.settings.lastMode = "escalation";
  state.settings.theme = sanitizeTheme(state.settings.theme);
  state.settings.swipeFolders = sanitizeFolderSelection(state.settings.swipeFolders, state.library.folders || []);
  state.settings.toktinderFolders = sanitizeFolderSelection(
    state.settings.toktinderFolders,
    state.library.folders || []
  );
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
  state.settings.escalationBaseInterval = clampNumber(Number(state.settings.escalationBaseInterval ?? 12), 3, 60);
  state.settings.escalationMinInterval = clampNumber(Number(state.settings.escalationMinInterval ?? 2), 1, 8);
  state.settings.escalationRampSeconds = clampNumber(Number(state.settings.escalationRampSeconds ?? 90), 20, 240);
  state.settings.escalationMaxSpeed = clampNumber(Number(state.settings.escalationMaxSpeed ?? 2.2), 1, 3);
  state.settings.escalationVideoVolume = clampNumber(Number(state.settings.escalationVideoVolume ?? 0.32), 0, 1);

  const signature = librarySignature();
  const libraryChanged = rebuild || signature !== state.librarySignature;
  state.librarySignature = signature;

  // Overview is the entrance; Continue keeps the last media mode one tap away.
  const restoreMode = null;
  state.modeRestored = true;

  renderThemeChoices();
  syncLibraryChrome();
  syncCounts();
  syncControls();
  renderMediaChoices();
  renderFolderFilters();
  applyTheme();
  syncAudioButton();
  if (libraryChanged || !state.swipeItems.length) {
    rebuildSwipeDeck();
  }
  if (state.currentMode === "swipe" && !restoreMode) renderSwipe();
  if (libraryChanged || !state.toktinderItems.length) {
    rebuildToktinderDeck();
  }
  if (state.currentMode === "toktinder" && !restoreMode) renderToktinder();
  if (libraryChanged) {
    state.feed.dirty = true;
  }

  if (state.currentMode === "escalation") {
    if (libraryChanged) {
      startEscalation();
    }
  } else {
    clearEscalationMedia();
    renderEscalationIdle();
  }

  if (state.currentMode === "gallery") {
    renderGallery(libraryChanged);
  } else if (state.currentMode === "ranked") {
    renderRanked();
  } else if (state.currentMode === "feed") {
    // startFeed() rebuilds only when the feed is dirty, otherwise it just
    // re-arms the clip already on screen.
    startFeed();
  } else if (state.currentMode === "mosaic") {
    if (libraryChanged || !state.mosaic.tiles.length) {
      startMosaic();
    }
  } else if (state.currentMode === "session") {
    refreshSessionMedia(libraryChanged);
  }

  if (restoreMode) {
    setMode(restoreMode);
  }
  syncWorkspace();
  if (state.currentMode === "dangerous" && !restoreMode) startDangerous(libraryChanged);
}

// The server stops sending `name` because it is always the tail of `path`,
// and repeating a 130-character hash filename 13,000 times was most of the
// payload. Putting it back here costs a few milliseconds and keeps every
// `item.name` in the rest of the app working untouched.
function hydrateLibraryNames(library) {
  for (const key of ["images", "videos"]) {
    const items = library[key];
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (item.name === undefined) {
        const cut = item.path.lastIndexOf("/");
        item.name = cut === -1 ? item.path : item.path.slice(cut + 1);
      }
      if (item.rating === undefined) {
        item.rating = null;
      }
    }
  }
}

// A cheap content fingerprint of the catalog. A rescan always stamps a new
// `updatedAt`, so that timestamp cannot tell "the drive came back with the
// same files" apart from "the files changed"; the paths can.
function librarySignature() {
  let hash = 5381;
  let count = 0;
  for (const key of ["images", "videos"]) {
    for (const item of state.library[key] || []) {
      count += 1;
      const path = item.path;
      for (let index = 0; index < path.length; index += 1) {
        hash = ((hash * 33) ^ path.charCodeAt(index)) >>> 0;
      }
    }
  }
  return `${count}:${hash}`;
}

function syncCounts() {
  const counts = state.libraryReady ? state.library.counts || {} : {};
  const format = (value) => Number(value || 0).toLocaleString();
  controls.imageCount.textContent = format(counts.images);
  controls.videoCount.textContent = format(counts.videos);
  controls.ratingCount.textContent = format(counts.liked);
}

function syncControls() {
  syncDrawerSummaries();
  RATING_FILTER_MODES.forEach(syncRatingFilter);
  syncBalancedFolders();
  syncModeControls();
  syncUndoButtons();
  syncBrokenSummary();
  syncThemeControls();
  controls.escalationCorners.value = String(state.settings.escalationCorners ?? 0);
  controls.escalationCornersValue.textContent = controls.escalationCorners.value;
  const ramp = state.settings.escalationRamp !== false;
  controls.escalationRampToggle.setAttribute("aria-checked", String(ramp));
  controls.escalationRampControls.hidden = !ramp;
  controls.escalationBaseIntervalLabel.textContent = ramp ? "Starts swapping every" : "Swap every";
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
  shuffleBalanced(state[config.itemsKey]);
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
  if (state.currentMode !== mode) return;
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
  markSeen(item.path);
  syncDrawerSummaries();
  setLabel(controls[config.nameControl], item.name);
  setLabel(controls[config.folderControl], item.folder || "Library root");
  controls[config.statusControl].textContent =
    `${state[config.indexKey] + 1} / ${state[config.itemsKey].length} in current deck`;
}

// Optimistic: the card leaves at once and the save happens behind it. Over
// Tailscale the round trip is long enough to feel, and a failure is rare --
// when it happens the card comes back and says so.
async function rateDeckItem(mode, rating) {
  flushDeckAnimation(mode);
  const config = deckConfig(mode);
  const item = currentDeckItem(mode);
  if (!config || !item) {
    return;
  }

  const previousRating = item.rating ?? null;
  const index = state[config.indexKey];
  recordRating(item.path, rating, item);
  haptic();

  // A rating can push the item out of the current filter (rate something
  // while on "Unrated", dislike something while on "Liked").
  const stillVisible = matchesRatingFilter(item, ratingFilterValue(config.filterKey));
  const entry = { kind: "rate", path: item.path, previousRating, index, removed: !stillVisible, item };
  pushHistory(mode, entry);

  if (!stillVisible) {
    state[config.itemsKey].splice(index, 1);
    if (state[config.indexKey] >= state[config.itemsKey].length) {
      state[config.indexKey] = 0;
    }
  } else if (state[config.itemsKey].length > 1) {
    state[config.indexKey] = (index + 1) % state[config.itemsKey].length;
  }
  animateDeckAdvance(mode, rating === "like" ? "right" : "left");

  try {
    await postJson("/api/rating", { path: item.path, rating });
  } catch (error) {
    console.error(error);
    recordRating(item.path, previousRating, item);
    state.history[mode] = state.history[mode].filter((logged) => logged !== entry);
    syncUndoButtons();
    const items = state[config.itemsKey];
    if (!items.includes(item)) {
      items.splice(clampNumber(index, 0, items.length), 0, item);
    }
    state[config.indexKey] = clampNumber(items.indexOf(item), 0, Math.max(0, items.length - 1));
    flushDeckAnimation(mode);
    renderDeck(mode);
    toast("Could not save that rating. Check the connection and try again.");
  }
}

function skipDeckItem(mode) {
  flushDeckAnimation(mode);
  const config = deckConfig(mode);
  if (!config || !state[config.itemsKey].length) {
    return;
  }
  pushHistory(mode, { kind: "skip", index: state[config.indexKey] });
  state[config.indexKey] = (state[config.indexKey] + 1) % state[config.itemsKey].length;
  animateDeckAdvance(mode, "down");
}

/* The card flies out the way it was rated, and the next one settles in.
   A second action during the flight finishes the first one immediately, so
   nothing is ever rated that has not been on screen. */
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const deckAnimations = {};

function animateDeckAdvance(mode, direction) {
  const card = swipeCardControl(mode);
  if (!card || state.currentMode !== mode || REDUCED_MOTION.matches) {
    renderAnyDeck(mode);
    return;
  }
  card.querySelector("video")?.pause();
  card.classList.remove("enter", "dragging");
  card.style.transform = "";
  card.classList.add(`fly-${direction}`);
  deckAnimations[mode] = window.setTimeout(() => finishDeckAnimation(mode), 190);
}

function finishDeckAnimation(mode) {
  window.clearTimeout(deckAnimations[mode]);
  deckAnimations[mode] = 0;
  const card = swipeCardControl(mode);
  card.classList.remove("fly-left", "fly-right", "fly-down");
  renderAnyDeck(mode);
  void card.offsetWidth;
  card.classList.add("enter");
}

function flushDeckAnimation(mode) {
  if (deckAnimations[mode]) {
    finishDeckAnimation(mode);
  }
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
  if (mode === "rediscover") {
    return document.getElementById("rediscoverCard");
  }
  return null;
}

// The drag gesture and the fly-out are shared by the two decks and Rediscover.
function deckHasItem(mode) {
  return mode === "rediscover" ? !!currentRediscoverItem() : !!currentDeckItem(mode);
}

function deckAction(mode, action) {
  if (mode === "rediscover") {
    actRediscover(action === "like" ? "keep" : action === "dislike" ? "pass" : "skip");
  } else if (action === "skip") {
    skipDeckItem(mode);
  } else {
    rateDeckItem(mode, action);
  }
}

function renderAnyDeck(mode) {
  if (mode === "rediscover") {
    renderRediscover();
  } else {
    renderDeck(mode);
  }
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

// The one place a saved rating lands in memory: the catalog entry, its
// timestamp (Collection sorts on it), the counts, and every pool filtered by
// rating. `extra` are copies (deck/gallery items) that should follow along.
function recordRating(path, rating, ...extra) {
  const stamp = rating ? new Date().toISOString() : undefined;
  for (const key of ["images", "videos"]) {
    const found = (state.library[key] || []).find((entry) => entry.path === path);
    if (found) {
      found.rating = rating;
      found.ratedAt = stamp;
    }
  }
  extra.forEach((item) => {
    if (item) {
      item.rating = rating;
      item.ratedAt = stamp;
    }
  });
  invalidateMediaPools();
  syncCountsFromLibrary();
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
  if (mode !== "home" && !ALL_MODES.includes(mode)) return;
  if (!FOCUS_MODES.includes(mode) && state.focusMode) setFocusMode(false);
  if (!controls.galleryLightbox.hidden) closeLightbox();
  state.currentMode = mode;
  if (mode !== "home" && state.settings.lastMode !== mode) {
    state.settings.lastMode = mode;
    queueSettingsSave();
  }
  closeDrawers();
  document.querySelectorAll(".mode-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${mode}Mode`);
  });
  syncModeMenuButton();

  // Silence everything first, then bring up only the mode being entered.
  // Leaving this to per-mode branches is how clips used to keep playing
  // underneath another mode.
  quietAllModes();
  releaseInactiveMedia(mode);
  state.setupVisible = false;
  state.themePanelVisible = false;
  syncLibraryChrome();

  if (mode === "dangerous") {
    startDangerous();
  } else if (mode === "duel") {
    startDuel();
  } else if (mode === "rediscover") {
    startRediscover();
  } else if (mode === "swipe") {
    renderSwipe();
  } else if (mode === "escalation") {
    startEscalation();
  } else if (mode === "toktinder") {
    renderToktinder();
    playToktinderVideo();
  } else if (mode === "session") {
    enterSession();
  } else if (mode === "gallery") {
    renderGallery(false);
  } else if (mode === "ranked") {
    renderRanked();
  } else if (mode === "mosaic") {
    startMosaic();
  } else if (mode === "feed") {
    startFeed();
  }
  syncWorkspace();
  syncFocusMode();
  syncWakeLock();
  document.querySelector(".mode-panel.active .home-scroll, .mode-panel.active .ranked-scroller")?.scrollTo?.(0, 0);
}

function quietAllModes() {
  stopCornerClips();
  stopEscalation();
  pauseSession();
  stopMosaic();
  pauseFeed();
  pauseToktinderVideo();
  document.querySelectorAll("video").forEach(video => video.pause());
}

function refreshMode(mode) {
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
  } else if (mode === "session") {
    refreshSessionMedia(true);
  } else if (mode === "gallery") {
    renderGallery(true);
  } else if (mode === "ranked") {
    if (state.currentMode === "ranked") {
      renderRanked();
    }
  } else if (mode === "mosaic") {
    if (state.currentMode === "mosaic") {
      startMosaic();
    }
  } else if (mode === "feed") {
    if (state.currentMode === "feed") {
      rebuildFeed();
    }
  } else if (mode === "dangerous") {
    dangerous.items = [];
    if (state.currentMode === "dangerous") {
      startDangerous(true);
    }
  } else if (mode === "duel") {
    if (state.currentMode === "duel") {
      nextDuel();
    }
  } else if (mode === "rediscover") {
    rediscover.items = [];
    if (state.currentMode === "rediscover") {
      startRediscover(true);
    }
  }
}

function toggleFocusMode() {
  if (!FOCUS_MODES.includes(state.currentMode)) return;
  setFocusMode(!state.focusMode);
}

// Focus also asks for real fullscreen where the browser allows it (desktop,
// Android). iOS refuses for anything but a <video>, and focus still works.
function setFocusMode(enabled) {
  state.focusMode = enabled;
  syncFocusMode();
  try {
    if (enabled && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    } else if (!enabled && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  } catch (error) {
    /* fullscreen is optional */
  }
}

// Icon + label buttons keep their icon: only the label text changes.
function setButtonLabel(button, text, icon) {
  if (!button) {
    return;
  }
  const label = button.querySelector(".label");
  if (label) {
    label.textContent = text;
  } else {
    button.textContent = text;
  }
  button.setAttribute("aria-label", text);
  button.title = text;
  if (icon) {
    button.querySelector("use")?.setAttribute("href", `#${icon}`);
  }
}

function syncFocusMode() {
  document.body.classList.toggle("focus-mode", state.focusMode);
  FOCUS_MODES.forEach((mode) => {
    const button = controls[`${mode}FocusToggle`];
    if (!button) return;
    setButtonLabel(button, state.focusMode ? "Exit focus" : "Focus", state.focusMode ? "i-unfocus" : "i-focus");
    button.classList.toggle("active", state.focusMode);
  });
  syncImmersive();
  syncDrawers();
}

/* Immersive layout: focus mode, or a phone held sideways in a stage mode.
   Tools float over the media and fade after a few idle seconds. */
const LANDSCAPE_PHONE = window.matchMedia("(max-height: 500px) and (orientation: landscape)");
let idleTimer = 0;

function syncImmersive() {
  const stage = FOCUS_MODES.includes(state.currentMode);
  const immersive = stage && (state.focusMode || LANDSCAPE_PHONE.matches);
  document.body.classList.toggle("immersive", immersive);
  document.body.classList.toggle("stage-mode", stage);
  wakeIdle();
}

function wakeIdle() {
  document.body.classList.remove("idle");
  window.clearTimeout(idleTimer);
  if (document.body.classList.contains("immersive")) {
    idleTimer = window.setTimeout(() => {
      // Never hide the controls from under an open panel or a dragging finger.
      if (!state.activeDrawer && !state.drag.active && !state.launcherOpen) {
        document.body.classList.add("idle");
      }
    }, 3200);
  }
}

/* Keep the screen on while something is playing on its own. A phone that
   dims in the middle of a stream is the most common annoyance there is. */
const WAKE_MODES = ["escalation", "session", "mosaic", "feed", "toktinder"];
let wakeLock = null;

async function syncWakeLock() {
  const wanted = WAKE_MODES.includes(state.currentMode) && !document.hidden && state.libraryReady;
  try {
    if (wanted && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } else if (!wanted && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch (error) {
    wakeLock = null;
  }
}

function syncBalancedFolders() {
  const balanced = foldersAreBalanced();
  syncSegmented(controls.balancedFolders, "balanced", balanced ? "balanced" : "flat");
  controls.balancedFoldersHint.textContent = balanced
    ? "Each folder gets the same airtime, so a small folder is not buried by a big one."
    : "Each file is equally likely, so the folders holding the most files come up most often.";
}

// Re-deal the decks and re-pick the running stage so a change of shuffle
// style takes effect now, without losing the library or the settings.
function reshuffleEverything() {
  rebuildDeck("swipe");
  renderDeck("swipe");
  rebuildDeck("toktinder");
  renderDeck("toktinder");
  state.feed.dirty = true;

  if (state.currentMode === "escalation") {
    startEscalation();
  } else if (state.currentMode === "session") {
    refreshSessionMedia(true);
  } else if (state.currentMode === "mosaic") {
    startMosaic();
  } else if (state.currentMode === "feed") {
    rebuildFeed();
  } else if (state.currentMode === "gallery") {
    renderGallery(true);
  }
}

function syncThemeControls() {
  const value = sanitizeTheme(state.settings.theme);
  const currentTheme = THEME_OPTIONS.find((theme) => theme.value === value) || THEME_OPTIONS[0];
  controls.themeSummary.textContent = `${currentTheme.label} · ${currentTheme.note}`;
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
  // Phone browser chrome (and the iOS status bar in standalone mode) reads
  // this, so without it a light theme still had a near-black address bar.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const background = window.getComputedStyle(document.body).backgroundColor;
    if (background) {
      meta.setAttribute("content", background);
    }
  }
}

function renderThemeChoices() {
  controls.themeChoices.innerHTML = "";
  THEME_OPTIONS.forEach((theme) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-choice";
    button.dataset.themeChoice = theme.value;
    const swatch = document.createElement("span");
    swatch.className = "theme-swatch";
    swatch.style.setProperty("--sw-bg", theme.swatch[0]);
    swatch.style.setProperty("--sw-surface", theme.swatch[1]);
    swatch.style.setProperty("--sw-accent", theme.swatch[2]);
    button.append(swatch, theme.label);
    button.title = theme.note;
    button.addEventListener("click", () => {
      state.settings.theme = theme.value;
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
    await loadState({ rebuild: true });
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
    await loadState({ rebuild: true });
    setStatus("All likes and dislikes cleared.");
  } catch (error) {
    console.error(error);
    setStatus("Could not clear likes and dislikes.");
  }
}

async function resetModeData(mode) {
  const messages = {
    swipe: {
      confirm: "Reset Photo deck data? This clears saved likes and dislikes for photos only.",
      busy: "Clearing photo ratings...",
      done: "Photo ratings cleared.",
      failed: "Could not clear photo ratings.",
    },
    toktinder: {
      confirm: "Reset Video deck data? This clears saved likes and dislikes for videos only.",
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
    await loadState({ rebuild: true });
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

const DOCK_QUERY = window.matchMedia("(min-width: 1280px)");

// On a wide screen the control center docks beside the stage: nothing is
// covered, the stage keeps its keyboard, and every change is visible live.
function drawerIsDocked() {
  return !!state.activeDrawer && DOCK_QUERY.matches && !state.focusMode;
}

function syncDrawers() {
  let anyOpen = false;
  DRAWER_MODES.forEach((mode) => {
    const open = state.activeDrawer === mode;
    anyOpen = anyOpen || open;
    const drawer = controls[`${mode}Drawer`];
    drawer.classList.toggle("open", open);
    drawer.style.transform = "";
    drawer.setAttribute("aria-hidden", String(!open));
    controls[`${mode}DrawerToggle`].classList.toggle("active", open);
    controls[`${mode}DrawerToggle`].setAttribute("aria-expanded", String(open));
    if (open) {
      showDrawerTab(mode, state.drawerTabs[mode] || "tune");
      paintRanges(drawer);
    }
  });

  const docked = drawerIsDocked();
  document.querySelectorAll(".drawer").forEach((drawer) => drawer.setAttribute("aria-modal", String(!docked)));
  controls.drawerBackdrop.hidden = !anyOpen || docked;
  controls.drawerBackdrop.classList.toggle("open", anyOpen && !docked);
  document.body.classList.toggle("drawer-open", anyOpen && !docked);
  document.body.classList.toggle("drawer-docked", docked);
}

// Sliders paint their own filled track from --fill.
function paintRange(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", `${clampNumber(fill, 0, 100)}%`);
}

function paintRanges(scope = document) {
  scope.querySelectorAll('input[type="range"]').forEach(paintRange);
}

function bindControlCenterChrome() {
  document.addEventListener("input", (event) => {
    if (event.target.matches?.('input[type="range"]')) {
      paintRange(event.target);
    }
  });
  DOCK_QUERY.addEventListener?.("change", syncDrawers);
  controls.galleryDoneButton.addEventListener("click", closeDrawers);
  controls.mosaicRebuildButton.addEventListener("click", () => startMosaic());

  // Phone bottom sheets close with a downward drag on their header.
  document.querySelectorAll(".drawer").forEach((drawer) => {
    const header = drawer.querySelector(".drawer-header");
    let drag = null;
    header.addEventListener("pointerdown", (event) => {
      if (window.matchMedia("(min-width: 768px)").matches || event.target.closest("button")) {
        return;
      }
      drag = { id: event.pointerId, y: event.clientY, dy: 0 };
      header.setPointerCapture(event.pointerId);
      drawer.classList.add("dragging");
    });
    header.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) {
        return;
      }
      drag.dy = Math.max(0, event.clientY - drag.y);
      drawer.style.transform = `translateY(${drag.dy}px)`;
    });
    const end = () => {
      if (!drag) {
        return;
      }
      const close = drag.dy > 90;
      drag = null;
      drawer.classList.remove("dragging");
      drawer.style.transform = "";
      if (close) {
        closeDrawers();
      }
    };
    header.addEventListener("pointerup", end);
    header.addEventListener("pointercancel", end);
  });
}

function startEscalation() {
  stopEscalation();
  state.escalationRecentPaths = [];
  state.escalationSessionStartedAt = Date.now();
  refreshEscalationMedia(true);
  refreshCornerClips();
  // The ramp meter moves every second, not only when the media swaps.
  state.escalationTick = window.setInterval(() => {
    if (state.currentMode === "escalation" && !document.hidden) {
      updateEscalationTelemetry();
    }
  }, 1000);
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
  window.clearInterval(state.escalationTick);
  state.escalationTick = 0;
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
  markSeen(item.path);
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
  markSeen(chosen.path);

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
  controls.escalationProgressFill.style.width = `${Math.round(progress * 100)}%`;
  controls.escalationTelemetry.textContent = `Swap ${(intervalMs / 1000).toFixed(1)}s • ${speed.toFixed(1)}x${
    burstActive ? " • Burst" : ""
  }`;
  if (controls.escalationVideo.src) {
    controls.escalationStatus.textContent = state.settings.escalationRamp === false ? "" : `${Math.round(getEscalationProgress() * 100)}% through the ramp`;
  } else if (controls.escalationPhoto.src) {
    controls.escalationStatus.textContent = state.settings.escalationRamp === false ? "" : `${Math.round(getEscalationProgress() * 100)}% through the ramp`;
  }
}

function escalationPhaseLabel(progress) {
  if (state.settings.escalationRamp === false) {
    return "Steady";
  }
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
  const baseSeconds = Math.max(minSeconds, clampNumber(Number(state.settings.escalationBaseInterval ?? 12), 1, 60));
  const eased = 1 - (1 - progress) ** 2;
  return lerp(baseSeconds * 1000, minSeconds * 1000, eased);
}

function currentEscalationSpeed(progress = getEscalationProgress()) {
  const maxSpeed = clampNumber(Number(state.settings.escalationMaxSpeed ?? 2.2), 1, 3);
  const eased = progress ** 1.15;
  return lerp(1, maxSpeed, eased);
}

function getEscalationProgress() {
  // Steady (no ramp): the pace never moves off its starting point.
  if (state.settings.escalationRamp === false) {
    return 0;
  }
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

/* Corner clips: up to two small videos over the Escalation stage (what the
   old Stream mode did). Each plays from a random point and swaps when it
   ends. Same folders and Show filter as the stage itself. */
function queueCornerRefresh() {
  // The slider fires on every pixel of a drag. Rebuilding on each one stacks
  // half-loaded <video> elements whose audio comes up on top of each other.
  window.clearTimeout(state.cornerRebuildTimer);
  state.cornerRebuildTimer = window.setTimeout(refreshCornerClips, 220);
}

function stopCornerClips() {
  window.clearTimeout(state.cornerRebuildTimer);
  state.cornerSlots.forEach(({ video }) => releaseVideo(video));
  controls.videoOverlay.querySelectorAll("video").forEach((video) => releaseVideo(video));
  controls.videoOverlay.innerHTML = "";
  state.cornerSlots = [];
}

function refreshCornerClips() {
  stopCornerClips();
  if (state.currentMode !== "escalation") return;
  const count = clampNumber(Number(state.settings.escalationCorners ?? 0), 0, 2);
  for (let index = 0; index < count; index += 1) {
    const fragment = document.getElementById("videoSlotTemplate").content.cloneNode(true);
    fragment.querySelector(".video-slot").classList.add(`corner-${index}`);
    controls.videoOverlay.appendChild(fragment);
    const video = controls.videoOverlay.lastElementChild.querySelector("video");

    video.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      playWhenReady(video, video.dataset.loadToken, Math.random() * Math.max(0, duration - 0.25));
    });
    video.addEventListener("loadeddata", noteMediaLoaded);
    video.addEventListener("error", () => {
      if (mediaErrorIsFatal(video) && reportBrokenMedia(video.dataset.path) && !brokenStreakExhausted("escalation")) {
        loadCornerClip(video);
      }
    });
    video.addEventListener("ended", () => loadCornerClip(video));

    state.cornerSlots.push({ video });
    loadCornerClip(video);
  }
  applyCornerVolume();
}

function loadCornerClip(video) {
  const videos = getEscalationVideos();
  if (!videos.length) {
    releaseVideo(video);
    return;
  }
  const busy = [controls.escalationVideo.dataset.path, ...state.cornerSlots.map((slot) => slot.video.dataset.path)].filter(Boolean);
  const chosen = pickWithoutRepeats(videos, busy, video.dataset.path);
  if (!chosen) {
    return;
  }
  video.loop = false;
  video.playsInline = true;
  loadVideoSource(video, chosen);
  markSeen(chosen.path);
  applyCornerVolume();
}

// Corners sit a little under the stage clip so the main one leads.
function applyCornerVolume() {
  const volume = clampNumber(Number(state.settings.escalationVideoVolume ?? 0.32), 0, 1) * 0.6;
  state.cornerSlots.forEach(({ video }) => {
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

function playCornerClips() {
  state.cornerSlots.forEach(({ video }) => {
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
  applyCornerVolume();
  applyToktinderAudio();
  applyEscalationAudio();
  applySessionAudio();
  applyMosaicAudio();
  applyFeedAudio();
  playCornerClips();
  playToktinderVideo();
  playEscalationVideo();
}

function onSwipePointerDown(event) {
  const mode = event.currentTarget.dataset.swipeMode;
  if (!deckHasItem(mode)) {
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
  card.classList.add("dragging");
  card.style.transform = `translate(${state.drag.deltaX}px, ${Math.max(0, state.drag.deltaY)}px) rotate(${rotation}deg)`;
  const horizontalIntent = Math.abs(state.drag.deltaX) >= Math.abs(state.drag.deltaY) * 0.9;
  card.classList.toggle("likeing", horizontalIntent && state.drag.deltaX > 35);
  card.classList.toggle("disliking", horizontalIntent && state.drag.deltaX < -35);
  card.classList.toggle("skipping", !horizontalIntent && state.drag.deltaY > 60);
}

function onSwipePointerUp(event) {
  if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
    return;
  }
  const mode = state.drag.mode;
  const { deltaX, deltaY } = state.drag;
  const card = swipeCardControl(mode);
  let action = null;
  if (deltaY > 120 && deltaY > Math.abs(deltaX) * 1.15) {
    action = () => deckAction(mode, "skip");
  } else if (deltaX > 110) {
    action = () => deckAction(mode, "like");
  } else if (deltaX < -110) {
    action = () => deckAction(mode, "dislike");
  }

  if (action) {
    // Keep the card where the finger left it; the fly-out starts from there.
    const released = card.style.transform;
    resetSwipeCard(mode);
    card.style.transform = released;
    action();
    return;
  }
  resetSwipeCard(mode);
  if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) {
    if (mode === "toktinder") {
      toggleToktinderPlayback();
    } else if (mode === "rediscover") {
      const video = document.getElementById("rediscoverVideo");
      if (!video.hidden) video.paused ? video.play().catch(() => {}) : video.pause();
    }
    return;
  }
  // Not far enough: glide back instead of snapping.
  card.classList.add("settling");
  window.setTimeout(() => card.classList.remove("settling"), 240);
}

function resetSwipeCard(mode = state.drag.mode) {
  if (mode && typeof mode === "object") {
    mode = mode.currentTarget?.dataset?.swipeMode || state.drag.mode;
  }
  const card = swipeCardControl(mode);
  if (card) {
    card.style.transform = "";
    card.classList.remove("likeing", "disliking", "skipping", "dragging");
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
  // Every control that changes a setting ends up here, so this is the one
  // place that can keep the drawer readback and the preset highlight honest
  // without each handler remembering to. The save itself stays debounced.
  syncDrawerSummaries();
  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(async () => {
    try {
      await postJson("/api/settings", state.settings);
    } catch (error) {
      console.error(error);
    }
  }, 220);
}

// Sound is one switch shared by every mode; each control center shows it.
function syncAudioButton() {
  const label = state.audioUnlocked ? "Sound on" : "Sound off";
  const hint = state.audioUnlocked ? "" : "Browsers keep videos muted until you turn sound on here.";
  [
    ["toktinderAudioToggleButton", "toktinderAudioHint"],
    ["escalationAudioToggleButton", "escalationAudioHint"],
    ["sessionAudioToggleButton", "sessionAudioHint"],
    ["mosaicAudioToggleButton", "mosaicAudioHint"],
    ["feedAudioToggleButton", "feedAudioHint"],
  ].forEach(([buttonKey, hintKey]) => {
    controls[buttonKey].textContent = label;
    controls[buttonKey].setAttribute("aria-pressed", String(state.audioUnlocked));
    controls[hintKey].textContent = hint;
  });
  const dangerSound = document.getElementById("dangerousSound");
  if (dangerSound) {
    dangerSound.textContent = label;
    dangerSound.setAttribute("aria-pressed", String(state.audioUnlocked));
  }
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
  bindSegmented(controls[`${mode}RatingFilter`], "ratingFilter", (value) => setRatingFilter(mode, value));
}

// Every mode's "Show: All / Unrated / Liked" goes through here.
function setRatingFilter(mode, value) {
  state.settings[`${mode}RatingFilter`] = sanitizeRatingFilter(value, false);
  syncRatingFilter(mode);
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
  state.session.edges = 0;
  state.session.startedAt = Date.now();
  state.session.recentPaths = [];
  renderSessionPips();
  refreshSessionMedia(true);
  runSessionTick();
  syncSessionControls();
}

function enterSession() {
  renderSessionPips();
  if (!controls.sessionStage.dataset.path) refreshSessionMedia(true);
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
  if (state.session.running && state.session.startedAt) {
    const minutes = formatClock((Date.now() - state.session.startedAt) / 1000);
    const edges = state.session.edges || 0;
    toast(`Session over · ${minutes}${edges ? ` · ${edges} edge${edges === 1 ? "" : "s"}` : ""}`);
  }
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

/* "Edge": you are close, so hold now instead of when the timer says. The
   current build is cut short, a hold of the full hold length starts, and the
   rest of the build resumes after it. During a hold it adds ten seconds. */
function edgeSession() {
  if (state.currentMode !== "session") {
    return;
  }
  if (!state.session.running) {
    toast("Start a session first. Edge then gives you an instant hold.");
    return;
  }
  const phase = currentSessionPhase();
  const phases = state.session.phases;
  if (phase.kind === "hold") {
    phase.seconds += 10;
    toast("Hold extended by 10 seconds.");
  } else {
    const { hold } = sessionSettings();
    const holdPhase = { kind: "hold", round: phase.round, seconds: hold };
    const elapsed = state.session.elapsedMs / 1000;
    const resume =
      phase.kind === "build"
        ? { kind: "build", round: phase.round, seconds: Math.max(10, Math.round(phase.seconds - elapsed)) }
        : { kind: "finish", round: phase.round, seconds: 0 };
    phases.splice(state.session.index + 1, 0, holdPhase, resume);
    advanceSessionPhase();
  }
  state.session.edges = (state.session.edges || 0) + 1;
  haptic();
  controls.sessionStage.classList.remove("edge-flash");
  void controls.sessionStage.offsetWidth;
  controls.sessionStage.classList.add("edge-flash");
  syncSessionHud();
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
    const images = modeSource("session", "images").map((item) => ({ ...item, kind: "photo" }));
    if (!sessionSettings().includeVideos) {
      return images;
    }
    const videos = modeSource("session", "videos").map((item) => ({ ...item, kind: "video" }));
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
  markSeen(chosen.path);
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

  const edges = state.session.edges || 0;
  controls.sessionEdges.hidden = !state.session.running || !edges;
  controls.sessionEdges.textContent = `${edges} edge${edges === 1 ? "" : "s"} this session`;
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
  setButtonLabel(controls.sessionToggleButton, state.session.running ? "Stop" : "Start", state.session.running ? "i-stop" : "i-play");
  controls.sessionToggleButton.classList.toggle("active", state.session.running);
  controls.sessionEdgeButton.hidden = !state.session.running;
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

// The grid's columns and its row height are one number: a square tile. CSS
// alone cannot derive it (see the note on .gallery-grid), so measure the
// scroller and hand both tracks back as custom properties.
const GALLERY_TILE_MIN = 104;
const GALLERY_TILE_MIN_WIDE = 148;

function syncGalleryTileSize() {
  syncGalleryTileSizeFor(controls.galleryGrid);
  if (state.currentMode === "ranked") {
    syncGalleryTileSizeFor(controls.rankedGrid);
  }
}

function syncGalleryTileSizeFor(grid) {
  const style = window.getComputedStyle(grid);
  const inner =
    grid.clientWidth -
    parseFloat(style.paddingLeft || "0") -
    parseFloat(style.paddingRight || "0");
  if (inner <= 0) {
    return;
  }

  const gap = parseFloat(style.columnGap) || 6;
  const minimum = window.matchMedia("(max-width: 767px)").matches
    ? GALLERY_TILE_MIN
    : GALLERY_TILE_MIN_WIDE;
  const columns = Math.max(1, Math.floor((inner + gap) / (minimum + gap)));
  const size = (inner - gap * (columns - 1)) / columns;

  grid.style.setProperty("--gallery-cols", String(columns));
  grid.style.setProperty("--gallery-tile", `${size.toFixed(2)}px`);
}

// Re-measure on rotation, on a window resize, and when the drawer or the tab
// bar changes how much room the grid has.
function observeGalleryTileSize() {
  if (state.gallery.sizeObserver || typeof ResizeObserver === "undefined") {
    return;
  }
  state.gallery.sizeObserver = new ResizeObserver((entries) => {
    entries.forEach((entry) => syncGalleryTileSizeFor(entry.target));
  });
  state.gallery.sizeObserver.observe(controls.galleryGrid);
  state.gallery.sizeObserver.observe(controls.rankedGrid);
}

function renderGallery(resetPage) {
  observeGalleryTileSize();
  syncGalleryTileSize();

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

  state.gallery.observer?.disconnect();
  state.gallery.observer = videoTileObserver(controls.galleryGrid);
  thumbQueue.length = 0;

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
  syncDrawerSummaries();
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
    // A title tile first; a still frame replaces it once one exists (see
    // the thumbnail queue). Opening the clip itself waits for a tap.
    tile.dataset.path = item.path;
    const preview = document.createElement("span");
    preview.className = "video-placeholder";
    const play = document.createElement("span");
    play.textContent = "▶";
    const label = document.createElement("span");
    label.textContent = item.name;
    preview.append(play, label);
    const thumb = document.createElement("img");
    thumb.className = "gallery-thumb";
    thumb.alt = "";
    thumb.decoding = "async";
    tile.append(preview, thumb);
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

/* ==========================================================================
   Video thumbnails

   There is no ffmpeg on the server, so the browser makes them: one frame a
   quarter of the way in, drawn to a 360px canvas and saved as a JPEG. The
   server keeps each one (keyed to the file's size and date), so a frame is
   grabbed once per video ever -- after that every device just loads a
   20KB image. Two at a time, only for tiles on screen, never while you are
   elsewhere in the app.
   ========================================================================== */

const thumbCache = new Map();
const thumbQueue = [];
let thumbActive = 0;
const THUMB_CONCURRENCY = 2;

function thumbUrl(path) {
  return `/thumb?path=${encodeURIComponent(path)}`;
}

function videoTileObserver(root) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          requestVideoThumb(entry.target);
        }
      });
    },
    { root: root === controls.rankedScroller ? root : null, rootMargin: "200px" }
  );
  return observer;
}

// A still that arrives after you have left the page is kept in the cache,
// not attached: hidden pages hold no media.
function tileIsOnScreen(tile) {
  return tile.isConnected && !!tile.closest(".mode-panel.active");
}

function showThumb(tile, url) {
  const img = tile.querySelector(".gallery-thumb");
  if (!img || !tileIsOnScreen(tile)) {
    return;
  }
  img.onload = () => tile.classList.add("has-thumb");
  img.src = url;
}

function requestVideoThumb(tile) {
  if (!tileIsOnScreen(tile)) {
    return;
  }
  const path = tile.dataset.path;
  const cached = thumbCache.get(path);
  if (cached === "failed") {
    return;
  }
  if (cached) {
    showThumb(tile, cached);
    return;
  }
  const img = tile.querySelector(".gallery-thumb");
  img.onload = () => {
    tile.classList.add("has-thumb");
    thumbCache.set(path, img.src);
  };
  // Not saved on the server yet: make one.
  img.onerror = () => {
    img.onerror = null;
    img.removeAttribute("src");
    thumbQueue.push(tile);
    pumpThumbs();
  };
  img.src = thumbUrl(path);
}

function pumpThumbs() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const tile = thumbQueue.shift();
    if (!tileIsOnScreen(tile)) {
      continue;
    }
    thumbActive += 1;
    const path = tile.dataset.path;
    generateThumb(path)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        thumbCache.set(path, url);
        showThumb(tile, url);
        fetch(`/api/thumb?path=${encodeURIComponent(path)}`, {
          method: "POST",
          headers: { "Content-Type": "image/jpeg" },
          body: blob,
        }).catch(() => {});
      })
      .catch(() => thumbCache.set(path, "failed"))
      .finally(() => {
        thumbActive -= 1;
        pumpThumbs();
      });
  }
}

function generateThumb(path) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let done = false;
    const finish = (error, blob) => {
      if (done) {
        return;
      }
      done = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      error ? reject(error) : resolve(blob);
    };
    const timer = window.setTimeout(() => finish(new Error("thumbnail timed out")), 20000);
    video.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = duration > 2 ? Math.min(duration * 0.25, 45) : 0.1;
    });
    video.addEventListener(
      "seeked",
      () => {
        const width = 360;
        const height = Math.max(1, Math.round((width * (video.videoHeight || 9)) / (video.videoWidth || 16)));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        try {
          canvas.getContext("2d").drawImage(video, 0, 0, width, height);
          canvas.toBlob((blob) => (blob ? finish(null, blob) : finish(new Error("encode failed"))), "image/jpeg", 0.72);
        } catch (error) {
          finish(error);
        }
      },
      { once: true }
    );
    video.addEventListener("error", () => finish(new Error("decode failed")));
    video.src = mediaUrl(path);
  });
}

function openLightbox(index) {
  const items = state.gallery.items;
  if (!items.length) {
    return;
  }
  state.gallery.lightboxIndex = clampNumber(index, 0, items.length - 1);
  const item = items[state.gallery.lightboxIndex];

  if (controls.galleryLightbox.hidden) {
    state.lightboxOpener = document.activeElement;
    controls.galleryLightbox.hidden = false;
    controls.lightboxClose.focus({ preventScroll: true });
  }
  document.body.classList.add("drawer-open");

  const isVideo = item.kind === "video";
  markSeen(item.path);
  controls.lightboxImage.hidden = isVideo;
  controls.lightboxVideo.hidden = !isVideo;

  if (isVideo) {
    controls.lightboxImage.removeAttribute("src");
    controls.lightboxVideo.muted = !state.audioUnlocked;
    const poster = thumbCache.get(item.path);
    if (poster && poster !== "failed") {
      controls.lightboxVideo.poster = poster;
    } else {
      controls.lightboxVideo.removeAttribute("poster");
    }
    loadVideoSource(controls.lightboxVideo, item);
    playWhenReady(controls.lightboxVideo, controls.lightboxVideo.dataset.loadToken, null);
  } else {
    releaseVideo(controls.lightboxVideo);
    controls.lightboxImage.src = mediaUrl(item.path);
    controls.lightboxImage.alt = item.name;
  }

  setLabel(controls.lightboxName, item.name);
  setLabel(controls.lightboxFolder, item.folder || "Library root");
  controls.lightboxCount.textContent = `${(state.gallery.lightboxIndex + 1).toLocaleString()} / ${items.length.toLocaleString()}`;
  controls.lightboxPrev.disabled = state.gallery.lightboxIndex === 0;
  controls.lightboxNext.disabled = state.gallery.lightboxIndex >= items.length - 1;
  syncLightboxRating();
}

// Touch: swipe sideways for the next file, down to close. The bottom of a
// video is left alone so its own scrubber still works.
function bindLightboxGestures() {
  const stage = controls.galleryLightbox.querySelector(".lightbox-media");
  let drag = null;
  const media = () => (controls.lightboxImage.hidden ? controls.lightboxVideo : controls.lightboxImage);
  stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || event.target.closest("button")) {
      return;
    }
    if (event.target.tagName === "VIDEO" && event.offsetY > event.target.clientHeight - 70) {
      return;
    }
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0 };
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) {
      return;
    }
    drag.dx = event.clientX - drag.x;
    drag.dy = event.clientY - drag.y;
    const vertical = Math.abs(drag.dy) > Math.abs(drag.dx);
    media().style.transform = vertical ? `translateY(${Math.max(0, drag.dy)}px)` : `translateX(${drag.dx}px)`;
    media().style.opacity = vertical ? String(1 - Math.min(0.6, Math.max(0, drag.dy) / 400)) : "1";
  });
  const end = () => {
    if (!drag) {
      return;
    }
    const { dx, dy } = drag;
    drag = null;
    media().style.transform = "";
    media().style.opacity = "";
    if (dy > 110 && dy > Math.abs(dx)) {
      closeLightbox();
    } else if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) {
      stepLightbox(dx < 0 ? 1 : -1);
    }
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
}

function closeLightbox() {
  controls.galleryLightbox.hidden = true;
  document.body.classList.toggle("drawer-open", !!state.activeDrawer);
  releaseVideo(controls.lightboxVideo);
  controls.lightboxImage.removeAttribute("src");
  state.gallery.lightboxIndex = -1;
  if (state.lightboxOpener?.getClientRects().length) state.lightboxOpener.focus({ preventScroll: true });
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

  recordRating(item.path, next, item);
  haptic();
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
   Drawer control centres

   Every drawer now leads with a plain-English readback of what the mode will
   actually do, and the ones with several interacting knobs get presets, so a
   feel is one tap instead of four sliders. The per-mode reset puts the
   defaults back without touching folders, ratings or anything else.
   ========================================================================== */

// Only the keys a mode owns; a reset must not reach into another mode's
// settings, its folders, or the library-wide ones.
const MODE_SETTING_KEYS = {
  swipe: ["swipeRatingFilter"],
  toktinder: ["toktinderRatingFilter"],
  escalation: [
    "escalationRatingFilter",
    "escalationBaseInterval",
    "escalationMinInterval",
    "escalationRampSeconds",
    "escalationMaxSpeed",
    "escalationVideoVolume",
    "escalationRamp",
    "escalationCorners",
  ],
  session: [
    "sessionRatingFilter",
    "sessionRounds",
    "sessionBuildSeconds",
    "sessionHoldSeconds",
    "sessionIncludeVideos",
    "sessionVideoVolume",
  ],
  gallery: ["galleryRatingFilter", "galleryKind", "gallerySort"],
  mosaic: ["mosaicRatingFilter", "mosaicTiles", "mosaicSwapSeconds", "mosaicIncludePhotos", "mosaicVolume"],
  feed: ["feedRatingFilter", "feedVolume", "feedAutoAdvance"],
  dangerous: ["dangerousKind", "dangerousUnrated"],
  duel: ["duelKind", "duelRatingFilter"],
  rediscover: ["rediscoverKind", "rediscoverRatingFilter"],
};

const MODE_DEFAULTS = {
  duelKind: "photos",
  duelRatingFilter: "liked",
  rediscoverKind: "all",
  rediscoverRatingFilter: "all",
  escalationRatingFilter: "all",
  sessionRatingFilter: "all",
  mosaicRatingFilter: "all",
  dangerousKind: "all",
  dangerousUnrated: false,
  swipeRatingFilter: "all",
  toktinderRatingFilter: "all",
  escalationRamp: true,
  escalationCorners: 0,
  escalationBaseInterval: 12,
  escalationMinInterval: 2,
  escalationRampSeconds: 90,
  escalationMaxSpeed: 2.2,
  escalationVideoVolume: 0.32,
  sessionRounds: 5,
  sessionBuildSeconds: 60,
  sessionHoldSeconds: 15,
  sessionIncludeVideos: true,
  sessionVideoVolume: 0.3,
  galleryRatingFilter: "all",
  galleryKind: "all",
  gallerySort: "name",
  mosaicTiles: 4,
  mosaicSwapSeconds: 12,
  mosaicIncludePhotos: false,
  mosaicVolume: 0.3,
  feedRatingFilter: "all",
  feedVolume: 1,
  feedAutoAdvance: false,
};

const MODE_PRESETS = {
  escalation: {
    // The old Stream mode: a constant pace with clips in the corners.
    steady: {
      escalationRamp: false,
      escalationBaseInterval: 14,
      escalationCorners: 2,
    },
    slow: {
      escalationRamp: true,
      escalationCorners: 0,
      escalationBaseInterval: 18,
      escalationMinInterval: 4,
      escalationRampSeconds: 180,
      escalationMaxSpeed: 1.6,
    },
    standard: {
      escalationRamp: true,
      escalationCorners: 0,
      escalationBaseInterval: 12,
      escalationMinInterval: 2,
      escalationRampSeconds: 90,
      escalationMaxSpeed: 2.2,
    },
    overload: {
      escalationRamp: true,
      escalationCorners: 0,
      escalationBaseInterval: 8,
      escalationMinInterval: 1,
      escalationRampSeconds: 45,
      escalationMaxSpeed: 3,
    },
  },
  session: {
    quick: { sessionRounds: 3, sessionBuildSeconds: 30, sessionHoldSeconds: 10 },
    standard: { sessionRounds: 5, sessionBuildSeconds: 60, sessionHoldSeconds: 15 },
    marathon: { sessionRounds: 8, sessionBuildSeconds: 120, sessionHoldSeconds: 30 },
  },
  mosaic: {
    calm: { mosaicTiles: 4, mosaicSwapSeconds: 24 },
    busy: { mosaicTiles: 6, mosaicSwapSeconds: 12 },
    frantic: { mosaicTiles: 9, mosaicSwapSeconds: 5 },
  },
};

function applyModePreset(mode, name) {
  const preset = MODE_PRESETS[mode]?.[name];
  if (!preset) {
    return;
  }
  Object.assign(state.settings, preset);
  afterModeSettingsChange(mode);
}

function resetModeSettings(mode) {
  (MODE_SETTING_KEYS[mode] || []).forEach((key) => {
    state.settings[key] = MODE_DEFAULTS[key];
  });
  afterModeSettingsChange(mode);
}

// One path out of every drawer change: re-sanitise, push the values back into
// the widgets, restate the summary, and let the mode pick the change up.
function afterModeSettingsChange(mode) {
  sanitizeModeSettings();
  invalidateMediaPools();
  syncControls();
  syncDrawerSummaries();
  refreshMode(mode);
  if (mode === "escalation") {
    applyEscalationAudio();
    applyCornerVolume();
  } else if (mode === "session") {
    applySessionAudio();
  } else if (mode === "mosaic") {
    applyMosaicAudio();
  } else if (mode === "feed") {
    applyFeedAudio();
  }
  queueSettingsSave();
}

// Highlights a preset only when every value it sets still matches.
function presetMatches(mode, name) {
  const preset = MODE_PRESETS[mode]?.[name];
  if (!preset) {
    return false;
  }
  return Object.entries(preset).every(([key, value]) => Number(state.settings[key]) === Number(value));
}

function currentPresetName(mode) {
  return Object.keys(MODE_PRESETS[mode] || {}).find((name) => presetMatches(mode, name)) || "";
}

function plural(count, one, many) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

// What each mode will actually do, in a sentence.
const DRAWER_SUMMARIES = {
  swipe: () => {
    const filter = ratingFilterValue("swipeRatingFilter");
    const word = filter === "all" ? "every photo" : filter === "liked" ? "kept photos" : "unrated photos";
    return `Dealing ${word} — ${plural(state.swipeItems.length, "card", "cards")} in this deck.`;
  },
  toktinder: () => {
    const filter = ratingFilterValue("toktinderRatingFilter");
    const word = filter === "all" ? "every clip" : filter === "liked" ? "kept clips" : "unrated clips";
    return `Dealing ${word} — ${plural(state.toktinderItems.length, "card", "cards")} in this deck.`;
  },
  escalation: () => {
    const corners = Number(state.settings.escalationCorners || 0);
    const clips = corners ? `, with ${plural(corners, "corner clip", "corner clips")}` : "";
    if (state.settings.escalationRamp === false) {
      return `Steady: a new photo or clip every ${state.settings.escalationBaseInterval}s${clips}, no ramp.`;
    }
    return `Opens at ${state.settings.escalationBaseInterval}s, tightens to ${state.settings.escalationMinInterval}s over ${state.settings.escalationRampSeconds}s, then bursts at up to ${Number(state.settings.escalationMaxSpeed).toFixed(1)}x${clips}.`;
  },
  session: () =>
    `${plural(state.settings.sessionRounds, "round", "rounds")}. Builds shorten from ${state.settings.sessionBuildSeconds}s, holds stretch from ${state.settings.sessionHoldSeconds}s.`,
  gallery: () => {
    const kind = state.settings.galleryKind;
    const what = kind === "photos" ? "photos" : kind === "videos" ? "videos" : "everything";
    return `Showing ${what}, ${plural(state.gallery.items.length, "file", "files")} matching.`;
  },
  mosaic: () => {
    const tiles = mosaicTileCount();
    const kinds = state.settings.mosaicIncludePhotos ? "clips and photos" : "clips";
    return `${plural(tiles, "tile", "tiles")} of ${kinds}, each swapping about every ${state.settings.mosaicSwapSeconds}s.`;
  },
  feed: () => {
    const filter = ratingFilterValue("feedRatingFilter");
    const word = filter === "all" ? "every clip" : filter === "liked" ? "kept clips" : "unrated clips";
    const ending = state.settings.feedAutoAdvance ? "rolls on to the next" : "loops";
    return `Scrolling ${word}. Each one ${ending} when it ends.`;
  },
  duel: () => {
    const pool = duelPool().length;
    const what = state.settings.duelKind === "videos" ? "clips" : state.settings.duelKind === "all" ? "files" : "photos";
    const filter = ratingFilterValue("duelRatingFilter");
    const which = filter === "liked" ? `kept ${what}` : filter === "unrated" ? `unrated ${what}` : what;
    return `Comparing ${plural(pool, which.replace(/s$/, ""), which)} two at a time. ${plural(duel.count, "pick", "picks")} this visit.`;
  },
  rediscover: () => {
    const never = rediscover.items.filter((item) => !seenAt(item.path)).length;
    return `${plural(rediscover.items.length, "file", "files")} in this deal, ${never.toLocaleString()} never seen before.`;
  },
  dangerous: () => {
    const kind = state.settings.dangerousKind === "photo" ? "photos" : state.settings.dangerousKind === "video" ? "videos" : "photos and videos";
    const which = state.settings.dangerousUnrated ? `unrated ${kind}` : kind;
    const left = Math.max(0, dangerous.items.length - dangerous.index);
    return `Reviewing ${which} — ${plural(left, "file", "files")} left in this deck.${state.canTrash ? "" : " The drive is read-only, so Delete is off."}`;
  },
};

// "…, only the ones you kept." appended to a summary when Show narrows it.
function filterNote(mode) {
  const filter = ratingFilterValue(`${mode}RatingFilter`);
  return filter === "liked" ? " Only what you kept." : filter === "unrated" ? " Only what you have not rated." : "";
}

function syncDrawerSummaries() {
  DRAWER_MODES.forEach((mode) => {
    const node = controls[`${mode}Summary`];
    if (node) {
      const extra = ["escalation", "session", "mosaic", "rediscover"].includes(mode) ? filterNote(mode) : "";
      node.textContent = DRAWER_SUMMARIES[mode] ? DRAWER_SUMMARIES[mode]() + extra : "";
    }
    const presets = controls[`${mode}Preset`];
    if (presets) {
      syncSegmented(presets, "preset", currentPresetName(mode));
    }
  });
}

function bindDrawerControls() {
  DRAWER_MODES.forEach((mode) => {
    const presets = controls[`${mode}Preset`];
    if (presets) {
      bindSegmented(presets, "preset", (value) => applyModePreset(mode, value));
    }
    controls[`${mode}ResetSettingsButton`].addEventListener("click", () => resetModeSettings(mode));
  });
}

/* ==========================================================================
   Mode launcher

   The tab bar is good for flicking between two or three favourites, but with
   nine modes it is a scrolling strip of bare words: nothing tells you what
   Escalation does differently to Session, or how much is even in there. The
   launcher lays them all out at once, each with a line about what it is for
   and a live count of what it has to play.
   ========================================================================== */

const MODE_CARDS = [
  {
    mode: "swipe",
    name: "Photo deck",
    blurb: "Slow down. Discover your photos, one at a time.",
    icon: "M4 5h16v11H4zM4 19h10",
    stat: () => `${countOf("images").toLocaleString()} photos`,
  },
  {
    mode: "toktinder",
    name: "Video deck",
    blurb: "Give every clip its moment. Watch, skip, or keep.",
    icon: "M4 5h16v14H4zM10 9l5 3-5 3z",
    stat: () => `${countOf("videos").toLocaleString()} clips`,
  },
  {
    mode: "escalation",
    name: "Escalation",
    blurb: "Photos and clips on a timer. Steady, or ramping up into burst mode.",
    icon: "M4 19l5-6 4 4 7-9M16 8h4v4",
    stat: () => (state.settings.escalationRamp === false ? `steady · ${state.settings.escalationBaseInterval}s` : `${state.settings.escalationRampSeconds ?? 90}s ramp`),
  },
  {
    mode: "session",
    name: "Session",
    blurb: "Timed build and hold rounds. The media freezes on a hold.",
    icon: "M12 7v5l3 2M12 3a9 9 0 110 18 9 9 0 010-18z",
    stat: () => `${state.settings.sessionRounds ?? 5} rounds`,
  },
  {
    mode: "gallery",
    name: "Gallery",
    blurb: "Your whole library, ready to search and explore.",
    icon: "M4 5h6v6H4zM14 5h6v6h-6zM4 13h6v6H4zM14 13h6v6h-6z",
    stat: () => `${(countOf("images") + countOf("videos")).toLocaleString()} files`,
  },
  {
    mode: "ranked",
    name: "Collection",
    blurb: "Everything you kept, and which folders you keep most.",
    icon: "M5 21V11M12 21V4M19 21v-6",
    stat: () => `${countOf("liked").toLocaleString()} kept`,
  },
  {
    mode: "mosaic",
    name: "Mosaic",
    blurb: "A wall of clips playing at once, one of them audible.",
    icon: "M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v5H4zM13 14h7v5h-7z",
    stat: () => `${mosaicTileCount()} tiles`,
  },
  {
    mode: "feed",
    name: "Feed",
    blurb: "Scroll clips one screen at a time. Double-tap to keep.",
    icon: "M7 4h10v16H7zM12 20v1",
    stat: () => `${countOf("videos").toLocaleString()} clips`,
  },
];

function countOf(key) {
  return Number(state.library.counts?.[key] || 0);
}

function renderModeLauncher() {
  const grid = controls.launcherGrid;
  grid.innerHTML = "";

  const shortcuts = document.createElement("div");
  shortcuts.className = "launcher-home";
  const home = document.createElement("button");
  home.className = "ghost-button small-button";
  home.innerHTML = '<svg aria-hidden="true"><use href="#i-home"/></svg>Overview';
  home.addEventListener("click", () => { setMode("home"); closeModeLauncher(); });
  const settings = document.createElement("button");
  settings.className = "ghost-button small-button";
  settings.innerHTML = '<svg aria-hidden="true"><use href="#i-gear"/></svg>Settings';
  settings.addEventListener("click", () => {
    closeModeLauncher();
    state.themePanelVisible = true;
    state.setupVisible = false;
    syncLibraryChrome();
  });
  shortcuts.append(home, settings);
  grid.append(shortcuts);
  MODE_GROUPS.forEach(({ label, modes }) => {
    const heading = document.createElement("p");
    heading.className = "launcher-group";
    heading.textContent = label;
    grid.append(heading);
    modes.forEach((mode) => {
      const card = MODE_CARDS.find((entry) => entry.mode === mode);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "launcher-card";
      button.dataset.mode = card.mode;
      button.classList.toggle("active", card.mode === state.currentMode);
      button.innerHTML = modeIcon(card);
      const key = document.createElement("kbd");
      key.textContent = modeKey(card.mode);
      const name = document.createElement("strong");
      name.textContent = card.name;
      const blurb = document.createElement("span");
      blurb.className = "launcher-blurb";
      blurb.textContent = card.blurb;
      const stat = document.createElement("span");
      stat.className = "launcher-stat";
      stat.textContent = card.stat();
      button.append(key, name, blurb, stat);
      button.addEventListener("click", () => {
        setMode(card.mode);
        closeModeLauncher();
      });
      grid.appendChild(button);
    });
  });

  const total = countOf("images") + countOf("videos");
  controls.launcherMeta.textContent = total
    ? `${total.toLocaleString()} files — ${countOf("liked").toLocaleString()} kept`
    : "";
}

function openModeLauncher() {
  if (!state.libraryReady) {
    return;
  }
  closeDrawers();
  state.launcherOpener = document.activeElement;
  renderModeLauncher();
  controls.modeLauncher.hidden = false;
  // Next frame, so the transition has a start state to animate from.
  window.requestAnimationFrame(() => controls.modeLauncher.classList.add("open"));
  state.launcherOpen = true;
  syncModeMenuButton();
  // preventScroll matters: focusing the active card otherwise scrolls the
  // sheet down to it and hides its own header, Close button and all.
  (controls.launcherGrid.querySelector(".launcher-card.active") || controls.launcherClose).focus({ preventScroll: true });
}

function closeModeLauncher() {
  if (!state.launcherOpen) {
    return;
  }
  state.launcherOpen = false;
  state.launcherOpener?.focus({ preventScroll: true });
  controls.modeLauncher.classList.remove("open");
  syncModeMenuButton();
  // Matches the CSS transition, so it fades out instead of vanishing.
  window.setTimeout(() => {
    if (!state.launcherOpen) {
      controls.modeLauncher.hidden = true;
    }
  }, 180);
}

function toggleModeLauncher() {
  if (state.launcherOpen) {
    closeModeLauncher();
  } else {
    openModeLauncher();
  }
}

function syncModeMenuButton() {
  controls.modeMenuLabel.textContent = workspaceNames[state.currentMode] || "Overview";
  controls.modeMenuButton.classList.toggle("active", state.launcherOpen);
  controls.modeMenuButton.setAttribute("aria-expanded", String(state.launcherOpen));
}

function bindModeLauncher() {
  controls.modeMenuButton.addEventListener("click", toggleModeLauncher);
  controls.launcherClose.addEventListener("click", closeModeLauncher);
  controls.modeLauncher.addEventListener("click", (event) => {
    // Only the backdrop dismisses; a click inside the sheet must not.
    if (event.target === controls.modeLauncher) {
      closeModeLauncher();
    }
  });
}

/* ==========================================================================
   Ranked — what you actually keep

   Every other mode looks forward: here is something new, yes or no. This one
   looks back. It answers "which folders am I actually into" with the only
   honest signal the app has -- the keep rate, not the file count -- and puts
   everything you kept in one grid.
   ========================================================================== */

const RANKED_PAGE_SIZE = 120;

function rankedPool() {
  const kind = state.settings.rankedKind || "all";
  const pool = [];
  if (kind !== "videos") {
    pool.push(...(state.library.images || []).map((item) => ({ ...item, kind: "photo" })));
  }
  if (kind !== "photos") {
    pool.push(...(state.library.videos || []).map((item) => ({ ...item, kind: "video" })));
  }
  return pool;
}

function rankedKeeps() {
  const items = rankedPool().filter((item) => item.rating === "like");
  const sort = state.settings.rankedSort || "recent";
  const stamp = (item) => (item.ratedAt ? Date.parse(item.ratedAt) || 0 : 0);

  if (sort === "recent") {
    // Anything rated before the app recorded times has no stamp; it sorts to
    // the back rather than pretending to be from 1970.
    items.sort((a, b) => stamp(b) - stamp(a) || a.path.localeCompare(b.path));
  } else if (sort === "oldest") {
    items.sort((a, b) => {
      const left = stamp(a) || Infinity;
      const right = stamp(b) || Infinity;
      return left - right || a.path.localeCompare(b.path);
    });
  } else if (sort === "largest") {
    items.sort((a, b) => (b.size || 0) - (a.size || 0));
  } else if (sort === "duel") {
    // Ranked first, by Elo; never-dueled files after, newest kept first.
    const score = (item) => (duel.ratings?.[item.path]?.n ? duel.ratings[item.path].r : -Infinity);
    items.sort((a, b) => score(b) - score(a) || stamp(b) - stamp(a));
  } else if (sort === "folder") {
    items.sort((a, b) => a.path.localeCompare(b.path));
  } else {
    items.sort((a, b) => a.name.localeCompare(b.name));
  }
  return items;
}

// Liked, disliked and seen per folder, for the leaderboard.
function rankedFolderRows() {
  const rows = new Map();
  for (const key of ["images", "videos"]) {
    for (const item of state.library[key] || []) {
      const folder = item.folder || "";
      let row = rows.get(folder);
      if (!row) {
        row = { folder, total: 0, liked: 0, disliked: 0 };
        rows.set(folder, row);
      }
      row.total += 1;
      if (item.rating === "like") {
        row.liked += 1;
      } else if (item.rating === "dislike") {
        row.disliked += 1;
      }
    }
  }

  return [...rows.values()]
    .filter((row) => row.liked + row.disliked > 0)
    .map((row) => {
      const rated = row.liked + row.disliked;
      return { ...row, rated, rate: rated ? row.liked / rated : 0 };
    })
    // Keep rate first, but a folder you have rated twice should not outrank
    // one you have rated two hundred times, so ties break on volume.
    .sort((a, b) => b.rate - a.rate || b.liked - a.liked || a.folder.localeCompare(b.folder));
}

function renderRanked() {
  if (state.settings.rankedSort === "duel" && !duel.ratings) {
    loadDuelRatings().then(() => state.currentMode === "ranked" && renderRanked());
  }
  renderFavoriteLaunchers(controls.rankedPlay, "Play what you kept");
  renderRankedStats();
  renderRankedFolders();
  renderRankedKeeps();
  syncSegmented(controls.rankedKind, "rankedKind", state.settings.rankedKind);
  controls.rankedSort.value = state.settings.rankedSort;
}

function renderRankedStats() {
  const all = [...(state.library.images || []), ...(state.library.videos || [])];
  const liked = all.filter((item) => item.rating === "like").length;
  const disliked = all.filter((item) => item.rating === "dislike").length;
  const rated = liked + disliked;
  const rate = rated ? Math.round((liked / rated) * 100) : 0;

  const tiles = [
    { value: liked.toLocaleString(), label: "kept", tone: "keep" },
    { value: disliked.toLocaleString(), label: "passed", tone: "pass" },
    { value: rated ? `${rate}%` : "--", label: "keep rate", tone: "" },
    { value: (all.length - rated).toLocaleString(), label: "still unrated", tone: "" },
  ];

  controls.rankedStats.innerHTML = "";
  tiles.forEach((tile) => {
    const box = document.createElement("div");
    box.className = `ranked-stat${tile.tone ? ` is-${tile.tone}` : ""}`;
    const value = document.createElement("strong");
    value.textContent = tile.value;
    const label = document.createElement("span");
    label.textContent = tile.label;
    box.append(value, label);
    controls.rankedStats.appendChild(box);
  });
}

function renderRankedFolders() {
  const rows = rankedFolderRows();
  controls.rankedFolders.innerHTML = "";

  if (!rows.length) {
    controls.rankedFolderNote.textContent = "Rate a few things and this fills in.";
    return;
  }
  controls.rankedFolderNote.textContent = `${rows.length} folder${rows.length === 1 ? "" : "s"} rated`;

  rows.slice(0, 12).forEach((row, index) => {
    const entry = document.createElement("li");
    entry.className = "ranked-folder";

    const rank = document.createElement("span");
    rank.className = "ranked-rank";
    rank.textContent = String(index + 1);

    const body = document.createElement("div");
    body.className = "ranked-folder-body";

    const name = document.createElement("strong");
    name.textContent = folderLabel(row.folder);

    const bar = document.createElement("div");
    bar.className = "ranked-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.round(row.rate * 100)}%`;
    bar.appendChild(fill);

    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = `${Math.round(row.rate * 100)}% kept — ${row.liked.toLocaleString()} of ${row.rated.toLocaleString()} rated, ${row.total.toLocaleString()} in folder`;

    body.append(name, bar, meta);

    // Jumping straight into a folder you like is the whole point of a
    // leaderboard, so a row is a shortcut into the gallery filtered to it.
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "ghost-button small-button";
    jump.textContent = "Browse";
    jump.addEventListener("click", () => {
      state.settings.galleryFolders = [row.folder];
      state.folderCleared.gallery = false;
      state.settings.galleryRatingFilter = "all";
      invalidateMediaPools();
      renderFolderFilter("gallery");
      syncSegmented(controls.galleryRatingFilter, "ratingFilter", "all");
      queueSettingsSave();
      setMode("gallery");
      renderGallery(true);
    });

    entry.append(rank, body, jump);
    controls.rankedFolders.appendChild(entry);
  });
}

function renderRankedKeeps() {
  const items = rankedKeeps();
  // The lightbox reads state.gallery.items, so point it at this list while
  // Ranked is what is on screen.
  state.gallery.items = items;
  state.gallery.page = 0;

  controls.rankedGrid.querySelectorAll("video").forEach(releaseVideo);
  controls.rankedGrid.innerHTML = "";
  controls.rankedEmpty.hidden = items.length > 0;

  if (!items.length) {
    controls.rankedEmpty.textContent =
      "Nothing kept yet. Rate some photos in Photo deck or clips in Video deck and they land here.";
    return;
  }

  state.ranked.observer?.disconnect();
  state.ranked.observer = videoTileObserver(controls.rankedScroller);

  const slice = items.slice(0, RANKED_PAGE_SIZE);
  const fragment = document.createDocumentFragment();
  slice.forEach((item, index) => fragment.appendChild(buildGalleryTile(item, index)));
  controls.rankedGrid.appendChild(fragment);
  controls.rankedGrid.querySelectorAll(".gallery-tile.is-video").forEach((tile) => {
    state.ranked.observer.observe(tile);
  });

  if (items.length > RANKED_PAGE_SIZE) {
    const more = document.createElement("p");
    more.className = "subtle ranked-empty";
    more.textContent = `Showing the first ${RANKED_PAGE_SIZE.toLocaleString()} of ${items.length.toLocaleString()}. Narrow it with the sort and type filters.`;
    controls.rankedGrid.after(more);
  }
  observeGalleryTileSize();
  syncGalleryTileSizeFor(controls.rankedGrid);
}

function bindRankedEvents() {
  bindSegmented(controls.rankedKind, "rankedKind", (value) => {
    state.settings.rankedKind = value;
    renderRanked();
    queueSettingsSave();
  });

  controls.rankedSort.addEventListener("change", (event) => {
    state.settings.rankedSort = event.target.value;
    renderRanked();
    queueSettingsSave();
  });
}

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
        playWhenReady(tile.video, token, duration > 4 ? Math.random() * (duration - 2) : 0);
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
  shuffleBalanced(state.feed.items);
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
    // A looping clip never fires `ended`, so the two settings are the same
    // switch seen from either side.
    video.loop = !state.settings.feedAutoAdvance;
    video.addEventListener("ended", () => {
      if (state.settings.feedAutoAdvance && Number(article.dataset.index) === state.feed.activeIndex) {
        scrollFeedTo(index + 1);
      }
    });
    video.addEventListener("error", () => {
      if (mediaErrorIsFatal(video)) {
        reportBrokenMedia(video.dataset.path);
        state.feed.dirty = true;
      }
    });

    article.querySelector(".feed-keep").addEventListener("click", () => rateFeedItem(index, "like"));
    article.querySelector(".feed-pass").addEventListener("click", () => rateFeedItem(index, "dislike"));

    // One tap toggles playback, two keeps the clip -- the gesture the Feed
    // drawer has always advertised but nothing implemented. The single-tap
    // action is deferred so a double tap does not also pause the video on
    // its way past; 280ms is the usual double-tap window.
    let tapTimer = 0;
    video.addEventListener("click", () => {
      if (tapTimer) {
        window.clearTimeout(tapTimer);
        tapTimer = 0;
        flashFeedKeep(article);
        rateFeedItem(index, "like", false);
        return;
      }
      tapTimer = window.setTimeout(() => {
        tapTimer = 0;
        if (video.paused) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      }, 280);
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

    if (distance > 1) {
      video.preload = "none";
      releaseVideo(video);
      return;
    }
    if (!video.getAttribute("src")) {
      const item = state.feed.items[position];
      if (item) {
        video.loop = !state.settings.feedAutoAdvance;
        video.preload = position === index ? "auto" : "metadata";
        loadVideoSource(video, item);
        video.preload = position === index ? "auto" : "metadata";
      }
    }
    if (position === index) {
      video.preload = "auto";
    }
    if (position === index) {
      applyFeedAudio();
      markSeen(state.feed.items[position]?.path);
      playWhenReady(video, video.dataset.loadToken, null);
    } else {
      video.pause();
    }
  });

  if (index >= state.feed.rendered - 4 && state.feed.rendered < state.feed.items.length) {
    appendFeedBatch();
  }
}

// A double tap has no button to light up, so the card itself acknowledges it.
function flashFeedKeep(article) {
  article.classList.remove("is-kept");
  // Reading offsetWidth restarts the animation when two taps land in a row.
  void article.offsetWidth;
  article.classList.add("is-kept");
  window.setTimeout(() => article.classList.remove("is-kept"), 650);
}

function applyFeedAudio() {
  const volume = clampNumber(Number(state.settings.feedVolume ?? 1), 0, 1);
  controls.feedScroller.querySelectorAll("video").forEach((video) => {
    const active = Number(video.closest(".feed-item")?.dataset.index) === state.feed.activeIndex;
    video.volume = volume;
    video.muted = !active || !state.audioUnlocked || volume === 0;
  });
}

// `advance` is what separates the two ways of keeping a clip. The Pass/Keep
// buttons are a verdict, so they move on. A double tap on the clip itself is
// not -- you are still watching it -- so it rates in place and leaves you
// there, which is also the only way the keep flash is on screen long enough
// to read.
async function rateFeedItem(index, rating, advance = true) {
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
  recordRating(item.path, rating, item);
  haptic();

  const article = controls.feedScroller.querySelector(`.feed-item[data-index="${index}"]`);
  if (article) {
    article.dataset.rating = rating;
  }
  if (advance) {
    scrollFeedTo(index + 1);
  }
}

function toggleFeedPlayback() {
  const article = controls.feedScroller.querySelector(`.feed-item[data-index="${state.feed.activeIndex}"]`);
  const video = article?.querySelector("video");
  if (!video) {
    return;
  }
  if (video.paused) {
    applyFeedAudio();
    video.play().catch(() => {});
  } else {
    video.pause();
  }
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

  ["session", "gallery", "mosaic", "feed", "dangerous", "duel", "rediscover"].forEach((mode) => {
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
  ["escalation", "session", "mosaic"].forEach((mode) => {
    state.settings[`${mode}RatingFilter`] = sanitizeRatingFilter(state.settings[`${mode}RatingFilter`], false);
  });
  state.settings.dangerousKind = pick(state.settings.dangerousKind, ["all", "photo", "video"], "all");
  state.settings.duelKind = pick(state.settings.duelKind, ["photos", "videos", "all"], "photos");
  state.settings.duelRatingFilter = RATING_FILTERS.includes(state.settings.duelRatingFilter) ? state.settings.duelRatingFilter : "liked";
  state.settings.rediscoverKind = pick(state.settings.rediscoverKind, ["all", "photos", "videos"], "all");
  state.settings.rediscoverRatingFilter = sanitizeRatingFilter(state.settings.rediscoverRatingFilter, false);
  state.settings.dangerousUnrated = !!state.settings.dangerousUnrated;
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
    ["recent", "oldest", "folder", "name", "largest", "duel"],
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
  document.getElementById("dangerousUnrated").setAttribute("aria-checked", String(!!state.settings.dangerousUnrated));
  paintRanges();
}

/* ==========================================================================
   Choosing what to show next

   Picking an item uniformly at random is not the same as browsing the
   library evenly, because folders are not the same size. In a real library
   the biggest folder can hold 1,000 files and the smallest 12, so uniform
   picking makes the big one 87x more likely and a handful of folders take
   most of the airtime -- every mode ends up replaying the same few.

   So the pick happens in two steps: choose a *folder* first, then an item
   inside it. Every folder then gets the same share of the screen whatever
   its size, and a 12-file folder is no longer invisible. `balancedFolders`
   turns this off and restores flat, per-file random.
   ========================================================================== */

function foldersAreBalanced() {
  return state.settings.balancedFolders !== false;
}

function groupByFolder(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.folder || "";
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

function randomOf(items) {
  return items.length ? items[Math.floor(Math.random() * items.length)] : null;
}

// One item, chosen folder-first. `recentPaths` is skipped where it can be,
// and folders holding a recent pick are deprioritised so the wall/stream
// moves on to a different folder rather than digging through the same one.
function pickBalanced(items, recentPaths, avoidPath) {
  if (!items.length) {
    return null;
  }
  if (!foldersAreBalanced()) {
    return pickFlat(items, recentPaths, avoidPath);
  }

  const recent = new Set(recentPaths || []);
  const groups = groupByFolder(items);

  // Folders still holding something unseen, keyed to those items so the
  // choice of folder and the choice of item do not filter the list twice.
  const fresh = new Map();
  for (const [folder, bucket] of groups) {
    const unseen = bucket.filter((item) => !recent.has(item.path) && item.path !== avoidPath);
    if (unseen.length) {
      fresh.set(folder, unseen);
    }
  }

  // Everything has been seen recently: fall back to any folder, then to any
  // item in it, rather than returning nothing.
  const pool = fresh.size ? fresh : groups;
  const folder = [...pool.keys()][Math.floor(Math.random() * pool.size)];
  const bucket = pool.get(folder);
  const notCurrent = bucket.filter((item) => item.path !== avoidPath);
  return randomOf(notCurrent.length ? notCurrent : bucket);
}

function pickFlat(items, recentPaths, avoidPath) {
  const recent = new Set(recentPaths || []);
  let candidates = items.filter((item) => !recent.has(item.path) && item.path !== avoidPath);
  if (!candidates.length) {
    candidates = items.filter((item) => item.path !== avoidPath);
  }
  if (!candidates.length) {
    candidates = items;
  }
  return randomOf(candidates);
}

function pickWithoutRepeats(items, recentPaths, avoidPath) {
  return pickBalanced(items, recentPaths, avoidPath);
}

function pickRandom(items, avoidPath) {
  return pickBalanced(items, avoidPath ? [avoidPath] : [], avoidPath);
}

function mediaUrl(path) {
  // A new representation key prevents mixing old cached MP4 ranges with
  // the virtual fast-start byte layout after an upgrade.
  return `/media?path=${encodeURIComponent(path)}&v=3`;
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

// Transient messages. They used to be written into the swipe/escalation
// status lines, where the next render overwrote them unseen.
function setStatus(message) {
  if (state.libraryReady) {
    toast(message);
  } else {
    controls.setupMessage.textContent = message;
  }
}

// A short buzz on phones that support it, so a rating is felt as well as seen.
function haptic() {
  try {
    navigator.vibrate?.(12);
  } catch (error) {
    /* optional */
  }
}

function syncLibraryChrome() {
  const setupOpen = !state.libraryReady || state.setupVisible;
  const themeOpen = state.libraryReady && state.themePanelVisible;
  controls.setupPanel.hidden = !setupOpen;
  controls.themePanel.hidden = !themeOpen;
  controls.mainContent.hidden = !state.libraryReady;
  controls.rescanButton.disabled = !state.libraryReady;
  // The launcher is the only way to change mode, so it lives and dies with
  // the library the same way the tab bar used to.
  controls.modeMenuButton.hidden = !state.libraryReady;
  controls.themeButton.hidden = !state.libraryReady;
  setButtonLabel(controls.themeButton, themeOpen ? "Close settings" : "Settings", themeOpen ? "i-close" : "i-gear");
  controls.themeButton.classList.toggle("active", themeOpen);
  controls.themeButton.setAttribute("aria-expanded", String(themeOpen));
  // Closing the picker is only an option once there is a library to go back to.
  controls.setupCloseButton.hidden = !state.libraryReady;
  controls.mediaDirInput.value = state.currentMediaDirectory || "";
  controls.hubLibraryPath.textContent = state.currentMediaDirectory
    ? `${state.currentMediaDirectory} — updated ${formatTimestamp(state.library.updatedAt)}`
    : "No media folder selected yet.";

  if (state.libraryReady) {
    controls.libraryMeta.textContent = `${state.currentMediaDirectory} | updated ${formatTimestamp(state.library.updatedAt)}`;
    controls.setupMessage.textContent = "Pick a folder path or tap a quick pick to switch libraries.";
    return;
  }

  stopCornerClips();
  stopEscalation();
  pauseToktinderVideo();
  if (state.currentMediaDirectory) {
    controls.libraryMeta.textContent = `${state.currentMediaDirectory} | unavailable`;
    controls.setupMessage.textContent =
      "That folder is unavailable right now. Reconnect the drive; it will load automatically. You can also choose another folder.";
  } else {
    controls.libraryMeta.textContent = "No media folder selected yet.";
    controls.setupMessage.textContent =
      "Choose a folder on your server to start exploring your photos and videos.";
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
    await loadState({ rebuild: true });
  } catch (error) {
    console.error(error);
    controls.setupMessage.textContent = error.message;
  }
}

/* ==========================================================================
   Folder picker

   The library is a tree (64 top-level folders, 55 below them on the real
   drive), so the picker is one too: a group row ticks or unticks everything
   under it, and a row's "Only" button narrows the mode to just that branch.
   Search flattens the tree to matching folders. Saved sets are named
   selections any mode can apply in one tap.

   The saved value keeps its old meaning so every older state.json still
   works: [] is "the whole library", and `folderCleared` is the in-memory
   "I unticked everything to start picking" state in which everything still
   plays until the first box is ticked.
   ========================================================================== */

function renderFolderFilters() {
  FOLDER_MODES.forEach(renderFolderFilter);
}

// How many files sit in each folder, cached per catalog.
let folderCountsCache = null;
let folderCountsKey = "";

function folderCounts() {
  if (folderCountsCache && folderCountsKey === state.librarySignature) {
    return folderCountsCache;
  }
  const counts = new Map();
  for (const key of ["images", "videos"]) {
    for (const item of state.library[key] || []) {
      const folder = item.folder || "";
      counts.set(folder, (counts.get(folder) || 0) + 1);
    }
  }
  folderCountsCache = counts;
  folderCountsKey = state.librarySignature;
  return counts;
}

// The folder list as a tree. Real folders (those holding files) are leaves or
// inner nodes; path prefixes that hold nothing themselves become groups.
let folderTreeCache = null;
let folderTreeKey = "";

function folderTree() {
  const folders = state.library.folders || [];
  const key = `${state.librarySignature}:${folders.length}`;
  if (folderTreeCache && folderTreeKey === key) {
    return folderTreeCache;
  }
  const counts = folderCounts();
  const nodes = new Map();
  const root = { path: null, name: "", children: [], own: false, total: 0, leaves: [] };
  const nodeFor = (path) => {
    if (nodes.has(path)) {
      return nodes.get(path);
    }
    const cut = path.lastIndexOf("/");
    const parent = cut === -1 ? root : nodeFor(path.slice(0, cut));
    const node = { path, name: cut === -1 ? path : path.slice(cut + 1), children: [], own: false, total: 0, leaves: [], parent };
    parent.children.push(node);
    nodes.set(path, node);
    return node;
  };
  folders.forEach((folder) => {
    if (folder === "") {
      const node = { path: "", name: "Library root", children: [], own: true, total: 0, leaves: [], parent: root };
      root.children.unshift(node);
      nodes.set("", node);
    } else {
      nodeFor(folder).own = true;
    }
  });
  // Totals and the real folders under each node, bottom-up.
  const settle = (node) => {
    node.children.forEach(settle);
    node.total = (node.own ? counts.get(node.path) || 0 : 0) + node.children.reduce((sum, child) => sum + child.total, 0);
    node.leaves = [...(node.own ? [node.path] : []), ...node.children.flatMap((child) => child.leaves)];
  };
  settle(root);
  folderTreeCache = { root, nodes };
  folderTreeKey = key;
  return folderTreeCache;
}

function folderViewFor(mode) {
  if (!state.folderView[mode]) {
    state.folderView[mode] = { open: new Set(), sort: "name" };
  }
  return state.folderView[mode];
}

// What is ticked right now, as a Set of real folder paths.
function effectiveFolderSelection(mode) {
  const saved = normalizedFolderSelection(`${mode}Folders`);
  if (saved.length) {
    return new Set(saved);
  }
  return state.folderCleared[mode] ? new Set() : new Set(state.library.folders || []);
}

function commitFolderSelection(mode, selected) {
  const folders = state.library.folders || [];
  const next = folders.filter((folder) => selected.has(folder));
  state.settings[`${mode}Folders`] = next.length === 0 || next.length === folders.length ? [] : next;
  state.folderCleared[mode] = next.length === 0;
  invalidateMediaPools();
  renderFolderFilter(mode);
  queueFolderRefresh(mode);
  queueSettingsSave();
}

// Ticking five folders in a row should restart the stage once, not five times.
const folderRefreshTimers = {};
function queueFolderRefresh(mode) {
  window.clearTimeout(folderRefreshTimers[mode]);
  folderRefreshTimers[mode] = window.setTimeout(() => {
    if (isDeckMode(mode) || mode === "feed" || mode === "dangerous" || state.currentMode === mode) {
      refreshMode(mode);
    } else {
      state.feed.dirty ||= mode === "feed";
    }
    syncDrawerSummaries();
  }, 450);
}

function setFolderSelection(mode, all) {
  commitFolderSelection(mode, all ? new Set(state.library.folders || []) : new Set());
}

function setFoldersChecked(mode, paths, checked) {
  const selected = effectiveFolderSelection(mode);
  paths.forEach((path) => (checked ? selected.add(path) : selected.delete(path)));
  commitFolderSelection(mode, selected);
}

function invertFolderSelection(mode) {
  const selected = effectiveFolderSelection(mode);
  commitFolderSelection(mode, new Set((state.library.folders || []).filter((folder) => !selected.has(folder))));
}

function updateFolderSelection(mode, folder, checked) {
  setFoldersChecked(mode, [folder], checked);
}

// Copy this mode's folder choice to every other mode.
function syncFolderSelectionEverywhere(mode) {
  const value = [...(state.settings[`${mode}Folders`] || [])];
  FOLDER_MODES.forEach((other) => {
    if (other !== mode) {
      state.settings[`${other}Folders`] = [...value];
      state.folderCleared[other] = false;
    }
  });
  invalidateMediaPools();
  renderFolderFilters();
  // Only the decks keep a dealt order off screen; everything else re-picks
  // when entered, so re-dealing them all now would be wasted downloads.
  rebuildDeck("swipe");
  renderDeck("swipe");
  rebuildDeck("toktinder");
  renderDeck("toktinder");
  state.feed.dirty = true;
  dangerous.items = [];
  refreshMode(mode);
  queueSettingsSave();
  toast("Folder selection copied to every mode.");
}

/* ---- saved sets ---- */

function sanitizeFolderSets(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((set) => set && typeof set.name === "string" && Array.isArray(set.folders))
    .map((set) => ({ name: set.name.slice(0, 40), folders: set.folders.filter((f) => typeof f === "string") }))
    .slice(0, 24);
}

function saveFolderSet(mode) {
  const selected = [...effectiveFolderSelection(mode)];
  if (!selected.length) {
    toast("Tick some folders first, then save them as a set.");
    return;
  }
  const name = (window.prompt(`Name this set of ${selected.length} folder${selected.length === 1 ? "" : "s"}:`) || "").trim();
  if (!name) {
    return;
  }
  const sets = sanitizeFolderSets(state.settings.folderSets).filter((set) => set.name !== name);
  sets.push({ name, folders: selected });
  state.settings.folderSets = sets;
  queueSettingsSave();
  renderFolderFilters();
  toast(`Saved “${name}”. It is available in every mode.`);
}

function applyFolderSet(mode, set) {
  const available = new Set(state.library.folders || []);
  const folders = set.folders.filter((folder) => available.has(folder));
  if (!folders.length) {
    toast(`None of the folders in “${set.name}” are in this library.`);
    return;
  }
  commitFolderSelection(mode, new Set(folders));
}

function deleteFolderSet(name) {
  if (!window.confirm(`Delete the folder set “${name}”? Folders and files are not touched.`)) {
    return;
  }
  state.settings.folderSets = sanitizeFolderSets(state.settings.folderSets).filter((set) => set.name !== name);
  queueSettingsSave();
  renderFolderFilters();
}

function renderFolderSets(mode, container, selected) {
  container.replaceChildren();
  if (!(state.library.folders || []).length) {
    return;
  }
  const label = document.createElement("span");
  label.className = "fp-sets-label";
  label.textContent = "Sets";
  container.append(label);
  const sets = sanitizeFolderSets(state.settings.folderSets);
  sets.forEach((set) => {
    const matches = set.folders.length === selected.size && set.folders.every((folder) => selected.has(folder));
    const wrap = document.createElement("span");
    wrap.className = `fp-set${matches ? " active" : ""}`;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = set.name;
    apply.title = `${set.folders.length} folders`;
    apply.addEventListener("click", () => applyFolderSet(mode, set));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Delete set ${set.name}`);
    remove.innerHTML = '<svg aria-hidden="true"><use href="#i-x"/></svg>';
    remove.addEventListener("click", () => deleteFolderSet(set.name));
    wrap.append(apply, remove);
    container.append(wrap);
  });
  const save = document.createElement("button");
  save.type = "button";
  save.className = "chip fp-save";
  save.innerHTML = '<svg aria-hidden="true"><use href="#i-plus"/></svg>Save selection';
  save.addEventListener("click", () => saveFolderSet(mode));
  container.append(save);
}

/* ---- rendering ---- */

function nodeCheckState(node, selected) {
  const ticked = node.leaves.filter((leaf) => selected.has(leaf)).length;
  if (!ticked) {
    return "false";
  }
  return ticked === node.leaves.length ? "true" : "mixed";
}

function highlightMatch(target, text, needle) {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at === -1) {
    target.textContent = text;
    return;
  }
  const mark = document.createElement("mark");
  mark.textContent = text.slice(at, at + needle.length);
  target.append(text.slice(0, at), mark, text.slice(at + needle.length));
}

function buildFolderRow(mode, node, depth, selected, { needle = "", flat = false } = {}) {
  const row = document.createElement("div");
  const isGroup = !flat && node.children.length > 0;
  const view = folderViewFor(mode);
  row.className = `fp-row${isGroup ? " is-group" : ""}`;
  row.style.setProperty("--depth", String(depth));
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-checked", nodeCheckState(node, selected));
  if (isGroup) {
    row.setAttribute("aria-expanded", String(view.open.has(node.path)));
    const twisty = document.createElement("button");
    twisty.type = "button";
    twisty.className = "fp-twisty";
    twisty.setAttribute("aria-label", `${view.open.has(node.path) ? "Collapse" : "Expand"} ${node.name}`);
    twisty.innerHTML = '<svg aria-hidden="true"><use href="#i-right"/></svg>';
    twisty.addEventListener("click", () => {
      view.open.has(node.path) ? view.open.delete(node.path) : view.open.add(node.path);
      renderFolderFilter(mode);
    });
    row.append(twisty);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "fp-spacer";
    row.append(spacer);
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fp-toggle";
  const box = document.createElement("span");
  box.className = "fp-box";
  box.innerHTML = '<svg aria-hidden="true"><use href="#i-check"/></svg>';
  const label = document.createElement("span");
  label.className = "fp-label";
  const name = document.createElement("span");
  name.className = "fp-name";
  highlightMatch(name, node.name, needle);
  label.append(name);
  if (flat && node.path && node.path.includes("/")) {
    const parent = document.createElement("span");
    parent.className = "fp-path";
    parent.textContent = node.path.slice(0, node.path.lastIndexOf("/"));
    label.append(parent);
  } else if (isGroup) {
    const sub = document.createElement("span");
    sub.className = "fp-path";
    const inside = node.leaves.length - (node.own ? 1 : 0);
    sub.textContent = `${inside} folder${inside === 1 ? "" : "s"} inside`;
    label.append(sub);
  }
  const count = document.createElement("span");
  count.className = "fp-count";
  count.textContent = node.total.toLocaleString();
  toggle.append(box, label, count);
  toggle.addEventListener("click", () => {
    setFoldersChecked(mode, node.leaves, row.getAttribute("aria-checked") !== "true");
  });
  row.append(toggle);

  const only = document.createElement("button");
  only.type = "button";
  only.className = "fp-only";
  only.textContent = "Only";
  only.setAttribute("aria-label", `Only ${node.name}`);
  only.addEventListener("click", () => commitFolderSelection(mode, new Set(node.leaves)));
  row.append(only);
  return row;
}

function sortedChildren(node, sort) {
  const children = [...node.children];
  if (sort === "count") {
    children.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  } else {
    children.sort((a, b) => (a.path === "" ? -1 : b.path === "" ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true })));
  }
  return children;
}

function renderFolderFilter(mode) {
  const folders = state.library.folders || [];
  const container = controls[`${mode}FolderFilters`];
  const summary = controls[`${mode}FolderSummary`];
  const search = controls[`${mode}FolderSearch`];
  const panel = document.getElementById(`${mode}FolderPanel`);
  const badge = document.getElementById(`${mode}FolderBadge`);
  if (!container || !summary) {
    return;
  }

  const selected = effectiveFolderSelection(mode);
  const cleared = !!state.folderCleared[mode] && !selected.size;
  const all = selected.size === folders.length;
  const counts = folderCounts();
  const totalFiles = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const pickedFiles = [...selected].reduce((sum, folder) => sum + (counts.get(folder) || 0), 0);

  if (badge) {
    badge.textContent = !folders.length || all || cleared ? "All" : `${selected.size}/${folders.length}`;
    badge.classList.toggle("filtered", !!folders.length && !all && !cleared);
  }

  if (!state.libraryReady || !folders.length) {
    summary.textContent = "No folders found yet.";
    container.replaceChildren();
    return;
  }

  summary.innerHTML = "";
  if (cleared) {
    summary.append("Nothing ticked yet — ");
    const dim = document.createElement("span");
    dim.className = "fp-dim";
    dim.textContent = "everything still plays until you pick a folder.";
    summary.append(dim);
  } else {
    const strong = document.createElement("b");
    strong.textContent = all ? `All ${folders.length} folders` : `${selected.size} of ${folders.length} folders`;
    const dim = document.createElement("span");
    dim.className = "fp-dim";
    dim.textContent = ` · ${pickedFiles.toLocaleString()} of ${totalFiles.toLocaleString()} files`;
    summary.append(strong, dim);
  }
  const meter = panel?.querySelector(".fp-meter i");
  if (meter) {
    meter.style.width = `${cleared ? 100 : totalFiles ? Math.round((pickedFiles / totalFiles) * 100) : 0}%`;
  }

  const view = folderViewFor(mode);
  const sortButton = panel?.querySelector('[data-fp="sort"]');
  if (sortButton) {
    sortButton.textContent = view.sort === "count" ? "Most files" : "A–Z";
  }
  const { root } = folderTree();
  const hasGroups = root.children.some((child) => child.children.length);
  const expandButton = panel?.querySelector('[data-fp="expand"]');
  if (expandButton) {
    expandButton.hidden = !hasGroups;
    const anyClosed = [...folderTree().nodes.values()].some((node) => node.children.length && !view.open.has(node.path));
    expandButton.textContent = anyClosed ? "Expand all" : "Collapse all";
  }
  panel?.querySelector('[data-fp-id="FoldersAllButton"]')?.classList.toggle("active", all);
  panel?.querySelector('[data-fp-id="FoldersNoneButton"]')?.classList.toggle("active", cleared);
  const sets = panel?.querySelector('[data-fp="sets"]');
  if (sets) {
    renderFolderSets(mode, sets, selected);
  }

  const scrollHost = container.closest(".drawer-body");
  const scrollTop = scrollHost?.scrollTop || 0;
  const fragment = document.createDocumentFragment();
  const needle = (search?.value || "").trim().toLowerCase();
  if (needle) {
    const matches = [...folderTree().nodes.values()]
      .filter((node) => node.path !== null && node.name.toLowerCase().includes(needle))
      .sort((a, b) => (view.sort === "count" ? b.total - a.total : 0) || a.path.localeCompare(b.path));
    search.placeholder = `Search ${folders.length} folders`;
    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "fp-empty";
      empty.textContent = `No folder matches “${search.value.trim()}”.`;
      fragment.append(empty);
    }
    matches.forEach((node) => fragment.append(buildFolderRow(mode, node, 0, selected, { needle, flat: true })));
  } else {
    const walk = (node, depth) => {
      sortedChildren(node, view.sort).forEach((child) => {
        fragment.append(buildFolderRow(mode, child, depth, selected));
        if (child.children.length && view.open.has(child.path)) {
          walk(child, depth + 1);
        }
      });
    };
    walk(root, 0);
  }
  if (search) {
    search.placeholder = `Search ${folders.length} folders`;
  }
  container.replaceChildren(fragment);
  if (scrollHost) {
    scrollHost.scrollTop = scrollTop;
  }
}

function bindFolderPicker(mode) {
  const panel = document.getElementById(`${mode}FolderPanel`);
  if (!panel) {
    return;
  }
  panel.querySelector('[data-fp="invert"]').addEventListener("click", () => invertFolderSelection(mode));
  panel.querySelector('[data-fp="sort"]').addEventListener("click", () => {
    const view = folderViewFor(mode);
    view.sort = view.sort === "name" ? "count" : "name";
    renderFolderFilter(mode);
  });
  panel.querySelector('[data-fp="expand"]').addEventListener("click", () => {
    const view = folderViewFor(mode);
    const groups = [...folderTree().nodes.values()].filter((node) => node.children.length);
    const anyClosed = groups.some((node) => !view.open.has(node.path));
    view.open = anyClosed ? new Set(groups.map((node) => node.path)) : new Set();
    renderFolderFilter(mode);
  });
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

// A mode's own slice of the library: its folders and its Show filter.
function modeSource(mode, key) {
  const selectedFolders = normalizedFolderSelection(`${mode}Folders`);
  const filter = ratingFilterValue(`${mode}RatingFilter`);
  return (state.library[key] || []).filter(
    (item) => matchesFolderSelection(item, selectedFolders) && matchesRatingFilter(item, filter)
  );
}

function getEscalationImages() {
  return modeSource("escalation", "images");
}

function getEscalationVideos() {
  return modeSource("escalation", "videos");
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
  const chosen = pickBalanced(items, recentPaths, controls.escalationStage?.dataset.path);
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
  if (THEMES.has(value)) {
    return value;
  }
  return LEGACY_THEMES[value] || "dark";
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

// The deck and the feed are shuffled once and then walked in order, so a flat
// shuffle has the same problem as a flat pick: the first hundred cards mirror
// the library's folder sizes, and the big folders bury the rest. This deals
// the deck folder by folder instead -- one card from each folder per round,
// with the folder order reshuffled every round -- so the first N cards come
// from N different folders and a small folder shows up just as early as a
// large one. Folders run out at different points; those simply drop out.
function shuffleBalanced(items) {
  if (!foldersAreBalanced() || items.length < 2) {
    shuffleArray(items);
    return;
  }

  const groups = groupByFolder(items);
  if (groups.size < 2) {
    shuffleArray(items);
    return;
  }

  const buckets = [...groups.values()];
  buckets.forEach(shuffleArray);

  const dealt = [];
  while (buckets.length) {
    shuffleArray(buckets);
    for (let index = buckets.length - 1; index >= 0; index -= 1) {
      dealt.push(buckets[index].pop());
      if (!buckets[index].length) {
        buckets.splice(index, 1);
      }
    }
  }

  // Written back in place: callers hold a reference to this same array.
  items.length = 0;
  items.push(...dealt);
}


/* Navigation, mixed-media sorting, and media readiness UI. No dependencies. */
const dangerous = { items: [], index: 0, library: "", history: [], busy: false,
  kept: 0, deleted: 0, drag: null, preloader: null };
const el = id => document.getElementById(id);
MODE_CARDS.push({ mode: "duel", name: "Duel",
  blurb: "Two at a time — pick the better one. Builds a real ranking of your favorites.",
  icon: "M4 5h7v14H4zM13 5h7v14h-7z", stat: () => (duel.ratings ? `${Object.keys(duel.ratings).length.toLocaleString()} ranked` : "rank your keeps") });
MODE_CARDS.push({ mode: "rediscover", name: "Rediscover",
  blurb: "Never-seen files first, then whatever you have not looked at for longest.",
  icon: "M12 4a8 8 0 1 1-7.4 5M4 4v5h5M12 8v4l3 2", stat: () => "oldest first" });
MODE_CARDS.push({ mode: "dangerous", name: "Dangerous",
  blurb: "Clean up. Swipe left moves the file to trash, right keeps it.",
  icon: "M12 3l9 17H3zM12 9v5M12 17v1", stat: () => (state.canTrash ? "keep / delete" : "read-only drive") });
const workspaceNames = { home: "Overview", duel: "Duel", rediscover: "Rediscover", swipe: "Photo deck", toktinder: "Video deck",
  escalation: "Escalation", session: "Session", gallery: "Gallery", ranked: "Collection",
  mosaic: "Mosaic", feed: "Feed", dangerous: "Dangerous" };
// One grouping for the sidebar, the overview and the mode picker.
const MODE_GROUPS = [
  { label: "Sort & rate", modes: ["swipe", "toktinder", "feed", "rediscover", "dangerous"] },
  { label: "Sit back", modes: ["escalation", "mosaic", "session"] },
  { label: "Your library", modes: ["gallery", "ranked", "duel"] },
];
const MODE_TONES = { duel: "warm", rediscover: "violet", mosaic: "violet", escalation: "warm", session: "warm", dangerous: "danger" };
const workspaceEyebrows = { home: "Your library", duel: "Your library", rediscover: "Sort & rate", swipe: "Sort & rate", toktinder: "Sort & rate", feed: "Sort & rate",
  dangerous: "Sort & rate", mosaic: "Sit back", escalation: "Sit back", session: "Sit back",
  gallery: "Your library", ranked: "Your library" };

function modeKey(mode) {
  const index = ALL_MODES.indexOf(mode);
  return index === -1 || index > 9 ? "" : index === 9 ? "0" : String(index + 1);
}

function initWorkspace() {
  MODE_GROUPS.forEach(({ label, modes }) => {
    const heading = document.createElement("p");
    heading.className = "nav-label";
    heading.textContent = label;
    el("workspaceLinks").append(heading);
    modes.forEach(mode => {
      const card = MODE_CARDS.find(c => c.mode === mode);
      const button = document.createElement("button");
      button.className = "workspace-link";
      button.dataset.mode = mode;
      button.title = `${workspaceNames[mode]} (${modeKey(mode)})`;
      button.setAttribute("aria-label", workspaceNames[mode]);
      button.innerHTML = `${modeIcon(card)}<span>${workspaceNames[mode]}</span><kbd>${modeKey(mode)}</kbd>`;
      button.addEventListener("click", () => setMode(mode));
      el("workspaceLinks").append(button);
    });
  });
  el("overviewButton").title = "Overview";
  el("overviewButton").setAttribute("aria-label", "Overview");
  el("overviewButton").addEventListener("click", () => setMode("home"));
  el("workspaceHome").addEventListener("click", () => setMode("home"));
  el("homeSettings").addEventListener("click", () => setMode("gallery"));
  el("continueButton").addEventListener("click", () => setMode(state.settings.lastMode || "swipe"));

  // Each mode's tools live in the top bar, so the stage gets that row back.
  document.querySelectorAll(".mode-panel .stage-toolbar").forEach(toolbar => {
    toolbar.dataset.mode = toolbar.closest(".mode-panel").id.replace(/Mode$/, "");
    controls.modeTools.append(toolbar);
  });
  renderOverview();

  // Dangerous: its settings now live in a control center like every mode.
  el("dangerousUndo").addEventListener("click", undoDangerous);
  el("dangerousKeep").addEventListener("click", () => actDangerous("keep"));
  el("dangerousDelete").addEventListener("click", () => actDangerous("delete"));
  el("dangerousSkip").addEventListener("click", () => actDangerous("skip"));
  el("dangerousShuffle").addEventListener("click", () => { startDangerous(true); closeDrawers(); });
  el("dangerousSound").addEventListener("click", () => {
    toggleVideoAudio();
    el("dangerousVideo").muted = !state.audioUnlocked;
    if (!el("dangerousVideo").hidden) el("dangerousVideo").play().catch(() => {});
  });
  bindSegmented(el("dangerousKind"), "dangerousKind", (value) => {
    state.settings.dangerousKind = value;
    syncSegmented(el("dangerousKind"), "dangerousKind", value);
    queueSettingsSave();
    startDangerous(true);
  });
  el("dangerousUnrated").addEventListener("click", () => {
    state.settings.dangerousUnrated = !state.settings.dangerousUnrated;
    el("dangerousUnrated").setAttribute("aria-checked", String(state.settings.dangerousUnrated));
    queueSettingsSave();
    startDangerous(true);
  });
  el("dangerousVideo").addEventListener("loadedmetadata", () => {
    if (state.currentMode === "dangerous") playWhenReady(el("dangerousVideo"), el("dangerousVideo").dataset.loadToken);
  });
  el("dangerousImage").addEventListener("load", preloadDangerous);
  el("dangerousVideo").addEventListener("loadeddata", preloadDangerous);
  const card = el("dangerousCard");
  card.addEventListener("pointerdown", event => {
    if (event.button !== 0 || dangerous.busy || event.target.closest("button")) return;
    // Leave the bottom native-video transport available for seeking.
    if (event.target.tagName === "VIDEO" && event.offsetY > event.target.clientHeight - 65) return;
    dangerous.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0 };
    card.setPointerCapture(event.pointerId);
  });
  card.addEventListener("pointermove", event => {
    const drag = dangerous.drag;
    if (!drag || drag.id !== event.pointerId) return;
    drag.dx = event.clientX - drag.x;
    card.style.transform = `translateX(${drag.dx * 0.55}px) rotate(${drag.dx / 45}deg)`;
    card.style.setProperty("--delete-opacity", Math.min(1, -drag.dx / 110));
    card.style.setProperty("--keep-opacity", Math.min(1, drag.dx / 110));
  });
  const finish = event => {
    const drag = dangerous.drag;
    dangerous.drag = null;
    card.style.transform = "";
    card.style.removeProperty("--delete-opacity");
    card.style.removeProperty("--keep-opacity");
    if (drag && event.type === "pointerup" && Math.abs(drag.dx) > Math.min(100, card.clientWidth * .22)) {
      actDangerous(drag.dx > 0 ? "keep" : "delete");
    }
  };
  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
  window.addEventListener("pagehide", () => flushSeen(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSeen(true);
    if (!document.hidden && state.currentMode === "dangerous" && !el("dangerousVideo").hidden) {
      playWhenReady(el("dangerousVideo"), el("dangerousVideo").dataset.loadToken);
    }
    syncWakeLock();
  });
  el("showTrash").addEventListener("click", reviewTrash);

  // Immersive chrome wakes on any interaction and fades when left alone.
  ["pointermove", "pointerdown", "keydown", "touchstart"].forEach(type =>
    window.addEventListener(type, wakeIdle, { passive: true }));
  LANDSCAPE_PHONE.addEventListener?.("change", syncImmersive);
  document.addEventListener("fullscreenchange", () => {
    // The browser's own Esc leaves fullscreen; leave focus with it.
    if (!document.fullscreenElement && state.focusMode) {
      state.focusMode = false;
      syncFocusMode();
    }
  });
  setupMediaFeedback();
  setupPanelAccessibility();
  bindLightboxGestures();
}

function syncWorkspace() {
  const mode = state.currentMode;
  document.body.dataset.mode = mode;
  document.body.classList.toggle("offline", !state.libraryReady);
  syncModeMenuButton();
  el("workspaceTitle").textContent = workspaceNames[mode] || "Your library";
  el("workspaceEyebrow").textContent = workspaceEyebrows[mode] || "Your library";
  document.title = mode === "home" ? "Edging Heaven" : `${workspaceNames[mode]} · Heaven`;
  controls.modeTools.querySelectorAll(".stage-toolbar").forEach(toolbar => {
    toolbar.classList.toggle("active", toolbar.dataset.mode === mode && state.libraryReady);
  });
  document.querySelectorAll(".workspace-link").forEach(button => {
    button.classList.toggle("active", button.dataset.mode === mode);
    button.setAttribute("aria-current", button.dataset.mode === mode ? "page" : "false");
    button.disabled = !state.libraryReady;
  });
  el("connectionLabel").textContent = state.libraryReady ? "Library connected" : "Library offline";
  const rated = countOf("liked") + Number(state.library.counts?.disliked || 0);
  el("hubStats").replaceChildren();
  [[countOf("images"), "Photos"], [countOf("videos"), "Videos"], [countOf("liked"), "Kept"], [rated, "Rated"]].forEach(([value, label]) => {
    const tile = document.createElement("div");
    tile.innerHTML = `<strong>${value.toLocaleString()}</strong><span>${label}</span>`;
    el("hubStats").append(tile);
  });
  el("dangerousReadOnly").hidden = state.canTrash;
  syncOverview();
}

/* ==========================================================================
   Seen times

   Every file that is put on screen anywhere is noted, in batches, so
   Rediscover can order the library by how long it has been since you last
   looked. Held locally too, so the current visit counts straight away.
   ========================================================================== */

const seenState = { map: new Map(), loaded: false, loading: null, pending: new Set(), timer: 0 };

function markSeen(path) {
  if (!path) {
    return;
  }
  seenState.map.set(path, Math.floor(Date.now() / 1000));
  seenState.pending.add(path);
  if (!seenState.timer) {
    seenState.timer = window.setTimeout(flushSeen, 15000);
  }
}

function flushSeen(useBeacon = false) {
  window.clearTimeout(seenState.timer);
  seenState.timer = 0;
  if (!seenState.pending.size) {
    return;
  }
  const paths = [...seenState.pending].slice(0, 500);
  paths.forEach((path) => seenState.pending.delete(path));
  const body = JSON.stringify({ paths });
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/seen", new Blob([body], { type: "application/json" }));
  } else {
    fetch("/api/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  }
  if (seenState.pending.size) {
    seenState.timer = window.setTimeout(flushSeen, 2000);
  }
}

async function loadSeen() {
  if (seenState.loaded) {
    return;
  }
  seenState.loading ||= fetchJson("/api/seen")
    .then((payload) => {
      Object.entries(payload.seen || {}).forEach(([path, stamp]) => {
        if (!seenState.map.has(path)) seenState.map.set(path, stamp);
      });
    })
    .catch(() => {})
    .finally(() => {
      seenState.loaded = true;
    });
  await seenState.loading;
}

function seenAt(path) {
  return seenState.map.get(path) || 0;
}

function timeAgo(epochSeconds) {
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [name, size] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${name}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/* ==========================================================================
   Duel

   Two files side by side; tap (or ←/→) the better one. Each pick is an Elo
   match on the server, so after a few dozen picks the order says which
   favorites are actually the favorites -- something a like can never do.
   Pairs are chosen to be informative: one side is a file with few duels,
   the other is close to it in rating.
   ========================================================================== */

const duel = { ratings: null, loading: null, pair: [], recent: [], history: [], busy: false, count: 0, bound: false };

async function loadDuelRatings(force = false) {
  if (duel.ratings && !force) {
    return;
  }
  if (force) duel.loading = null;
  duel.loading ||= fetchJson("/api/duel")
    .then((payload) => {
      duel.ratings = payload.ratings || {};
    })
    .catch(() => {
      duel.ratings = duel.ratings || {};
    });
  await duel.loading;
}

function duelRating(path) {
  return duel.ratings?.[path] || { r: 1500, n: 0 };
}

function duelPool() {
  const kind = state.settings.duelKind || "photos";
  return mediaPool(`duel:${kind}`, () => [
    ...(kind !== "videos" ? modeSource("duel", "images").map((item) => ({ ...item, kind: "photo" })) : []),
    ...(kind !== "photos" ? modeSource("duel", "videos").map((item) => ({ ...item, kind: "video" })) : []),
  ]);
}

function pickDuelPair() {
  const pool = duelPool();
  if (pool.length < 2) {
    return null;
  }
  const recent = new Set(duel.recent);
  const sample = (count) => Array.from({ length: Math.min(count, pool.length * 2) }, () => pool[Math.floor(Math.random() * pool.length)]);
  const fresh = (list) => list.filter((item) => !recent.has(item.path));
  let firstPool = fresh(sample(14));
  if (!firstPool.length) firstPool = sample(14);
  const first = firstPool.sort((a, b) => duelRating(a.path).n - duelRating(b.path).n)[0];
  const target = duelRating(first.path).r;
  let secondPool = fresh(sample(20)).filter((item) => item.path !== first.path);
  if (!secondPool.length) secondPool = pool.filter((item) => item.path !== first.path);
  secondPool.sort((a, b) => Math.abs(duelRating(a.path).r - target) - Math.abs(duelRating(b.path).r - target));
  const second = secondPool[Math.floor(Math.random() * Math.min(3, secondPool.length))];
  return Math.random() < 0.5 ? [first, second] : [second, first];
}

function duelSides() {
  return [document.getElementById("duelLeft"), document.getElementById("duelRight")];
}

function bindDuel() {
  if (duel.bound) return;
  duel.bound = true;
  duelSides().forEach((side, index) => side.addEventListener("click", () => pickDuelWinner(index)));
  el("duelSkipButton").addEventListener("click", nextDuel);
  el("duelShuffleButton").addEventListener("click", () => { nextDuel(); closeDrawers(); });
  el("duelUndoButton").addEventListener("click", undoDuel);
  bindSegmented(el("duelKind"), "duelKind", (value) => {
    state.settings.duelKind = value;
    syncSegmented(el("duelKind"), "duelKind", value);
    invalidateMediaPools();
    queueSettingsSave();
    nextDuel();
    syncDrawerSummaries();
  });
  el("duelLeadersOpen").addEventListener("click", () => {
    state.settings.rankedSort = "duel";
    queueSettingsSave();
    setMode("ranked");
  });
  el("duelResetButton").addEventListener("click", async () => {
    if (!window.confirm("Forget every duel result? Likes and dislikes stay.")) return;
    const cleared = Object.fromEntries(Object.keys(duel.ratings || {}).map((path) => [path, null]));
    try {
      await postJson("/api/duel-restore", { ratings: cleared });
      duel.ratings = {};
      duel.history = [];
      renderDuelLeaders();
      nextDuel();
      toast("Duel ranking reset.");
    } catch (error) {
      toast(error.message);
    }
  });
}

async function startDuel() {
  bindDuel();
  syncSegmented(el("duelKind"), "duelKind", state.settings.duelKind || "photos");
  await loadDuelRatings();
  if (state.currentMode !== "duel") return;
  if (duel.pair.length === 2 && duel.pair.every((item) => duelPool().some((entry) => entry.path === item.path))) {
    renderDuel();
  } else {
    nextDuel();
  }
}

function nextDuel() {
  if (state.currentMode !== "duel") return;
  duel.pair = pickDuelPair() || [];
  duel.pair.forEach((item) => {
    duel.recent.push(item.path);
    markSeen(item.path);
  });
  duel.recent = duel.recent.slice(-12);
  renderDuel();
}

function renderDuel() {
  const empty = duel.pair.length < 2;
  el("duelEmpty").hidden = !empty;
  if (empty) {
    const filter = ratingFilterValue("duelRatingFilter");
    el("duelEmptyText").textContent = filter === "liked"
      ? "Duel compares what you have kept, and there are fewer than two. Keep a few more in the decks, or set Show to All under Adjust."
      : "Duel needs at least two files in the chosen folders.";
  }
  duelSides().forEach((side, index) => {
    const item = duel.pair[index];
    const image = side.querySelector("img");
    const video = side.querySelector("video");
    side.hidden = empty;
    side.classList.remove("won", "lost");
    if (!item) {
      releaseVideo(video);
      image.removeAttribute("src");
      return;
    }
    const isVideo = item.kind === "video";
    image.hidden = isVideo;
    video.hidden = !isVideo;
    if (isVideo) {
      image.removeAttribute("src");
      video.muted = true;
      const token = loadVideoSource(video, item);
      video.addEventListener("loadedmetadata", () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        playWhenReady(video, token, duration > 6 ? duration * (0.2 + Math.random() * 0.5) : 0);
      }, { once: true });
    } else {
      releaseVideo(video);
      image.dataset.path = item.path;
      image.src = mediaUrl(item.path);
    }
    const rating = duelRating(item.path);
    side.querySelector(".duel-caption strong").textContent = item.name;
    side.querySelector(".duel-caption small").textContent = rating.n
      ? `${Math.round(rating.r)} · ${plural(rating.n, "duel", "duels")}`
      : "first duel";
    side.title = item.path;
  });
  el("duelProgress").textContent = duel.count ? `${duel.count} picked` : "";
  el("duelUndoButton").disabled = !duel.history.length || duel.busy;
  renderDuelLeaders();
  syncDrawerSummaries();
}

async function pickDuelWinner(index) {
  if (duel.busy || duel.pair.length < 2 || state.currentMode !== "duel") return;
  const winner = duel.pair[index];
  const loser = duel.pair[1 - index];
  duel.busy = true;
  const sides = duelSides();
  sides[index].classList.add("won");
  sides[1 - index].classList.add("lost");
  haptic();
  let saved = false;
  try {
    const result = await postJson("/api/duel", { winner: winner.path, loser: loser.path });
    Object.assign(duel.ratings, result.ratings);
    duel.history.push({ before: result.before, pair: [...duel.pair] });
    duel.history = duel.history.slice(-40);
    duel.count += 1;
    saved = true;
  } catch (error) {
    toast("Could not save that pick. If the server was just updated, it needs a restart.");
  }
  window.setTimeout(() => {
    duel.busy = false;
    if (saved) nextDuel();
    else renderDuel();
  }, REDUCED_MOTION.matches ? 0 : 420);
}

async function undoDuel() {
  const entry = duel.history.at(-1);
  if (!entry || duel.busy) return;
  duel.busy = true;
  try {
    await postJson("/api/duel-restore", { ratings: entry.before });
    Object.entries(entry.before).forEach(([path, value]) => {
      if (value) duel.ratings[path] = value;
      else delete duel.ratings[path];
    });
    duel.history.pop();
    duel.count = Math.max(0, duel.count - 1);
    duel.pair = entry.pair;
    toast("Last pick undone.");
  } catch (error) {
    toast(error.message);
  } finally {
    duel.busy = false;
    renderDuel();
  }
}

function duelLeaders(limit) {
  const available = new Map(duelPool().map((item) => [item.path, item]));
  return Object.entries(duel.ratings || {})
    .filter(([path, rating]) => available.has(path) && rating.n >= 2)
    .sort((a, b) => b[1].r - a[1].r)
    .slice(0, limit)
    .map(([path, rating]) => ({ item: available.get(path), rating }));
}

function renderDuelLeaders() {
  const list = el("duelLeaders");
  if (!list) return;
  list.replaceChildren();
  const leaders = duelLeaders(8);
  if (!leaders.length) {
    const empty = document.createElement("li");
    empty.className = "subtle";
    empty.textContent = "Pick a few winners and the top of your ranking appears here.";
    list.append(empty);
    return;
  }
  leaders.forEach(({ item, rating }) => {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = item.name;
    name.title = item.path;
    const score = document.createElement("b");
    score.textContent = Math.round(rating.r);
    row.append(name, score);
    list.append(row);
  });
}

/* ==========================================================================
   Rediscover

   A mixed deck ordered by neglect: files never shown anywhere in the app
   first (folder-balanced), then the ones you have not seen for longest.
   Keep / Pass / Skip rate exactly like the other decks.
   ========================================================================== */

const rediscover = { items: [], index: 0, history: [], bound: false, loadingDeal: false };
const REDISCOVER_DEAL = 400;

function bindRediscover() {
  if (rediscover.bound) return;
  rediscover.bound = true;
  el("rediscoverKeep").addEventListener("click", () => actRediscover("keep"));
  el("rediscoverPass").addEventListener("click", () => actRediscover("pass"));
  el("rediscoverSkip").addEventListener("click", () => actRediscover("skip"));
  el("rediscoverUndoButton").addEventListener("click", undoRediscover);
  el("rediscoverRefresh").addEventListener("click", () => { startRediscover(true); closeDrawers(); });
  el("rediscoverSound").addEventListener("click", () => {
    toggleVideoAudio();
    const video = el("rediscoverVideo");
    video.muted = !state.audioUnlocked;
    if (!video.hidden) video.play().catch(() => {});
  });
  bindSegmented(el("rediscoverKind"), "rediscoverKind", (value) => {
    state.settings.rediscoverKind = value;
    syncSegmented(el("rediscoverKind"), "rediscoverKind", value);
    invalidateMediaPools();
    queueSettingsSave();
    startRediscover(true);
  });
  const card = el("rediscoverCard");
  card.addEventListener("pointerdown", onSwipePointerDown);
  card.addEventListener("pointermove", onSwipePointerMove);
  card.addEventListener("pointerup", onSwipePointerUp);
  card.addEventListener("pointercancel", resetSwipeCard);
  card.dataset.swipeMode = "rediscover";
  el("rediscoverVideo").addEventListener("loadedmetadata", () => {
    const video = el("rediscoverVideo");
    if (state.currentMode === "rediscover") playWhenReady(video, video.dataset.loadToken, null);
  });
}

async function startRediscover(rebuild = false) {
  bindRediscover();
  syncSegmented(el("rediscoverKind"), "rediscoverKind", state.settings.rediscoverKind || "all");
  if (!seenState.loaded) {
    el("rediscoverStatus").textContent = "Looking up what you have seen…";
    await loadSeen();
    if (state.currentMode !== "rediscover") return;
  }
  if (rebuild || !rediscover.items.length) {
    const kind = state.settings.rediscoverKind || "all";
    const items = [
      ...(kind !== "videos" ? modeSource("rediscover", "images").map((item) => ({ ...item, kind: "photo" })) : []),
      ...(kind !== "photos" ? modeSource("rediscover", "videos").map((item) => ({ ...item, kind: "video" })) : []),
    ];
    const never = items.filter((item) => !seenAt(item.path));
    shuffleBalanced(never);
    const seen = items.filter((item) => seenAt(item.path)).sort((a, b) => seenAt(a.path) - seenAt(b.path));
    rediscover.items = [...never, ...seen].slice(0, REDISCOVER_DEAL);
    // Remember what each card said when dealt; seeing it now changes the map.
    rediscover.items.forEach((item) => { item.lastSeen = seenAt(item.path); });
    rediscover.index = 0;
    rediscover.history = [];
  }
  renderRediscover();
}

function currentRediscoverItem() {
  return rediscover.items[rediscover.index] || null;
}

function renderRediscover() {
  if (state.currentMode !== "rediscover") return;
  const item = currentRediscoverItem();
  const image = el("rediscoverImage");
  const video = el("rediscoverVideo");
  const isVideo = item?.kind === "video";
  el("rediscoverEmpty").hidden = !!item;
  image.hidden = !item || isVideo;
  video.hidden = !item || !isVideo;
  resetSwipeCard("rediscover");
  if (!isVideo) releaseVideo(video);
  if (!item || isVideo) image.removeAttribute("src");
  if (item) {
    if (isVideo) {
      video.muted = !state.audioUnlocked;
      loadVideoSource(video, item);
    } else {
      image.dataset.path = item.path;
      image.alt = item.name;
      image.src = mediaUrl(item.path);
    }
    markSeen(item.path);
  }
  const badge = el("rediscoverBadge");
  badge.hidden = !item;
  if (item) {
    badge.textContent = item.lastSeen ? `Last seen ${timeAgo(item.lastSeen)}` : "Never seen";
    badge.classList.toggle("is-new", !item.lastSeen);
  }
  setLabel(el("rediscoverName"), item?.name || "");
  setLabel(el("rediscoverFolder"), item ? item.folder || "Library root" : "");
  el("rediscoverStatus").textContent = item ? `${(rediscover.index + 1).toLocaleString()} / ${rediscover.items.length.toLocaleString()}` : "";
  el("rediscoverProgress").textContent = item ? `${(rediscover.index + 1).toLocaleString()} / ${rediscover.items.length.toLocaleString()}` : "";
  el("rediscoverUndoButton").disabled = !rediscover.history.length;
  ["rediscoverKeep", "rediscoverPass", "rediscoverSkip"].forEach((id) => { el(id).disabled = !item; });
  syncDrawerSummaries();
}

async function actRediscover(action) {
  flushDeckAnimation("rediscover");
  const item = currentRediscoverItem();
  if (!item) return;
  const entry = { action, index: rediscover.index, item, previousRating: item.rating ?? null };
  rediscover.history.push(entry);
  rediscover.history = rediscover.history.slice(-60);
  rediscover.index += 1;
  if (action === "skip") {
    animateDeckAdvance("rediscover", "down");
    return;
  }
  const rating = action === "keep" ? "like" : "dislike";
  recordRating(item.path, rating, item);
  haptic();
  animateDeckAdvance("rediscover", action === "keep" ? "right" : "left");
  try {
    await postJson("/api/rating", { path: item.path, rating });
  } catch (error) {
    recordRating(item.path, entry.previousRating, item);
    rediscover.history = rediscover.history.filter((logged) => logged !== entry);
    rediscover.index = entry.index;
    flushDeckAnimation("rediscover");
    renderRediscover();
    toast("Could not save that rating. Check the connection and try again.");
  }
}

async function undoRediscover() {
  flushDeckAnimation("rediscover");
  const entry = rediscover.history.pop();
  if (!entry) return;
  if (entry.action !== "skip") {
    try {
      await postJson("/api/rating", { path: entry.item.path, rating: entry.previousRating });
      recordRating(entry.item.path, entry.previousRating, entry.item);
    } catch (error) {
      rediscover.history.push(entry);
      toast("Could not undo the last rating.");
      return;
    }
  }
  rediscover.index = entry.index;
  renderRediscover();
  toast(entry.action === "skip" ? "Back one card." : "Rating undone.");
}

function releaseInactiveMedia(mode) {
  if (mode !== "gallery") state.gallery.observer?.disconnect();
  if (mode !== "ranked") state.ranked.observer?.disconnect();
  if (!["gallery", "ranked"].includes(mode)) thumbQueue.length = 0;
  document.querySelectorAll(".mode-panel").forEach(panel => {
    if (panel.id === `${mode}Mode`) return;
    panel.querySelectorAll("video[src]").forEach(releaseVideo);
    panel.querySelectorAll("img[src]").forEach(image => image.removeAttribute("src"));
  });
  if (mode !== "session") delete controls.sessionStage.dataset.path;
  if (state.preloader) { state.preloader.src = ""; state.preloader = null; }
  if (dangerous.preloader) { dangerous.preloader.src = ""; dangerous.preloader = null; }
}

function startDangerous(rebuild = false) {
  if (dangerous.busy) return;
  if (dangerous.library !== state.currentMediaDirectory) {
    dangerous.library = state.currentMediaDirectory;
    dangerous.history = [];
    dangerous.kept = dangerous.deleted = 0;
    rebuild = true;
  }
  if (rebuild || !dangerous.items.length) {
    const kind = state.settings.dangerousKind || "all";
    const selected = normalizedFolderSelection("dangerousFolders");
    dangerous.items = [
      ...(kind !== "video" ? state.library.images.map(i => ({ ...i, kind: "photo" })) : []),
      ...(kind !== "photo" ? state.library.videos.map(i => ({ ...i, kind: "video" })) : []),
    ].filter(item => matchesFolderSelection(item, selected) && (!state.settings.dangerousUnrated || !item.rating));
    shuffleBalanced(dangerous.items);
    dangerous.index = 0;
  }
  syncSegmented(el("dangerousKind"), "dangerousKind", state.settings.dangerousKind || "all");
  el("dangerousUnrated").setAttribute("aria-checked", String(!!state.settings.dangerousUnrated));
  syncDrawerSummaries();
  renderDangerous();
}

function renderDangerous() {
  if (state.currentMode !== "dangerous") return;
  const item = dangerous.items[dangerous.index];
  const image = el("dangerousImage"), video = el("dangerousVideo");
  const isVideo = item?.kind === "video";
  image.hidden = !item || isVideo;
  video.hidden = !item || !isVideo;
  el("dangerousEmpty").hidden = !!item;
  el("dangerousCard").classList.toggle("is-video", !!isVideo);
  if (!isVideo) releaseVideo(video);
  if (isVideo || !item) image.removeAttribute("src");
  if (item) {
    if (isVideo) {
      video.muted = !state.audioUnlocked;
      loadVideoSource(video, item);
    } else {
      image.alt = item.name;
      image.decoding = "async";
      image.dataset.path = item.path;
      image.src = mediaUrl(item.path);
    }
  }
  if (item) markSeen(item.path);
  el("dangerousName").textContent = item?.name || "";
  el("dangerousFolder").textContent = item ? (item.folder || "Library root") : "";
  el("dangerousType").textContent = item ? (isVideo ? "VIDEO" : "PHOTO") : "DONE";
  el("dangerousProgress").textContent = item ? `${(dangerous.index + 1).toLocaleString()} / ${dangerous.items.length.toLocaleString()}` : "Deck complete";
  syncDangerousActions();
}

function syncDangerousActions() {
  const empty = !dangerous.items[dangerous.index];
  ["dangerousKeep", "dangerousSkip", "dangerousDelete", "dangerousShuffle", "dangerousUnrated"].forEach(id => {
    el(id).disabled = dangerous.busy || (empty && ["dangerousKeep", "dangerousSkip", "dangerousDelete"].includes(id));
  });
  el("dangerousDelete").disabled ||= !state.canTrash;
  el("dangerousUndo").disabled = dangerous.busy || !dangerous.history.length;
  el("dangerousSessionCount").textContent = `${dangerous.kept} kept · ${dangerous.deleted} deleted`;
}

async function actDangerous(action) {
  const item = dangerous.items[dangerous.index];
  if (!item || dangerous.busy) return;
  if (action === "delete" && !state.canTrash) { toast("This drive is read-only. The file was not deleted."); return; }
  dangerous.busy = true;
  syncDangerousActions();
  const library = state.currentMediaDirectory;
  const entry = { action, item, index: dangerous.index, previousRating: item.rating ?? null, library };
  try {
    if (action === "delete") {
      const result = await postJson("/api/trash", { path: item.path, library });
      if (state.currentMediaDirectory !== library) {
        toast("The previous library's file was moved to trash.");
        return;
      }
      entry.token = result.token;
      removeLibraryItem(item.path);
      state.library.updatedAt = result.updatedAt;
      state.librarySignature = librarySignature();
      state.feed.dirty = true;
      dangerous.deleted++;
      toast("Moved to local trash. Press U to undo.");
    } else if (action === "keep") {
      await postJson("/api/rating", { path: item.path, rating: "like" });
      if (state.currentMediaDirectory !== library) return;
      recordRating(item.path, "like", item);
      dangerous.kept++;
    }
    dangerous.history.push(entry);
    dangerous.index++;
    syncCountsFromLibrary();
    syncWorkspace();
    renderDangerous();
  } catch (error) {
    toast(error.message || "Could not save. This item is still here.");
  } finally {
    dangerous.busy = false;
    if (dangerous.library !== state.currentMediaDirectory) startDangerous(true);
    syncDangerousActions();
  }
}

async function undoDangerous() {
  const entry = dangerous.history.at(-1);
  if (!entry || dangerous.busy) return;
  dangerous.busy = true;
  syncDangerousActions();
  try {
    if (entry.action === "delete") {
      await postJson("/api/restore", { token: entry.token, library: entry.library });
      await loadState();
      dangerous.deleted--;
    } else if (entry.action === "keep") {
      await postJson("/api/rating", { path: entry.item.path, rating: entry.previousRating });
      recordRating(entry.item.path, entry.previousRating, entry.item);
      dangerous.kept--;
    }
    dangerous.history.pop();
    // Filters or a shuffle may have changed the deck since this action.
    const index = dangerous.items.findIndex(i => i.path === entry.item.path);
    if (index < 0) { dangerous.items.splice(dangerous.index, 0, entry.item); }
    else dangerous.index = index;
    syncCountsFromLibrary();
    syncWorkspace();
    renderDangerous();
    toast("Undone. File restored to its previous state.");
  } catch (error) { toast(error.message); }
  finally { dangerous.busy = false; syncDangerousActions(); }
}

function preloadDangerous() {
  const next = dangerous.items[dangerous.index + 1];
  if (!next || next.kind === "video" || state.currentMode !== "dangerous") return;
  dangerous.preloader = new Image();
  dangerous.preloader.decoding = "async";
  dangerous.preloader.src = mediaUrl(next.path);
}

async function reviewTrash() {
  const list = el("trashList");
  list.textContent = "Loading…";
  try {
    const library = state.currentMediaDirectory;
    const payload = await fetchJson("/api/trash");
    list.replaceChildren();
    if (!payload.entries.length) list.textContent = "Nothing in trash.";
    payload.entries.forEach(entry => {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = entry.path;
      const button = document.createElement("button");
      button.className = "ghost-button";
      button.textContent = "Restore";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await postJson("/api/restore", { token: entry.token, library });
          dangerous.history = dangerous.history.filter(h => h.token !== entry.token);
          await loadState();
          await reviewTrash();
          toast("Restored to the original folder.");
        } catch (error) { toast(error.message); button.disabled = false; }
      });
      row.append(label, button);
      list.append(row);
    });
  } catch (error) { list.textContent = error.message; }
}

let toastTimer;
function toast(message) {
  el("workspaceToast").textContent = message;
  el("workspaceToast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el("workspaceToast").hidden = true; }, 5000);
}

function setupMediaFeedback() {
  const tracked = new WeakMap();
  function watch(media) {
    if (tracked.has(media) || media.closest(".gallery-grid, .ranked-grid")) return;
    const host = media.closest(".dangerous-card, .swipe-card, .duel-side, .video-slot, .mosaic-tile, .feed-item, .lightbox-media, .stream-stage");
    if (!host) return;
    if (media.tagName === "IMG") media.decoding = "async";
    const overlay = document.createElement("div");
    overlay.className = "media-feedback";
    overlay.hidden = true;
    overlay.innerHTML = '<span class="loading-ring" aria-hidden="true"></span><span role="status">Loading media…</span><div hidden><button class="ghost-button">Retry</button><button class="ghost-button">Skip</button></div>';
    host.append(overlay);
    const record = { timer: null, overlay };
    tracked.set(media, record);
    const done = () => { clearTimeout(record.timer); overlay.hidden = true; };
    const pending = () => {
      done();
      if (!media.getAttribute("src") || media.hidden) return;
      if (media.tagName === "IMG" && media.complete && media.naturalWidth) return;
      overlay.hidden = false;
      overlay.querySelector('[role="status"]').textContent = "Loading media…";
      overlay.querySelector("div").hidden = true;
      record.timer = setTimeout(() => stalled("Taking longer than usual. Retry or skip this file."), 8000);
    };
    const stalled = message => {
      if (!media.getAttribute("src") || media.hidden) return;
      clearTimeout(record.timer);
      overlay.hidden = false;
      overlay.querySelector('[role="status"]').textContent = message;
      overlay.querySelector("div").hidden = false;
    };
    overlay.querySelectorAll("button")[0].addEventListener("click", () => {
      pending();
      if (media.tagName === "VIDEO") {
        media.load();
        media.play().catch(() => {});
      } else { const src = media.src; media.removeAttribute("src"); media.src = src; }
    });
    overlay.querySelectorAll("button")[1].addEventListener("click", () => {
      done();
      if (!controls.galleryLightbox.hidden) stepLightbox(1);
      else if (state.currentMode === "dangerous") actDangerous("skip");
      else if (state.currentMode === "duel") nextDuel();
      else if (state.currentMode === "rediscover") actRediscover("skip");
      else if (isDeckMode(state.currentMode)) skipDeckItem(state.currentMode);
      else if (state.currentMode === "feed") scrollFeedTo(state.feed.activeIndex + 1);
      else refreshMode(state.currentMode);
    });
    ["load", "loadeddata", "playing", "canplay"].forEach(event => media.addEventListener(event, done));
    media.addEventListener("waiting", pending);
    media.addEventListener("error", () => stalled("This file could not be played. Retry or skip."));
    new MutationObserver(pending).observe(media, { attributes: true, attributeFilter: ["src"] });
    if (media.getAttribute("src")) pending();
  }
  document.querySelectorAll("img,video").forEach(watch);
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
    if (node.nodeType !== 1) return;
    if (node.matches("img,video")) watch(node);
    node.querySelectorAll("img,video").forEach(watch);
  }))).observe(el("mainContent"), { childList: true, subtree: true });
}

function setupPanelAccessibility() {
  document.querySelectorAll(".drawer").forEach(drawer => {
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-label", drawer.querySelector("h2").textContent);
    drawer.inert = true;
    let previousFocus;
    let wasOpen = false;
    new MutationObserver(() => {
      const open = drawer.getAttribute("aria-hidden") === "false";
      drawer.inert = !open;
      if (open === wasOpen) return;
      wasOpen = open;
      if (open) { previousFocus = document.activeElement; drawer.querySelector(".drawer-header button")?.focus({ preventScroll: true }); }
      else if (previousFocus?.getClientRects().length) previousFocus.focus({ preventScroll: true });
    }).observe(drawer, { attributes: true, attributeFilter: ["aria-hidden"] });
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const dialog = (drawerIsDocked() ? null : document.querySelector('.drawer.open')) || (state.launcherOpen ? controls.modeLauncher : null) || (!controls.galleryLightbox.hidden ? controls.galleryLightbox : null);
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll('button, input, select, summary, [tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (!dialog.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
}

// Overview uses metadata only, so opening the app never downloads a wall of media.
function modeIcon(card) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${card.icon}"/></svg>`;
}

function renderOverview() {
  const groups = el("homeModes");
  groups.replaceChildren();
  MODE_GROUPS.forEach(({ label, modes }) => {
    const group = document.createElement("section");
    group.className = "home-group";
    const heading = document.createElement("h3");
    heading.textContent = label;
    const grid = document.createElement("div");
    grid.className = "home-modes";
    modes.forEach(mode => {
      const card = MODE_CARDS.find(c => c.mode === mode);
      const button = document.createElement("button");
      button.className = "home-mode";
      button.dataset.mode = mode;
      if (MODE_TONES[mode]) button.dataset.tone = MODE_TONES[mode];
      button.innerHTML = `<span class="mode-icon">${modeIcon(card)}</span><strong></strong><p></p><span class="mode-stat"></span><kbd>${modeKey(mode)}</kbd>`;
      button.querySelector("strong").textContent = card.name;
      button.querySelector("p").textContent = card.blurb;
      button.addEventListener("click", () => setMode(mode));
      grid.append(button);
    });
    group.append(heading, grid);
    groups.append(group);
  });
  [["images", "Photos", "gallery"], ["videos", "Videos", "toktinder"], ["liked", "Kept", "ranked"], ["unrated", "Unrated", "swipe"]].forEach(([key, label, mode]) => {
    const button = document.createElement("button");
    button.className = "overview-stat";
    button.dataset.count = key;
    button.innerHTML = `${modeIcon(MODE_CARDS.find(c => c.mode === mode))}<div><strong>0</strong><span>${label}</span></div>`;
    button.addEventListener("click", () => {
      if (key === "unrated") {
        setRatingFilter("swipe", "unrated");
      }
      setMode(mode);
    });
    el("overviewStats").append(button);
  });
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Late night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

// Chips that open a lean-back mode with Show set to Liked.
function renderFavoriteLaunchers(container, title) {
  container.replaceChildren();
  const liked = countOf("liked");
  container.hidden = !liked;
  if (!liked) return;
  const head = document.createElement("span");
  head.className = "fav-title ranked-play-label";
  head.innerHTML = '<svg aria-hidden="true"><use href="#i-heart"/></svg>';
  head.append(title);
  container.append(head);
  ["escalation", "mosaic", "session", "feed"].forEach(mode => {
    const card = MODE_CARDS.find(c => c.mode === mode);
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.innerHTML = modeIcon(card);
    chip.append(card.name);
    chip.addEventListener("click", () => playFavorites(mode));
    container.append(chip);
  });
}

function playFavorites(mode) {
  state.settings[`${mode}RatingFilter`] = "liked";
  syncRatingFilter(mode);
  invalidateMediaPools();
  if (mode === "feed") state.feed.dirty = true;
  queueSettingsSave();
  setMode(mode);
  toast(`${workspaceNames[mode]} is showing only what you kept. Change it under Adjust → Show.`);
}

function syncOverview() {
  const counts = state.library.counts || {};
  const total = countOf("images") + countOf("videos");
  const rated = countOf("liked") + Number(counts.disliked || 0);
  document.querySelectorAll(".overview-stat").forEach(button => {
    const key = button.dataset.count;
    const value = key === "unrated" ? Math.max(0, total - rated) : countOf(key);
    button.querySelector("strong").textContent = value.toLocaleString();
  });
  document.querySelectorAll(".home-mode").forEach(button => {
    const card = MODE_CARDS.find(c => c.mode === button.dataset.mode);
    button.querySelector(".mode-stat").textContent = card.stat();
    button.classList.toggle("is-last", button.dataset.mode === state.settings.lastMode);
  });
  const last = MODE_CARDS.find(c => c.mode === state.settings.lastMode) || MODE_CARDS[0];
  el("continueButton").replaceChildren(document.createTextNode(`Continue in ${last.name}`));
  el("continueButton").insertAdjacentHTML("beforeend", '<svg aria-hidden="true"><use href="#i-right"/></svg>');
  el("homeGreeting").textContent = greeting();
  const percent = total ? Math.round((rated / total) * 100) : 0;
  el("homeHeadline").textContent = !total ? "Your library is empty." : rated === 0 ? "Fresh library. Start sorting." : percent >= 100 ? "Everything is sorted." : "Pick up where you left off.";
  el("homeSubline").textContent = total
    ? `${total.toLocaleString()} files · ${countOf("liked").toLocaleString()} kept · ${Math.max(0, total - rated).toLocaleString()} still to rate`
    : "Choose a folder in Settings to begin.";
  el("homeMeterValue").textContent = `${percent}%`;
  el("homeMeterFill").style.strokeDashoffset = String(326.7 * (1 - percent / 100));
  renderFavoriteLaunchers(el("homeFavorites"), "Play your favorites");
}
