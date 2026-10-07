/* ==========================================================================
   Timed modes — the shared parts

   Beat, Red light, Dice, Ladder, Spotlight and Highlights all do the same
   few things: pick a photo or a clip from their slice of the library, show
   it with a short crossfade, freeze it on a stop, keep time that pauses
   when you leave, and write the finished run to the session log. Each mode
   registers a handler here and the app's own mode switching, keyboard and
   visibility code call into it:

     enter()   the mode is on screen (again): resume whatever was running
     quiet()   the mode is leaving or the tab is hidden: pause, keep state
     refresh() the pool changed (folders, Show, rescan): re-pick, keep the run
     next()    skip what is on screen (the loading overlay's Skip button)
     key(key, lower, event) → true when the key was used
   ========================================================================== */

const MODE_HANDLERS = {};
const PLAY_MODES = ["beat", "redlight", "dice", "ladder", "spotlight", "highlights"];

function registerMode(mode, handler) {
  MODE_HANDLERS[mode] = {
    enter() {},
    quiet() {},
    refresh() {},
    ...handler,
  };
}

// Everything a mode adds to the shared tables: its launcher card, its
// control-center readback, its defaults and presets.
function registerModeUI(mode, { card, summary, defaults = {}, presets }) {
  MODE_CARDS.push({ mode, ...card });
  DRAWER_SUMMARIES[mode] = summary;
  Object.assign(MODE_DEFAULTS, defaults);
  MODE_SETTING_KEYS[mode] = Object.keys(defaults);
  if (presets) {
    MODE_PRESETS[mode] = presets;
  }
}

/* ---- settings: ranges, sliders, switches, segmented choices ---- */

// [min, max] for every numeric setting of the timed modes; anything else
// they own is a choice checked against its segmented control's buttons.
const PLAY_SETTING_RANGES = {
  beatStartBpm: [40, 160], beatPeakBpm: [60, 220], beatMinutes: [2, 30], beatVolume: [0, 1],
  beatMediaVolume: [0, 1], beatSwapBeats: [2, 32],
  redlightGreenMin: [3, 60], redlightGreenMax: [5, 120], redlightRedMin: [3, 60], redlightRedMax: [5, 120],
  redlightMinutes: [2, 45], redlightVolume: [0, 1],
  diceDrawMin: [10, 90], diceDrawMax: [15, 180], diceFinishOdds: [0, 30], diceMinMinutes: [0, 60], diceVolume: [0, 1],
  ladderSteps: [10, 120], ladderStartSeconds: [3, 30], ladderEndSeconds: [1, 15], ladderVolume: [0, 1],
  spotlightRampSeconds: [60, 900], spotlightBaseInterval: [3, 30], spotlightMinInterval: [1, 10], spotlightVolume: [0, 1],
  highlightsRepeat: [1, 5], highlightsVolume: [0, 1],
  toyMax: [0.05, 1],
};
const PLAY_SETTING_CHOICES = {
  beatKind: ["all", "photos", "videos"], beatStops: ["off", "some", "lots"], beatSound: ["click", "wood", "thump"],
  redlightKind: ["all", "photos", "videos"], redlightEnding: ["finish", "deny", "random"],
  diceKind: ["all", "photos", "videos"], ladderKind: ["all", "photos", "videos"],
  highlightsOrder: ["shuffle", "best", "newest"],
};
const PLAY_SETTING_SWITCHES = ["beatVibrate", "redlightWarning", "redlightSound", "diceHolds", "diceSpeed", "diceEdges",
  "useMarks", "neutralTitle", "panicOnHide", "toyAuto"];

function sanitizePlaySettings() {
  const settings = state.settings;
  Object.entries(PLAY_SETTING_RANGES).forEach(([key, [min, max]]) => {
    const fallback = MODE_DEFAULTS[key] ?? min;
    const value = Number(settings[key] ?? fallback);
    settings[key] = clampNumber(Number.isFinite(value) ? value : fallback, min, max);
  });
  // The delete sound was an on/off switch before Moan came along.
  if (typeof settings.thrillSound === "boolean") settings.thrillSound = settings.thrillSound ? "moan" : "off";
  Object.entries(PLAY_SETTING_CHOICES).forEach(([key, allowed]) => {
    if (!allowed.includes(settings[key])) settings[key] = MODE_DEFAULTS[key] ?? allowed[0];
  });
  PLAY_SETTING_SWITCHES.forEach((key) => {
    settings[key] = settings[key] === undefined ? !!MODE_DEFAULTS[key] : !!settings[key];
  });
  // Pairs that must stay in order.
  settings.beatPeakBpm = Math.max(settings.beatPeakBpm, settings.beatStartBpm);
  settings.redlightGreenMax = Math.max(settings.redlightGreenMax, settings.redlightGreenMin);
  settings.redlightRedMax = Math.max(settings.redlightRedMax, settings.redlightRedMin);
  settings.diceDrawMax = Math.max(settings.diceDrawMax, settings.diceDrawMin);
  settings.ladderEndSeconds = Math.min(settings.ladderEndSeconds, settings.ladderStartSeconds);
  settings.spotlightMinInterval = Math.min(settings.spotlightMinInterval, settings.spotlightBaseInterval);
  settings.spotlightModel = typeof settings.spotlightModel === "string" ? settings.spotlightModel : "";
  settings.useMarks = settings.useMarks !== false;
}

