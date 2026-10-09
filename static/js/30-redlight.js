/* ==========================================================================
   Red light / green light — go and stop at random

   Session is predictable: you can feel the hold coming. Here every green
   and every red is a fresh random length inside the ranges you set, and
   green shows no countdown. When the time is up, the last green ends in
   either "Finish" or "Denied" (or a coin toss between them).
   ========================================================================== */

const redlight = {
  stage: null, clock: null, bound: false,
  running: false, phase: "idle", phaseStart: 0, phaseSeconds: 0, rounds: 0, edges: 0, nextSwapAt: 0, warned: false, ending: "",
};

registerModeUI("redlight", {
  card: {
    name: "Red light",
    blurb: "Go and stop at random, no countdown on green. Ends in Finish or Denied.",
    icon: "M9 3h6v18H9zM12 7v.01M12 12v.01M12 17v.01",
    stat: () => `${state.settings.redlightMinutes ?? 10} min`,
  },
  defaults: {
    redlightOrder: "random",
    redlightRatingFilter: "all",
    redlightKind: "all",
    redlightGreenMin: 8,
    redlightGreenMax: 40,
    redlightRedMin: 8,
    redlightRedMax: 25,
    redlightMinutes: 10,
    redlightEnding: "random",
    redlightWarning: false,
    redlightSound: true,
    redlightVolume: 0.3,
  },
  presets: {
    gentle: { redlightGreenMin: 20, redlightGreenMax: 60, redlightRedMin: 5, redlightRedMax: 15 },
    tricky: { redlightGreenMin: 8, redlightGreenMax: 40, redlightRedMin: 8, redlightRedMax: 25 },
    brutal: { redlightGreenMin: 3, redlightGreenMax: 20, redlightRedMin: 15, redlightRedMax: 45 },
  },
  summary: () => {
    const s = state.settings;
    const ending = { finish: "a finish", deny: "denial", random: "a coin toss between finish and denial" }[s.redlightEnding];
    return `Green for ${s.redlightGreenMin}–${s.redlightGreenMax}s, red for ${s.redlightRedMin}–${s.redlightRedMax}s, at random, for ${s.redlightMinutes} min. Then ${ending}.${s.redlightWarning ? " A short warning before each red." : ""}`;
  },
});

function randomBetween(min, max) {
  return min + Math.random() * Math.max(0, max - min);
}

function redlightElapsed() {
  return (redlight.clock.elapsed - redlight.phaseStart) / 1000;
}

function setRedlightPhase(phase, seconds) {
  redlight.phase = phase;
  redlight.phaseStart = redlight.clock.elapsed;
  redlight.phaseSeconds = seconds;
  redlight.warned = false;
  const sound = state.settings.redlightSound;
  if (phase === "red" || phase === "deny") {
    redlight.stage.freeze(true);
    toySet(0);
    if (sound) playTone(260, 380, 0.3);
    try {
      navigator.vibrate?.([60, 60, 60]);
    } catch (error) {
      /* optional */
    }
  } else {
    if (redlight.stage.frozen) {
      redlight.stage.freeze(false);
      redlightSwap();
    }
    if (sound) playTone(phase === "finish" ? 990 : 720, 160, 0.26);
  }
  syncRedlightHud();
}

function redlightSwap() {
  const items = playPool("redlight", state.settings.redlightKind);
  if (!items.length) return;
  const progress = clampNumber(redlight.clock.elapsed / (state.settings.redlightMinutes * 60000), 0, 1);
  redlight.stage.fadeMs = Math.round(lerp(380, 160, progress));
  redlight.stage.show(redlight.stage.pick(items));
  redlight.nextSwapAt = redlight.clock.elapsed + lerp(9000, 3500, progress) * (0.8 + Math.random() * 0.4);
}

function redlightTick(elapsed) {
  const s = state.settings;
  const within = redlightElapsed();
  const progress = clampNumber(elapsed / (s.redlightMinutes * 60000), 0, 1);
  if (redlight.phase === "green") {
    if (elapsed >= redlight.nextSwapAt) redlightSwap();
    toySet(lerp(0.35, 0.95, progress) * (0.9 + Math.random() * 0.1));
    if (s.redlightWarning && !redlight.warned && within >= redlight.phaseSeconds - 2) {
      redlight.warned = true;
      el("redlightStage").dataset.warn = "true";
      if (s.redlightSound) playTone(520, 120, 0.18);
    }
    if (within >= redlight.phaseSeconds) {
      el("redlightStage").dataset.warn = "false";
      if (elapsed >= s.redlightMinutes * 60000) {
        redlight.ending = s.redlightEnding === "random" ? (Math.random() < 0.5 ? "finish" : "deny") : s.redlightEnding;
        setRedlightPhase(redlight.ending, redlight.ending === "deny" ? 15 : 0);
      } else {
        setRedlightPhase("red", randomBetween(s.redlightRedMin, s.redlightRedMax));
      }
      return;
    }
  } else if (redlight.phase === "red") {
    if (within >= redlight.phaseSeconds) {
      redlight.rounds += 1;
      setRedlightPhase("green", randomBetween(s.redlightGreenMin, s.redlightGreenMax));
      return;
    }
  } else if (redlight.phase === "finish") {
    if (elapsed >= redlight.nextSwapAt) redlightSwap();
    toySet(1);
  } else if (redlight.phase === "deny" && within >= redlight.phaseSeconds) {
    stopRedlight();
    return;
  }
  syncRedlightHud();
}

