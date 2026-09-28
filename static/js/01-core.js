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
  "beat",
  "redlight",
  "dice",
  "ladder",
  "spotlight",
  "highlights",
];
const FOCUS_MODES = ["swipe", "toktinder", "escalation", "session", "mosaic", "feed", "dangerous", "duel", "rediscover",
  "beat", "redlight", "dice", "ladder", "spotlight", "highlights"];
// Spotlight picks a model (a top-level folder) instead of folders.
const FOLDER_MODES = DRAWER_MODES.filter((mode) => mode !== "spotlight");
// Modes whose control center has an All / Unrated / Liked / Loved "Show" filter.
const RATING_FILTER_MODES = ["swipe", "toktinder", "escalation", "session", "gallery", "mosaic", "feed", "duel", "rediscover",
  "beat", "redlight", "dice", "ladder", "spotlight", "highlights"];
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
  "beat",
  "redlight",
  "dice",
  "ladder",
  "spotlight",
  "highlights",
  "downloads",
  "bookmarks",
];

document.addEventListener("DOMContentLoaded", () => {
  mountControlCenters();
  cacheDom();
  bindEvents();
  initWorkspace();
  loadState().catch((error) => {
    // A PIN-locked server: the lock screen is already up and loads the
    // library itself once unlocked.
    if (error.locked) return;
    console.error(error);
    controls.libraryMeta.textContent = "Could not load the library.";
    setStatus("Startup failed. Check the server terminal for details.");
  });
  setTimeout(checkLibraryConnection, 5000);
});

