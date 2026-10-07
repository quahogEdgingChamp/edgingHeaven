function releaseInactiveMedia(mode) {
  if (mode !== "gallery") state.gallery.observer?.disconnect();
  if (mode !== "ranked") state.ranked.observer?.disconnect();
  if (!["gallery", "ranked"].includes(mode)) thumbQueue.length = 0;
  document.querySelectorAll(".mode-panel").forEach(panel => {
    if (panel.id === `${mode}Mode`) return;
    panel.querySelectorAll("video[src]").forEach(releaseVideo);
    panel.querySelectorAll("img[src]").forEach(image => image.removeAttribute("src"));
  });
  if (mode !== "session") delete controls.sessionStage.dataset.path;
  if (state.preloader) { state.preloader.src = ""; state.preloader = null; }
  if (dangerous.preloader) { dangerous.preloader.src = ""; dangerous.preloader = null; }
}

/* Dangerous is for clearing space, not for rating: Keep only remembers that
   you looked at a file here and kept it (server: dangerousKept), so it does
   not come up again while "Hide files I already kept here" is on. */
const dangerousKept = { paths: new Set(), loaded: false, loading: null };

async function loadDangerousKept() {
  if (!state.features.has("dangerousKept")) return;
  dangerousKept.loading ||= fetchJson("/api/dangerous-kept")
    .then((payload) => {
      dangerousKept.paths = new Set(Object.keys(payload.kept || {}));
      dangerousKept.loaded = true;
    })
    .catch(() => {})
    .finally(() => { dangerousKept.loading = null; });
  return dangerousKept.loading;
}

function dangerousEligible(item, selected = normalizedFolderSelection("dangerousFolders")) {
  const kind = state.settings.dangerousKind || "all";
  if ((kind === "photo" && item.kind === "video") || (kind === "video" && item.kind !== "video")) return false;
  if (!matchesFolderSelection(item, selected)) return false;
  return !state.settings.dangerousHideKept || !keptHere(item);
}

// Every file Swipe would deal right now, whatever this deal holds.
function dangerousPool() {
  const selected = normalizedFolderSelection("dangerousFolders");
  return [
    ...state.library.images.map(i => ({ ...i, kind: "photo" })),
    ...state.library.videos.map(i => ({ ...i, kind: "video" })),
  ].filter(item => dangerousEligible(item, selected));
}

// How far through the library Swipe is, for Tune: of the files its Media
// and folder choices take in, how many are kept, and what they leave out.
function dangerousCoverage() {
  const selected = normalizedFolderSelection("dangerousFolders");
  const kind = state.settings.dangerousKind || "all";
  const tally = { total: 0, kept: 0, otherKind: 0, otherFolders: 0 };
  [...state.library.images.map(i => ["photo", i]), ...state.library.videos.map(i => ["video", i])].forEach(([itemKind, item]) => {
    if (kind !== "all" && kind !== itemKind) tally.otherKind++;
    else if (!matchesFolderSelection(item, selected)) tally.otherFolders++;
    else {
      tally.total++;
      if (keptHere(item)) tally.kept++;
    }
  });
  return tally;
}

// Files from a download in progress join the deck after the one on screen.
function addToDangerous(items) {
  if (!dangerous.items.length && !dangerous.index) return; // not dealt yet: they are in the next deal
  const selected = normalizedFolderSelection("dangerousFolders");
  const wasEmpty = dangerous.index >= dangerous.items.length;
  items.filter((item) => dangerousEligible(item, selected)).forEach((item) => {
    const start = Math.min(dangerous.items.length, dangerous.index + (wasEmpty ? 0 : 1));
    dangerous.items.splice(start + Math.floor(Math.random() * (dangerous.items.length - start + 1)), 0, item);
  });
  if (wasEmpty && dangerous.index < dangerous.items.length && state.currentMode === "dangerous") renderDangerous();
}

// Downloads → Sort in Dangerous: that model's files you have not kept yet.
function sortModelInDangerous(model) {
  state.settings.dangerousFolders = modelFolders(model);
  state.folderCleared.dangerous = false;
  state.settings.dangerousHideKept = true;
  renderFolderFilter("dangerous");
  queueSettingsSave();
  setMode("dangerous");
  startDangerous(true);
}

