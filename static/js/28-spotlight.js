/* ==========================================================================
   Spotlight — one model, start to finish

   A model is a top-level folder and everything under it. Spotlight plays
   only that model: mostly photos at first, more and more clips as the ramp
   goes on, swaps getting quicker. "Surprise me" picks a model weighted by
   how much of it you kept.
   ========================================================================== */

const spotlight = { stage: null, model: null, running: false, clock: null, nextSwapAt: 0, bound: false, introUntil: 0 };

registerModeUI("spotlight", {
  card: {
    name: "Spotlight",
    blurb: "One model, start to finish. Photos build into clips as it speeds up.",
    icon: "M12 3v3M5.6 5.6l2.1 2.1M3 12h3M18 12h3M16.3 7.7l2.1-2.1M8 16a4 4 0 118 0v4H8z",
    stat: () => (state.settings.spotlightModel ? folderLabel(state.settings.spotlightModel) : "surprise me"),
  },
  defaults: {
    spotlightModel: "",
    spotlightRatingFilter: "all",
    spotlightRampSeconds: 240,
    spotlightBaseInterval: 10,
    spotlightMinInterval: 3,
    spotlightVolume: 0.3,
    spotlightOrder: "random",
  },
  presets: {
    slow: { spotlightRampSeconds: 480, spotlightBaseInterval: 14, spotlightMinInterval: 4 },
    standard: { spotlightRampSeconds: 240, spotlightBaseInterval: 10, spotlightMinInterval: 3 },
    fast: { spotlightRampSeconds: 120, spotlightBaseInterval: 7, spotlightMinInterval: 2 },
  },
  summary: () => {
    const model = spotlightModelName();
    const count = model === null ? 0 : spotlightItems(model).length;
    const who = state.settings.spotlightModel ? folderLabel(model) : "A surprise model";
    return `${who}${count ? ` (${plural(count, "file", "files")})` : ""}: swaps every ${state.settings.spotlightBaseInterval}s down to ${state.settings.spotlightMinInterval}s over ${SETTING_FORMATS.ramp(state.settings.spotlightRampSeconds)}, clips taking over as it goes.`;
  },
});

// Every model with its file and keep counts, most kept first.
function spotlightModels() {
  return mediaPool("spotlight:models", () => {
    const rows = new Map();
    for (const key of ["images", "videos"]) {
      for (const item of state.library[key] || []) {
        const model = (item.folder || "").split("/")[0];
        const row = rows.get(model) || { model, total: 0, kept: 0, loved: 0, videos: 0 };
        row.total += 1;
        row.kept += isKept(item) ? 1 : 0;
        row.loved += item.rating === "love" ? 1 : 0;
        row.videos += key === "videos" ? 1 : 0;
        rows.set(model, row);
      }
    }
    return [...rows.values()].sort((a, b) => b.kept - a.kept || b.total - a.total || a.model.localeCompare(b.model));
  });
}

function inModel(item, model) {
  const folder = item.folder || "";
  return model ? folder === model || folder.startsWith(`${model}/`) : !folder;
}

// The model's files under the Show filter; if the filter leaves almost
// nothing, all of the model's files, so a model you have barely rated still plays.
function spotlightItems(model) {
  return mediaPool(`spotlight:items:${model}`, () => {
    const all = [
      ...(state.library.images || []).map((item) => ({ ...item, kind: "photo" })),
      ...(state.library.videos || []).map((item) => ({ ...item, kind: "video" })),
    ].filter((item) => inModel(item, model));
    const filtered = all.filter((item) => matchesRatingFilter(item, ratingFilterValue("spotlightRatingFilter")));
    return filtered.length >= 3 ? filtered : all;
  });
}

function spotlightModelName() {
  if (spotlight.model !== null) return spotlight.model;
  const chosen = state.settings.spotlightModel;
  if (chosen && spotlightModels().some((row) => row.model === chosen)) return chosen;
  return null;
}