async function checkLibraryConnection() {
  try {
    if (!document.hidden) {
      await refreshLibrary();
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
    if (!FOLDER_MODES.includes(mode)) {
      return;
    }
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
    "loveButton",
    "toktinderLoveButton",
    "toktinderMarkButton",
    "toktinderSeekMarks",
    "lightboxLove",
    "lightboxMark",
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
      DRAWER_MODES.flatMap((mode) => [
        `${mode}Drawer`,
        `${mode}DrawerToggle`,
        `${mode}DrawerClose`,
        `${mode}Summary`,
        `${mode}Preset`,
        `${mode}ResetSettingsButton`,
      ]),
      FOLDER_MODES.flatMap((mode) => [
        `${mode}FoldersAllButton`,
        `${mode}FoldersNoneButton`,
        `${mode}FoldersSyncButton`,
        `${mode}FolderSearch`,
        `${mode}FolderSummary`,
        `${mode}FolderFilters`,
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
  controls.loveButton.addEventListener("click", () => rateCurrent("love"));
  controls.toktinderLoveButton.addEventListener("click", () => rateToktinderCurrent("love"));
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
  bindPrivacyCards();
  bindDownloads();
  bindBookmarks();
  bindMarking();
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
  document.querySelectorAll("[data-global-sound]").forEach((button) => button.addEventListener("click", toggleVideoAudio));

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
    } else if (!state.panic && !state.locked) {
      resumeCurrentMode();
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

  if (state.locked) {
    return;
  }
  if (state.panic) {
    if (key === "`" || key === "Escape") {
      event.preventDefault();
      setPanic(false);
    }
    return;
  }
  if (key === "`" && !typing) {
    event.preventDefault();
    setPanic(true);
    return;
  }

  if (!controls.galleryLightbox.hidden) {
    if (key === "Escape") {
      closeLightbox();
    } else if (key === "ArrowLeft") {
      stepLightbox(-1);
    } else if (key === "ArrowRight") {
      stepLightbox(1);
    } else if (lower === "l" && !typing) {
      rateLightboxItem("love");
    } else if (lower === "b" && !typing) {
      markFromLightbox();
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
  const handler = MODE_HANDLERS[mode];
  if (handler) {
    if (handler.key?.(key, lower, event)) {
      event.preventDefault();
    }
    return;
  }
  if (mode === "feed") {
    const actions = {
      ArrowDown: () => scrollFeedTo(state.feed.activeIndex + 1),
      j: () => scrollFeedTo(state.feed.activeIndex + 1),
      ArrowUp: () => scrollFeedTo(Math.max(0, state.feed.activeIndex - 1)),
      k: () => scrollFeedTo(Math.max(0, state.feed.activeIndex - 1)),
      ArrowRight: () => rateFeedItem(state.feed.activeIndex, "like"),
      ArrowLeft: () => rateFeedItem(state.feed.activeIndex, "dislike"),
      l: () => rateFeedItem(state.feed.activeIndex, "love", false),
      b: markFromFeed,
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
    const action = { ArrowLeft: "pass", ArrowRight: "keep", ArrowDown: "skip", ArrowUp: "love", l: "love", L: "love" }[key];
    if (lower === "b") {
      event.preventDefault();
      markFromRediscover();
      return;
    }
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
    const action = { ArrowLeft: "delete", ArrowRight: "keep", ArrowDown: "skip", ArrowUp: "keep" }[key];
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
  if (mode === "toktinder" && lower === "b") {
    event.preventDefault();
    markFromToktinder();
    return;
  }
  if (key === "ArrowUp" || lower === "l") {
    event.preventDefault();
    rateDeckItem(mode, "love");
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
  // What this server can do: an older server.py still running after a
  // frontend update has no marks, sessions or PIN lock.
  state.features = new Set(Array.isArray(payload.features) ? payload.features : []);
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
  if (libraryChanged && MODE_HANDLERS[state.currentMode]) MODE_HANDLERS[state.currentMode].refresh();
  if (state.features.has("marks")) loadMarks();
  if (state.settings.toyAuto && !state.toyAutoTried) {
    state.toyAutoTried = true;
    toyConnect();
  }
  syncDocumentTitle();
}

// Library changes, as the five-second poll sees them. Files a download adds
// while it runs arrive as additions and are merged in place (see
// applyLibraryAdditions); anything else -- a rescan, a reconnected drive,
// another device deleting -- reloads the whole library as before.
async function refreshLibrary() {
  const status = await fetchJson("/api/library-status");
  const sameLibrary = status.libraryReady === state.libraryReady && (status.mediaDirectory || "") === state.currentMediaDirectory;
  if (sameLibrary && state.features.has("additions") && status.scanId === state.library.scanId
      && status.appended > (state.library.appended || 0)) {
    await applyLibraryAdditions();
  } else if (!sameLibrary || status.updatedAt !== state.library.updatedAt) {
    await loadState();
  }
}

// New files from a download in progress, added without reshuffling anything:
// decks and Dangerous get them after the card on screen, the other modes
// through their pools on the next pick, and nothing that is playing restarts.
async function applyLibraryAdditions() {
  let payload;
  try {
    payload = await fetchJson(`/api/library-additions?scan=${encodeURIComponent(state.library.scanId)}&from=${state.library.appended || 0}`);
  } catch (error) {
    if (error.locked) throw error;
    await loadState(); // rescanned in the meantime
    return;
  }
  const known = new Set([...state.library.images, ...state.library.videos].map((item) => item.path));
  const fresh = { images: [], videos: [] };
  payload.items.forEach(({ kind, ...item }) => {
    if (!known.has(item.path)) fresh[kind === "video" ? "videos" : "images"].push(item);
  });
  state.library.appended = payload.next;
  state.library.updatedAt = payload.updatedAt;
  const added = [...fresh.images, ...fresh.videos];
  if (!added.length) return;
  hydrateLibraryNames(fresh);
  state.library.images.push(...fresh.images);
  state.library.videos.push(...fresh.videos);
  state.library.counts = { ...(state.library.counts || {}), images: state.library.images.length, videos: state.library.videos.length };

  const newFolders = [...new Set(added.map((item) => item.folder || ""))].filter((folder) => !state.library.folders.includes(folder));
  if (newFolders.length) {
    adoptNewFolders(newFolders);
    state.library.folders = [...state.library.folders, ...newFolders]
      .sort((a, b) => (a !== "") - (b !== "") || a.toLowerCase().localeCompare(b.toLowerCase()));
    renderFolderFilters();
  }
  state.librarySignature = librarySignature();
  invalidateMediaPools();
  addToDeck("swipe", fresh.images);
  addToDeck("toktinder", fresh.videos);
  addToDangerous(added.map((item) => ({ ...item, kind: fresh.videos.includes(item) ? "video" : "photo" })));
  if (state.currentMode !== "feed") state.feed.dirty = true;
  syncCountsFromLibrary();
  syncWorkspace();
  if (state.currentMode === "ranked") renderRanked();
  if (["downloads", "bookmarks"].includes(state.currentMode)) MODE_HANDLERS[state.currentMode].refresh();
}

// A folder that appears inside a model (cyberdrop-dl makes some) joins every
// folder selection that already had all of that model's folders; picking
// "this model" should not quietly exclude the part still downloading.
function adoptNewFolders(folders) {
  Object.keys(state.settings).filter((key) => key.endsWith("Folders")).forEach((key) => {
    const selection = state.settings[key];
    if (!Array.isArray(selection) || !selection.length) return; // empty = every folder already
    folders.forEach((folder) => {
      const model = folder.split("/")[0];
      const siblings = state.library.folders.filter((known) => known === model || known.startsWith(`${model}/`));
      if (siblings.length && siblings.every((known) => selection.includes(known)) && !selection.includes(folder)) {
        selection.push(folder);
      }
    });
  });
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