function startDangerous(rebuild = false) {
  if (dangerous.busy) return;
  if (state.features.has("dangerousKept") && !dangerousKept.loaded) {
    loadDangerousKept().then(() => {
      if (dangerousKept.loaded && state.currentMode === "dangerous") startDangerous(true);
    });
    return;
  }
  if (dangerous.library !== state.currentMediaDirectory) {
    dangerous.library = state.currentMediaDirectory;
    dangerous.history = [];
    dangerous.kept = dangerous.deleted = 0;
    rebuild = true;
  }
  if (!rebuild && dangerous.items.length) {
    if (dangerous.index >= dangerous.items.length) {
      // A finished deal deals again whatever is still unsorted (the files
      // skipped), so every file comes back until it is kept or deleted.
      rebuild = state.settings.dangerousHideKept && dangerousPool().length > 0;
    } else {
      // Kept in Grid, Junk or Folders since this deal: not asked again here.
      const selected = normalizedFolderSelection("dangerousFolders");
      dangerous.items = [
        ...dangerous.items.slice(0, dangerous.index),
        ...dangerous.items.slice(dangerous.index).filter(item => dangerousEligible(item, selected)),
      ];
    }
  }
  if (rebuild || !dangerous.items.length) {
    dangerous.items = orderCleanupItems(dangerousPool(), state.settings.dangerousOrder);
    dangerous.index = 0;
  }
  syncSegmented(el("dangerousKind"), "dangerousKind", state.settings.dangerousKind || "all");
  syncSettingControls(el("dangerousDrawer"));
  renderCleanupMeters();
  el("dangerousHideKept").setAttribute("aria-checked", String(!!state.settings.dangerousHideKept));
  syncDrawerSummaries();
  renderDangerous();
}

function renderDangerous() {
  if (state.currentMode !== "dangerous") return;
  el("dangerousCard").classList.remove("is-burnt");
  const item = dangerous.items[dangerous.index];
  const image = el("dangerousImage"), video = el("dangerousVideo");
  const isVideo = item?.kind === "video";
  image.hidden = !item || isVideo;
  video.hidden = !item || !isVideo;
  el("dangerousEmpty").hidden = !!item;
  if (!item) syncDangerousEmpty();
  el("dangerousCard").classList.toggle("is-video", !!isVideo);
  if (!isVideo) el("dangerousTransport").hidden = true;
  if (!isVideo) releaseVideo(video);
  if (isVideo || !item) image.removeAttribute("src");
  if (item) {
    if (isVideo) {
      video.muted = !state.audioUnlocked;
      loadVideoSource(video, item);
    } else {
      image.alt = item.name;
      image.decoding = "async";
      image.dataset.path = item.path;
      image.src = mediaUrl(item.path);
    }
  }
  if (item) markSeen(item.path);
  if (el("dangerousFrames").dataset.path !== (item?.path || "")) {
    el("dangerousFrames").dataset.path = item?.path || "";
    renderFrameStrip(item);
  }
  el("dangerousName").textContent = item?.name || "";
  el("dangerousFolder").textContent = item ? (item.folder || "Library root") : "";
  el("dangerousType").textContent = item ? (isVideo ? "VIDEO" : "PHOTO") : "DONE";
  el("dangerousProgress").textContent = item ? `${(dangerous.index + 1).toLocaleString()} / ${dangerous.items.length.toLocaleString()}` : "Deck complete";
  // Tune's "… files left in this deck" follows every swipe, not just a new deal.
  if (controls.dangerousSummary) controls.dangerousSummary.textContent = DRAWER_SUMMARIES.dangerous();
  syncDangerousActions();
}

// The end of a deal is only "All sorted" when nothing is left unsorted;
// skipped files are still there and the next deal brings them back.
function syncDangerousEmpty() {
  const left = state.settings.dangerousHideKept ? dangerousPool().length : 0;
  el("dangerousEmpty").querySelector("h2").textContent = left ? "End of this deal." : "All sorted.";
  el("dangerousEmpty").querySelector("p").textContent = left
    ? `${plural(left, "file is", "files are")} still unsorted (skipped, not kept or deleted). Shuffle under Adjust deals ${left === 1 ? "it" : "them"} again; so does coming back to Swipe.`
    : "Everything this deck takes in is kept or deleted. Change Media or folders under Adjust to go on.";
}

/* The video gets its own transport instead of native controls: the browser's
   controls swallow touches, so a swipe over a video never reached the card. */
