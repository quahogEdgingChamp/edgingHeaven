/* ==========================================================================
   Session — a paced build/hold cycle laid over the media

   Escalation ramps the media. This ramps the session: each round gives you a
   shorter build and a longer hold, and the media follows the phase — swaps
   speed up while building, and freeze while you are holding.
   ========================================================================== */

function sessionSettings() {
  return {
    rounds: clampNumber(Number(state.settings.sessionRounds ?? 5), 2, 10),
    build: clampNumber(Number(state.settings.sessionBuildSeconds ?? 60), 20, 180),
    hold: clampNumber(Number(state.settings.sessionHoldSeconds ?? 15), 5, 60),
    includeVideos: state.settings.sessionIncludeVideos !== false,
  };
}

function buildSessionPhases() {
  const { rounds, build, hold } = sessionSettings();
  const phases = [];
  for (let round = 0; round < rounds; round += 1) {
    const t = rounds === 1 ? 1 : round / (rounds - 1);
    phases.push({
      kind: "build",
      round: round + 1,
      seconds: Math.max(10, Math.round(lerp(build, build * 0.4, t))),
    });
    phases.push({
      kind: "hold",
      round: round + 1,
      seconds: Math.max(5, Math.round(lerp(hold * 0.5, hold, t))),
    });
  }
  // Open-ended: seconds 0 means "runs until you stop it".
  phases.push({ kind: "finish", round: rounds, seconds: 0 });
  return phases;
}

function startSession() {
  stopSessionTimers();
  state.session.phases = buildSessionPhases();
  state.session.index = 0;
  state.session.elapsedMs = 0;
  state.session.running = true;
  state.session.edges = 0;
  state.session.startedAt = Date.now();
  state.session.recentPaths = [];
  renderSessionPips();
  refreshSessionMedia(true);
  runSessionTick();
  syncSessionControls();
}

function enterSession() {
  renderSessionPips();
  if (!controls.sessionStage.dataset.path) refreshSessionMedia(true);
  if (state.session.running) {
    runSessionTick();
    if (currentSessionPhase().kind !== "hold") {
      playWhenReady(controls.sessionVideo, controls.sessionVideo.dataset.loadToken, null);
    }
  } else {
    refreshSessionMedia(true);
    syncSessionHud();
  }
  syncSessionControls();
}

function pauseSession() {
  stopSessionTimers();
  controls.sessionVideo.pause();
}

// A clip picked mid-session starts playing (from a marked moment if it has
// one) unless a hold has frozen the picture in the meantime.
function playSessionClip() {
  const video = controls.sessionVideo;
  if (state.currentMode !== "session" || !video.getAttribute("src")) {
    return;
  }
  if (state.session.running && currentSessionPhase().kind === "hold") {
    return;
  }
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  applySessionAudio();
  playWhenReady(video, video.dataset.loadToken,
    clipStart(video.dataset.path, duration, () => (duration > 8 ? duration * (0.15 + Math.random() * 0.5) : 0)));
}

function sessionToyLevel() {
  if (!state.session.running) return 0;
  const phase = currentSessionPhase();
  if (phase.kind === "hold") return 0;
  if (phase.kind === "finish") return 0.85;
  const within = phase.seconds ? clampNumber(state.session.elapsedMs / (phase.seconds * 1000), 0, 1) : 0;
  return lerp(0.25, 0.95, clampNumber(sessionProgress() * 0.7 + within * 0.3, 0, 1));
}

function stopSession() {
  stopSessionTimers();
  if (state.session.running && state.session.startedAt) {
    const seconds = (Date.now() - state.session.startedAt) / 1000;
    const edges = state.session.edges || 0;
    toast(`Session over · ${formatClock(seconds)}${edges ? ` · ${edges} edge${edges === 1 ? "" : "s"}` : ""}`);
    logSession("session", seconds, edges);
  }
  toyStop();
  state.session.running = false;
  state.session.index = 0;
  state.session.elapsedMs = 0;
  controls.sessionVideo.pause();
  syncSessionHud();
  syncSessionControls();
}

function stopSessionTimers() {
  window.clearInterval(state.session.tickTimer);
  window.clearTimeout(state.session.mediaTimer);
  state.session.tickTimer = null;
  state.session.mediaTimer = null;
}

function toggleSession() {
  if (state.session.running) {
    stopSession();
  } else {
    startSession();
  }
}

