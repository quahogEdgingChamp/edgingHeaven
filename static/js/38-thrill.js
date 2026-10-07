/* ==========================================================================
   Dangerous — the payoff

   Cleaning is a hundred small decisions with nothing back but a byte count.
   This is what comes back, the same in every Dangerous mode:

   - Feedback: a deleted file burns (or shreds) where it was, with a sound and
     a buzz, and deletes in quick succession build a
     purge streak. How it looks and sounds is in 40-thrill-fx.js.
   - Rewards: every so much freed earns a short clip of what you Loved (your
     marked moments first). It plays over the mode, then you go on cleaning.
   - Toy: each delete pushes the toy up a step and each keep brings it down
     (or the other way round), so the cleaning itself is what drives it.

   Every mode reports its deletes and keeps through cleanupCount(), which
   calls thrillCount() here. Nothing in this file deletes or keeps anything.
   ========================================================================== */

const DANGEROUS_MODES = ["dangerous", "dgrid", "djunk", "dsimilar", "dfolders", "survivor"];
const THRILL_DEFAULTS = {
  thrillEffect: "burn",
  thrillSound: "effects",
  rewardEveryMb: 500,
  rewardSeconds: 30,
  rewardAuto: true,
  toyCleanup: "delete",
  toyCleanupStep: 0.1,
  toyCleanupHurry: false,
};
const THRILL_KEYS = Object.keys(THRILL_DEFAULTS);
Object.assign(MODE_DEFAULTS, THRILL_DEFAULTS, { thrillBestStreak: 0 });
Object.assign(PLAY_SETTING_RANGES, { toyCleanupStep: [0.05, 0.25] });
Object.assign(PLAY_SETTING_CHOICES, {
  thrillEffect: ["burn", "shred", "off"],
  thrillSound: ["effects", "off"],
  rewardEveryMb: [0, 250, 500, 1000, 2000],
  rewardSeconds: [15, 30, 60],
  toyCleanup: ["off", "delete", "keep"],
});
PLAY_SETTING_SWITCHES.push("rewardAuto", "toyCleanupHurry");
// Survivor registers itself after this file and adds the keys there.
["dangerous", "dgrid", "djunk", "dsimilar", "dfolders"].forEach((mode) => MODE_SETTING_KEYS[mode].push(...THRILL_KEYS));

const thrill = {
  streak: 0, lastAt: 0, comboTimer: 0,
  rewardsGiven: 0, banked: 0, autoTimer: 0, reward: null,
  toyLevel: 0, toyIdle: false, hurryTimer: 0,
};
// Deletes this close together keep a streak going. Grid and the other page
// modes take longer per decision than a swipe does.
const STREAK_WINDOW = { dangerous: 5000, survivor: 6000 };
const STREAK_PAGE_WINDOW = 25000;
const STREAK_MILESTONES = [5, 10, 25, 50, 100, 250, 500];
const HURRY_MS = 3000;
const BURN_LIMIT = 24;

/* ---- the shared controls, in every Dangerous control center ---- */

