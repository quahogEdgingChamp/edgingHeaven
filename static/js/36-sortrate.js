/* ==========================================================================
   Sort & rate extras — photo deck, video deck, Feed, Rediscover

   Tune → "Only files I kept in Dangerous": the mode shows only what you
   looked at in a Dangerous mode and kept there (the server's dangerousKept,
   see 20-dangerous.js). It combines with Show, so Unrated + this switch is
   "kept in Dangerous, not rated yet". The photo deck only deals photos and
   the video deck and Feed only videos, so the switch can empty a mode when
   everything kept there is the other kind; the switch's note, the summary
   and the empty deck say so.

   Tune → "Move to trash": the file on screen goes to local trash, like Delete
   in Dangerous. The toast's Undo (or Settings → trash) brings it back.
   ========================================================================== */

const DANGER_KEPT_MODES = ["swipe", "toktinder", "feed", "rediscover"];

function dangerKeptOnly(mode) {
  return DANGER_KEPT_MODES.includes(mode)
    && !!state.settings[`${mode}DangerKeptOnly`]
    && !!state.features?.has("dangerousKept");
}

function matchesDangerKept(mode, item) {
  return !dangerKeptOnly(mode) || dangerousKept.paths.has(item.path);
}

// Kept in Dangerous, by kind. The photo deck only ever deals photos, so
// with only videos kept there the switch leaves it empty (and the reverse).
function dangerKeptCounts() {
  const count = (list) => (list || []).reduce((sum, item) => sum + (dangerousKept.paths.has(item.path) ? 1 : 0), 0);
  return { photos: count(state.library.images), videos: count(state.library.videos) };
}

function dangerKeptModeKind(mode) {
  if (mode === "swipe") return "photos";
  if (mode === "rediscover") return state.settings.rediscoverKind || "all";
  return "videos";
}

// Why the switch leaves this mode with nothing, or "" when it does not.
function dangerKeptEmptyReason(mode) {
  if (!dangerKeptOnly(mode) || !dangerousKept.loaded) return "";
  const { photos, videos } = dangerKeptCounts();
  const kind = dangerKeptModeKind(mode);
  if (!photos && !videos) return "Nothing is kept in Dangerous yet. Keep files there first, or turn off \"Only files I kept in Dangerous\".";
  if (kind === "photos" && !photos) return `You kept ${plural(videos, "video", "videos")} and no photos in Dangerous, and this deck is photos only. Turn the switch on in the video deck or Feed instead.`;
  if (kind === "videos" && !videos) return `You kept ${plural(photos, "photo", "photos")} and no videos in Dangerous, and this ${mode === "feed" ? "feed" : "deck"} is videos only. Turn the switch on in the photo deck instead.`;
  return "";
}

// The Tune summary's ending while the switch is on.
function dangerKeptSummary(mode) {
  if (!dangerKeptOnly(mode)) return "";
  const reason = dangerKeptEmptyReason(mode);
  return ` Only files you kept in Dangerous.${reason ? ` ${reason}` : ""}`;
}

function bindSortRate() {
  DANGER_KEPT_MODES.forEach((mode) => {
    el(`${mode}DangerKeptOnly`).addEventListener("click", () => setDangerKeptOnly(mode, !state.settings[`${mode}DangerKeptOnly`]));
    el(`${mode}TrashButton`).addEventListener("click", () => trashCurrentFile(mode));
  });
}

async function setDangerKeptOnly(mode, on) {
  state.settings[`${mode}DangerKeptOnly`] = on;
  syncDangerKeptSwitches();
  queueSettingsSave();
  // The kept list is otherwise only fetched when a Dangerous mode opens.
  if (on && !dangerousKept.loaded) await loadDangerousKept();
  applyShowChange(mode);
  const reason = dangerKeptEmptyReason(mode);
  if (on && reason) toast(reason, 8000);
}

function syncDangerKeptSwitches() {
  const counts = dangerousKept.loaded ? dangerKeptCounts() : null;
  DANGER_KEPT_MODES.forEach((mode) => {
    const button = el(`${mode}DangerKeptOnly`);
    button.hidden = !state.features?.has("dangerousKept");
    button.setAttribute("aria-checked", String(!!state.settings[`${mode}DangerKeptOnly`]));
    // Under the label: what the list holds, so an empty deck is no surprise.
    const label = button.querySelector("span");
    let note = label.querySelector("small");
    if (!note) {
      note = document.createElement("small");
      label.append(note);
    }
    note.hidden = !counts;
    if (counts) note.textContent = `${plural(counts.photos, "photo", "photos")} and ${plural(counts.videos, "video", "videos")} kept there`;
    // Left tappable on a read-only drive, so a tap says why nothing happens.
    el(`${mode}TrashButton`).classList.toggle("is-unavailable", !state.canTrash);
  });
}