function bindDangerousTransport() {
  const video = el("dangerousVideo"), seek = el("dangerousSeek");
  ["pointerdown", "pointermove", "pointerup"].forEach(type => {
    el("dangerousTransport").addEventListener(type, event => event.stopPropagation());
  });
  el("dangerousPlayToggle").addEventListener("click", toggleDangerousPlayback);
  let dragging = false;
  const applySeek = () => {
    dragging = false;
    if (!video.src || !Number.isFinite(video.duration)) return;
    try {
      video.currentTime = clampNumber(Number(seek.value), 0, Math.max(0, video.duration - 0.05));
    } catch (error) {
      console.debug("seek failed", error);
    }
  };
  seek.addEventListener("input", () => {
    dragging = true;
    el("dangerousTime").textContent = formatClock(Number(seek.value));
    paintRange(seek);
  });
  seek.addEventListener("change", applySeek);
  const sync = () => {
    const hasClip = !video.hidden && !!video.getAttribute("src");
    el("dangerousTransport").hidden = !hasClip;
    if (!hasClip) return;
    // Some files never report a length; play/pause and sound still work.
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    seek.disabled = !duration;
    seek.max = String(duration || 100);
    el("dangerousDuration").textContent = duration ? formatClock(duration) : "–:––";
    if (!dragging) {
      seek.value = String(video.currentTime);
      el("dangerousTime").textContent = formatClock(video.currentTime);
      paintRange(seek);
    }
    el("dangerousPlayToggle").textContent = video.paused ? "Play" : "Pause";
    el("dangerousPlayToggle").classList.toggle("active", video.paused);
  };
  ["loadstart", "loadedmetadata", "durationchange", "timeupdate", "play", "pause", "emptied"].forEach(type => video.addEventListener(type, sync));
}

function toggleDangerousPlayback() {
  const video = el("dangerousVideo");
  if (video.hidden || !video.src) return;
  if (video.paused) {
    video.muted = !state.audioUnlocked;
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function syncDangerousActions() {
  const empty = !dangerous.items[dangerous.index];
  ["dangerousKeep", "dangerousLove", "dangerousSkip", "dangerousDelete", "dangerousShuffle", "dangerousHideKept"].forEach(id => {
    el(id).disabled = dangerous.busy || (empty && ["dangerousKeep", "dangerousLove", "dangerousSkip", "dangerousDelete"].includes(id));
  });
  el("dangerousLove").hidden = state.settings.dangerousUpLoves === false;
  el("dangerousBlitzButton").disabled = empty && !blitz.running;
  el("dangerousDelete").disabled ||= !state.canTrash;
  el("dangerousUndo").disabled = dangerous.busy || !dangerous.history.length;
  el("dangerousSessionCount").textContent = `${dangerous.kept} kept · ${dangerous.deleted} deleted`;
}

async function actDangerous(action) {
  const item = dangerous.items[dangerous.index];
  if (!item || dangerous.busy) return;
  if (action === "delete" && !state.canTrash) { toast("This drive is read-only. The file was not deleted."); return; }
  dangerous.busy = true;
  syncDangerousActions();
  const library = state.currentMediaDirectory;
  // ↑ keeps and Loves (a real rating, so the other modes can use it), unless
  // that is switched off; then it only keeps, like →.
  if (action === "love" && state.settings.dangerousUpLoves === false) action = "keep";
  const entry = { action, item, index: dangerous.index, library };
  if (action === "delete") {
    // The copy burns over the card; the card itself goes blank until the next file.
    thrillBurn([el("dangerousCard")]);
    if (state.settings.thrillEffect !== "off" && !REDUCED_MOTION.matches) el("dangerousCard").classList.add("is-burnt");
  }
  try {
    if (action === "delete") {
      const result = await postJson("/api/trash", { path: item.path, library });
      if (state.currentMediaDirectory !== library) {
        toast("The previous library's file was moved to trash.");
        return;
      }
      entry.token = result.token;
      removeLibraryItem(item.path);
      state.library.updatedAt = result.updatedAt;
      state.librarySignature = librarySignature();
      state.feed.dirty = true;
      // No toast: it covered the next picture, and the count and Undo say it.
      dangerous.deleted++;
      cleanupCount("delete", item.size || 0);
    } else if (action === "keep" || action === "love") {
      if (state.features.has("dangerousKept")) {
        await postJson("/api/dangerous-kept", { path: item.path, kept: true });
        if (state.currentMediaDirectory !== library) return;
        dangerousKept.paths.add(item.path);
      }
      if (action === "love") {
        entry.previousRating = item.rating ?? null;
        await postJson("/api/rating", { path: item.path, rating: "love" });
        recordRating(item.path, "love", item);
      }
      dangerous.kept++;
      cleanupCount("keep");
    }
    dangerous.history.push(entry);
    dangerous.index++;
    syncCountsFromLibrary();
    syncWorkspace();
    renderDangerous();
  } catch (error) {
    el("dangerousCard").classList.remove("is-burnt");
    toast(error.message || "Could not save. This item is still here.");
  } finally {
    dangerous.busy = false;
    if (dangerous.library !== state.currentMediaDirectory) startDangerous(true);
    syncDangerousActions();
  }
}

async function undoDangerous() {
  const entry = dangerous.history.at(-1);
  if (!entry || dangerous.busy) return;
  dangerous.busy = true;
  syncDangerousActions();
  try {
    if (entry.action === "delete") {
      const result = await postJson("/api/restore", { token: entry.token, library: entry.library });
      if (result.item) restoreLibraryItem(result);
      else await loadState();
      dangerous.deleted--;
      cleanupCount("restore", entry.item.size || 0);
    } else if (entry.action === "keep" || entry.action === "love") {
      if (entry.action === "love") {
        await postJson("/api/rating", { path: entry.item.path, rating: entry.previousRating });
        recordRating(entry.item.path, entry.previousRating, entry.item);
      }
      if (state.features.has("dangerousKept")) {
        await postJson("/api/dangerous-kept", { path: entry.item.path, kept: false });
        dangerousKept.paths.delete(entry.item.path);
      }
      dangerous.kept--;
      cleanupCount("unkeep");
    }
    dangerous.history.pop();
    // Filters or a shuffle may have changed the deck since this action.
    const index = dangerous.items.findIndex(i => i.path === entry.item.path);
    if (index < 0) { dangerous.items.splice(dangerous.index, 0, entry.item); }
    else dangerous.index = index;
    syncCountsFromLibrary();
    syncWorkspace();
    renderDangerous();
  } catch (error) { toast(error.message); }
  finally { dangerous.busy = false; syncDangerousActions(); }
}

function preloadDangerous() {
  const next = dangerous.items[dangerous.index + 1];
  if (!next || next.kind === "video" || state.currentMode !== "dangerous") return;
  dangerous.preloader = new Image();
  dangerous.preloader.decoding = "async";
  dangerous.preloader.src = mediaUrl(next.path);
}

async function reviewTrash() {
  const list = el("trashList");
  list.textContent = "Loading…";
  try {
    const library = state.currentMediaDirectory;
    const payload = await fetchJson("/api/trash");
    list.replaceChildren();
    if (!payload.entries.length) list.textContent = "Nothing in trash.";
    payload.entries.forEach(entry => {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = entry.path;
      const button = document.createElement("button");
      button.className = "ghost-button";
      button.textContent = "Restore";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const result = await postJson("/api/restore", { token: entry.token, library });
          dangerous.history = dangerous.history.filter(h => h.token !== entry.token);
          if (result.item) restoreLibraryItem(result);
          else await loadState();
          await reviewTrash();
          toast("Restored to the original folder.");
        } catch (error) { toast(error.message); button.disabled = false; }
      });
      row.append(label, button);
      list.append(row);
    });
  } catch (error) { list.textContent = error.message; }
}