function surpriseModel(avoid) {
  const rows = spotlightModels().filter((row) => row.total >= 3 && row.model !== avoid);
  if (!rows.length) return spotlightModels()[0]?.model ?? null;
  // Smart order: Thompson sampling over models (42-smart.js).
  if (smartOn("spotlight")) return smartSurpriseModel(rows);
  // Weighted by what you kept, with a floor so an unexplored model can win.
  const weights = rows.map((row) => Math.sqrt(row.kept + row.loved * 2) + 0.6);
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let index = 0; index < rows.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return rows[index].model;
  }
  return rows.at(-1).model;
}

function spotlightProgress() {
  return clampNumber(spotlight.clock.elapsed / (state.settings.spotlightRampSeconds * 1000), 0, 1);
}

function spotlightSwap() {
  const model = spotlightModelName();
  const items = model === null ? [] : spotlightItems(model);
  if (!items.length) return;
  const progress = spotlightProgress();
  const videos = items.filter((item) => item.kind === "video");
  const photos = items.filter((item) => item.kind === "photo");
  const wantVideo = videos.length && (!photos.length || Math.random() < lerp(0.15, 0.85, progress));
  const chosen = spotlight.stage.pick(wantVideo ? videos : photos.length ? photos : videos);
  spotlight.stage.fadeMs = Math.round(lerp(420, 150, progress));
  spotlight.stage.show(chosen);
  const seconds = lerp(state.settings.spotlightBaseInterval, state.settings.spotlightMinInterval, 1 - (1 - progress) ** 2);
  spotlight.nextSwapAt = spotlight.clock.elapsed + seconds * 1000 * (0.85 + Math.random() * 0.3);
}

function spotlightTick(elapsed) {
  if (elapsed >= spotlight.nextSwapAt) spotlightSwap();
  const progress = spotlightProgress();
  toySet(lerp(0.2, 1, progress));
  syncSpotlightHud();
}

function syncSpotlightHud() {
  const model = spotlightModelName();
  if (!spotlight.running) {
    const label = model !== null ? folderLabel(model) : "Surprise me";
    const row = spotlightModels().find((entry) => entry.model === model);
    setHud("spotlight", {
      phase: "idle",
      cue: label,
      big: "",
      sub: row ? `${plural(row.total, "file", "files")} · ${row.kept.toLocaleString()} kept` : "A model picked for you when you start.",
      fill: 0,
    });
    syncRunButtons("spotlight", false);
    return;
  }
  const progress = spotlightProgress();
  const intro = spotlight.clock.elapsed < spotlight.introUntil;
  setHud("spotlight", {
    phase: progress >= 1 ? "finish" : "go",
    cue: intro ? folderLabel(model) : `${folderLabel(model)} · ${progress >= 1 ? "Finish" : escalationPhaseLabelFor(progress)}`,
    sub: intro ? "Tonight's spotlight" : `${Math.round(progress * 100)}%`,
    fill: progress,
    compact: !intro,
  });
  syncRunButtons("spotlight", true);
}

function escalationPhaseLabelFor(progress) {
  return progress >= 0.82 ? "Peak" : progress >= 0.58 ? "Overclock" : progress >= 0.28 ? "Drive" : "Warmup";
}

function startSpotlight() {
  spotlight.model = state.settings.spotlightModel && spotlightModels().some((row) => row.model === state.settings.spotlightModel)
    ? state.settings.spotlightModel
    : surpriseModel(spotlight.lastModel);
  if (spotlight.model === null) {
    toast("No model folders to spotlight yet.");
    return;
  }
  spotlight.lastModel = spotlight.model;
  spotlight.running = true;
  spotlight.stage.recent = [];
  spotlight.clock.start();
  spotlight.introUntil = 2600;
  spotlight.nextSwapAt = 0;
  spotlightTick(0);
}