const THRILL_SECTION = `
  <section class="cc-section">
    <h3>Rewards</h3>
    <p class="subtle">Every time you free this much, a short clip of what you Loved plays. Your marked moments come first.</p>
    <div class="segmented" role="group" aria-label="A reward every" data-setting="rewardEveryMb"><button type="button" class="segment" data-value="0">Off</button><button type="button" class="segment" data-value="250">250 MB</button><button type="button" class="segment" data-value="500">500 MB</button><button type="button" class="segment" data-value="1000">1 GB</button><button type="button" class="segment" data-value="2000">2 GB</button></div>
    <div class="segmented" role="group" aria-label="Reward length" data-setting="rewardSeconds"><button type="button" class="segment" data-value="15">15 s</button><button type="button" class="segment" data-value="30">30 s</button><button type="button" class="segment" data-value="60">1 min</button></div>
    <button class="switch-row" role="switch" aria-checked="true" data-setting="rewardAuto"><span>Play a reward as soon as it is earned</span><i aria-hidden="true"></i></button>
    <p class="subtle" data-thrill-reward></p>
  </section>
  <section class="cc-section">
    <h3>Feedback</h3>
    <div class="segmented" role="group" aria-label="What a delete looks like" data-setting="thrillEffect"><button type="button" class="segment" data-value="burn">Burn</button><button type="button" class="segment" data-value="shred">Shred</button><button type="button" class="segment" data-value="off">Plain</button></div>
    <div class="segmented" role="group" aria-label="What a delete sounds like" data-setting="thrillSound"><button type="button" class="segment" data-value="effects">Effects</button><button type="button" class="segment" data-value="off">Silent</button></div>
    <p class="subtle" data-thrill-streak></p>
  </section>
  <section class="cc-section">
    <h3>Toy</h3>
    <div class="segmented" role="group" aria-label="What pushes the toy up" data-setting="toyCleanup"><button type="button" class="segment" data-value="off">Off</button><button type="button" class="segment" data-value="delete">Deletes</button><button type="button" class="segment" data-value="keep">Keeps</button></div>
    <label class="range-row"><span>Step per file</span><strong data-value-for="toyCleanupStep" data-format="pct"></strong><input type="range" min="0.05" max="0.25" step="0.05" data-setting="toyCleanupStep" /></label>
    <button class="switch-row" role="switch" aria-checked="false" data-setting="toyCleanupHurry"><span>Toy stops if you wait more than 3 s</span><i aria-hidden="true"></i></button>
    <p class="subtle" data-thrill-toy></p>
  </section>`;

// Deferred scripts run once the page is parsed and before DOMContentLoaded,
// so the sections are in place when bindCleanup() binds every data-setting.
// Each mode's tool bar also gets the Reward button, shown while one waits.
DANGEROUS_MODES.forEach((mode) => {
  const tune = document.querySelector(`#${mode}Drawer [data-panel="tune"]`);
  const keys = tune?.querySelector(".cc-keys");
  if (keys) keys.insertAdjacentHTML("beforebegin", THRILL_SECTION);
  const tools = document.querySelector(`#${mode}Mode .stage-toolbar .tool-button`);
  tools?.insertAdjacentHTML("beforebegin", '<button class="tool-button reward-tool" data-reward-play hidden aria-label="Play a reward (R)"><svg aria-hidden="true"><use href="#i-heart" /></svg><span class="label">Reward</span></button>');
});

function thrillSettingChanged(key) {
  if (key === "rewardEveryMb") {
    // A new rate counts from here: no pile of rewards for what was freed before.
    const every = rewardEvery();
    thrill.rewardsGiven = every ? Math.floor(cleanup.freed / every) : 0;
  }
  if (key.startsWith("toyCleanup")) {
    if (state.settings.toyCleanup === "off") {
      thrill.toyLevel = 0;
      if (!thrill.reward) toyStop();
    }
    armHurry();
    applyThrillToy();
  }
  // Hear (and see nothing of) what was just picked.
  if (key === "thrillSound" || key === "thrillEffect") {
    const context = thrillAudio();
    if (context) playDeleteSound(context, { effect: state.settings.thrillEffect, weight: 0.3, streak: thrill.streak, milestone: false });
  }
  syncThrillNotes();
  renderCleanupMeters();
}

function syncThrillNotes() {
  const every = rewardEvery();
  const rewardNote = !every
    ? "Rewards are off."
    : rewardSource()
      ? `${thrill.banked ? `${plural(thrill.banked, "reward", "rewards")} waiting. ` : ""}Clips come from your ${rewardSource().level === "love" ? "Loved" : "liked"} files.`
      : "Nothing is Loved yet, so there is nothing to play. ↑ in Swipe keeps and Loves a file.";
  const best = Number(state.settings.thrillBestStreak) || 0;
  const streakNote = best ? `Best purge streak: ×${best}. Deletes close together build one; a keep does not break it.` : "Deletes close together build a purge streak; a keep does not break it.";
  const toyNote = state.settings.toyCleanup === "off"
    ? "The toy is left alone here."
    : !toyConnected()
      ? "No toy connected. Connect one in Settings → Toy."
      : `Now at ${Math.round((thrill.toyIdle ? 0 : thrill.toyLevel) * 100)}% (Max intensity in Settings scales it).`;
  document.querySelectorAll("[data-thrill-reward]").forEach((node) => (node.textContent = rewardNote));
  document.querySelectorAll("[data-thrill-streak]").forEach((node) => (node.textContent = streakNote));
  document.querySelectorAll("[data-thrill-toy]").forEach((node) => (node.textContent = toyNote));
}

