function startEscalation() {
  stopEscalation();
  state.escalationRecentPaths = [];
  state.escalationSessionStartedAt = Date.now();
  refreshEscalationMedia(true);
  refreshCornerClips();
  // The ramp meter moves every second, not only when the media swaps.
  state.escalationTick = window.setInterval(() => {
    if (state.currentMode === "escalation" && !document.hidden) {
      updateEscalationTelemetry();
      toySet(state.settings.escalationRamp === false ? 0.45 : lerp(0.2, 1, getEscalationProgress()));
    }
  }, 1000);
}

function stopEscalation() {
  if (state.escalationTimer) {
    window.clearTimeout(state.escalationTimer);
    state.escalationTimer = null;
  }
  if (state.escalationBurstTimer) {
    window.clearInterval(state.escalationBurstTimer);
    state.escalationBurstTimer = null;
  }
  window.clearInterval(state.escalationTick);
  state.escalationTick = 0;
  state.escalationCurrentIntervalMs = 0;
  state.escalationSessionStartedAt = 0;
  pauseEscalationVideo();
}

function renderEscalationIdle() {
  setLabel(controls.escalationName, "Waiting for media");
  setLabel(controls.escalationFolder, "");
  controls.escalationStatus.textContent = "Building pressure...";
  controls.escalationPhaseBadge.textContent = "Warmup";
  controls.escalationTelemetry.textContent = "Swap 12.0s • 1.0x";
}

function refreshEscalationMedia(force) {
  const mediaItems = getEscalationMediaItems();

  if (!mediaItems.length) {
    clearEscalationMedia();
    setLabel(controls.escalationName, "No escalation media available");
    setLabel(controls.escalationFolder, "");
    controls.escalationStatus.textContent =
      "Add images or videos, or widen the folder filter to start the ramp.";
    controls.escalationPhaseBadge.textContent = "Idle";
    controls.escalationTelemetry.textContent = "No media";
    return;
  }

  const currentPath = controls.escalationStage.dataset.path;
  if (!force && currentPath) {
    updateEscalationTelemetry();
    scheduleEscalationSwap();
    return;
  }

  const chosen = pickEscalationItem(mediaItems);
  if (!chosen) {
    return;
  }

  if (chosen.kind === "photo") {
    showEscalationPhoto(chosen);
  } else {
    loadEscalationVideoClip(chosen);
  }
  updateEscalationTelemetry();
  scheduleEscalationSwap();
}

function scheduleEscalationSwap() {
  if (state.currentMode !== "escalation") {
    return;
  }
  if (state.escalationTimer) {
    window.clearTimeout(state.escalationTimer);
  }
  state.escalationCurrentIntervalMs = currentEscalationIntervalMs();
  state.escalationTimer = window.setTimeout(() => {
    refreshEscalationMedia(true);
  }, state.escalationCurrentIntervalMs);
}

function showEscalationPhoto(item) {
  if (!item) {
    controls.escalationPhoto.removeAttribute("src");
    controls.escalationPhoto.alt = "";
    return;
  }

  if (state.escalationBurstTimer) {
    window.clearInterval(state.escalationBurstTimer);
    state.escalationBurstTimer = null;
  }

  crossfadeStage(controls.escalationStage, escalationFadeMs());
  releaseVideo(controls.escalationVideo);

  controls.escalationStage.dataset.activeKind = "photo";
  controls.escalationStage.dataset.path = item.path;
  controls.escalationPhoto.dataset.path = item.path;
  controls.escalationPhoto.src = mediaUrl(item.path);
  controls.escalationPhoto.alt = item.name;
  markSeen(item.path);
  setLabel(controls.escalationName, item.name);
  setLabel(controls.escalationFolder, item.folder || "Library root");
}

