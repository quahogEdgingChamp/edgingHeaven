
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
  mosaic: "Mosaic", feed: "Feed", dangerous: "Dangerous", beat: "Beat", redlight: "Red light", dice: "Dice",
  ladder: "Ladder", spotlight: "Spotlight", highlights: "Highlights", downloads: "Downloads",
  bookmarks: "Bookmarks" };
// One grouping for the sidebar, the overview and the mode picker.
const MODE_GROUPS = [
  { label: "Sort & rate", modes: ["swipe", "toktinder", "feed", "rediscover", "dangerous"] },
  { label: "Sit back", modes: ["escalation", "session", "beat", "redlight", "dice", "mosaic"] },
  { label: "Your best", modes: ["ladder", "spotlight", "highlights"] },
  { label: "Your library", modes: ["gallery", "ranked", "duel", "bookmarks", "downloads"] },
];
const MODE_TONES = { duel: "warm", rediscover: "violet", mosaic: "violet", escalation: "warm", session: "warm", dangerous: "danger",
  beat: "warm", redlight: "danger", dice: "violet", ladder: "warm", spotlight: "violet", highlights: "violet" };
const workspaceEyebrows = { home: "Your library", duel: "Your library", rediscover: "Sort & rate", swipe: "Sort & rate", toktinder: "Sort & rate", feed: "Sort & rate",
  dangerous: "Sort & rate", mosaic: "Sit back", escalation: "Sit back", session: "Sit back",
  beat: "Sit back", redlight: "Sit back", dice: "Sit back", ladder: "Your best", spotlight: "Your best", highlights: "Your best",
  gallery: "Your library", ranked: "Your library", downloads: "Your library",
  bookmarks: "Your library" };

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
      button.title = modeKey(mode) ? `${workspaceNames[mode]} (${modeKey(mode)})` : workspaceNames[mode];
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
  const toggleDangerousSound = () => {
    toggleVideoAudio();
    el("dangerousVideo").muted = !state.audioUnlocked;
    if (!el("dangerousVideo").hidden) el("dangerousVideo").play().catch(() => {});
  };
  el("dangerousSound").addEventListener("click", toggleDangerousSound);
  el("dangerousMuteToggle").addEventListener("click", toggleDangerousSound);
  bindSegmented(el("dangerousKind"), "dangerousKind", (value) => {
    state.settings.dangerousKind = value;
    syncSegmented(el("dangerousKind"), "dangerousKind", value);
    queueSettingsSave();
    startDangerous(true);
  });
  el("dangerousHideKept").addEventListener("click", () => {
    state.settings.dangerousHideKept = !state.settings.dangerousHideKept;
    el("dangerousHideKept").setAttribute("aria-checked", String(state.settings.dangerousHideKept));
    queueSettingsSave();
    startDangerous(true);
  });
  el("dangerousVideo").addEventListener("loadedmetadata", () => {
    if (state.currentMode === "dangerous") playWhenReady(el("dangerousVideo"), el("dangerousVideo").dataset.loadToken);
  });
  el("dangerousImage").addEventListener("load", preloadDangerous);
  el("dangerousVideo").addEventListener("loadeddata", preloadDangerous);
  bindDangerousTransport();
  const card = el("dangerousCard");
  card.addEventListener("pointerdown", event => {
    if (event.button !== 0 || dangerous.busy || event.target.closest("button")) return;
    dangerous.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, onVideo: event.target === el("dangerousVideo") };
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
    } else if (drag?.onVideo && event.type === "pointerup" && Math.abs(drag.dx) < 8) {
      toggleDangerousPlayback();
    }
  };
  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
  window.addEventListener("pagehide", () => flushSeen(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSeen(true);
    if (!document.hidden && !state.panic && !state.locked && state.currentMode === "dangerous" && !el("dangerousVideo").hidden) {
      playWhenReady(el("dangerousVideo"), el("dangerousVideo").dataset.loadToken);
    }
    syncWakeLock();
  });
  el("showTrash").addEventListener("click", reviewTrash);
  el("emptyTrash").addEventListener("click", emptyTrash);

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
  syncDocumentTitle();
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