/* ---- what every delete and keep reports ---- */

function thrillCount(action, bytes, count) {
  if (!DANGEROUS_MODES.includes(state.currentMode) || !count) return;
  const now = Date.now();
  if (action === "delete") {
    const gap = STREAK_WINDOW[state.currentMode] || STREAK_PAGE_WINDOW;
    const before = now - thrill.lastAt <= gap ? thrill.streak : 0;
    thrill.streak = before + count;
    thrill.lastAt = now;
    const milestone = STREAK_MILESTONES.filter((step) => before < step && thrill.streak >= step).pop();
    showCombo(milestone);
    deleteSound(count, milestone);
    buzz(milestone ? [30, 40, 30] : 18);
    const best = Number(state.settings.thrillBestStreak) || 0;
    if (thrill.streak > best) {
      state.settings.thrillBestStreak = thrill.streak;
      queueSettingsSave();
    }
  } else if (action === "keep") {
    // A keep is a decision too: it keeps the streak alive without adding to it.
    if (thrill.streak) thrill.lastAt = now;
    keepSound();
  } else if (action === "restore") {
    thrill.streak = Math.max(0, thrill.streak - count);
  }
  stepThrillToy(action, count);
  if (action === "delete" || action === "restore") checkRewards();
  syncThrillNotes();
}

/* ---- the purge streak ---- */

function comboNode() {
  let node = el("thrillCombo");
  if (!node) {
    node = document.createElement("div");
    node.id = "thrillCombo";
    node.className = "thrill-combo";
    node.setAttribute("aria-hidden", "true");
    node.hidden = true;
    node.innerHTML = "<strong></strong><span></span>";
    document.body.append(node);
  }
  return node;
}

function showCombo(milestone) {
  if (thrill.streak < 2) return;
  const node = comboNode();
  node.querySelector("strong").textContent = `×${thrill.streak}`;
  node.querySelector("span").textContent = milestone ? "Purge streak!" : "purge streak";
  node.classList.toggle("is-milestone", !!milestone);
  node.hidden = false;
  // Restart the pop on every delete.
  node.classList.remove("is-pop");
  void node.offsetWidth;
  node.classList.add("is-pop");
  window.clearTimeout(thrill.comboTimer);
  thrill.comboTimer = window.setTimeout(() => (node.hidden = true), milestone ? 2200 : 1400);
}

/* ---- burn and shred ---- */

// The media an element is showing right now: a playing clip, else a loaded
// picture or still. Null when there is nothing on screen to copy.
function visibleMedia(node) {
  const shown = (media) => !media.hidden && media.offsetWidth && getComputedStyle(media).visibility !== "hidden";
  const video = [...node.querySelectorAll("video")].find((v) => shown(v) && v.readyState >= 2 && v.videoWidth);
  if (video) return video;
  return [...node.querySelectorAll("img")].find((img) => shown(img) && img.complete && img.naturalWidth && getComputedStyle(img).opacity !== "0") || null;
}