function loadEscalationVideoClip(chosen) {
  const video = controls.escalationVideo;
  if (!chosen) {
    if (state.escalationBurstTimer) {
      window.clearInterval(state.escalationBurstTimer);
      state.escalationBurstTimer = null;
    }
    releaseVideo(video);
    return;
  }

  if (state.escalationBurstTimer) {
    window.clearInterval(state.escalationBurstTimer);
    state.escalationBurstTimer = null;
  }

  crossfadeStage(controls.escalationStage, escalationFadeMs());
  controls.escalationStage.dataset.activeKind = "video";
  controls.escalationStage.dataset.path = chosen.path;
  controls.escalationPhoto.removeAttribute("src");
  controls.escalationPhoto.removeAttribute("data-path");
  controls.escalationPhoto.alt = "";
  video.loop = false;
  video.playsInline = true;
  applyEscalationAudio();
  loadVideoSource(video, chosen);
  markSeen(chosen.path);

  setLabel(controls.escalationName, chosen.name);
  setLabel(controls.escalationFolder, chosen.folder || "Library root");
}

function configureEscalationVideo() {
  if (state.currentMode !== "escalation" || !controls.escalationVideo.src) {
    return;
  }

  const video = controls.escalationVideo;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const progress = getEscalationProgress();
  const speed = currentEscalationSpeed(progress);
  // A marked moment when the clip has one, else somewhere past the intro.
  const hotStart = clipStart(video.dataset.path, duration, () =>
    clampNumber(duration > 0 ? duration * (0.35 + Math.random() * 0.5) : 0, 0, Math.max(0, duration - 0.4)));

  video.playbackRate = speed;
  applyEscalationAudio();
  restartEscalationBurst(duration, progress);
  updateEscalationTelemetry(progress);
  // Land the seek and decode a frame before the sound starts.
  playWhenReady(video, video.dataset.loadToken, hotStart);
}

function restartEscalationBurst(duration, progress) {
  if (state.escalationBurstTimer) {
    window.clearInterval(state.escalationBurstTimer);
    state.escalationBurstTimer = null;
  }
  if (progress < 0.58 || duration < 8) {
    return;
  }

  const burstProgress = clampNumber((progress - 0.58) / 0.42, 0, 1);
  const cadence = Math.round(lerp(460, 110, burstProgress));
  state.escalationBurstTimer = window.setInterval(() => {
    if (state.currentMode !== "escalation" || document.hidden || !controls.escalationVideo.src) {
      return;
    }

    const video = controls.escalationVideo;
    const maxTime = Math.max(duration * 0.4, duration - 0.6);
    const minTime = duration * 0.35;
    if (maxTime <= minTime) {
      return;
    }

    const forwardJump = duration * lerp(0.04, 0.14, burstProgress) * (0.8 + Math.random() * 0.9);
    let target = video.currentTime + forwardJump;
    if (target >= maxTime || Math.random() > lerp(0.82, 0.42, burstProgress)) {
      target = minTime + Math.random() * (maxTime - minTime);
    }

    try {
      video.currentTime = clampNumber(target, minTime, maxTime);
    } catch (error) {
      console.error(error);
    }
  }, cadence);
}

function updateEscalationTelemetry(progress = getEscalationProgress()) {
  const intervalMs = currentEscalationIntervalMs(progress);
  const speed = currentEscalationSpeed(progress);
  const phase = escalationPhaseLabel(progress);
  const burstActive = progress >= 0.58 && !!controls.escalationVideo.src;

  controls.escalationPhaseBadge.textContent = phase;
  controls.escalationProgressFill.style.width = `${Math.round(progress * 100)}%`;
  controls.escalationTelemetry.textContent = `Swap ${(intervalMs / 1000).toFixed(1)}s • ${speed.toFixed(1)}x${
    burstActive ? " • Burst" : ""
  }`;
  if (controls.escalationVideo.src) {
    controls.escalationStatus.textContent = state.settings.escalationRamp === false ? "" : `${Math.round(getEscalationProgress() * 100)}% through the ramp`;
  } else if (controls.escalationPhoto.src) {
    controls.escalationStatus.textContent = state.settings.escalationRamp === false ? "" : `${Math.round(getEscalationProgress() * 100)}% through the ramp`;
  }
}

