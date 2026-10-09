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
  swipe: ["swipeRatingFilter", "swipeDangerKeptOnly", "swipeOrder"],
  toktinder: ["toktinderRatingFilter", "toktinderDangerKeptOnly", "toktinderOrder"],
  escalation: [
    "escalationOrder",
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
    "sessionOrder",
    "sessionRatingFilter",
    "sessionRounds",
    "sessionBuildSeconds",
    "sessionHoldSeconds",
    "sessionIncludeVideos",
    "sessionVideoVolume",
  ],
  gallery: ["galleryRatingFilter", "galleryKind", "gallerySort"],
  mosaic: ["mosaicOrder", "mosaicRatingFilter", "mosaicTiles", "mosaicSwapSeconds", "mosaicIncludePhotos", "mosaicVolume"],
  feed: ["feedOrder", "feedRatingFilter", "feedDangerKeptOnly", "feedVolume", "feedAutoAdvance"],
  dangerous: ["dangerousKind", "dangerousHideKept"],
  duel: ["duelKind", "duelRatingFilter"],
  rediscover: ["rediscoverOrder", "rediscoverKind", "rediscoverRatingFilter", "rediscoverDangerKeptOnly"],
};

const MODE_DEFAULTS = {
  swipeOrder: "random",
  toktinderOrder: "random",
  feedOrder: "random",
  rediscoverOrder: "random",
  escalationOrder: "random",
  sessionOrder: "random",
  mosaicOrder: "random",
  duelKind: "photos",
  duelRatingFilter: "liked",
  rediscoverKind: "all",
  rediscoverRatingFilter: "all",
  escalationRatingFilter: "all",
  sessionRatingFilter: "all",
  mosaicRatingFilter: "all",
  dangerousKind: "all",
  dangerousHideKept: true,
  swipeDangerKeptOnly: false,
  toktinderDangerKeptOnly: false,
  feedDangerKeptOnly: false,
  rediscoverDangerKeptOnly: false,
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
  syncSmartOrderControls();
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
  // Numbers compare as numbers (a slider may hand back "2.2"); words as words.
  return Object.entries(preset).every(([key, value]) =>
    typeof value === "number" ? Number(state.settings[key]) === value : state.settings[key] === value);
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
    const which = state.settings.dangerousHideKept ? `${kind} you have not kept here yet` : kind;
    const left = Math.max(0, dangerous.items.length - dangerous.index);
    // "Does it go through everything?" answered: kept so far of all it takes
    // in, and what Media or folders leave out.
    const cover = dangerousCoverage();
    const parts = [`Reviewing ${which} — ${plural(left, "file", "files")} left in this deck.`];
    parts.push(`${cover.kept.toLocaleString()} of ${plural(cover.total, "file", "files")} kept here so far.`);
    if (cover.otherKind) parts.push(`${plural(cover.otherKind, state.settings.dangerousKind === "photo" ? "video is" : "photo is", state.settings.dangerousKind === "photo" ? "videos are" : "photos are")} left out by Media.`);
    if (cover.otherFolders) parts.push(`${plural(cover.otherFolders, "file", "files")} in other folders ${cover.otherFolders === 1 ? "is" : "are"} left out by Folders.`);
    if (!state.canTrash) parts.push("The drive is read-only, so Delete is off.");
    return parts.join(" ");
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
      const kept = dangerKeptSummary(mode);
      node.textContent = DRAWER_SUMMARIES[mode] ? DRAWER_SUMMARIES[mode]() + extra + kept + smartOrderNote(mode) : "";
    }
    const presets = controls[`${mode}Preset`];
    if (presets) {
      syncSegmented(presets, "preset", currentPresetName(mode));
    }
  });
  // The kept counts under Sort & rate's switch move with every keep.
  syncDangerKeptSwitches();
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