const SETTING_FORMATS = {
  s: (v) => `${v}s`,
  bpm: (v) => `${v} bpm`,
  pct: (v) => `${Math.round(v * 100)}%`,
  min: (v) => `${v} min`,
  n: (v) => `${v}`,
  x: (v) => `${v}×`,
  beats: (v) => `${v} beats`,
  odds: (v) => (Number(v) ? `1 in ${v}` : "never"),
  ramp: (v) => (v >= 60 ? `${Math.round((v / 60) * 10) / 10} min` : `${v}s`),
};

// Every control inside a timed mode's drawer (and the Settings cards) is
// described in the markup: data-setting names the key, data-format how its
// value reads. One binder, one sync, no per-slider code.
function bindSettingControls(scope, onChange) {
  scope.querySelectorAll('input[type="range"][data-setting]').forEach((input) => {
    input.addEventListener("input", () => {
      state.settings[input.dataset.setting] = Number(input.value);
      settingControlChanged(scope, input.dataset.setting, onChange);
    });
  });
  scope.querySelectorAll('[role="switch"][data-setting]').forEach((button) => {
    button.addEventListener("click", () => {
      state.settings[button.dataset.setting] = !state.settings[button.dataset.setting];
      settingControlChanged(scope, button.dataset.setting, onChange);
    });
  });
  scope.querySelectorAll(".segmented[data-setting]").forEach((group) => {
    group.addEventListener("click", (event) => {
      const button = event.target.closest("[data-value]");
      if (!button) return;
      const raw = button.dataset.value;
      state.settings[group.dataset.setting] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      settingControlChanged(scope, group.dataset.setting, onChange);
    });
  });
}

function settingControlChanged(scope, key, onChange) {
  sanitizePlaySettings();
  syncSettingControls(scope);
  queueSettingsSave();
  onChange?.(key);
}

function syncSettingControls(scope) {
  scope.querySelectorAll('input[type="range"][data-setting]').forEach((input) => {
    input.value = String(state.settings[input.dataset.setting] ?? input.value);
    paintRange(input);
  });
  scope.querySelectorAll("[data-value-for]").forEach((output) => {
    const format = SETTING_FORMATS[output.dataset.format] || SETTING_FORMATS.n;
    output.textContent = format(state.settings[output.dataset.valueFor]);
  });
  scope.querySelectorAll('[role="switch"][data-setting]').forEach((button) => {
    button.setAttribute("aria-checked", String(!!state.settings[button.dataset.setting]));
  });
  scope.querySelectorAll(".segmented[data-setting]").forEach((group) => {
    syncSegmented(group, "value", state.settings[group.dataset.setting]);
  });
}

/* ---- what a timed mode plays ---- */

// A mode's slice of the library as {..., kind} items: its folders, its Show
// filter, and which kinds it wants.
function playPool(mode, kind = "all") {
  return mediaPool(`${mode}:${kind}`, () => [
    ...(kind !== "videos" ? modeSource(mode, "images").map((item) => ({ ...item, kind: "photo" })) : []),
    ...(kind !== "photos" ? modeSource(mode, "videos").map((item) => ({ ...item, kind: "video" })) : []),
  ]);
}

// Where a clip should start: a marked moment if it has any (and the user
// has not turned that off), otherwise whatever the mode would have picked.
function clipStart(path, duration, fallback) {
  const spans = state.settings.useMarks === false ? null : marksFor(path);
  if (spans?.length && duration > 0) {
    const span = randomOf(spans);
    return clampNumber(span[0], 0, Math.max(0, duration - 0.5));
  }
  return typeof fallback === "function" ? fallback() : fallback ?? null;
}

/* ---- crossfade ----

   The outgoing picture is copied onto a canvas laid over the stage, the new
   media loads underneath it, and the copy fades out once the new one is
   ready. Nothing about the stage's own elements changes, so every mode can
   use it with one call before it swaps sources. */

