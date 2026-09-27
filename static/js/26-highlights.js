/* ==========================================================================
   Highlights — only the moments you marked, back to back

   Each marked span plays from its start to its end (repeated if you like),
   then the next one loads. Order: shuffled a folder at a time, best duel
   rank first, or newest files first.
   ========================================================================== */

const highlights = { stage: null, moments: [], index: 0, repeat: 0, paused: false, bound: false, signature: "" };

registerModeUI("highlights", {
  card: {
    name: "Highlights",
    blurb: "Only the moments you marked, back to back. Mark with B or the Mark button.",
    icon: "M4 17l4-4 3 3 5-6 4 4M4 5h16",
    stat: () => (state.features.has("marks") ? plural(markedCount(), "moment", "moments") : "needs server update"),
  },
  defaults: {
    highlightsRatingFilter: "all",
    highlightsOrder: "shuffle",
    highlightsRepeat: 1,
    highlightsVolume: 0.5,
  },
  summary: () => {
    const count = highlights.moments.length;
    const order = { shuffle: "shuffled", best: "best duel rank first", newest: "newest files first" }[state.settings.highlightsOrder];
    const repeat = Number(state.settings.highlightsRepeat) > 1 ? `, each played ${state.settings.highlightsRepeat} times` : "";
    return count ? `${plural(count, "marked moment", "marked moments")}, ${order}${repeat}.` : "No marked moments match yet.";
  },
});

function buildHighlightMoments() {
  const moments = [];
  modeSource("highlights", "videos").forEach((item) => {
    (marksFor(item.path) || []).forEach(([start, end]) => {
      moments.push({ item: { ...item, kind: "video" }, start, end, folder: item.folder, path: item.path });
    });
  });
  const order = state.settings.highlightsOrder;
  if (order === "best") {
    const score = (moment) => {
      const rating = duelRating(moment.path);
      return (rating.n ? rating.r : 1400) + (moment.item.rating === "love" ? 60 : 0);
    };
    moments.sort((a, b) => score(b) - score(a) || a.start - b.start);
  } else if (order === "newest") {
    moments.sort((a, b) => (b.item.mtime || 0) - (a.item.mtime || 0) || a.start - b.start);
  } else {
    shuffleBalanced(moments);
  }
  return moments;
}

function highlightsSignature() {
  return `${mediaPoolVersion}:${markedCount()}:${state.settings.highlightsOrder}`;
}

function currentMoment() {
  return highlights.moments[highlights.index] || null;
}

function playMoment(index) {
  const count = highlights.moments.length;
  if (!count) return;
  highlights.index = ((index % count) + count) % count;
  highlights.repeat = 0;
  const moment = currentMoment();
  highlights.stage.show(moment.item, { start: moment.start, fade: 260 });
  syncHighlightsHud();
}

function highlightsTime(video) {
  const moment = currentMoment();
  if (!moment || video.dataset.path !== moment.path || highlights.paused) return;
  syncHighlightsBar(video);
  if (video.currentTime >= moment.end - 0.06) {
    if (highlights.repeat + 1 < Number(state.settings.highlightsRepeat || 1)) {
      highlights.repeat += 1;
      video.currentTime = moment.start;
    } else {
      playMoment(highlights.index + 1);
    }
  }
}

function syncHighlightsBar(video) {
  const moment = currentMoment();
  if (!moment) return;
  const length = Math.max(0.1, moment.end - moment.start);
  el("highlightsBarFill").style.width = `${Math.round(clampNumber((video.currentTime - moment.start) / length, 0, 1) * 100)}%`;
}

function syncHighlightsHud() {
  const moment = currentMoment();
  const empty = !moment;
  el("highlightsEmpty").hidden = !empty;
  if (empty) {
    el("highlightsEmptyText").textContent = !state.features.has("marks")
      ? "Marked moments need the updated server. Restart edging-heaven.service, then mark clips with B or the Mark button."
      : markedCount()
        ? "None of your marked moments match the folders or Show filter. Widen them under Adjust."
        : "Nothing marked yet. In Video deck or Feed press B (or Mark) where a moment starts and again where it ends. Two quick presses mark the next 15 seconds.";
    setHud("highlights", { phase: "idle", cue: "", compact: true, fill: 0 });
    return;
  }
  setHud("highlights", {
    phase: highlights.paused ? "hold" : "go",
    cue: `Moment ${highlights.index + 1} / ${highlights.moments.length}`,
    sub: `${formatClock(moment.start)}–${formatClock(moment.end)}${highlights.paused ? " · paused" : ""}`,
    compact: true,
  });
  el("highlightsProgress").textContent = `${highlights.index + 1} / ${highlights.moments.length}`;
  el("highlightsStatus").textContent = `${plural(highlights.moments.length, "moment", "moments")}`;
  syncDrawerSummaries();
}