function syncRedlightHud() {
  if (!redlight.running) {
    setHud("redlight", {
      phase: "idle",
      cue: "Red light",
      big: "",
      sub: `${state.settings.redlightMinutes} min of random go and stop.`,
      fill: 0,
    });
    syncRunButtons("redlight", false);
    return;
  }
  const total = state.settings.redlightMinutes * 60000;
  const fill = redlight.clock.elapsed / total;
  const left = Math.max(0, redlight.phaseSeconds - redlightElapsed());
  const edges = redlight.edges ? ` · ${plural(redlight.edges, "edge", "edges")}` : "";
  if (redlight.phase === "green") {
    setHud("redlight", { phase: "go", cue: "Go", sub: `${formatClock(redlight.clock.elapsed / 1000)} in${edges}`, fill, compact: true });
  } else if (redlight.phase === "red") {
    setHud("redlight", { phase: "hold", cue: "Stop", big: formatClock(Math.ceil(left)), sub: "Hands off.", fill });
  } else if (redlight.phase === "finish") {
    setHud("redlight", { phase: "finish", cue: "Finish", sub: "You made it. Go ahead.", fill: 1, compact: true });
  } else if (redlight.phase === "deny") {
    setHud("redlight", { phase: "deny", cue: "Denied", big: formatClock(Math.ceil(left)), sub: "Hands off. That's the end.", fill: 1 });
  }
  el("redlightStatus").textContent = `Round ${redlight.rounds + 1}`;
  syncRunButtons("redlight", true);
}

function startRedlight() {
  if (!playPool("redlight", state.settings.redlightKind).length) {
    toast("Nothing to show. Widen the folders or Show under Adjust.");
    return;
  }
  audioContext();
  redlight.running = true;
  redlight.rounds = 0;
  redlight.edges = 0;
  redlight.ending = "";
  redlight.stage.freeze(false);
  el("redlightStage").dataset.warn = "false";
  redlight.clock.start();
  redlight.nextSwapAt = 0;
  setRedlightPhase("green", randomBetween(state.settings.redlightGreenMin, state.settings.redlightGreenMax));
  redlightSwap();
}

function stopRedlight() {
  if (redlight.running) {
    const seconds = redlight.clock.elapsed / 1000;
    logSession("redlight", seconds, redlight.edges, redlight.ending || undefined);
    toast(`Red light over · ${formatClock(seconds)}${redlight.ending ? ` · ${redlight.ending === "deny" ? "denied" : "finished"}` : ""}`);
  }
  redlight.running = false;
  redlight.phase = "idle";
  redlight.clock.stop();
  redlight.stage.freeze(false);
  redlight.stage.clear();
  el("redlightStage").dataset.warn = "false";
  toyStop();
  syncRedlightHud();
}

// Edge: a penalty stop of the longest red.
function edgeRedlight() {
  if (!redlight.running) {
    toast("Start first. Edge then gives you an instant stop.");
    return;
  }
  if (redlight.phase === "finish" || redlight.phase === "deny") return;
  redlight.edges += 1;
  haptic();
  flashStage("redlight");
  if (redlight.phase === "red") {
    redlight.phaseSeconds += 10;
    toast("Stop extended by 10 seconds.");
    syncRedlightHud();
  } else {
    setRedlightPhase("red", state.settings.redlightRedMax);
  }
}

function bindRedlight() {
  if (redlight.bound) return;
  redlight.bound = true;
  redlight.stage = new PlayStage("redlight", { volumeKey: "redlightVolume" });
  redlight.clock = new PlayClock(redlightTick, 100);
  redlight.stage.onBroken = redlightSwap;
  el("redlightToggleButton").addEventListener("click", () => (redlight.running ? stopRedlight() : startRedlight()));
  el("redlightHudStart").addEventListener("click", startRedlight);
  el("redlightEdgeButton").addEventListener("click", edgeRedlight);
  el("redlightRestart").addEventListener("click", () => {
    stopRedlight();
    startRedlight();
    closeDrawers();
  });
  bindSettingControls(el("redlightDrawer"), (key) => {
    if (key === "redlightVolume") redlight.stage.applyAudio();
    if (key === "redlightKind") invalidateMediaPools();
    syncDrawerSummaries();
    if (!redlight.running) syncRedlightHud();
  });
}

registerMode("redlight", {
  enter() {
    bindRedlight();
    syncSettingControls(el("redlightDrawer"));
    if (redlight.running) {
      redlight.clock.resume();
      redlight.stage.resume();
    }
    syncRedlightHud();
  },
  quiet() {
    redlight.clock?.pause();
    redlight.stage?.pause();
  },
  refresh() {
    if (redlight.running && redlight.phase === "green" && state.currentMode === "redlight") redlightSwap();
    syncDrawerSummaries();
  },
  next() {
    if (redlight.running && !redlight.stage.frozen) redlightSwap();
  },
  key(key, lower) {
    const actions = { " ": () => (redlight.running ? stopRedlight() : startRedlight()), ArrowRight: () => redlight.running && !redlight.stage.frozen && redlightSwap() };
    const action = actions[key] || { e: edgeRedlight, l: () => loveCurrentPlayItem("redlight") }[lower];
    if (!action) return false;
    action();
    return true;
  },
});