function crossfadeStage(stage, durationMs = 300) {
  if (!stage || REDUCED_MOTION.matches || durationMs <= 0 || document.hidden) {
    return;
  }
  const kind = stage.dataset.activeKind;
  // The stage's own photo and clip: the first of each (Escalation's corner
  // clips come later in the markup and are not part of the swap).
  const photo = stage.querySelector("img");
  const video = stage.querySelector("video");
  const media = kind === "photo" ? photo : kind === "video" ? video : null;
  const ready = media && (media.tagName === "IMG" ? media.complete && media.naturalWidth : media.readyState >= 2);
  if (!ready) {
    return;
  }
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) {
    return;
  }
  stage.querySelectorAll(".xfade-ghost").forEach((node) => node.remove());
  const scale = Math.min(window.devicePixelRatio || 1, 1.5);
  const canvas = document.createElement("canvas");
  canvas.className = "xfade-ghost";
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const sourceWidth = media.naturalWidth || media.videoWidth;
  const sourceHeight = media.naturalHeight || media.videoHeight;
  try {
    // object-fit: contain, the way the stage draws it.
    const fit = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const drawWidth = sourceWidth * fit;
    const drawHeight = sourceHeight * fit;
    canvas.getContext("2d").drawImage(media, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
  } catch (error) {
    return;
  }
  canvas.style.setProperty("--xfade", `${durationMs}ms`);
  const shell = stage.querySelector('[class$="video-shell"]');
  (shell || media).after(canvas);

  let done = false;
  const fade = () => {
    if (done) return;
    done = true;
    photo?.removeEventListener("load", fade);
    video?.removeEventListener("playing", fade);
    canvas.classList.add("fading");
    window.setTimeout(() => canvas.remove(), durationMs + 60);
  };
  // Whichever element takes the new media reports it ready.
  photo?.addEventListener("load", fade, { once: true });
  video?.addEventListener("playing", fade, { once: true });
  window.setTimeout(fade, 1400);
}

/* ---- the stage ---- */

class PlayStage {
  constructor(mode, { volumeKey, loop = true } = {}) {
    this.mode = mode;
    this.root = el(`${mode}Stage`);
    this.photo = this.root.querySelector(".ps-photo");
    this.video = this.root.querySelector(".ps-video");
    this.volumeKey = volumeKey;
    this.loop = loop;
    this.recent = [];
    this.item = null;
    this.seekTo = null;
    this.rate = 1;
    this.frozen = false;
    this.fadeMs = 300;
    this.onBroken = null;
    this.onEnded = null;
    this.onTime = null;

    const broken = (element) => {
      if (state.currentMode !== this.mode || brokenStreakExhausted(this.mode)) return;
      retryOrCondemn(element, () => this.onBroken?.());
    };
    this.photo.addEventListener("error", () => broken(this.photo));
    this.photo.addEventListener("load", () => {
      retryCounts.delete(this.photo.dataset.path);
      noteMediaLoaded();
    });
    this.video.addEventListener("error", () => {
      if (mediaErrorIsFatal(this.video)) broken(this.video);
    });
    this.video.addEventListener("loadeddata", () => {
      retryCounts.delete(this.video.dataset.path);
      noteMediaLoaded();
    });
    this.video.addEventListener("loadedmetadata", () => this.startClip());
    this.video.addEventListener("ended", () => this.onEnded?.());
    this.video.addEventListener("timeupdate", () => this.onTime?.(this.video));
  }

  pick(items) {
    const chosen = pickWithoutRepeats(items, this.recent, this.item?.path);
    if (chosen) {
      this.recent.push(chosen.path);
      if (this.recent.length > Math.min(40, Math.max(3, Math.floor(items.length / 2)))) this.recent.shift();
    }
    return chosen;
  }

  show(item, { start = null, rate = 1, fade = this.fadeMs } = {}) {
    if (!item) return;
    crossfadeStage(this.root, fade);
    this.item = item;
    this.seekTo = start;
    this.rate = rate;
    this.root.dataset.path = item.path;
    markSeen(item.path);
    setLabel(el(`${this.mode}Name`), item.name);
    setLabel(el(`${this.mode}Folder`), item.folder || "Library root");
    if (item.kind === "photo") {
      releaseVideo(this.video);
      this.root.dataset.activeKind = "photo";
      this.photo.dataset.path = item.path;
      this.photo.alt = item.name;
      this.photo.src = mediaUrl(item.path);
    } else {
      this.photo.removeAttribute("src");
      this.photo.removeAttribute("data-path");
      this.root.dataset.activeKind = "video";
      this.video.loop = this.loop;
      this.video.playsInline = true;
      this.applyAudio();
      loadVideoSource(this.video, item);
    }
  }

  startClip() {
    const video = this.video;
    if (state.currentMode !== this.mode || !video.getAttribute("src")) return;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const start = this.seekTo ?? clipStart(video.dataset.path, duration, () => (duration > 8 ? duration * (0.15 + Math.random() * 0.55) : 0));
    video.playbackRate = this.rate;
    this.applyAudio();
    if (this.frozen) {
      try {
        video.currentTime = start || 0;
      } catch (error) {
        /* a frozen frame is fine wherever it lands */
      }
      return;
    }
    playWhenReady(video, video.dataset.loadToken, start);
  }