function toggleHighlightsPause() {
  if (!currentMoment()) return;
  highlights.paused = !highlights.paused;
  highlights.stage.freeze(highlights.paused);
  toySet(highlights.paused ? 0 : 0.5);
  syncHighlightsHud();
}

async function removeCurrentMoment() {
  const moment = currentMoment();
  if (!moment || !window.confirm(`Remove this moment (${formatClock(moment.start)}–${formatClock(moment.end)}) from ${moment.item.name}?`)) return;
  const remaining = (marksFor(moment.path) || []).filter(([start, end]) => !(start === moment.start && end === moment.end));
  try {
    await saveMarks(moment.path, remaining);
  } catch (error) {
    toast(error.message);
    return;
  }
  highlights.moments.splice(highlights.index, 1);
  highlights.signature = highlightsSignature();
  toast("Moment removed.");
  if (highlights.moments.length) {
    playMoment(highlights.index);
  } else {
    highlights.stage.clear();
    syncHighlightsHud();
  }
}

function bindHighlights() {
  if (highlights.bound) return;
  highlights.bound = true;
  highlights.stage = new PlayStage("highlights", { volumeKey: "highlightsVolume", loop: false });
  highlights.stage.onTime = highlightsTime;
  highlights.stage.onEnded = () => playMoment(highlights.index + 1);
  highlights.stage.onBroken = () => {
    highlights.moments = highlights.moments.filter((moment) => moment.path !== highlights.stage.item?.path);
    playMoment(highlights.index);
  };
  el("highlightsPrevButton").addEventListener("click", () => playMoment(highlights.index - 1));
  el("highlightsNextButton").addEventListener("click", () => playMoment(highlights.index + 1));
  el("highlightsRemoveButton").addEventListener("click", removeCurrentMoment);
  el("highlightsShuffle").addEventListener("click", () => {
    highlights.signature = "";
    rebuildHighlights();
    closeDrawers();
  });
  el("highlightsStage").addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    toggleHighlightsPause();
  });
  bindSettingControls(el("highlightsDrawer"), (key) => {
    if (key === "highlightsVolume") highlights.stage.applyAudio();
    if (key === "highlightsOrder") rebuildHighlights();
    syncDrawerSummaries();
  });
}

async function rebuildHighlights() {
  await loadMarks();
  if (state.settings.highlightsOrder === "best") await loadDuelRatings();
  highlights.moments = buildHighlightMoments();
  highlights.signature = highlightsSignature();
  highlights.paused = false;
  highlights.stage.freeze(false);
  if (state.currentMode !== "highlights") return;
  if (highlights.moments.length) {
    playMoment(0);
  } else {
    highlights.stage.clear();
    syncHighlightsHud();
  }
}

registerMode("highlights", {
  async enter() {
    bindHighlights();
    syncSettingControls(el("highlightsDrawer"));
    await loadMarks();
    if (state.currentMode !== "highlights") return;
    if (highlights.signature !== highlightsSignature() || !highlights.moments.length) {
      await rebuildHighlights();
      return;
    }
    if (highlights.stage.item?.path !== currentMoment()?.path) {
      playMoment(highlights.index);
    } else {
      highlights.stage.resume();
    }
    toySet(highlights.paused ? 0 : 0.5);
    syncHighlightsHud();
  },
  quiet() {
    highlights.stage?.pause();
  },
  refresh() {
    highlights.signature = "";
    if (state.currentMode === "highlights") rebuildHighlights();
  },
  next() {
    playMoment(highlights.index + 1);
  },
  key(key, lower) {
    const actions = {
      ArrowRight: () => playMoment(highlights.index + 1),
      ArrowDown: () => playMoment(highlights.index + 1),
      ArrowLeft: () => playMoment(highlights.index - 1),
      ArrowUp: () => playMoment(highlights.index - 1),
      " ": toggleHighlightsPause,
      Delete: removeCurrentMoment,
      Backspace: removeCurrentMoment,
    };
    const action = actions[key] || { l: () => loveCurrentPlayItem("highlights") }[lower];
    if (!action) return false;
    action();
    return true;
  },
});

// L in any timed mode: love whatever is on screen right now.
async function loveCurrentPlayItem(mode) {
  const item = MODE_HANDLERS[mode] && playStageFor(mode)?.item;
  if (!item) return;
  const previous = item.rating ?? null;
  const next = previous === "love" ? "like" : "love";
  recordRating(item.path, next, item);
  try {
    await postJson("/api/rating", { path: item.path, rating: next });
    haptic();
    toast(next === "love" ? `Loved ${item.name}.` : `${item.name} is back to kept.`);
  } catch (error) {
    recordRating(item.path, previous, item);
    toast("Could not save that. Check the connection.");
  }
}

function playStageFor(mode) {
  return { highlights, ladder, spotlight, beat, redlight, dice }[mode]?.stage || null;
}