// The picture as it sits on screen, on a canvas, and where on screen it is:
// a contained picture leaves bars around it, and those should not burn.
function snapshotMedia(media, rect) {
  const sourceW = media.videoWidth || media.naturalWidth;
  const sourceH = media.videoHeight || media.naturalHeight;
  const cover = getComputedStyle(media).objectFit === "cover";
  const fit = (cover ? Math.max : Math.min)(rect.width / sourceW, rect.height / sourceH);
  const width = Math.min(rect.width, sourceW * fit), height = Math.min(rect.height, sourceH * fit);
  const shown = { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
  shown.right = shown.left + width;
  shown.bottom = shown.top + height;
  const scale = Math.min(1, 720 / Math.max(width, height)) * Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const drawW = sourceW * fit * scale, drawH = sourceH * fit * scale;
  try {
    canvas.getContext("2d").drawImage(media, (canvas.width - drawW) / 2, (canvas.height - drawH) / 2, drawW, drawH);
  } catch {
    return null;
  }
  return { canvas, rect: shown };
}

// Lays a copy of each element's picture over it and burns or shreds the
// copy away (40-thrill-fx.js). The real element is left alone: its mode
// re-renders it.
function thrillBurn(nodes) {
  const effect = state.settings.thrillEffect || "burn";
  // Reduced motion: the file just goes, as it always did.
  if (effect === "off" || REDUCED_MOTION.matches) return;
  nodes.filter(Boolean).slice(0, BURN_LIMIT).forEach((node) => {
    const media = visibleMedia(node);
    const rect = (media || node).getBoundingClientRect();
    if (!media || rect.width < 8 || rect.height < 8 || rect.bottom < 0 || rect.top > window.innerHeight) return;
    const shot = snapshotMedia(media, rect);
    if (!shot || shot.rect.width < 8 || shot.rect.height < 8) return;
    const small = shot.rect.width < 200;
    runFx(effect === "shred" ? shredEffect(shot.canvas, shot.rect, small) : burnEffect(shot.canvas, shot.rect, small));
  });
}

/* ---- sounds and buzzes ---- */

function buzz(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* optional */
  }
}

function thrillAudio() {
  return state.settings.thrillSound === "off" || state.panic ? null : audioContext();
}

// Heavier when a whole page or folder goes at once.
function deleteSound(count, milestone) {
  const context = thrillAudio();
  if (!context) return;
  playDeleteSound(context, { effect: state.settings.thrillEffect, weight: Math.min(1, (count - 1) / 6), streak: thrill.streak, milestone });
}

function keepSound() {
  const context = thrillAudio();
  if (context) keepChime(context);
}

/* ---- toy ---- */

function stepThrillToy(action, count) {
  const mode = state.settings.toyCleanup;
  if (mode === "off") return;
  const direction = (mode === "delete"
    ? { delete: 1, keep: -1, restore: -1, unkeep: 1 }
    : { keep: 1, delete: -1, unkeep: -1, restore: 1 })[action];
  if (!direction) return;
  // Back from a pause for waiting too long: pick up at half of where it was.
  if (thrill.toyIdle) {
    thrill.toyIdle = false;
    thrill.toyLevel *= 0.5;
  }
  const step = Number(state.settings.toyCleanupStep) || 0.1;
  thrill.toyLevel = clampNumber(thrill.toyLevel + direction * step * count, 0, 1);
  armHurry();
  applyThrillToy();
}

function applyThrillToy() {
  if (thrill.reward || state.settings.toyCleanup === "off" || !DANGEROUS_MODES.includes(state.currentMode)) return;
  toySet(thrill.toyIdle ? 0 : thrill.toyLevel);
}

// "Stops if you wait": every decision restarts a 3 s clock.
function armHurry() {
  window.clearTimeout(thrill.hurryTimer);
  if (!state.settings.toyCleanupHurry || state.settings.toyCleanup === "off" || !thrill.toyLevel) return;
  thrill.hurryTimer = window.setTimeout(() => {
    if (thrill.reward || !DANGEROUS_MODES.includes(state.currentMode)) return;
    thrill.toyIdle = true;
    toySet(0);
    syncThrillNotes();
  }, HURRY_MS);
}

// A Dangerous mode came on screen (again): the toy picks up where it was.
function thrillEnter() {
  if (!DANGEROUS_MODES.includes(state.currentMode)) return;
  applyThrillToy();
  armHurry();
  syncThrillNotes();
  syncRewardReady();
}

// Leaving, hiding the tab or panicking: everything stops (quietAllModes).
function thrillQuiet() {
  window.clearTimeout(thrill.hurryTimer);
  window.clearTimeout(thrill.autoTimer);
  endReward();
  syncRewardReady();
}