// Swaps soften into each other early on and snap late in the ramp.
function escalationFadeMs() {
  return state.settings.escalationRamp === false ? 450 : Math.round(lerp(450, 110, getEscalationProgress()));
}

function escalationPhaseLabel(progress) {
  if (state.settings.escalationRamp === false) {
    return "Steady";
  }
  if (progress >= 0.82) {
    return "Burst Mode";
  }
  if (progress >= 0.58) {
    return "Overclock";
  }
  if (progress >= 0.28) {
    return "Drive";
  }
  return "Warmup";
}

function currentEscalationIntervalMs(progress = getEscalationProgress()) {
  const minSeconds = clampNumber(Number(state.settings.escalationMinInterval ?? 2), 1, 12);
  const baseSeconds = Math.max(minSeconds, clampNumber(Number(state.settings.escalationBaseInterval ?? 12), 1, 60));
  const eased = 1 - (1 - progress) ** 2;
  return lerp(baseSeconds * 1000, minSeconds * 1000, eased);
}

function currentEscalationSpeed(progress = getEscalationProgress()) {
  const maxSpeed = clampNumber(Number(state.settings.escalationMaxSpeed ?? 2.2), 1, 3);
  const eased = progress ** 1.15;
  return lerp(1, maxSpeed, eased);
}

function getEscalationProgress() {
  // Steady (no ramp): the pace never moves off its starting point.
  if (state.settings.escalationRamp === false) {
    return 0;
  }
  const rampMs = clampNumber(Number(state.settings.escalationRampSeconds ?? 90), 20, 300) * 1000;
  if (!state.escalationSessionStartedAt) {
    return 0;
  }
  return clampNumber((Date.now() - state.escalationSessionStartedAt) / rampMs, 0, 1);
}

function clearEscalationMedia() {
  stopEscalation();
  state.escalationRecentPaths = [];
  controls.escalationStage.dataset.activeKind = "idle";
  controls.escalationStage.removeAttribute("data-path");
  controls.escalationPhoto.removeAttribute("src");
  controls.escalationPhoto.removeAttribute("data-path");
  controls.escalationPhoto.alt = "";
  releaseVideo(controls.escalationVideo);
}

/* Corner clips: up to two small videos over the Escalation stage (what the
   old Stream mode did). Each plays from a random point and swaps when it
   ends. Same folders and Show filter as the stage itself. */
function queueCornerRefresh() {
  // The slider fires on every pixel of a drag. Rebuilding on each one stacks
  // half-loaded <video> elements whose audio comes up on top of each other.
  window.clearTimeout(state.cornerRebuildTimer);
  state.cornerRebuildTimer = window.setTimeout(refreshCornerClips, 220);
}

function stopCornerClips() {
  window.clearTimeout(state.cornerRebuildTimer);
  state.cornerSlots.forEach(({ video }) => releaseVideo(video));
  controls.videoOverlay.querySelectorAll("video").forEach((video) => releaseVideo(video));
  controls.videoOverlay.innerHTML = "";
  state.cornerSlots = [];
}

function refreshCornerClips() {
  stopCornerClips();
  if (state.currentMode !== "escalation") return;
  const count = clampNumber(Number(state.settings.escalationCorners ?? 0), 0, 2);
  for (let index = 0; index < count; index += 1) {
    const fragment = document.getElementById("videoSlotTemplate").content.cloneNode(true);
    fragment.querySelector(".video-slot").classList.add(`corner-${index}`);
    controls.videoOverlay.appendChild(fragment);
    const video = controls.videoOverlay.lastElementChild.querySelector("video");

    video.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      playWhenReady(video, video.dataset.loadToken, Math.random() * Math.max(0, duration - 0.25));
    });
    video.addEventListener("loadeddata", noteMediaLoaded);
    video.addEventListener("error", () => {
      if (mediaErrorIsFatal(video) && reportBrokenMedia(video.dataset.path) && !brokenStreakExhausted("escalation")) {
        loadCornerClip(video);
      }
    });
    video.addEventListener("ended", () => loadCornerClip(video));

    state.cornerSlots.push({ video });
    loadCornerClip(video);
  }
  applyCornerVolume();
}