function stopSpotlight() {
  if (spotlight.running) logSession("spotlight", spotlight.clock.elapsed / 1000);
  spotlight.running = false;
  spotlight.clock.stop();
  spotlight.stage.clear();
  spotlight.model = null;
  toyStop();
  syncSpotlightHud();
}

function newSpotlightModel() {
  const next = surpriseModel(spotlightModelName());
  state.settings.spotlightModel = "";
  queueSettingsSave();
  syncSpotlightPicker();
  spotlight.model = next;
  spotlight.lastModel = next;
  if (spotlight.running) {
    spotlight.stage.recent = [];
    spotlight.introUntil = spotlight.clock.elapsed + 2600;
    spotlight.nextSwapAt = 0;
    spotlightTick(spotlight.clock.elapsed);
  } else {
    syncSpotlightHud();
  }
  syncDrawerSummaries();
}

function syncSpotlightPicker() {
  const select = el("spotlightModel");
  const rows = spotlightModels();
  const current = state.settings.spotlightModel || "";
  const options = [new Option("Surprise me", "")];
  rows.forEach((row) => {
    options.push(new Option(`${folderLabel(row.model)} — ${row.kept.toLocaleString()} kept of ${row.total.toLocaleString()}`, row.model));
  });
  select.replaceChildren(...options);
  select.value = rows.some((row) => row.model === current) ? current : "";
}

function bindSpotlight() {
  if (spotlight.bound) return;
  spotlight.bound = true;
  spotlight.stage = new PlayStage("spotlight", { volumeKey: "spotlightVolume" });
  spotlight.clock = new PlayClock(spotlightTick, 200);
  spotlight.stage.onBroken = () => spotlightSwap();
  spotlight.stage.onEnded = () => spotlightSwap();
  el("spotlightToggleButton").addEventListener("click", () => (spotlight.running ? stopSpotlight() : startSpotlight()));
  el("spotlightHudStart").addEventListener("click", startSpotlight);
  el("spotlightNewModel").addEventListener("click", newSpotlightModel);
  el("spotlightModel").addEventListener("change", (event) => {
    state.settings.spotlightModel = event.target.value;
    queueSettingsSave();
    if (!spotlight.running) spotlight.model = null;
    syncDrawerSummaries();
    syncSpotlightHud();
  });
  bindSettingControls(el("spotlightDrawer"), (key) => {
    if (key === "spotlightVolume") spotlight.stage.applyAudio();
    syncDrawerSummaries();
  });
}

// Collection's model page: play exactly this model.
function playModelInSpotlight(model) {
  state.settings.spotlightModel = model;
  queueSettingsSave();
  spotlight.model = null;
  setMode("spotlight");
  if (spotlight.running) stopSpotlight();
  startSpotlight();
}

registerMode("spotlight", {
  enter() {
    bindSpotlight();
    syncSettingControls(el("spotlightDrawer"));
    syncSpotlightPicker();
    if (spotlight.running) {
      spotlight.clock.resume();
      spotlight.stage.resume();
    } else {
      spotlight.model = null;
    }
    syncSpotlightHud();
  },
  quiet() {
    spotlight.clock?.pause();
    spotlight.stage?.pause();
  },
  refresh() {
    if (state.currentMode !== "spotlight") return;
    syncSpotlightPicker();
    if (spotlight.running) spotlightSwap();
    syncSpotlightHud();
  },
  next() {
    if (spotlight.running) spotlightSwap();
  },
  key(key, lower) {
    const actions = {
      " ": () => (spotlight.running ? stopSpotlight() : startSpotlight()),
      ArrowRight: () => spotlight.running && spotlightSwap(),
      ArrowDown: () => spotlight.running && spotlightSwap(),
    };
    const action = actions[key] || { n: newSpotlightModel, l: () => loveCurrentPlayItem("spotlight") }[lower];
    if (!action) return false;
    action();
    return true;
  },
});
