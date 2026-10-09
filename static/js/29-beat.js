/* ==========================================================================
   Beat — a metronome that ramps

   The run is planned when it starts: stretches of 20–45 seconds whose tempo
   climbs from the start BPM to the peak, with random stops between them
   (silence, the picture freezes and dims), then an open-ended finish at the
   peak. The tempo glides inside each stretch, so the climb is continuous.

   Clicks are Web Audio oscillators scheduled a little ahead on the audio
   clock (the usual lookahead pattern), so they stay steady even when the
   page's timers are late. The pulse on screen, the phone's vibration and
   the toy follow the same beat times. The media swaps every N beats.
   ========================================================================== */

const beat = {
  stage: null, clock: null, bound: false,
  running: false, plan: [], index: 0, phaseStart: 0,
  scheduler: 0, nextBeatTime: 0, beatCount: 0, beatsSinceSwap: 0, visuals: [],
  edges: 0, slowdown: 1,
};
const BEAT_LOOKAHEAD = 0.12;

registerModeUI("beat", {
  card: {
    name: "Beat",
    blurb: "A metronome that climbs, with random stops. The media swaps on the beat.",
    icon: "M4 20h16M7 20 11 4h2l4 16M9 13l7-6",
    stat: () => `${state.settings.beatStartBpm ?? 70}→${state.settings.beatPeakBpm ?? 140} bpm`,
  },
  defaults: {
    beatOrder: "random",
    beatRatingFilter: "all",
    beatKind: "all",
    beatStartBpm: 70,
    beatPeakBpm: 140,
    beatMinutes: 8,
    beatStops: "some",
    beatSound: "click",
    beatVolume: 0.6,
    beatVibrate: false,
    beatMediaVolume: 0.2,
    beatSwapBeats: 8,
  },
  presets: {
    slow: { beatStartBpm: 60, beatPeakBpm: 120, beatMinutes: 12, beatStops: "some" },
    standard: { beatStartBpm: 70, beatPeakBpm: 140, beatMinutes: 8, beatStops: "some" },
    overload: { beatStartBpm: 100, beatPeakBpm: 200, beatMinutes: 5, beatStops: "lots" },
  },
  summary: () => {
    const stops = { off: "no stops", some: "a few random stops", lots: "lots of random stops" }[state.settings.beatStops];
    return `${state.settings.beatStartBpm} bpm climbing to ${state.settings.beatPeakBpm} over ${state.settings.beatMinutes} min, ${stops}, then an open finish. New picture every ${state.settings.beatSwapBeats} beats.`;
  },
});

function buildBeatPlan() {
  const { beatStartBpm: start, beatPeakBpm: peak, beatMinutes: minutes, beatStops: stops } = state.settings;
  const total = minutes * 60;
  const stopChance = { off: 0, some: 0.28, lots: 0.5 }[stops] ?? 0;
  const plan = [];
  let t = 0;
  while (t < total) {
    const seconds = Math.min(total - t, 20 + Math.random() * 25);
    const from = lerp(start, peak, (t / total) ** 1.15);
    const to = lerp(start, peak, ((t + seconds) / total) ** 1.15);
    plan.push({ kind: "go", seconds, from, to });
    t += seconds;
    // No stop in the first minute, none right before the finish.
    if (t > 60 && t < total - 15 && Math.random() < stopChance) {
      const length = stops === "lots" ? 10 + Math.random() * 20 : 8 + Math.random() * 14;
      plan.push({ kind: "stop", seconds: length });
    }
  }
  plan.push({ kind: "finish", seconds: 0, from: peak, to: peak });
  return plan;
}

function beatPhase() {
  return beat.plan[beat.index] || { kind: "idle", seconds: 0 };
}

function beatPhaseElapsed() {
  return (beat.clock.elapsed - beat.phaseStart) / 1000;
}

function currentBpm() {
  const phase = beatPhase();
  if (phase.kind === "stop" || phase.kind === "idle") return 0;
  const within = phase.seconds ? clampNumber(beatPhaseElapsed() / phase.seconds, 0, 1) : 1;
  return lerp(phase.from, phase.to, within) * beat.slowdown;
}

/* ---- sound ---- */

function beatClick(time, accent) {
  const context = audioContext();
  const volume = clampNumber(Number(state.settings.beatVolume), 0, 1) * (accent ? 1 : 0.62);
  if (!context || volume <= 0) return;
  const sound = state.settings.beatSound;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  if (sound === "thump") {
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(accent ? 170 : 140, time);
    oscillator.frequency.exponentialRampToValueAtTime(55, time + 0.11);
  } else if (sound === "wood") {
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(accent ? 1250 : 980, time);
  } else {
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(accent ? 2100 : 1650, time);
  }
  const length = sound === "thump" ? 0.14 : sound === "wood" ? 0.06 : 0.03;
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(volume * (sound === "click" ? 0.35 : 0.9), time + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + length);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(time);
  oscillator.stop(time + length + 0.02);
}