function loadCornerClip(video) {
  const videos = getEscalationVideos();
  if (!videos.length) {
    releaseVideo(video);
    return;
  }
  const busy = [controls.escalationVideo.dataset.path, ...state.cornerSlots.map((slot) => slot.video.dataset.path)].filter(Boolean);
  const chosen = pickWithoutRepeats(videos, busy, video.dataset.path, "escalation");
  if (!chosen) {
    return;
  }
  video.loop = false;
  video.playsInline = true;
  loadVideoSource(video, chosen);
  markSeen(chosen.path);
  applyCornerVolume();
}

// Corners sit a little under the stage clip so the main one leads.
function applyCornerVolume() {
  const volume = clampNumber(Number(state.settings.escalationVideoVolume ?? 0.32), 0, 1) * 0.6;
  state.cornerSlots.forEach(({ video }) => {
    video.volume = volume;
    video.muted = !state.audioUnlocked || volume === 0;
  });
}

function applyToktinderAudio() {
  controls.toktinderVideo.volume = 1;
  controls.toktinderVideo.muted = !state.audioUnlocked;
}

function applyEscalationAudio() {
  controls.escalationVideo.volume = clampNumber(Number(state.settings.escalationVideoVolume ?? 0.32), 0, 1);
  controls.escalationVideo.muted =
    !state.audioUnlocked || Number(state.settings.escalationVideoVolume ?? 0.32) === 0;
}

function playCornerClips() {
  state.cornerSlots.forEach(({ video }) => {
    video.play().catch(() => {});
  });
}

function pauseToktinderVideo() {
  controls.toktinderVideo.pause();
}

function pauseEscalationVideo() {
  controls.escalationVideo.pause();
}

function playToktinderVideo() {
  if (state.currentMode !== "toktinder" || !controls.toktinderVideo.src) {
    return;
  }
  applyToktinderAudio();
  controls.toktinderVideo.play().catch(() => {});
}

function playEscalationVideo() {
  if (state.currentMode !== "escalation" || !controls.escalationVideo.src) {
    return;
  }
  applyEscalationAudio();
  controls.escalationVideo.play().catch(() => {});
}

function toggleVideoAudio() {
  state.audioUnlocked = !state.audioUnlocked;
  syncAudioButton();
  applyCornerVolume();
  applyToktinderAudio();
  applyEscalationAudio();
  applySessionAudio();
  applyMosaicAudio();
  applyFeedAudio();
  playCornerClips();
  playToktinderVideo();
  playEscalationVideo();
  PLAY_MODES.forEach((mode) => playStageFor(mode)?.applyAudio());
  playStageFor(state.currentMode)?.resume();
}

function onSwipePointerDown(event) {
  const mode = event.currentTarget.dataset.swipeMode;
  if (!deckHasItem(mode)) {
    return;
  }
  state.drag.active = true;
  state.drag.mode = mode;
  state.drag.pointerId = event.pointerId;
  state.drag.startX = event.clientX;
  state.drag.startY = event.clientY;
  state.drag.deltaX = 0;
  state.drag.deltaY = 0;
  event.currentTarget.setPointerCapture(event.pointerId);
}

function onSwipePointerMove(event) {
  if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
    return;
  }
  const card = swipeCardControl(state.drag.mode);
  if (!card) {
    return;
  }
  state.drag.deltaX = event.clientX - state.drag.startX;
  state.drag.deltaY = event.clientY - state.drag.startY;
  const rotation = state.drag.deltaX * 0.04;
  card.classList.add("dragging");
  card.style.transform = `translate(${state.drag.deltaX}px, ${state.drag.deltaY}px) rotate(${rotation}deg)`;
  const horizontalIntent = Math.abs(state.drag.deltaX) >= Math.abs(state.drag.deltaY) * 0.9;
  card.classList.toggle("likeing", horizontalIntent && state.drag.deltaX > 35);
  card.classList.toggle("disliking", horizontalIntent && state.drag.deltaX < -35);
  card.classList.toggle("skipping", !horizontalIntent && state.drag.deltaY > 60);
  card.classList.toggle("loving", !horizontalIntent && state.drag.deltaY < -60);
}