// A page that opens with the switch already on needs the kept list before
// its first deal; rebuild whatever was dealt without it.
function loadDangerKeptForSortRate() {
  const waiting = DANGER_KEPT_MODES.filter(dangerKeptOnly);
  if (!waiting.length || dangerousKept.loaded) return;
  loadDangerousKept().then(() => {
    if (dangerousKept.loaded) waiting.forEach(applyShowChange);
    syncDangerKeptSwitches();
  });
}

/* ---- Move to trash ---- */

function sortRateCurrent(mode) {
  if (mode === "feed") return state.feed.items[state.feed.activeIndex] || null;
  if (mode === "rediscover") return currentRediscoverItem();
  return currentDeckItem(mode);
}

async function trashCurrentFile(mode) {
  const item = sortRateCurrent(mode);
  if (!item) { toast("Nothing on screen to move to trash."); return; }
  if (!state.canTrash) { toast("This drive is read-only. The file was not deleted."); return; }
  const button = el(`${mode}TrashButton`);
  if (button.disabled) return;
  button.disabled = true;
  const library = state.currentMediaDirectory;
  try {
    const result = await postJson("/api/trash", { path: item.path, library });
    if (state.currentMediaDirectory !== library) return;
    const place = dropFromSortRate(mode, item);
    removeLibraryItem(item.path);
    state.library.updatedAt = result.updatedAt;
    state.librarySignature = librarySignature();
    if (mode !== "feed") state.feed.dirty = true;
    if (isDeckMode(mode)) renderDeck(mode);
    syncWorkspace();
    syncDrawerSummaries();
    toast(`Moved ${item.name} to trash.`, 8000, { label: "Undo", run: () => untrashFile(mode, item, place, result.token, library) });
  } catch (error) {
    if (!error.locked) toast(error.message || "Could not move it to trash. The file is still here.");
  } finally {
    button.disabled = false;
  }
}

// Feed and Rediscover keep their own lists; the decks are handled by
// removeLibraryItem. Returns where the file was, for Undo.
function dropFromSortRate(mode, item) {
  if (mode === "rediscover") {
    const index = rediscover.items.findIndex((entry) => entry.path === item.path);
    if (index >= 0) rediscover.items.splice(index, 1);
    rediscover.history = rediscover.history.filter((entry) => entry.item?.path !== item.path);
    if (rediscover.index > rediscover.items.length) rediscover.index = rediscover.items.length;
    renderRediscover();
    return index;
  }
  if (mode === "feed") {
    const index = state.feed.items.findIndex((entry) => entry.path === item.path);
    if (index >= 0) {
      state.feed.items.splice(index, 1);
      redrawFeedAt(Math.min(index, state.feed.items.length - 1));
    }
    return index;
  }
  return state[deckConfig(mode).indexKey];
}

// Feed cards remember their position, so a removal redraws the list and
// lands on the same spot instead of reshuffling the whole feed.
function redrawFeedAt(index) {
  controls.feedScroller.querySelectorAll("video").forEach(releaseVideo);
  controls.feedScroller.innerHTML = "";
  state.feed.rendered = 0;
  state.feed.activeIndex = -1;
  if (!state.feed.items.length) {
    const empty = document.createElement("p");
    empty.className = "feed-empty subtle";
    empty.textContent = dangerKeptEmptyReason("feed") || "No videos match the feed filter.";
    controls.feedScroller.appendChild(empty);
    return;
  }
  while (state.feed.rendered <= index && state.feed.rendered < state.feed.items.length) appendFeedBatch();
  window.requestAnimationFrame(() => {
    controls.feedScroller.scrollTop = index * controls.feedScroller.clientHeight;
    activateFeedItem(index, true);
  });
}

async function untrashFile(mode, item, place, token, library) {
  try {
    const result = await postJson("/api/restore", { token, library });
    if (state.currentMediaDirectory !== library) return;
    if (result.item) restoreLibraryItem(result);
    else await loadState();
    const back = state.library[item.kind === "video" || mode === "toktinder" || mode === "feed" ? "videos" : "images"]
      .find((entry) => entry.path === item.path) || item;
    // Put it back where it was, so it is on screen again.
    if (mode === "rediscover") {
      rediscover.items.splice(Math.max(0, Math.min(place, rediscover.items.length)), 0, { ...back, kind: item.kind, lastSeen: item.lastSeen });
      rediscover.index = Math.max(0, Math.min(place, rediscover.items.length - 1));
      renderRediscover();
    } else if (mode === "feed") {
      const at = Math.max(0, Math.min(place, state.feed.items.length));
      state.feed.items.splice(at, 0, back);
      if (state.currentMode === "feed") redrawFeedAt(at);
    } else {
      const config = deckConfig(mode);
      const at = Math.max(0, Math.min(place, state[config.itemsKey].length));
      state[config.itemsKey].splice(at, 0, back);
      state[config.indexKey] = at;
      renderDeck(mode);
    }
    syncWorkspace();
    syncDrawerSummaries();
    toast(`${item.name} is back.`);
  } catch (error) {
    if (!error.locked) toast(error.message || "Could not bring it back. It is still in Settings → trash.");
  }
}
