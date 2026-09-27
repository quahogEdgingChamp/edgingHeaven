/* ==========================================================================
   Ladder — climb your own ranking

   Takes the top N of what you kept by Duel rank (unranked keeps fill the
   rest, loved first), turns it upside down and plays it: the weakest first,
   your #1 last. Each step is shorter than the one before. The top step
   stays on screen until you stop.
   ========================================================================== */

const ladder = { stage: null, steps: [], index: 0, running: false, paused: false, clock: null, stepStartedAt: 0, bound: false };

registerModeUI("ladder", {
  card: {
    name: "Ladder",
    blurb: "Your keeps in rising Duel rank. Faster every step, your #1 last.",
    icon: "M7 21V3M17 21V3M7 7h10M7 12h10M7 17h10",
    stat: () => `${state.settings.ladderSteps ?? 40} steps`,
  },
  defaults: {
    ladderRatingFilter: "liked",
    ladderKind: "all",
    ladderSteps: 40,
    ladderStartSeconds: 10,
    ladderEndSeconds: 3,
    ladderVolume: 0.3,
  },
  presets: {
    short: { ladderSteps: 20, ladderStartSeconds: 10, ladderEndSeconds: 4 },
    standard: { ladderSteps: 40, ladderStartSeconds: 10, ladderEndSeconds: 3 },
    long: { ladderSteps: 80, ladderStartSeconds: 12, ladderEndSeconds: 3 },
  },
  summary: () => {
    const pool = playPool("ladder", state.settings.ladderKind).length;
    const ranked = playPool("ladder", state.settings.ladderKind).filter((item) => duelRating(item.path).n).length;
    const steps = Math.min(pool, state.settings.ladderSteps);
    return `${plural(steps, "step", "steps")} from ${plural(pool, "file", "files")} (${ranked.toLocaleString()} duel-ranked), ${state.settings.ladderStartSeconds}s each at the bottom, ${state.settings.ladderEndSeconds}s at the top.`;
  },
});

function buildLadder() {
  const pool = playPool("ladder", state.settings.ladderKind);
  const ranked = pool.filter((item) => duelRating(item.path).n > 0).sort((a, b) => duelRating(b.path).r - duelRating(a.path).r);
  const unranked = pool.filter((item) => !duelRating(item.path).n);
  shuffleBalanced(unranked);
  unranked.sort((a, b) => (b.rating === "love") - (a.rating === "love"));
  // Best first, then flipped: the climb ends on #1.
  return [...ranked, ...unranked].slice(0, state.settings.ladderSteps).reverse();
}

function ladderStepSeconds(index) {
  const count = ladder.steps.length;
  const t = count > 1 ? index / (count - 1) : 1;
  return lerp(state.settings.ladderStartSeconds, state.settings.ladderEndSeconds, t ** 0.8);
}

function showLadderStep(index) {
  const count = ladder.steps.length;
  ladder.index = clampNumber(index, 0, count - 1);
  ladder.stepStartedAt = ladder.clock.elapsed;
  const item = ladder.steps[ladder.index];
  ladder.stage.fadeMs = Math.round(lerp(380, 140, count > 1 ? ladder.index / (count - 1) : 1));
  ladder.stage.show(item);
  syncLadderHud();
}

function ladderTick(elapsed) {
  if (ladder.paused || !ladder.steps.length) return;
  const count = ladder.steps.length;
  const progress = count > 1 ? ladder.index / (count - 1) : 1;
  toySet(lerp(0.25, 1, progress));
  const within = (elapsed - ladder.stepStartedAt) / 1000;
  if (ladder.index < count - 1 && within >= ladderStepSeconds(ladder.index)) {
    showLadderStep(ladder.index + 1);
    return;
  }
  syncLadderBar(within);
}

function syncLadderBar(within = 0) {
  const count = ladder.steps.length;
  const overall = count > 1 ? (ladder.index + clampNumber(within / ladderStepSeconds(ladder.index), 0, 1)) / (count - 1) : 1;
  el("ladderBarFill").style.width = `${Math.round(clampNumber(overall, 0, 1) * 100)}%`;
}