/* "Edge": you are close, so hold now instead of when the timer says. The
   current build is cut short, a hold of the full hold length starts, and the
   rest of the build resumes after it. During a hold it adds ten seconds. */
function edgeSession() {
  if (state.currentMode !== "session") {
    return;
  }
  if (!state.session.running) {
    toast("Start a session first. Edge then gives you an instant hold.");
    return;
  }
  const phase = currentSessionPhase();
  const phases = state.session.phases;
  if (phase.kind === "hold") {
    phase.seconds += 10;
    toast("Hold extended by 10 seconds.");
  } else {
    const { hold } = sessionSettings();
    const holdPhase = { kind: "hold", round: phase.round, seconds: hold };
    const elapsed = state.session.elapsedMs / 1000;
    const resume =
      phase.kind === "build"
        ? { kind: "build", round: phase.round, seconds: Math.max(10, Math.round(phase.seconds - elapsed)) }
        : { kind: "finish", round: phase.round, seconds: 0 };
    phases.splice(state.session.index + 1, 0, holdPhase, resume);
    advanceSessionPhase();
  }
  state.session.edges = (state.session.edges || 0) + 1;
  haptic();
  controls.sessionStage.classList.remove("edge-flash");
  void controls.sessionStage.offsetWidth;
  controls.sessionStage.classList.add("edge-flash");
  syncSessionHud();
}

function currentSessionPhase() {
  return state.session.phases[state.session.index] || { kind: "idle", round: 0, seconds: 0 };
}

function sessionProgress() {
  const phases = state.session.phases;
  if (!phases.length) {
    return 0;
  }
  return clampNumber(state.session.index / Math.max(1, phases.length - 1), 0, 1);
}

const SESSION_TICK_MS = 200;

function runSessionTick() {
  stopSessionTimers();
  state.session.tickTimer = window.setInterval(() => {
    if (state.currentMode !== "session" || document.hidden) {
      return;
    }
    const phase = currentSessionPhase();
    state.session.elapsedMs += SESSION_TICK_MS;
    toySet(sessionToyLevel());
    if (phase.seconds > 0 && state.session.elapsedMs >= phase.seconds * 1000) {
      advanceSessionPhase();
      return;
    }
    syncSessionHud();
  }, SESSION_TICK_MS);
  scheduleSessionSwap();
  syncSessionHud();
}

function advanceSessionPhase() {
  if (state.session.index >= state.session.phases.length - 1) {
    state.session.elapsedMs = 0;
    syncSessionHud();
    return;
  }
  state.session.index += 1;
  state.session.elapsedMs = 0;
  const phase = currentSessionPhase();

  if (phase.kind === "hold") {
    // The picture stops with you.
    window.clearTimeout(state.session.mediaTimer);
    state.session.mediaTimer = null;
    controls.sessionVideo.pause();
  } else {
    refreshSessionMedia(true);
  }

  renderSessionPips();
  syncSessionHud();
}

function sessionSwapIntervalMs() {
  const phase = currentSessionPhase();
  if (phase.kind === "hold") {
    return 0;
  }
  if (phase.kind === "finish") {
    return 2500;
  }
  const withinPhase = phase.seconds
    ? clampNumber(state.session.elapsedMs / (phase.seconds * 1000), 0, 1)
    : 0;
  const overall = clampNumber(sessionProgress() * 0.65 + withinPhase * 0.35, 0, 1);
  return lerp(9000, 3000, overall);
}

function scheduleSessionSwap() {
  window.clearTimeout(state.session.mediaTimer);
  const interval = sessionSwapIntervalMs();
  if (!interval || state.currentMode !== "session") {
    return;
  }
  state.session.mediaTimer = window.setTimeout(() => {
    refreshSessionMedia(true);
  }, interval);
}

function getSessionMediaItems() {
  return mediaPool(`session:${sessionSettings().includeVideos}`, () => {
    const images = modeSource("session", "images").map((item) => ({ ...item, kind: "photo" }));
    if (!sessionSettings().includeVideos) {
      return images;
    }
    const videos = modeSource("session", "videos").map((item) => ({ ...item, kind: "video" }));
    return [...images, ...videos];
  });
}