/* ---- rewards ---- */

function rewardEvery() {
  return (Number(state.settings.rewardEveryMb) || 0) * MB;
}

function checkRewards() {
  const every = rewardEvery();
  if (!every) return;
  // Counted from what is freed now, not from deletes: deleting and undoing
  // the same file again never earns twice.
  const earned = Math.floor(cleanup.freed / every);
  if (earned <= thrill.rewardsGiven) return;
  thrill.banked += earned - thrill.rewardsGiven;
  thrill.rewardsGiven = earned;
  const context = thrillAudio();
  if (context) {
    chime(context, [392, 523.25, 659.25, 783.99, 1046.5, 1318.5], context.currentTime + 0.18, 0.065, 0.14);
  }
  buzz([60, 40, 60, 40, 120]);
  syncRewardReady();
  if (state.settings.rewardAuto !== false) {
    window.clearTimeout(thrill.autoTimer);
    // After the burn, so the reward does not cut it off.
    thrill.autoTimer = window.setTimeout(() => playReward(true), 900);
  }
}

// Progress to the next reward, for the "freed this visit" line.
function rewardMeterText() {
  const every = rewardEvery();
  if (!every) return "";
  return `next reward in ${formatSize(every - (cleanup.freed % every))}`;
}

// Loved first, then liked. Marked moments beat whole clips, clips beat photos.
function rewardSource() {
  for (const level of ["love", "like"]) {
    const videos = (state.library.videos || []).filter((item) => item.rating === level);
    const moments = videos.flatMap((item) => (marksFor(item.path) || []).map(([start, end]) => ({ item: { ...item, kind: "video" }, start, end })));
    if (moments.length) return { level, list: moments };
    if (videos.length) return { level, list: videos.map((item) => ({ item: { ...item, kind: "video" }, start: null, end: null })) };
    const photos = (state.library.images || []).filter((item) => item.rating === level);
    if (photos.length) return { level, list: photos.map((item) => ({ item: { ...item, kind: "photo" } })) };
  }
  return null;
}

function syncRewardReady() {
  const show = thrill.banked > 0 && !thrill.reward && !!rewardEvery();
  document.querySelectorAll("[data-reward-play]").forEach((button) => {
    button.hidden = !show;
    button.querySelector(".label").textContent = thrill.banked > 1 ? `Reward ×${thrill.banked}` : "Reward";
  });
}

function playReward(auto) {
  if (thrill.reward || !thrill.banked || !DANGEROUS_MODES.includes(state.currentMode) || state.panic || state.locked || document.hidden) return;
  if (blitz.running) {
    // A Blitz round is on the clock; its reward waits for the end.
    if (!auto) toast("Your reward waits until the Blitz is over.");
    return;
  }
  const source = rewardSource();
  if (!source) {
    if (!auto) toast("Nothing is Loved yet, so there is nothing to play. ↑ in Swipe keeps and Loves a file.");
    return;
  }
  thrill.banked -= 1;
  const seconds = Number(state.settings.rewardSeconds) || 30;
  // Whatever plays in the mode underneath pauses, and comes back after.
  const paused = [...document.querySelectorAll(".mode-panel.active video, #cleanupViewerVideo")].filter((video) => !video.paused);
  paused.forEach((video) => video.pause());
  const list = [...source.list];
  shuffleArray(list);
  thrill.reward = {
    list,
    index: 0,
    seconds,
    endsAt: Date.now() + seconds * 1000,
    paused,
    timer: window.setInterval(tickReward, 200),
    photoTimer: 0,
    entry: null,
  };
  el("rewardTitle").textContent = auto ? "Reward earned" : "Reward";
  el("rewardOverlay").hidden = false;
  syncRewardReady();
  nextRewardEntry();
  tickReward();
  el("rewardDone").focus({ preventScroll: true });
}