// Runs every 25ms while a run is going: schedule every beat that falls in
// the next 120ms on the audio clock, and queue its pulse for the screen.
function scheduleBeats() {
  const context = audioContext();
  if (!context) return;
  const bpm = currentBpm();
  if (!bpm) {
    beat.nextBeatTime = context.currentTime + 0.05;
    return;
  }
  if (beat.nextBeatTime < context.currentTime) beat.nextBeatTime = context.currentTime + 0.03;
  while (beat.nextBeatTime < context.currentTime + BEAT_LOOKAHEAD) {
    const accent = beat.beatCount % 4 === 0;
    beatClick(beat.nextBeatTime, accent);
    queueBeatVisual(beat.nextBeatTime - context.currentTime, accent, bpm);
    beat.nextBeatTime += 60 / bpm;
    beat.beatCount += 1;
  }
}

function queueBeatVisual(delaySeconds, accent, bpm) {
  const timer = window.setTimeout(() => {
    beat.visuals = beat.visuals.filter((entry) => entry !== timer);
    if (!beat.running || state.currentMode !== "beat") return;
    const pulse = el("beatPulse");
    pulse.classList.remove("on", "accent");
    void pulse.offsetWidth;
    pulse.classList.add("on");
    pulse.classList.toggle("accent", accent);
    const fraction = clampNumber((bpm - state.settings.beatStartBpm) / Math.max(1, state.settings.beatPeakBpm - state.settings.beatStartBpm), 0, 1);
    const level = lerp(0.35, 1, fraction);
    toySet(level);
    window.setTimeout(() => toySet(level * 0.2), (60 / bpm) * 450);
    if (state.settings.beatVibrate) {
      try {
        navigator.vibrate?.(accent ? 45 : 25);
      } catch (error) {
        /* optional */
      }
    }
    beat.beatsSinceSwap += 1;
    if (beat.beatsSinceSwap >= state.settings.beatSwapBeats) {
      beat.beatsSinceSwap = 0;
      beatSwap();
    }
  }, Math.max(0, delaySeconds * 1000));
  beat.visuals.push(timer);
}

function startBeatScheduler() {
  window.clearInterval(beat.scheduler);
  const context = audioContext();
  if (context) beat.nextBeatTime = context.currentTime + 0.1;
  beat.scheduler = window.setInterval(scheduleBeats, 25);
}

function stopBeatScheduler() {
  window.clearInterval(beat.scheduler);
  beat.scheduler = 0;
  beat.visuals.forEach((timer) => window.clearTimeout(timer));
  beat.visuals = [];
}

/* ---- media ---- */

function beatSwap() {
  const items = playPool("beat", state.settings.beatKind);
  if (!items.length) return;
  beat.stage.fadeMs = 140;
  beat.stage.show(beat.stage.pick(items));
}

/* ---- the run ---- */

function beatTick() {
  const phase = beatPhase();
  if (phase.seconds && beatPhaseElapsed() >= phase.seconds) {
    advanceBeatPhase();
    return;
  }
  syncBeatHud();
}

function advanceBeatPhase() {
  if (beat.index >= beat.plan.length - 1) return;
  beat.index += 1;
  beat.phaseStart = beat.clock.elapsed;
  const phase = beatPhase();
  if (phase.kind === "stop") {
    beat.stage.freeze(true);
    toySet(0);
    playTone(330, 260, 0.3 * clampNumber(Number(state.settings.beatVolume), 0, 1));
  } else {
    if (beat.stage.frozen) {
      beat.stage.freeze(false);
      playTone(660, 120, 0.25 * clampNumber(Number(state.settings.beatVolume), 0, 1));
      beatSwap();
    }
    // Back after a stop (or an edge): ease in slower and recover.
    if (beat.slowdown < 1) beat.slowdown = Math.min(1, beat.slowdown + 0.08);
  }
  syncBeatHud();
}

function syncBeatHud() {
  if (!beat.running) {
    setHud("beat", {
      phase: "idle",
      cue: "Beat",
      big: "",
      sub: `${state.settings.beatStartBpm} → ${state.settings.beatPeakBpm} bpm · ${state.settings.beatMinutes} min`,
      fill: 0,
    });
    syncRunButtons("beat", false);
    return;
  }
  const phase = beatPhase();
  const total = beat.plan.reduce((sum, entry) => sum + entry.seconds, 0);
  const done = beat.plan.slice(0, beat.index).reduce((sum, entry) => sum + entry.seconds, 0) + Math.min(phase.seconds || 0, beatPhaseElapsed());
  const left = Math.max(0, (phase.seconds || 0) - beatPhaseElapsed());
  if (phase.kind === "stop") {
    setHud("beat", { phase: "hold", cue: "Stop", big: formatClock(Math.ceil(left)), sub: "Hands off. The beat comes back on its own.", fill: done / total });
  } else if (phase.kind === "finish") {
    setHud("beat", { phase: "finish", cue: `Finish · ${Math.round(currentBpm())} bpm`, sub: "Open end. Stop when you are done.", fill: 1, compact: true });
  } else {
    setHud("beat", { phase: "go", cue: `${Math.round(currentBpm())} bpm`, sub: `${formatClock(beat.clock.elapsed / 1000)} in${beat.edges ? ` · ${plural(beat.edges, "edge", "edges")}` : ""}`, fill: done / total, compact: true });
  }
  el("beatStatus").textContent = phase.kind === "stop" ? "" : `${beat.beatCount.toLocaleString()} beats`;
  syncRunButtons("beat", true);
}