function syncLadderHud() {
  const count = ladder.steps.length;
  el("ladderEmpty").hidden = !!count || ladder.running;
  if (!ladder.running) {
    const pool = playPool("ladder", state.settings.ladderKind).length;
    el("ladderEmpty").hidden = pool > 1;
    setHud("ladder", {
      phase: "idle",
      cue: "Ladder",
      big: "",
      sub: pool > 1 ? `${plural(Math.min(pool, state.settings.ladderSteps), "step", "steps")}, weakest first, your #1 last.` : "",
      fill: 0,
    });
    el("ladderEmptyText").textContent = state.settings.ladderRatingFilter === "liked" || state.settings.ladderRatingFilter === "loved"
      ? "The ladder climbs what you kept, and there is not enough of it here. Keep more in the decks, or set Show to All under Adjust."
      : "Not enough files in the chosen folders.";
    syncRunButtons("ladder", false);
    return;
  }
  const item = ladder.steps[ladder.index];
  const rating = duelRating(item.path);
  const top = ladder.index === count - 1;
  const rank = count - ladder.index;
  setHud("ladder", {
    phase: top ? "finish" : ladder.paused ? "hold" : "go",
    cue: top ? "Top of the ladder" : `Step ${ladder.index + 1} / ${count}`,
    sub: `#${rank}${rating.n ? ` · ${Math.round(rating.r)}` : " · unranked"}${item.rating === "love" ? " · loved" : ""}${ladder.paused ? " · paused" : ""}`,
    compact: true,
  });
  el("ladderStatus").textContent = `${ladderStepSeconds(ladder.index).toFixed(1)}s a step`;
  syncRunButtons("ladder", true);
}

async function startLadder() {
  await loadDuelRatings();
  ladder.steps = buildLadder();
  if (ladder.steps.length < 2) {
    ladder.running = false;
    syncLadderHud();
    toast("Not enough files for a ladder. Widen the folders or Show under Adjust.");
    return;
  }
  ladder.running = true;
  ladder.paused = false;
  ladder.stage.freeze(false);
  ladder.clock.start();
  showLadderStep(0);
}

function stopLadder() {
  if (ladder.running) logSession("ladder", ladder.clock.elapsed / 1000);
  ladder.running = false;
  ladder.paused = false;
  ladder.clock.stop();
  ladder.stage.freeze(false);
  ladder.stage.clear();
  toyStop();
  syncLadderHud();
}

function toggleLadderPause() {
  if (!ladder.running) {
    startLadder();
    return;
  }
  ladder.paused = !ladder.paused;
  ladder.stage.freeze(ladder.paused);
  if (ladder.paused) {
    ladder.clock.pause();
    toyStop();
  } else {
    // Resume the step where it was, not from its start.
    ladder.clock.resume();
  }
  syncLadderHud();
}

function bindLadder() {
  if (ladder.bound) return;
  ladder.bound = true;
  ladder.stage = new PlayStage("ladder", { volumeKey: "ladderVolume" });
  ladder.clock = new PlayClock(ladderTick, 100);
  ladder.stage.onBroken = () => {
    ladder.steps.splice(ladder.index, 1);
    if (ladder.steps.length) showLadderStep(ladder.index);
    else stopLadder();
  };
  el("ladderToggleButton").addEventListener("click", () => (ladder.running ? stopLadder() : startLadder()));
  el("ladderHudStart").addEventListener("click", startLadder);
  el("ladderRestart").addEventListener("click", () => {
    stopLadder();
    startLadder();
    closeDrawers();
  });
  bindSettingControls(el("ladderDrawer"), (key) => {
    if (key === "ladderVolume") ladder.stage.applyAudio();
    if (key === "ladderKind") invalidateMediaPools();
    syncDrawerSummaries();
    if (!ladder.running) syncLadderHud();
  });
}

registerMode("ladder", {
  async enter() {
    bindLadder();
    syncSettingControls(el("ladderDrawer"));
    await loadDuelRatings();
    if (state.currentMode !== "ladder") return;
    syncDrawerSummaries();
    if (ladder.running) {
      if (!ladder.paused) ladder.clock.resume();
      if (ladder.stage.item?.path !== ladder.steps[ladder.index]?.path) ladder.stage.show(ladder.steps[ladder.index]);
      else ladder.stage.resume();
    }
    syncLadderHud();
  },
  quiet() {
    ladder.clock?.pause();
    ladder.stage?.pause();
  },
  refresh() {
    syncDrawerSummaries();
    if (!ladder.running && state.currentMode === "ladder") syncLadderHud();
  },
  next() {
    if (ladder.running) showLadderStep(ladder.index + 1);
  },
  key(key, lower) {
    const actions = {
      " ": toggleLadderPause,
      ArrowRight: () => ladder.running && showLadderStep(ladder.index + 1),
      ArrowLeft: () => ladder.running && showLadderStep(ladder.index - 1),
    };
    const action = actions[key] || { l: () => loveCurrentPlayItem("ladder") }[lower];
    if (!action) return false;
    action();
    return true;
  },
});