function refreshSessionMedia(force) {
  const items = getSessionMediaItems();
  if (!items.length) {
    setLabel(controls.sessionName, "No media matches the session filter");
    setLabel(controls.sessionFolder, "");
    controls.sessionStatus.textContent = "Widen the folder filter to run a session.";
    return;
  }

  if (!force && controls.sessionStage.dataset.path) {
    scheduleSessionSwap();
    return;
  }

  const chosen = pickWithoutRepeats(items, state.session.recentPaths, controls.sessionStage.dataset.path);
  if (!chosen) {
    return;
  }
  state.session.recentPaths.push(chosen.path);
  if (state.session.recentPaths.length > 24) {
    state.session.recentPaths.shift();
  }

  crossfadeStage(controls.sessionStage, 380);
  controls.sessionStage.dataset.path = chosen.path;
  markSeen(chosen.path);
  setLabel(controls.sessionName, chosen.name);
  setLabel(controls.sessionFolder, chosen.folder || "Library root");

  if (chosen.kind === "photo") {
    releaseVideo(controls.sessionVideo);
    controls.sessionStage.dataset.activeKind = "photo";
    controls.sessionPhoto.dataset.path = chosen.path;
    controls.sessionPhoto.src = mediaUrl(chosen.path);
    controls.sessionPhoto.alt = chosen.name;
  } else {
    controls.sessionStage.dataset.activeKind = "video";
    controls.sessionPhoto.removeAttribute("src");
    controls.sessionPhoto.removeAttribute("data-path");
    controls.sessionVideo.loop = true;
    controls.sessionVideo.playsInline = true;
    applySessionAudio();
    loadVideoSource(controls.sessionVideo, chosen);
  }

  scheduleSessionSwap();
}

function applySessionAudio() {
  const volume = clampNumber(Number(state.settings.sessionVideoVolume ?? 0.3), 0, 1);
  controls.sessionVideo.volume = volume;
  controls.sessionVideo.muted = !state.audioUnlocked || volume === 0;
}

function syncSessionHud() {
  const phase = currentSessionPhase();
  const stage = controls.sessionStage;
  stage.dataset.phase = state.session.running ? phase.kind : "idle";

  const edges = state.session.edges || 0;
  controls.sessionEdges.hidden = !state.session.running || !edges;
  controls.sessionEdges.textContent = `${edges} edge${edges === 1 ? "" : "s"} this session`;
  if (!state.session.running) {
    controls.sessionCue.textContent = "Ready";
    controls.sessionCountdown.textContent = "";
    controls.sessionBarFill.style.width = "0%";
    controls.sessionStatus.textContent = "Press Start to begin a paced session.";
    return;
  }

  const remaining = phase.seconds
    ? Math.max(0, phase.seconds - state.session.elapsedMs / 1000)
    : 0;
  const fraction = phase.seconds
    ? clampNumber(state.session.elapsedMs / (phase.seconds * 1000), 0, 1)
    : 1;

  if (phase.kind === "build") {
    const level = Math.round(lerp(3, 9, clampNumber(sessionProgress(), 0, 1)));
    controls.sessionCue.textContent = `Build — pace ${level}/10`;
  } else if (phase.kind === "hold") {
    controls.sessionCue.textContent = "Hands off";
  } else {
    controls.sessionCue.textContent = "Go";
  }

  controls.sessionCountdown.textContent = phase.seconds ? formatClock(Math.ceil(remaining)) : "";
  controls.sessionBarFill.style.width = `${Math.round(fraction * 100)}%`;

  const { rounds } = sessionSettings();
  controls.sessionStatus.textContent =
    phase.kind === "finish"
      ? "Final round — no timer."
      : `Round ${phase.round} of ${rounds}`;
}

function renderSessionPips() {
  const { rounds } = sessionSettings();
  const phase = currentSessionPhase();
  controls.sessionRoundPips.innerHTML = "";
  for (let round = 1; round <= rounds; round += 1) {
    const pip = document.createElement("span");
    pip.className = "session-pip";
    if (state.session.running && round < phase.round) {
      pip.classList.add("done");
    } else if (state.session.running && round === phase.round) {
      pip.classList.add("current");
    }
    controls.sessionRoundPips.appendChild(pip);
  }
}

function syncSessionControls() {
  setButtonLabel(controls.sessionToggleButton, state.session.running ? "Stop" : "Start", state.session.running ? "i-stop" : "i-play");
  controls.sessionToggleButton.classList.toggle("active", state.session.running);
  controls.sessionEdgeButton.hidden = !state.session.running;
}