async function emptyTrash() {
  const button = el("emptyTrash");
  button.disabled = true;
  try {
    const library = state.currentMediaDirectory;
    const { entries } = await fetchJson("/api/trash");
    if (!entries.length) { toast("Trash is already empty."); return; }
    if (!window.confirm(`Permanently erase ${plural(entries.length, "file", "files")} from the drive? This frees the space and cannot be undone.`)) return;
    await trashErased(await postJson("/api/empty-trash", { library }));
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

// Removes the whole .heaven-trash folder, including anything Empty trash
// leaves there (files it did not put in the trash, broken entries).
async function deleteTrashFolder() {
  const button = el("deleteTrashFolder");
  button.disabled = true;
  try {
    const library = state.currentMediaDirectory;
    const { entries } = await fetchJson("/api/trash");
    const count = entries.length ? `${plural(entries.length, "deleted file", "deleted files")} and anything else in it` : "everything in it";
    if (!window.confirm(`Delete the whole .heaven-trash folder from the drive, with ${count}? Nothing in it can be restored afterwards.`)) return;
    await trashErased(await postJson("/api/delete-trash-folder", { library }));
  } catch (error) {
    toast(error.message === "Not found." ? "The server needs a restart before this button works." : error.message);
  }
  finally { button.disabled = false; }
}

async function trashErased(result) {
  // Erased files can no longer be undone from Dangerous.
  dangerous.history = dangerous.history.filter(h => h.action !== "delete");
  cleanup.history = cleanup.history.filter(entry => !entry.trashed.length);
  syncCleanupButtons();
  syncDangerousActions();
  if (el("trashList").childNodes.length) await reviewTrash();
  // freeBytes is missing until the server is restarted onto this version.
  const free = Number.isFinite(result.freeBytes) ? ` ${formatBytes(result.freeBytes)} free on the drive now.` : "";
  toast(`Erased ${plural(result.removed, "file", "files")}, freed ${formatBytes(result.freedBytes)}.${free}`, 10000);
}

