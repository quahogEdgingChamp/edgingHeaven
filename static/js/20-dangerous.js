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

function startDangerous(rebuild = false) {
  if (dangerous.busy) return;
  if (dangerous.library !== state.currentMediaDirectory) {
    dangerous.library = state.currentMediaDirectory;
    dangerous.history = [];
    dangerous.kept = dangerous.deleted = 0;
    rebuild = true;
  }
  if (rebuild || !dangerous.items.length) {
    const kind = state.settings.dangerousKind || "all";
    const selected = normalizedFolderSelection("dangerousFolders");
    dangerous.items = [
      ...(kind !== "video" ? state.library.images.map(i => ({ ...i, kind: "photo" })) : []),
      ...(kind !== "photo" ? state.library.videos.map(i => ({ ...i, kind: "video" })) : []),
    ].filter(item => matchesFolderSelection(item, selected) && (!state.settings.dangerousUnrated || !item.rating));
    shuffleBalanced(dangerous.items);
    dangerous.index = 0;
  }
  syncSegmented(el("dangerousKind"), "dangerousKind", state.settings.dangerousKind || "all");
  el("dangerousUnrated").setAttribute("aria-checked", String(!!state.settings.dangerousUnrated));
  syncDrawerSummaries();
  renderDangerous();
}

function renderDangerous() {
  if (state.currentMode !== "dangerous") return;
  const item = dangerous.items[dangerous.index];
  const image = el("dangerousImage"), video = el("dangerousVideo");
  const isVideo = item?.kind === "video";
  image.hidden = !item || isVideo;
  video.hidden = !item || !isVideo;
  el("dangerousEmpty").hidden = !!item;
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
  el("dangerousName").textContent = item?.name || "";
  el("dangerousFolder").textContent = item ? (item.folder || "Library root") : "";
  el("dangerousType").textContent = item ? (isVideo ? "VIDEO" : "PHOTO") : "DONE";
  el("dangerousProgress").textContent = item ? `${(dangerous.index + 1).toLocaleString()} / ${dangerous.items.length.toLocaleString()}` : "Deck complete";
  syncDangerousActions();
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
  ["dangerousKeep", "dangerousSkip", "dangerousDelete", "dangerousShuffle", "dangerousUnrated"].forEach(id => {
    el(id).disabled = dangerous.busy || (empty && ["dangerousKeep", "dangerousSkip", "dangerousDelete"].includes(id));
  });
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
  const entry = { action, item, index: dangerous.index, previousRating: item.rating ?? null, library };
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
      dangerous.deleted++;
      toast("Moved to local trash. Press U to undo.");
    } else if (action === "keep" || action === "love") {
      const rating = action === "love" ? "love" : "like";
      await postJson("/api/rating", { path: item.path, rating });
      if (state.currentMediaDirectory !== library) return;
      recordRating(item.path, rating, item);
      dangerous.kept++;
    }
    dangerous.history.push(entry);
    dangerous.index++;
    syncCountsFromLibrary();
    syncWorkspace();
    renderDangerous();
  } catch (error) {
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
      await postJson("/api/restore", { token: entry.token, library: entry.library });
      await loadState();
      dangerous.deleted--;
    } else if (entry.action === "keep" || entry.action === "love") {
      await postJson("/api/rating", { path: entry.item.path, rating: entry.previousRating });
      recordRating(entry.item.path, entry.previousRating, entry.item);
      dangerous.kept--;
    }
    dangerous.history.pop();
    // Filters or a shuffle may have changed the deck since this action.
    const index = dangerous.items.findIndex(i => i.path === entry.item.path);
    if (index < 0) { dangerous.items.splice(dangerous.index, 0, entry.item); }
    else dangerous.index = index;
    syncCountsFromLibrary();
    syncWorkspace();
    renderDangerous();
    toast("Undone. File restored to its previous state.");
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
          await postJson("/api/restore", { token: entry.token, library });
          dangerous.history = dangerous.history.filter(h => h.token !== entry.token);
          await loadState();
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
    const result = await postJson("/api/empty-trash", { library });
    // Erased files can no longer be undone from Dangerous.
    dangerous.history = dangerous.history.filter(h => h.action !== "delete");
    syncDangerousActions();
    if (el("trashList").childNodes.length) await reviewTrash();
    // freeBytes is missing until the server is restarted onto this version.
    const free = Number.isFinite(result.freeBytes) ? ` ${formatBytes(result.freeBytes)} free on the drive now.` : "";
    toast(`Erased ${plural(result.removed, "file", "files")}, freed ${formatBytes(result.freedBytes)}.${free}`, 10000);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