function nextRewardEntry() {
  const reward = thrill.reward;
  if (!reward) return;
  const entry = reward.list[reward.index % reward.list.length];
  reward.index += 1;
  reward.entry = entry;
  window.clearTimeout(reward.photoTimer);
  const image = el("rewardImage"), video = el("rewardVideo");
  const isVideo = entry.item.kind === "video";
  image.hidden = isVideo;
  video.hidden = !isVideo;
  el("rewardNote").textContent = entry.item.name || "";
  if (isVideo) {
    image.removeAttribute("src");
    video.muted = !state.audioUnlocked;
    const token = loadVideoSource(video, entry.item);
    video.addEventListener("loadedmetadata", () => {
      if (thrill.reward !== reward || reward.entry !== entry) return;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const start = entry.start ?? (duration > 8 ? duration * (0.2 + Math.random() * 0.5) : 0);
      playWhenReady(video, token, start);
    }, { once: true });
  } else {
    releaseVideo(video);
    image.src = mediaUrl(entry.item.path);
    // Photos change every few seconds; one photo alone just stays.
    if (reward.list.length > 1) reward.photoTimer = window.setTimeout(nextRewardEntry, 5000);
  }
}

function rewardVideoTime() {
  const reward = thrill.reward;
  const entry = reward?.entry;
  const video = el("rewardVideo");
  if (!entry || entry.item.kind !== "video" || entry.end == null) return;
  // A marked moment ends where you marked it; the next one follows.
  if (video.currentTime >= entry.end - 0.06) {
    if (reward.list.length > 1) nextRewardEntry();
    else video.currentTime = entry.start;
  }
}

function tickReward() {
  const reward = thrill.reward;
  if (!reward) return;
  const left = Math.max(0, reward.endsAt - Date.now());
  const progress = 1 - left / (reward.seconds * 1000);
  el("rewardClock").textContent = formatClock(Math.ceil(left / 1000));
  el("rewardFill").style.width = `${Math.round(progress * 100)}%`;
  // The toy builds through the reward, whatever cleaning had it at.
  if (state.settings.toyCleanup !== "off") toySet(lerp(0.35, 1, progress));
  if (!left) endReward();
}

function endReward() {
  const reward = thrill.reward;
  if (!reward) return;
  thrill.reward = null;
  window.clearInterval(reward.timer);
  window.clearTimeout(reward.photoTimer);
  el("rewardOverlay").hidden = true;
  releaseVideo(el("rewardVideo"));
  el("rewardImage").removeAttribute("src");
  if (DANGEROUS_MODES.includes(state.currentMode) && !document.hidden && !state.panic) {
    reward.paused.forEach((video) => video.isConnected && video.getAttribute("src") && video.play().catch(() => {}));
    if (state.settings.toyCleanup !== "off") {
      // Back to where cleaning had it.
      toySet(0);
      applyThrillToy();
      armHurry();
    }
  }
  syncRewardReady();
  syncThrillNotes();
}

// While a reward plays it owns the keyboard, so an arrow meant to end it
// never deletes the file underneath. The panic key still goes through.
function rewardKeys(event) {
  if (event.key === "`") return;
  if (thrill.reward) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape" || event.key === "Enter") endReward();
    else if (event.key === " ") {
      const video = el("rewardVideo");
      if (!video.hidden) video.paused ? video.play().catch(() => {}) : video.pause();
    }
    return;
  }
  if (event.key.toLowerCase() === "r" && thrill.banked && DANGEROUS_MODES.includes(state.currentMode)
    && !isTyping() && !event.metaKey && !event.ctrlKey && !event.altKey && !state.activeDrawer) {
    event.preventDefault();
    event.stopImmediatePropagation();
    playReward(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.addEventListener("keydown", rewardKeys, true);
  document.querySelectorAll("[data-reward-play]").forEach((button) => button.addEventListener("click", () => playReward(false)));
  el("rewardDone").addEventListener("click", endReward);
  el("rewardVideo").addEventListener("timeupdate", rewardVideoTime);
  el("rewardVideo").addEventListener("ended", () => thrill.reward && nextRewardEntry());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.panic && !state.locked) thrillEnter();
  });
  syncThrillNotes();
});