function startBeat() {
  const items = playPool("beat", state.settings.beatKind);
  if (!items.length) {
    toast("Nothing to show. Widen the folders or Show under Adjust.");
    return;
  }
  audioContext(); // Created inside the tap, which is what browsers require.
  beat.plan = buildBeatPlan();
  beat.index = 0;
  beat.phaseStart = 0;
  beat.beatCount = 0;
  beat.beatsSinceSwap = 0;
  beat.edges = 0;
  beat.slowdown = 1;
  beat.running = true;
  beat.stage.freeze(false);
  beat.clock.start();
  startBeatScheduler();
  beatSwap();
  syncBeatHud();
}

function stopBeat() {
  if (beat.running) {
    const seconds = beat.clock.elapsed / 1000;
    toast(`Beat over · ${formatClock(seconds)} · ${beat.beatCount.toLocaleString()} beats${beat.edges ? ` · ${plural(beat.edges, "edge", "edges")}` : ""}`);
    logSession("beat", seconds, beat.edges, beatPhase().kind === "finish" ? "finish" : undefined);
  }
  beat.running = false;
  beat.clock.stop();
  stopBeatScheduler();
  beat.stage.freeze(false);
  beat.stage.clear();
  toyStop();
  syncBeatHud();
}

// Edge: an instant stop now, and the beat comes back a notch slower.
function edgeBeat() {
  if (!beat.running) {
    toast("Start the beat first. Edge then gives you an instant stop.");
    return;
  }
  const phase = beatPhase();
  beat.edges += 1;
  haptic();
  flashStage("beat");
  if (phase.kind === "stop") {
    phase.seconds += 10;
    toast("Stop extended by 10 seconds.");
    syncBeatHud();
    return;
  }
  const left = phase.seconds ? Math.max(8, phase.seconds - beatPhaseElapsed()) : 0;
  const resume = phase.kind === "finish"
    ? { kind: "finish", seconds: 0, from: phase.from, to: phase.to }
    : { kind: "go", seconds: left, from: currentBpm() / beat.slowdown, to: phase.to };
  beat.plan.splice(beat.index + 1, 0, { kind: "stop", seconds: 20 }, resume);
  beat.slowdown = Math.max(0.7, beat.slowdown - 0.15);
  advanceBeatPhase();
}

function bindBeat() {
  if (beat.bound) return;
  beat.bound = true;
  beat.stage = new PlayStage("beat", { volumeKey: "beatMediaVolume" });
  beat.clock = new PlayClock(beatTick, 100);
  beat.stage.onBroken = beatSwap;
  el("beatToggleButton").addEventListener("click", () => (beat.running ? stopBeat() : startBeat()));
  el("beatHudStart").addEventListener("click", startBeat);
  el("beatEdgeButton").addEventListener("click", edgeBeat);
  el("beatRestart").addEventListener("click", () => {
    stopBeat();
    startBeat();
    closeDrawers();
  });
  el("beatPreview").addEventListener("click", () => {
    const context = audioContext();
    if (!context) return;
    for (let index = 0; index < 4; index += 1) beatClick(context.currentTime + 0.05 + index * 0.5, index === 0);
  });
  bindSettingControls(el("beatDrawer"), (key) => {
    if (key === "beatMediaVolume") beat.stage.applyAudio();
    if (key === "beatKind") invalidateMediaPools();
    syncDrawerSummaries();
    if (!beat.running) syncBeatHud();
  });
}

registerMode("beat", {
  enter() {
    bindBeat();
    syncSettingControls(el("beatDrawer"));
    if (beat.running) {
      beat.clock.resume();
      startBeatScheduler();
      beat.stage.resume();
    }
    syncBeatHud();
  },
  quiet() {
    if (!beat.bound) return;
    beat.clock.pause();
    stopBeatScheduler();
    beat.stage.pause();
  },
  refresh() {
    if (beat.running && state.currentMode === "beat") beatSwap();
    syncDrawerSummaries();
  },
  next() {
    if (beat.running) beatSwap();
  },
  key(key, lower) {
    const actions = { " ": () => (beat.running ? stopBeat() : startBeat()), ArrowRight: () => beat.running && beatSwap() };
    const action = actions[key] || { e: edgeBeat, l: () => loveCurrentPlayItem("beat") }[lower];
    if (!action) return false;
    action();
    return true;
  },
});
