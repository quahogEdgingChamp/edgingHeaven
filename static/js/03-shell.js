function setMode(mode) {
  if (mode !== "home" && !ALL_MODES.includes(mode)) return;
  if (!FOCUS_MODES.includes(mode) && state.focusMode) setFocusMode(false);
  if (!controls.galleryLightbox.hidden) closeLightbox();
  state.currentMode = mode;
  if (mode !== "ranked") state.ranked.model = null;
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
  } else if (MODE_HANDLERS[mode]) {
    MODE_HANDLERS[mode].enter();
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
  Object.values(MODE_HANDLERS).forEach((handler) => handler.quiet());
  document.querySelectorAll("video").forEach(video => video.pause());
  toyStop();
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
  } else if (MODE_HANDLERS[mode]) {
    MODE_HANDLERS[mode].refresh();
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
  // The Dangerous modes delete files, so their buttons stay put instead of fading.
  const deletes = ["dangerous", "dgrid", "djunk", "dsimilar", "dfolders"].includes(state.currentMode);
  if (document.body.classList.contains("immersive") && !deletes) {
    idleTimer = window.setTimeout(() => {
      // Never hide the controls from under an open panel or a dragging finger.
      if (!state.activeDrawer && !state.drag.active && !state.launcherOpen && !deletes) {
        document.body.classList.add("idle");
      }
    }, 3200);
  }
}

/* Keep the screen on while something is playing on its own. A phone that
   dims in the middle of a stream is the most common annoyance there is. */
const WAKE_MODES = ["escalation", "session", "mosaic", "feed", "toktinder", "beat", "redlight", "dice", "ladder", "spotlight", "highlights"];
let wakeLock = null;

async function syncWakeLock() {
  const wanted = WAKE_MODES.includes(state.currentMode) && !document.hidden && state.libraryReady && !state.panic && !state.locked;
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