  setRate(rate) {
    this.rate = rate;
    if (this.video.getAttribute("src")) this.video.playbackRate = rate;
  }

  freeze(on) {
    this.frozen = on;
    this.root.dataset.frozen = String(on);
    if (on) {
      this.video.pause();
    } else {
      this.resume();
    }
  }

  pause() {
    this.video.pause();
  }

  resume() {
    if (this.frozen || state.currentMode !== this.mode || !this.video.getAttribute("src")) return;
    this.applyAudio();
    playWhenReady(this.video, this.video.dataset.loadToken, null);
  }

  applyAudio() {
    const volume = clampNumber(Number(state.settings[this.volumeKey] ?? 0.3), 0, 1);
    this.video.volume = volume;
    this.video.muted = !state.audioUnlocked || volume === 0;
  }

  clear() {
    releaseVideo(this.video);
    this.photo.removeAttribute("src");
    this.photo.removeAttribute("data-path");
    delete this.root.dataset.path;
    this.root.dataset.activeKind = "idle";
    this.root.querySelectorAll(".xfade-ghost").forEach((node) => node.remove());
    this.item = null;
    setLabel(el(`${this.mode}Name`), "");
    setLabel(el(`${this.mode}Folder`), "");
  }
}

/* ---- time that stops when you leave ---- */

class PlayClock {
  constructor(onTick, stepMs = 100) {
    this.onTick = onTick;
    this.stepMs = stepMs;
    this.elapsed = 0;
    this.running = false;
    this.timer = 0;
  }

  start() {
    this.elapsed = 0;
    this.running = true;
    this.resume();
  }

  resume() {
    if (!this.running) return;
    window.clearInterval(this.timer);
    let last = performance.now();
    this.timer = window.setInterval(() => {
      const now = performance.now();
      // A throttled background timer can fire late; never jump more than a second.
      this.elapsed += Math.min(1000, now - last);
      last = now;
      this.onTick(this.elapsed);
    }, this.stepMs);
  }

  pause() {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  stop() {
    this.running = false;
    this.pause();
  }
}

/* ---- the HUD every timed mode shares ---- */

function setHud(mode, { phase, cue, big = "", sub = "", fill = null, compact = false }) {
  const stage = el(`${mode}Stage`);
  if (phase !== undefined) stage.dataset.phase = phase;
  stage.dataset.hud = compact ? "compact" : "full";
  if (cue !== undefined) el(`${mode}Cue`).textContent = cue;
  el(`${mode}Big`).textContent = big;
  el(`${mode}Sub`).textContent = sub;
  if (fill !== null) el(`${mode}BarFill`).style.width = `${Math.round(clampNumber(fill, 0, 1) * 100)}%`;
}

// Start / Stop and Edge in the top bar, for the modes that run a session.
function syncRunButtons(mode, running) {
  const toggle = el(`${mode}ToggleButton`);
  if (toggle) {
    setButtonLabel(toggle, running ? "Stop" : "Start", running ? "i-stop" : "i-play");
    toggle.classList.toggle("active", running);
  }
  const edge = el(`${mode}EdgeButton`);
  if (edge) edge.hidden = !running;
}

function flashStage(mode, className = "edge-flash") {
  const stage = el(`${mode}Stage`);
  stage.classList.remove(className);
  void stage.offsetWidth;
  stage.classList.add(className);
}

/* ---- one shared audio context for cue tones ---- */

let sharedAudio = null;

function audioContext() {
  if (!sharedAudio) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    sharedAudio = new Context();
  }
  if (sharedAudio.state === "suspended") sharedAudio.resume().catch(() => {});
  return sharedAudio;
}

// A short sine blip: the stop/go cues in Red light and the card chime in Dice.
function playTone(frequency, durationMs = 160, volume = 0.25, when = 0) {
  const context = audioContext();
  if (!context || volume <= 0) return;
  const start = Math.max(context.currentTime, when || context.currentTime);
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationMs / 1000);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + durationMs / 1000 + 0.02);
}

/* ---- the session log ---- */

let sessionHistory = null;

// Runs shorter than a minute are false starts, not sessions.
function logSession(mode, seconds, edges = 0, ending) {
  if (!state.features.has("sessions") || !(seconds >= 60)) return;
  postJson("/api/sessions", { mode, seconds: Math.round(seconds), edges, ...(ending ? { ending } : {}) })
    .then(() => {
      sessionHistory = null;
    })
    .catch((error) => console.debug("session not saved", error));
}
