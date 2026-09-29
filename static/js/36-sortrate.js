/* ==========================================================================
   Sort & rate extras — photo deck, video deck, Feed, Rediscover

   Tune → "Only files I kept in Dangerous": the mode shows only what you
   looked at in a Dangerous mode and kept there (the server's dangerousKept,
   see 20-dangerous.js). It combines with Show, so Unrated + this switch is
   "kept in Dangerous, not rated yet".

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
}

function syncDangerKeptSwitches() {
  DANGER_KEPT_MODES.forEach((mode) => {
    const button = el(`${mode}DangerKeptOnly`);
    button.hidden = !state.features?.has("dangerousKept");
    button.setAttribute("aria-checked", String(!!state.settings[`${mode}DangerKeptOnly`]));
    el(`${mode}TrashButton`).disabled = !state.canTrash;
  });
}

// A page that opens with the switch already on needs the kept list before
// its first deal; rebuild whatever was dealt without it.
function loadDangerKeptForSortRate() {
  const waiting = DANGER_KEPT_MODES.filter(dangerKeptOnly);
  if (!waiting.length || dangerousKept.loaded) return;
  loadDangerousKept().then(() => {
    if (dangerousKept.loaded) waiting.forEach(applyShowChange);
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
    button.disabled = !state.canTrash;
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
    empty.textContent = "No videos match the feed filter.";
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