function onSwipePointerUp(event) {
  if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
    return;
  }
  const mode = state.drag.mode;
  const { deltaX, deltaY } = state.drag;
  const card = swipeCardControl(mode);
  let action = null;
  if (deltaY > 120 && deltaY > Math.abs(deltaX) * 1.15) {
    action = () => deckAction(mode, "skip");
  } else if (deltaY < -120 && -deltaY > Math.abs(deltaX) * 1.15) {
    // Up is the stronger keep: Love.
    action = () => deckAction(mode, "love");
  } else if (deltaX > 110) {
    action = () => deckAction(mode, "like");
  } else if (deltaX < -110) {
    action = () => deckAction(mode, "dislike");
  }

  if (action) {
    // Keep the card where the finger left it; the fly-out starts from there.
    const released = card.style.transform;
    resetSwipeCard(mode);
    card.style.transform = released;
    action();
    return;
  }
  resetSwipeCard(mode);
  if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) {
    if (mode === "toktinder") {
      toggleToktinderPlayback();
    } else if (mode === "rediscover") {
      const video = document.getElementById("rediscoverVideo");
      if (!video.hidden) video.paused ? video.play().catch(() => {}) : video.pause();
    }
    return;
  }
  // Not far enough: glide back instead of snapping.
  card.classList.add("settling");
  window.setTimeout(() => card.classList.remove("settling"), 240);
}

function resetSwipeCard(mode = state.drag.mode) {
  if (mode && typeof mode === "object") {
    mode = mode.currentTarget?.dataset?.swipeMode || state.drag.mode;
  }
  const card = swipeCardControl(mode);
  if (card) {
    card.style.transform = "";
    card.classList.remove("likeing", "disliking", "skipping", "loving", "dragging");
  }
  state.drag.active = false;
  state.drag.mode = null;
  state.drag.pointerId = null;
  state.drag.startX = 0;
  state.drag.startY = 0;
  state.drag.deltaX = 0;
  state.drag.deltaY = 0;
}

function queueSettingsSave() {
  // Every control that changes a setting ends up here, so this is the one
  // place that can keep the drawer readback and the preset highlight honest
  // without each handler remembering to. The save itself stays debounced.
  syncDrawerSummaries();
  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(async () => {
    try {
      await postJson("/api/settings", state.settings);
    } catch (error) {
      console.error(error);
    }
  }, 220);
}

// Sound is one switch shared by every mode; each control center shows it.
function syncAudioButton() {
  const label = state.audioUnlocked ? "Sound on" : "Sound off";
  const hint = state.audioUnlocked ? "" : "Browsers keep videos muted until you turn sound on here.";
  [
    ["toktinderAudioToggleButton", "toktinderAudioHint"],
    ["escalationAudioToggleButton", "escalationAudioHint"],
    ["sessionAudioToggleButton", "sessionAudioHint"],
    ["mosaicAudioToggleButton", "mosaicAudioHint"],
    ["feedAudioToggleButton", "feedAudioHint"],
  ].forEach(([buttonKey, hintKey]) => {
    controls[buttonKey].textContent = label;
    controls[buttonKey].setAttribute("aria-pressed", String(state.audioUnlocked));
    controls[hintKey].textContent = hint;
  });
  ["dangerousSound", "dangerousMuteToggle"].forEach(id => {
    const button = document.getElementById(id);
    if (!button) return;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(state.audioUnlocked));
  });
  document.querySelectorAll("[data-global-sound]").forEach((button) => {
    button.textContent = label;
    button.setAttribute("aria-pressed", String(state.audioUnlocked));
  });
}

