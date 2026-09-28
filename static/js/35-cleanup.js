/* ==========================================================================
   Dangerous — Grid, Junk, Look-alikes and Folders (and Swipe's extras)

   Swipe (20-dangerous.js) decides one file at a time. These decide many at
   once: a page of files, a set of near-identical shots, a whole folder.
   They share what deletes and keeps (one request for many files), the Undo
   stack, the "freed this visit" meter with its goal, and the tile the grids
   are built from. Nothing is erased here: Delete moves files into
   .heaven-trash exactly as Swipe does, and Undo brings them back.

   Look-alikes needs a fingerprint of every picture. The server has no image
   decoder, so the page makes them (a 64-bit difference hash: the picture
   shrunk to 9×8 greys, one bit per "is the next one brighter") and stores
   them on the server, the same way video stills are made and kept.
   ========================================================================== */

const cleanup = { freed: 0, deleted: 0, kept: 0, history: [], busy: false, goalToasted: false };
const KB = 1024;
const MB = 1024 * 1024;

// formatBytes rounds anything small to "0.0 MB"; junk is mostly small.
function formatSize(bytes) {
  return bytes < MB ? `${Math.max(1, Math.round(bytes / KB))} KB` : formatBytes(bytes);
}

// A grid page fills the space it has: as many rows as the page needs, none
// shorter than a thumb can use (then it scrolls).
function fitGridRows(grid) {
  const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length);
  grid.style.setProperty("--rows", String(Math.max(1, Math.ceil(grid.children.length / columns))));
}
window.addEventListener("resize", () => document.querySelectorAll(".mode-panel.active .sweep-grid").forEach(fitGridRows));

/* ---- settings ---- */

Object.assign(PLAY_SETTING_RANGES, { cleanupGoalGb: [0, 50] });
Object.assign(PLAY_SETTING_CHOICES, {
  dangerousOrder: ["random", "biggest", "junk"],
  blitzSeconds: [30, 60, 120],
  dgridKind: ["all", "photos", "videos"],
  dgridOrder: ["random", "biggest", "junk", "name"],
  dgridTiles: [9, 12, 16, 20],
  djunkKind: ["all", "photos", "videos"],
  dsimilarKind: ["photos", "all"],
  dsimilarStrictness: ["tight", "close", "loose"],
});
PLAY_SETTING_SWITCHES.push("dangerousUpLoves", "dangerousFrames", "dgridHideKept", "djunkHideKept", "dfoldersHideKept");
SETTING_FORMATS.gb = (value) => (Number(value) ? `${value} GB` : "Off");

const SWIPE_DEFAULTS = { dangerousOrder: "random", dangerousUpLoves: true, dangerousFrames: true, cleanupGoalGb: 0, blitzSeconds: 60 };
Object.assign(MODE_DEFAULTS, SWIPE_DEFAULTS);
MODE_SETTING_KEYS.dangerous.push(...Object.keys(SWIPE_DEFAULTS));

const ORDER_WORDS = { random: "shuffled", biggest: "biggest first", junk: "likely junk first", name: "by name" };

registerModeUI("dgrid", {
  card: {
    name: "Grid",
    blurb: "A page of files at once. Tap the ones to delete, keep the rest in one go.",
    icon: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14.5 14.5l5 5M19.5 14.5l-5 5",
    stat: () => "page at a time",
  },
  summary: () => {
    const sweep = sweepState("dgrid");
    const left = Math.max(0, sweep.items.length - sweep.pos);
    return `${plural(left, "file", "files")} to go, ${state.settings.dgridTiles} a page, ${ORDER_WORDS[state.settings.dgridOrder] || "shuffled"}.`;
  },
  defaults: { dgridKind: "all", dgridOrder: "random", dgridTiles: 12, dgridHideKept: true, cleanupGoalGb: 0 },
});

registerModeUI("djunk", {
  card: {
    name: "Junk",
    blurb: "Only what looks like junk: tiny, low-resolution, screenshots, previews, promo names.",
    icon: "M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5",
    stat: () => "suspects only",
  },
  summary: () => {
    const sweep = sweepState("djunk");
    const left = Math.max(0, sweep.items.length - sweep.pos);
    return `${plural(left, "suspect", "suspects")} left. Each tile says why it is here; nothing is marked for you.`;
  },
  defaults: { djunkKind: "all", djunkHideKept: true, cleanupGoalGb: 0 },
});

registerModeUI("dsimilar", {
  card: {
    name: "Look-alikes",
    blurb: "Near-identical shots grouped together: bursts, resized and re-saved copies. Keep the best.",
    icon: "M4 8h11v12H4zM9 4h11v12",
    stat: () => (similar.sets.length ? `${similar.sets.length.toLocaleString()} sets` : "find sets"),
  },
  summary: () => {
    const pool = similarPool().length;
    const printed = similarPool().filter((item) => similar.prints.has(item.path)).length;
    const found = similar.built ? ` ${plural(similar.sets.length, "set", "sets")} found.` : "";
    return `${printed.toLocaleString()} of ${pool.toLocaleString()} fingerprinted.${found} Compared within each model only.`;
  },
  defaults: { dsimilarKind: "photos", dsimilarStrictness: "close", cleanupGoalGb: 0 },
});

registerModeUI("dfolders", {
  card: {
    name: "Folders",
    blurb: "One folder at a time: a handful of samples, then keep or delete the whole folder.",
    icon: "M3 6h6l2 2h10v11H3zM9 13h6",
    stat: () => "whole folders",
  },
  summary: () => `${plural(folderSweep.list.length, "folder", "folders")}, biggest first. Delete asks before it moves anything.`,
  defaults: { dfoldersHideKept: true, cleanupGoalGb: 0 },
});

/* ---- which files, in what order ---- */

function keptHere(item) {
  return state.features.has("dangerousKept") ? dangerousKept.paths.has(item.path) : !!item.rating;
}

function cleanupItems(mode, kind = "all", hideKept = false) {
  const selected = normalizedFolderSelection(`${mode}Folders`);
  const items = [];
  if (kind !== "videos") (state.library.images || []).forEach((item) => items.push({ ...item, kind: "photo" }));
  if (kind !== "photos") (state.library.videos || []).forEach((item) => items.push({ ...item, kind: "video" }));
  return items.filter((item) => matchesFolderSelection(item, selected) && !(hideKept && keptHere(item)));
}

// What makes a file look like junk, strongest first. Names only suggest:
// whole packs are named after the channel that posted them.
const JUNK_NAMES = [
  [/screen[-_ ]?(shot|record)/i, "Screenshot", 2],
  [/avatar|profile[-_ ]?pic|icons?8|\bicon\b|logo|banner/i, "Icon or avatar", 2],
  [/thumb|preview|sample|teaser/i, "Preview", 2],
  [/telegram|t\.me\b|discord|patreon|promo|subscribe|join[-_ ]?us|@[a-z0-9_]{3,}/i, "Promo name", 1],
];

function junkReasons(item) {
  const reasons = [];
  if (item.kind === "video") {
    if (item.size < 1.5 * MB) reasons.push(["Tiny clip", 3]);
    else if (item.size < 4 * MB) reasons.push(["Very short clip", 1]);
  } else {
    if (item.size < 30 * KB) reasons.push([`Tiny file, ${formatSize(item.size)}`, 3]);
    else if (item.size < 80 * KB) reasons.push(["Small file", 1]);
    const print = similar.prints.get(item.path);
    if (print?.w && Math.min(print.w, print.h) < 480) reasons.push([`Low resolution ${print.w}×${print.h}`, 3]);
  }
  const name = item.name || item.path.split("/").pop();
  JUNK_NAMES.forEach(([pattern, label, weight]) => pattern.test(name) && reasons.push([label, weight]));
  return reasons;
}

function junkScore(item) {
  return junkReasons(item).reduce((sum, [, weight]) => sum + weight, 0);
}

function orderCleanupItems(items, order) {
  if (order === "biggest") {
    items.sort((a, b) => b.size - a.size);
  } else if (order === "name") {
    items.sort((a, b) => a.path.localeCompare(b.path));
  } else {
    shuffleBalanced(items);
    if (order === "junk") {
      // Stable: equal scores keep the balanced shuffle.
      const scores = new Map(items.map((item) => [item.path, junkScore(item)]));
      items.sort((a, b) => scores.get(b.path) - scores.get(a.path));
    }
  }
  return items;
}

async function ensureKeptLoaded() {
  if (state.features.has("dangerousKept") && !dangerousKept.loaded) await loadDangerousKept();
}

/* ---- deleting, keeping, undoing ---- */

// Moves files into .heaven-trash. Big folders go in chunks so the server
// keeps serving pictures between them, and the button can count up.
async function cleanupDelete(items, onProgress) {
  if (!state.canTrash) throw new Error("This drive is read-only. Nothing was deleted.");
  const library = state.currentMediaDirectory;
  const byPath = new Map(items.map((item) => [item.path, item]));
  const paths = [...byPath.keys()];
  const trashed = [];
  const failed = [];
  let updatedAt = null;
  try {
    if (state.features.has("cleanup")) {
      for (let start = 0; start < paths.length; start += 200) {
        const result = await postJson("/api/trash-many", { paths: paths.slice(start, start + 200), library });
        trashed.push(...result.trashed);
        failed.push(...result.failed);
        updatedAt = result.updatedAt;
        onProgress?.(Math.min(paths.length, start + 200), paths.length);
      }
    } else {
      // A server from before these modes: one request per file.
      for (const [index, path] of paths.entries()) {
        try {
          const result = await postJson("/api/trash", { path, library });
          trashed.push({ path, token: result.token });
          updatedAt = result.updatedAt;
        } catch (error) {
          if (error instanceof LockedError) throw error;
          failed.push({ path, error: error.message });
        }
        onProgress?.(index + 1, paths.length);
      }
    }
  } finally {
    // Whatever moved before an error is gone from the drive: the page must
    // stop showing it either way.
    forgetDeleted(trashed.map((entry) => entry.path), updatedAt);
  }
  const done = trashed.map((entry) => ({ token: entry.token, item: byPath.get(entry.path) }));
  const bytes = done.reduce((sum, entry) => sum + (entry.item.size || 0), 0);
  cleanupCount("delete", bytes, done.length);
  return { trashed: done, failed, bytes, library };
}

function forgetDeleted(paths, updatedAt) {
  if (!paths.length) return;
  const gone = new Set(paths);
  removeLibraryItems(paths);
  // Swipe walks its own deck; keep its place while dropping these.
  const before = dangerous.items.filter((item, index) => gone.has(item.path) && index < dangerous.index).length;
  dangerous.items = dangerous.items.filter((item) => !gone.has(item.path));
  dangerous.index = Math.max(0, dangerous.index - before);
  if (updatedAt) state.library.updatedAt = updatedAt;
  state.librarySignature = librarySignature();
  state.feed.dirty = true;
  syncWorkspace();
}

async function cleanupKeep(items, kept = true) {
  const paths = items.map((item) => item.path);
  if (!paths.length) return;
  if (state.features.has("cleanup")) {
    await postJson("/api/dangerous-kept", { paths, kept });
  } else if (state.features.has("dangerousKept")) {
    for (const path of paths) await postJson("/api/dangerous-kept", { path, kept });
  }
  paths.forEach((path) => (kept ? dangerousKept.paths.add(path) : dangerousKept.paths.delete(path)));
  cleanupCount(kept ? "keep" : "unkeep", 0, paths.length);
}

// Takes back the newest action of one mode: files come out of the trash to
// where they were, keep marks are removed.
async function cleanupUndo(mode) {
  const index = cleanup.history.findLastIndex((entry) => entry.mode === mode);
  if (index < 0 || cleanup.busy) return null;
  const entry = cleanup.history[index];
  cleanup.busy = true;
  syncCleanupButtons();
  let reload = false;
  try {
    if (entry.trashed.length > 1 && state.features.has("cleanup")) {
      for (let start = 0; start < entry.trashed.length; start += 200) {
        const chunk = entry.trashed.slice(start, start + 200);
        const result = await postJson("/api/restore-many", { tokens: chunk.map((t) => t.token), library: entry.library });
        result.items.forEach((item) => restoreLibraryItem({ item, updatedAt: result.updatedAt }));
        const back = new Set(result.items.map((item) => item.path));
        const bytes = chunk.filter((t) => back.has(t.item.path)).reduce((sum, t) => sum + (t.item.size || 0), 0);
        cleanupCount("restore", bytes, back.size);
        if (result.failed.length) toast(`${plural(result.failed.length, "file", "files")} could not be restored: ${result.failed[0].error}`, 8000);
      }
      entry.trashed = [];
    }
    for (const { token, item } of [...entry.trashed]) {
      const result = await postJson("/api/restore", { token, library: entry.library });
      if (result.item) restoreLibraryItem(result);
      else reload = true;
      entry.trashed.shift();
      cleanupCount("restore", item.size || 0, 1);
    }
    await cleanupKeep(entry.kept, false);
    cleanup.history.splice(index, 1);
    if (reload) await loadState();
    syncWorkspace();
    return entry;
  } catch (error) {
    toast(error.message);
    return null;
  } finally {
    cleanup.busy = false;
    syncCleanupButtons();
  }
}

/* ---- the meter: freed this visit, and the goal ---- */

function cleanupCount(action, bytes = 0, count = 1) {
  if (action === "delete") {
    cleanup.freed += bytes;
    cleanup.deleted += count;
  } else if (action === "restore") {
    cleanup.freed = Math.max(0, cleanup.freed - bytes);
    cleanup.deleted = Math.max(0, cleanup.deleted - count);
  } else if (action === "keep") {
    cleanup.kept += count;
  } else if (action === "unkeep") {
    cleanup.kept = Math.max(0, cleanup.kept - count);
  }
  if (blitz.running && (action === "delete" || action === "keep")) {
    blitz.count += count;
    blitz.freed += bytes;
  } else if (blitz.running && (action === "restore" || action === "unkeep")) {
    blitz.count = Math.max(0, blitz.count - count);
    blitz.freed = Math.max(0, blitz.freed - bytes);
  }
  renderCleanupMeters();
}

function renderCleanupMeters() {
  const goal = Number(state.settings.cleanupGoalGb || 0) * 1024 ** 3;
  const reached = goal > 0 && cleanup.freed >= goal;
  document.querySelectorAll("[data-cleanup-meter]").forEach((node) => {
    const text = document.createElement("span");
    text.textContent = `Freed ${formatBytes(cleanup.freed)} this visit · ${plural(cleanup.deleted, "deleted", "deleted")} · ${plural(cleanup.kept, "kept", "kept")}`;
    const parts = [text];
    if (goal > 0) {
      const bar = document.createElement("span");
      bar.className = "meter-bar";
      bar.style.setProperty("--fill", `${Math.min(100, (cleanup.freed / goal) * 100)}%`);
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", `${Math.round(Math.min(1, cleanup.freed / goal) * 100)}% of the goal`);
      const label = document.createElement("strong");
      label.textContent = reached ? "Goal reached" : `goal ${formatBytes(goal)}`;
      parts.push(bar, label);
    }
    node.classList.toggle("is-reached", reached);
    node.replaceChildren(...parts);
  });
  if (reached && !cleanup.goalToasted) {
    cleanup.goalToasted = true;
    toast(`Goal reached: ${formatBytes(cleanup.freed)} freed. Empty the trash in Settings to get the space back.`, 8000);
  } else if (!reached) {
    cleanup.goalToasted = false;
  }
}

/* ---- the tile every grid is built from ---- */

// A photo, or a clip's still (made and kept like the gallery's), with its
// size and why it is here. Tapping marks it; the corner button opens it.
function cleanupTile(item, { marked, badges = [], note = "", onToggle, onOpen, observer }) {
  const tile = document.createElement("div");
  tile.className = `sweep-tile${item.kind === "video" ? " is-video" : ""}${marked ? " is-marked" : ""}`;
  tile.dataset.path = item.path;
  tile.setAttribute("role", "listitem");
  const hit = document.createElement("button");
  hit.type = "button";
  hit.className = "sweep-hit";
  hit.setAttribute("aria-pressed", String(!!marked));
  hit.setAttribute("aria-label", `${item.name || item.path}: ${marked ? "marked for delete" : "keep"}`);
  if (item.kind === "video") {
    const preview = document.createElement("span");
    preview.className = "video-placeholder";
    preview.innerHTML = "<span>▶</span><span></span>";
    preview.lastChild.textContent = item.name || "";
    const thumb = document.createElement("img");
    thumb.className = "gallery-thumb";
    thumb.alt = "";
    thumb.decoding = "async";
    hit.append(preview, thumb);
  } else {
    const image = document.createElement("img");
    image.loading = "lazy";
    image.decoding = "async";
    image.alt = "";
    image.src = mediaUrl(item.path);
    image.addEventListener("error", () => tile.classList.add("is-missing"));
    hit.append(image);
  }
  const stamp = document.createElement("span");
  stamp.className = "sweep-stamp";
  stamp.textContent = "Delete";
  hit.append(stamp);
  hit.addEventListener("click", () => onToggle?.(item, tile));
  tile.append(hit);

  if (badges.length) {
    const list = document.createElement("span");
    list.className = "sweep-badges";
    badges.forEach((label) => {
      const badge = document.createElement("span");
      badge.className = "sweep-badge";
      badge.textContent = label;
      list.append(badge);
    });
    tile.append(list);
  }
  const meta = document.createElement("span");
  meta.className = "sweep-meta";
  meta.textContent = [item.kind === "video" ? "Video" : "", formatSize(item.size || 0), note].filter(Boolean).join(" · ");
  tile.append(meta);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "sweep-open";
  open.setAttribute("aria-label", `Open ${item.name || "file"} larger`);
  open.innerHTML = '<svg aria-hidden="true"><use href="#i-search" /></svg>';
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    onOpen?.(item, tile);
  });
  tile.append(open);
  if (item.kind === "video") observer?.observe(tile);
  return tile;
}

function setTileMarked(tile, marked, label = "marked for delete") {
  tile.classList.toggle("is-marked", marked);
  const hit = tile.querySelector(".sweep-hit");
  hit.setAttribute("aria-pressed", String(marked));
  hit.setAttribute("aria-label", `${tile.dataset.path.split("/").pop()}: ${marked ? label : "keep"}`);
}

/* ---- the viewer: one file, big, with its mark ---- */

const viewer = { item: null, onToggle: null, isMarked: null };

function openCleanupViewer(item, { isMarked, onToggle }) {
  Object.assign(viewer, { item, isMarked, onToggle });
  const box = el("cleanupViewer");
  const image = el("cleanupViewerImage");
  const video = el("cleanupViewerVideo");
  image.hidden = item.kind === "video";
  video.hidden = item.kind !== "video";
  if (item.kind === "video") {
    image.removeAttribute("src");
    video.muted = !state.audioUnlocked;
    loadVideoSource(video, item);
    video.play().catch(() => {});
  } else {
    releaseVideo(video);
    image.src = mediaUrl(item.path);
  }
  el("cleanupViewerName").textContent = item.name || item.path;
  el("cleanupViewerFolder").textContent = `${item.folder || "Library root"} · ${formatSize(item.size || 0)}`;
  syncViewerMark();
  box.hidden = false;
  el("cleanupViewerClose").focus({ preventScroll: true });
}

function syncViewerMark() {
  const marked = !!viewer.isMarked?.(viewer.item);
  const button = el("cleanupViewerMark");
  button.textContent = marked ? "Marked for delete — tap to keep" : "Keeping — tap to mark for delete";
  button.classList.toggle("is-marked", marked);
}

function closeCleanupViewer() {
  const box = el("cleanupViewer");
  if (box.hidden) return;
  box.hidden = true;
  releaseVideo(el("cleanupViewerVideo"));
  el("cleanupViewerImage").removeAttribute("src");
  viewer.item = null;
}

/* ---- Grid and Junk: a page of files at a time ---- */

const sweeps = {};

function sweepState(mode) {
  return (sweeps[mode] ||= { items: [], pos: 0, marked: new Set(), cursor: 0, built: false, library: "", observer: null });
}

function sweepPageSize(mode) {
  return mode === "djunk" ? 12 : Number(state.settings.dgridTiles || 12);
}

function buildSweep(mode) {
  const sweep = sweepState(mode);
  const kind = state.settings[`${mode}Kind`] || "all";
  let items = cleanupItems(mode, kind, !!state.settings[`${mode}HideKept`]);
  if (mode === "djunk") {
    const scored = items.map((item) => ({ item, reasons: junkReasons(item) })).filter((entry) => entry.reasons.length);
    scored.forEach((entry) => {
      entry.score = entry.reasons.reduce((sum, [, weight]) => sum + weight, 0);
    });
    scored.sort((a, b) => b.score - a.score || a.item.size - b.item.size);
    items = scored.map((entry) => entry.item);
  } else {
    orderCleanupItems(items, state.settings.dgridOrder);
  }
  Object.assign(sweep, { items, pos: 0, cursor: 0, built: true, library: state.currentMediaDirectory });
  sweep.marked.clear();
}

function sweepPage(mode) {
  const sweep = sweepState(mode);
  return sweep.items.slice(sweep.pos, sweep.pos + sweepPageSize(mode));
}

// Files deleted elsewhere (another mode, another device) leave the deal.
function dropMissing(items) {
  const known = new Set([...(state.library.images || []), ...(state.library.videos || [])].map((item) => item.path));
  return items.filter((item) => known.has(item.path));
}

async function enterSweep(mode) {
  await ensureKeptLoaded();
  if (mode === "djunk" && state.features.has("cleanup")) await loadPrints();
  if (state.currentMode !== mode) return;
  const sweep = sweepState(mode);
  if (!sweep.built || sweep.library !== state.currentMediaDirectory) buildSweep(mode);
  else sweep.items = dropMissing(sweep.items);
  renderSweep(mode);
}

function renderSweep(mode) {
  if (state.currentMode !== mode) return;
  const sweep = sweepState(mode);
  const page = sweepPage(mode);
  const grid = el(`${mode}Grid`);
  sweep.observer?.disconnect();
  sweep.observer = videoTileObserver(null);
  grid.querySelectorAll("video").forEach(releaseVideo);
  sweep.cursor = clampNumber(sweep.cursor, 0, Math.max(0, page.length - 1));
  grid.dataset.count = String(page.length);
  grid.replaceChildren(...page.map((item, index) => {
    const tile = cleanupTile(item, {
      marked: sweep.marked.has(item.path),
      badges: mode === "djunk" ? junkReasons(item).map(([label]) => label) : [],
      onToggle: () => toggleSweepMark(mode, item.path),
      onOpen: () => openCleanupViewer(item, { isMarked: (it) => sweep.marked.has(it.path), onToggle: (it) => toggleSweepMark(mode, it.path) }),
      observer: sweep.observer,
    });
    tile.classList.toggle("is-cursor", index === sweep.cursor);
    return tile;
  }));
  fitGridRows(grid);
  const total = sweep.items.length;
  el(`${mode}Empty`).hidden = page.length > 0;
  el(`${mode}Progress`).textContent = page.length
    ? `${(sweep.pos + 1).toLocaleString()}–${(sweep.pos + page.length).toLocaleString()} of ${total.toLocaleString()}`
    : "All done";
  syncSweepActions(mode);
  syncDrawerSummaries();
}

function toggleSweepMark(mode, path) {
  if (cleanup.busy) return;
  const sweep = sweepState(mode);
  if (sweep.marked.has(path)) sweep.marked.delete(path);
  else sweep.marked.add(path);
  const tile = el(`${mode}Grid`).querySelector(`.sweep-tile[data-path="${CSS.escape(path)}"]`);
  if (tile) setTileMarked(tile, sweep.marked.has(path));
  if (viewer.item?.path === path) syncViewerMark();
  syncSweepActions(mode);
}

function syncSweepActions(mode) {
  const sweep = sweepState(mode);
  const page = sweepPage(mode);
  const marked = page.filter((item) => sweep.marked.has(item.path)).length;
  const commit = el(`${mode}Commit`);
  commit.querySelector("span").textContent = marked ? `Delete ${marked} · keep ${page.length - marked}` : `Keep all ${page.length}`;
  commit.classList.toggle("delete", marked > 0);
  commit.classList.toggle("keep", marked === 0);
  commit.disabled = cleanup.busy || !page.length || (marked > 0 && !state.canTrash);
  el(`${mode}Skip`).disabled = cleanup.busy || !page.length;
  el(`${mode}MarkAll`).disabled = cleanup.busy || !page.length;
  el(`${mode}MarkAll`).textContent = page.length && marked === page.length ? "Clear marks" : "Mark all";
  el(`${mode}Undo`).disabled = cleanup.busy || !cleanup.history.some((entry) => entry.mode === mode);
  el(`${mode}ReadOnly`).hidden = state.canTrash !== false;
}

function syncCleanupButtons() {
  ["dgrid", "djunk"].forEach((mode) => el(`${mode}Commit`) && syncSweepActions(mode));
  syncSimilarActions();
  syncFolderActions();
}

function markWholePage(mode) {
  const sweep = sweepState(mode);
  const page = sweepPage(mode);
  const all = page.length && page.every((item) => sweep.marked.has(item.path));
  page.forEach((item) => (all ? sweep.marked.delete(item.path) : sweep.marked.add(item.path)));
  renderSweep(mode);
}

async function commitSweep(mode) {
  const sweep = sweepState(mode);
  const page = sweepPage(mode);
  if (!page.length || cleanup.busy) return;
  const doomed = page.filter((item) => sweep.marked.has(item.path));
  const keep = page.filter((item) => !sweep.marked.has(item.path));
  cleanup.busy = true;
  syncSweepActions(mode);
  try {
    const result = doomed.length ? await cleanupDelete(doomed) : { trashed: [], failed: [], library: state.currentMediaDirectory };
    await cleanupKeep(keep);
    cleanup.history.push({ mode, trashed: result.trashed, kept: keep, page, library: result.library });
    const settled = new Set([...result.trashed.map((entry) => entry.item.path), ...keep.map((item) => item.path)]);
    sweep.items = sweep.items.filter((item) => !settled.has(item.path));
    sweep.marked.clear();
    sweep.cursor = 0;
    if (result.failed.length) toast(`${plural(result.failed.length, "file", "files")} could not be deleted: ${result.failed[0].error}`, 8000);
    haptic();
  } catch (error) {
    if (!(error instanceof LockedError)) toast(error.message || "Could not save. Nothing on this page changed.");
  } finally {
    cleanup.busy = false;
    renderSweep(mode);
  }
}

function skipSweepPage(mode) {
  const sweep = sweepState(mode);
  if (cleanup.busy || sweep.pos >= sweep.items.length) return;
  sweep.pos += sweepPageSize(mode);
  sweep.marked.clear();
  sweep.cursor = 0;
  renderSweep(mode);
  el(`${mode}Grid`).scrollTo?.(0, 0);
}

async function undoSweep(mode) {
  const entry = await cleanupUndo(mode);
  if (!entry) return;
  const sweep = sweepState(mode);
  const present = new Set(sweep.items.map((item) => item.path));
  sweep.items.splice(sweep.pos, 0, ...entry.page.filter((item) => !present.has(item.path)));
  sweep.marked = new Set(entry.page.filter((item) => !entry.kept.includes(item)).map((item) => item.path));
  renderSweep(mode);
}

// Space and Enter on a focused button are that button's own click; handling
// them here as well would mark a tile twice, or commit the page.
function focusOwnsKey(key) {
  return (key === " " || key === "Enter") && document.activeElement?.tagName === "BUTTON";
}

function sweepKey(mode, key, lower) {
  if (focusOwnsKey(key)) return false;
  const sweep = sweepState(mode);
  const page = sweepPage(mode);
  const columns = Math.max(1, getComputedStyle(el(`${mode}Grid`)).gridTemplateColumns.split(" ").length);
  const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[key];
  if (move !== undefined) {
    // The cursor outline only shows once the keyboard is in use.
    el(`${mode}Grid`).classList.add("show-cursor");
    sweep.cursor = clampNumber(sweep.cursor + move, 0, Math.max(0, page.length - 1));
    el(`${mode}Grid`).querySelectorAll(".sweep-tile").forEach((tile, index) => tile.classList.toggle("is-cursor", index === sweep.cursor));
    el(`${mode}Grid`).children[sweep.cursor]?.scrollIntoView({ block: "nearest" });
    return true;
  }
  if (key === " " || lower === "x") {
    if (page[sweep.cursor]) toggleSweepMark(mode, page[sweep.cursor].path);
    return true;
  }
  if (key === "Enter") return commitSweep(mode), true;
  if (lower === "s") return skipSweepPage(mode), true;
  if (lower === "a") return markWholePage(mode), true;
  if (lower === "u") return undoSweep(mode), true;
  if (lower === "v" && page[sweep.cursor]) {
    el(`${mode}Grid`).children[sweep.cursor]?.querySelector(".sweep-open")?.click();
    return true;
  }
  return false;
}

function viewerKey(key, lower) {
  if (el("cleanupViewer").hidden) return false;
  if (focusOwnsKey(key)) return false;
  if (key === "Escape") closeCleanupViewer();
  else if (key === " " || lower === "x") {
    viewer.onToggle?.(viewer.item);
    syncViewerMark();
  }
  return true;
}

["dgrid", "djunk"].forEach((mode) => {
  registerMode(mode, {
    enter: () => {
      syncSettingControls(el(`${mode}Drawer`));
      renderCleanupMeters();
      enterSweep(mode);
    },
    quiet: () => {
      closeCleanupViewer();
    },
    refresh: () => {
      syncSettingControls(el(`${mode}Drawer`));
      sweepState(mode).built = false;
      if (state.currentMode === mode) enterSweep(mode);
    },
    next: () => skipSweepPage(mode),
    key: (key, lower) => viewerKey(key, lower) || sweepKey(mode, key, lower),
  });
});

/* ---- Look-alikes ---- */

const similar = {
  prints: new Map(), loaded: false, loading: null,
  queue: [], workers: 0, running: false, failed: 0, pending: {}, flushTimer: 0,
  sets: [], index: 0, keep: new Set(), built: false, building: false, library: "",
};
const STRICTNESS = { tight: 4, close: 8, loose: 12 };
let hashCanvas = null;

async function loadPrints() {
  if (!state.features.has("cleanup") || similar.loaded) return;
  similar.loading ||= fetchJson("/api/fingerprints")
    .then(({ fingerprints }) => {
      Object.entries(fingerprints || {}).forEach(([path, [hash, w, h]]) => similar.prints.set(path, { hash, w, h }));
      similar.loaded = true;
    })
    .catch(() => {})
    .finally(() => { similar.loading = null; });
  return similar.loading;
}

function similarPool() {
  return mediaPool(`dsimilar:${state.settings.dsimilarKind}`, () =>
    cleanupItems("dsimilar", state.settings.dsimilarKind === "all" ? "all" : "photos"));
}

// A 64-bit difference hash: the picture drawn at 36×32, averaged into 9×8
// greys, and one bit per cell for "the cell to its right is brighter".
async function hashImage(url) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
    hashCanvas ||= document.createElement("canvas");
    hashCanvas.width = 36;
    hashCanvas.height = 32;
    const context = hashCanvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, 36, 32);
    const pixels = context.getImageData(0, 0, 36, 32).data;
    const grey = new Float64Array(72);
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 36; x += 1) {
        const at = (y * 36 + x) * 4;
        grey[(y >> 2) * 9 + (x >> 2)] += 0.299 * pixels[at] + 0.587 * pixels[at + 1] + 0.114 * pixels[at + 2];
      }
    }
    let high = 0;
    let low = 0;
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const bit = grey[row * 9 + column] < grey[row * 9 + column + 1] ? 1 : 0;
        if (row < 4) high = ((high << 1) | bit) >>> 0;
        else low = ((low << 1) | bit) >>> 0;
      }
    }
    return { hash: high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0"), w: image.naturalWidth, h: image.naturalHeight };
  } finally {
    image.src = "";
  }
}

// A clip is compared by its still: the saved one if there is one, else a
// new one made (and saved) the way the gallery makes them.
async function fingerprintItem(item) {
  if (item.kind !== "video") return hashImage(mediaUrl(item.path));
  let url = thumbCache.get(item.path);
  if (url === "failed") throw new Error("no still");
  if (!url) {
    try {
      const saved = await hashImage(thumbUrl(item.path));
      return { hash: saved.hash, w: 0, h: 0 };
    } catch {
      const blob = await generateThumb(item.path);
      url = URL.createObjectURL(blob);
      thumbCache.set(item.path, url);
      fetch(`/api/thumb?path=${encodeURIComponent(item.path)}`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob }).catch(() => {});
    }
  }
  const made = await hashImage(url);
  return { hash: made.hash, w: 0, h: 0 };
}

function startFingerprinting() {
  const missing = similarPool().filter((item) => !similar.prints.has(item.path));
  similar.queue = missing;
  similar.failed = 0;
  similar.running = missing.length > 0;
  similar.library = state.currentMediaDirectory;
  for (let n = similar.workers; n < 4; n += 1) fingerprintWorker();
  renderSimilar();
}

function pauseFingerprinting() {
  similar.running = false;
  flushPrints();
  renderSimilar();
}

async function fingerprintWorker() {
  similar.workers += 1;
  try {
    while (similar.running && similar.queue.length && state.currentMode === "dsimilar" && !document.hidden
      && similar.library === state.currentMediaDirectory) {
      const item = similar.queue.shift();
      if (similar.prints.has(item.path)) continue;
      try {
        const print = await fingerprintItem(item);
        similar.prints.set(item.path, print);
        similar.pending[item.path] = [print.hash, print.w, print.h];
        if (Object.keys(similar.pending).length >= 100) flushPrints();
        else scheduleFlush();
      } catch {
        similar.failed += 1;
      }
      renderScanProgress();
    }
  } finally {
    similar.workers -= 1;
    if (!similar.workers) {
      flushPrints();
      if (!similar.queue.length && similar.running) {
        similar.running = false;
        buildSimilarSets();
      } else {
        similar.running = false;
        renderSimilar();
      }
    }
  }
}

function scheduleFlush() {
  window.clearTimeout(similar.flushTimer);
  similar.flushTimer = window.setTimeout(flushPrints, 3000);
}

function flushPrints() {
  window.clearTimeout(similar.flushTimer);
  const items = similar.pending;
  if (!Object.keys(items).length || !state.features.has("cleanup")) return;
  similar.pending = {};
  postJson("/api/fingerprints", { items }).catch(() => Object.assign(similar.pending, items));
}

let scanPaint = 0;
function renderScanProgress() {
  const now = performance.now();
  if (now - scanPaint < 200 && similar.running) return;
  scanPaint = now;
  const pool = similarPool();
  const printed = pool.filter((item) => similar.prints.has(item.path)).length;
  el("dsimilarScanBar").style.setProperty("--fill", `${pool.length ? (printed / pool.length) * 100 : 0}%`);
  const failed = similar.failed ? ` · ${plural(similar.failed, "file", "files")} could not be read` : "";
  el("dsimilarScanText").textContent = `${printed.toLocaleString()} of ${pool.length.toLocaleString()} fingerprinted${failed}.`;
  el("dsimilarProgress").textContent = similar.running ? "Fingerprinting…" : similar.built ? setProgressText() : "";
}

function popcount(value) {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Everything within the chosen distance of something else in the same model
// (and of the same kind) ends up in one set. Runs in slices so the page
// stays responsive on a phone.
async function buildSimilarSets() {
  if (similar.building) return;
  similar.building = true;
  renderSimilar();
  try {
    const limit = STRICTNESS[state.settings.dsimilarStrictness] ?? 8;
    const buckets = new Map();
    similarPool().forEach((item) => {
      const print = similar.prints.get(item.path);
      if (!print) return;
      const high = parseInt(print.hash.slice(0, 8), 16);
      const low = parseInt(print.hash.slice(8), 16);
      // A flat picture (all black, all white) matches every other flat one.
      const bits = popcount(high) + popcount(low);
      if (bits <= 1 || bits >= 63) return;
      const key = `${item.path.split("/")[0]}\u0000${item.kind}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ item, high, low, print });
    });
    const sets = [];
    let work = 0;
    for (const members of buckets.values()) {
      const n = members.length;
      const high = Uint32Array.from(members, (m) => m.high);
      const low = Uint32Array.from(members, (m) => m.low);
      const parent = Int32Array.from({ length: n }, (_, i) => i);
      const find = (i) => {
        while (parent[i] !== i) {
          parent[i] = parent[parent[i]];
          i = parent[i];
        }
        return i;
      };
      for (let i = 0; i < n; i += 1) {
        const hi = high[i];
        const lo = low[i];
        for (let j = i + 1; j < n; j += 1) {
          if (popcount(hi ^ high[j]) + popcount(lo ^ low[j]) <= limit) {
            const a = find(i);
            const b = find(j);
            if (a !== b) parent[b] = a;
          }
        }
        work += n - i;
        if (work > 1500000) {
          work = 0;
          await new Promise((resolve) => setTimeout(resolve));
        }
      }
      const groups = new Map();
      members.forEach((member, i) => {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(member);
      });
      groups.forEach((group) => {
        if (group.length < 2) return;
        const items = group.map((m) => ({ ...m.item, w: m.print.w, h: m.print.h }));
        // Best first: most pixels, then the biggest file, then the shortest path.
        items.sort((a, b) => b.w * b.h - a.w * a.h || b.size - a.size || a.path.length - b.path.length);
        const bytes = items.reduce((sum, item) => sum + item.size, 0) - items[0].size;
        sets.push({ items, bytes });
      });
    }
    sets.sort((a, b) => b.bytes - a.bytes);
    // Sets you already went through (every file kept here) stay settled.
    similar.sets = sets.filter((set) => !set.items.every(keptHere));
    similar.index = 0;
    similar.built = true;
    similar.library = state.currentMediaDirectory;
    pickSetDefaults();
  } finally {
    similar.building = false;
    renderSimilar();
  }
}

function currentSet() {
  return similar.sets[similar.index] || null;
}

function pickSetDefaults() {
  const set = currentSet();
  similar.keep = new Set(set ? [set.items[0].path] : []);
}

function setProgressText() {
  return similar.sets.length ? `Set ${Math.min(similar.index + 1, similar.sets.length).toLocaleString()} of ${similar.sets.length.toLocaleString()}` : "No sets";
}

function renderSimilar() {
  if (state.currentMode !== "dsimilar") return;
  const pool = similarPool();
  const missing = pool.filter((item) => !similar.prints.has(item.path)).length;
  const showScan = similar.running || similar.building || !similar.built || missing > 0;
  el("dsimilarScan").hidden = !showScan;
  el("dsimilarScanToggle").textContent = similar.running ? "Pause" : missing ? (pool.length - missing ? "Continue" : "Start") : "Up to date";
  el("dsimilarScanToggle").disabled = similar.building || (!similar.running && !missing);
  el("dsimilarScanShow").disabled = similar.running || similar.building || pool.length === missing;
  el("dsimilarScanShow").textContent = similar.building ? "Comparing…" : similar.built ? "Compare again" : "Show sets found so far";
  el("dsimilarScanNote").textContent = state.features.has("cleanup")
    ? "Each photo is read once to fingerprint it; the fingerprints are saved, so this is quicker next time and on other devices."
    : "Fingerprints are kept only until you reload (the server needs a restart to save them).";
  renderScanProgress();

  const set = similar.built ? currentSet() : null;
  el("dsimilarHead").hidden = !set;
  el("dsimilarActions").hidden = !set;
  el("dsimilarEmpty").hidden = !(similar.built && !set && !similar.running);
  const grid = el("dsimilarGrid");
  similar.observer?.disconnect();
  similar.observer = videoTileObserver(null);
  grid.querySelectorAll("video").forEach(releaseVideo);
  if (!set) {
    grid.replaceChildren();
  } else {
    syncSetHead();
    grid.dataset.count = String(set.items.length);
    requestAnimationFrame(() => fitGridRows(grid));
    grid.replaceChildren(...set.items.map((item, index) => {
      const note = item.w ? `${item.w}×${item.h}` : "";
      const tile = cleanupTile(item, {
        marked: !similar.keep.has(item.path),
        badges: index === 0 ? ["Best copy"] : [],
        note,
        onToggle: () => toggleSetKeep(item.path),
        onOpen: () => openCleanupViewer(item, { isMarked: (it) => !similar.keep.has(it.path), onToggle: (it) => toggleSetKeep(it.path) }),
        observer: similar.observer,
      });
      return tile;
    }));
  }
  el("dsimilarProgress").textContent = similar.running ? "Fingerprinting…" : similar.built ? setProgressText() : "";
  syncSimilarActions();
  syncDrawerSummaries();
}

function toggleSetKeep(path) {
  if (cleanup.busy) return;
  const set = currentSet();
  if (!set) return;
  if (similar.keep.has(path)) {
    if (similar.keep.size === 1) {
      toast("Keep at least one of a set. To drop them all, use Grid.");
      return;
    }
    similar.keep.delete(path);
  } else {
    similar.keep.add(path);
  }
  if (viewer.item?.path === path) syncViewerMark();
  const tile = el("dsimilarGrid").querySelector(`.sweep-tile[data-path="${CSS.escape(path)}"]`);
  if (tile) setTileMarked(tile, !similar.keep.has(path));
  syncSetHead();
  syncSimilarActions();
}

function syncSetHead() {
  const set = currentSet();
  if (!set) return;
  const doomed = set.items.filter((item) => !similar.keep.has(item.path));
  const freed = doomed.reduce((sum, item) => sum + item.size, 0);
  el("dsimilarHeadTitle").textContent = `${plural(set.items.length, "look-alike", "look-alikes")} in ${set.items[0].path.split("/")[0]}`;
  el("dsimilarHeadNote").textContent = doomed.length
    ? `Deleting the ones marked frees ${formatBytes(freed)}. The best copy is kept unless you change it.`
    : "Everything here is kept. Tap a picture to mark it for delete.";
}

function syncSimilarActions() {
  const commit = el("dsimilarCommit");
  if (!commit) return;
  const set = similar.built ? currentSet() : null;
  const doomed = set ? set.items.filter((item) => !similar.keep.has(item.path)).length : 0;
  commit.querySelector("span").textContent = set ? `Delete ${doomed} · keep ${set.items.length - doomed}` : "Delete";
  commit.disabled = cleanup.busy || !set || !doomed || !state.canTrash;
  el("dsimilarKeepAll").disabled = cleanup.busy || !set;
  el("dsimilarSkip").disabled = cleanup.busy || !set;
  el("dsimilarUndo").disabled = cleanup.busy || !cleanup.history.some((entry) => entry.mode === "dsimilar");
  el("dsimilarReadOnly").hidden = state.canTrash !== false;
}

async function commitSet(keepAll = false) {
  const set = currentSet();
  if (!set || cleanup.busy) return;
  const doomed = keepAll ? [] : set.items.filter((item) => !similar.keep.has(item.path));
  const keep = set.items.filter((item) => !doomed.includes(item));
  cleanup.busy = true;
  syncSimilarActions();
  try {
    const result = doomed.length ? await cleanupDelete(doomed) : { trashed: [], failed: [], library: state.currentMediaDirectory };
    await cleanupKeep(keep);
    cleanup.history.push({ mode: "dsimilar", trashed: result.trashed, kept: keep, set, setIndex: similar.index, keepPaths: [...similar.keep], library: result.library });
    similar.sets.splice(similar.index, 1);
    if (result.failed.length) toast(`${plural(result.failed.length, "file", "files")} could not be deleted: ${result.failed[0].error}`, 8000);
    pickSetDefaults();
    haptic();
  } catch (error) {
    if (!(error instanceof LockedError)) toast(error.message || "Could not save. Nothing in this set changed.");
  } finally {
    cleanup.busy = false;
    renderSimilar();
  }
}

function skipSet() {
  if (cleanup.busy || !currentSet()) return;
  similar.index += 1;
  pickSetDefaults();
  renderSimilar();
}

async function undoSet() {
  const entry = await cleanupUndo("dsimilar");
  if (!entry) return;
  similar.index = clampNumber(entry.setIndex, 0, similar.sets.length);
  similar.sets.splice(similar.index, 0, entry.set);
  similar.keep = new Set(entry.keepPaths);
  renderSimilar();
}

function toggleScan() {
  if (similar.running) pauseFingerprinting();
  else startFingerprinting();
}

registerMode("dsimilar", {
  enter: async () => {
    syncSettingControls(el("dsimilarDrawer"));
    renderCleanupMeters();
    await ensureKeptLoaded();
    await loadPrints();
    if (state.currentMode !== "dsimilar") return;
    if (similar.library && similar.library !== state.currentMediaDirectory) {
      similar.built = false;
      similar.sets = [];
    }
    if (similar.built) {
      // Files deleted since (here or elsewhere) leave their sets.
      const known = new Set(similarPool().map((item) => item.path));
      similar.sets = similar.sets
        .map((set) => ({ ...set, items: set.items.filter((item) => known.has(item.path)) }))
        .filter((set) => set.items.length > 1);
      if (!currentSet()) similar.index = 0;
      if (!currentSet()?.items.some((item) => similar.keep.has(item.path))) pickSetDefaults();
    }
    const missing = similarPool().some((item) => !similar.prints.has(item.path));
    if (missing) startFingerprinting();
    else if (!similar.built) buildSimilarSets();
    else renderSimilar();
  },
  quiet: () => {
    closeCleanupViewer();
    flushPrints();
  },
  refresh: () => {
    syncSettingControls(el("dsimilarDrawer"));
    invalidateMediaPools();
    similar.built = false;
    similar.sets = [];
    if (state.currentMode === "dsimilar") MODE_HANDLERS.dsimilar.enter();
  },
  next: skipSet,
  key: (key, lower) => {
    if (viewerKey(key, lower)) return true;
    if (focusOwnsKey(key)) return false;
    if (key === "Enter") return commitSet(), true;
    if (lower === "k") return commitSet(true), true;
    if (lower === "s" || key === "ArrowDown") return skipSet(), true;
    if (lower === "u") return undoSet(), true;
    return false;
  },
});

/* ---- Folders: keep or delete a whole folder ---- */

const folderSweep = { list: [], index: 0, samples: [], built: false, library: "", observer: null };

function buildFolderSweep() {
  const groups = new Map();
  cleanupItems("dfolders", "all").forEach((item) => {
    const key = item.folder || "";
    if (!groups.has(key)) groups.set(key, { folder: key, items: [], bytes: 0, kept: 0 });
    const group = groups.get(key);
    group.items.push(item);
    group.bytes += item.size || 0;
    if (keptHere(item)) group.kept += 1;
  });
  let list = [...groups.values()];
  if (state.settings.dfoldersHideKept) list = list.filter((group) => group.kept < group.items.length);
  list.sort((a, b) => b.bytes - a.bytes);
  Object.assign(folderSweep, { list, index: 0, built: true, library: state.currentMediaDirectory });
  pickFolderSamples();
}

function currentFolder() {
  return folderSweep.list[folderSweep.index] || null;
}

function pickFolderSamples() {
  const group = currentFolder();
  if (!group) {
    folderSweep.samples = [];
    return;
  }
  const photos = group.items.filter((item) => item.kind === "photo");
  const videos = group.items.filter((item) => item.kind === "video");
  shuffleArray(photos);
  shuffleArray(videos);
  // Mostly photos (they load fast), with a few stills if it has clips.
  const clipShare = photos.length ? Math.min(videos.length, 3) : Math.min(videos.length, 12);
  folderSweep.samples = [...photos.slice(0, 12 - clipShare), ...videos.slice(0, clipShare)];
}

function renderFolders() {
  if (state.currentMode !== "dfolders") return;
  const group = currentFolder();
  el("dfoldersHead").hidden = !group;
  el("dfoldersActions").hidden = !group;
  el("dfoldersEmpty").hidden = !!group;
  const grid = el("dfoldersGrid");
  folderSweep.observer?.disconnect();
  folderSweep.observer = videoTileObserver(null);
  grid.querySelectorAll("video").forEach(releaseVideo);
  if (group) {
    const [model, ...rest] = (group.folder || "Library root").split("/");
    el("dfoldersModel").textContent = model;
    el("dfoldersName").textContent = rest.length ? rest.join(" / ") : "Files directly in the model folder";
    const photos = group.items.filter((item) => item.kind === "photo").length;
    const rated = group.items.filter((item) => item.rating).length;
    el("dfoldersStats").textContent = [
      `${plural(group.items.length, "file", "files")} · ${formatBytes(group.bytes)}`,
      `${plural(photos, "photo", "photos")}, ${plural(group.items.length - photos, "video", "videos")}`,
      group.kept ? `${group.kept.toLocaleString()} kept here before` : "",
      rated ? `${rated.toLocaleString()} rated` : "",
    ].filter(Boolean).join(" · ");
    grid.dataset.count = String(folderSweep.samples.length);
    requestAnimationFrame(() => fitGridRows(grid));
    grid.replaceChildren(...folderSweep.samples.map((item) => cleanupTile(item, {
      marked: false,
      onToggle: (it) => openCleanupViewer(it, { isMarked: () => false, onToggle: null }),
      onOpen: (it) => openCleanupViewer(it, { isMarked: () => false, onToggle: null }),
      observer: folderSweep.observer,
    })));
    el("dfoldersDelete").querySelector("span").textContent = "Delete folder";
  } else {
    grid.replaceChildren();
  }
  el("dfoldersProgress").textContent = group
    ? `Folder ${(folderSweep.index + 1).toLocaleString()} of ${folderSweep.list.length.toLocaleString()}`
    : "All done";
  syncFolderActions();
  syncDrawerSummaries();
}

function syncFolderActions() {
  const button = el("dfoldersDelete");
  if (!button) return;
  const group = currentFolder();
  button.disabled = cleanup.busy || !group || !state.canTrash;
  el("dfoldersKeep").disabled = cleanup.busy || !group;
  el("dfoldersSkip").disabled = cleanup.busy || !group;
  el("dfoldersMore").disabled = cleanup.busy || !group;
  el("dfoldersToGrid").disabled = cleanup.busy || !group;
  el("dfoldersUndo").disabled = cleanup.busy || !cleanup.history.some((entry) => entry.mode === "dfolders");
  el("dfoldersReadOnly").hidden = state.canTrash !== false;
}

async function deleteFolder() {
  const group = currentFolder();
  if (!group || cleanup.busy) return;
  const rated = group.items.filter((item) => item.rating).length;
  const where = group.folder || "the library root";
  const warning = rated ? ` ${plural(rated, "of them is", "of them are")} rated.` : "";
  if (!window.confirm(`Delete all ${plural(group.items.length, "file", "files")} in “${where}” (${formatBytes(group.bytes)})?${warning} They go to the trash; Undo brings them back until you empty it.`)) return;
  cleanup.busy = true;
  syncFolderActions();
  const button = el("dfoldersDelete").querySelector("span");
  try {
    const result = await cleanupDelete(group.items, (done, total) => {
      button.textContent = `Deleting ${done.toLocaleString()} of ${total.toLocaleString()}…`;
    });
    cleanup.history.push({ mode: "dfolders", trashed: result.trashed, kept: [], group, groupIndex: folderSweep.index, library: result.library });
    folderSweep.list.splice(folderSweep.index, 1);
    if (result.failed.length) toast(`${plural(result.failed.length, "file", "files")} could not be deleted: ${result.failed[0].error}`, 8000);
    else toast(`Moved ${plural(result.trashed.length, "file", "files")} (${formatBytes(result.bytes)}) to the trash.`);
    pickFolderSamples();
  } catch (error) {
    if (!(error instanceof LockedError)) toast(error.message || "Could not delete the folder.");
    // Whatever did move is out of the library; show what is left.
    buildFolderSweep();
  } finally {
    cleanup.busy = false;
    renderFolders();
  }
}

async function keepFolder() {
  const group = currentFolder();
  if (!group || cleanup.busy) return;
  cleanup.busy = true;
  syncFolderActions();
  try {
    const fresh = group.items.filter((item) => !keptHere(item));
    await cleanupKeep(fresh);
    cleanup.history.push({ mode: "dfolders", trashed: [], kept: fresh, group, groupIndex: folderSweep.index, library: state.currentMediaDirectory });
    folderSweep.list.splice(folderSweep.index, 1);
    pickFolderSamples();
  } catch (error) {
    if (!(error instanceof LockedError)) toast(error.message);
  } finally {
    cleanup.busy = false;
    renderFolders();
  }
}

function skipFolder() {
  if (cleanup.busy || !currentFolder()) return;
  folderSweep.index += 1;
  pickFolderSamples();
  renderFolders();
}

async function undoFolder() {
  const entry = await cleanupUndo("dfolders");
  if (!entry) return;
  folderSweep.index = clampNumber(entry.groupIndex, 0, folderSweep.list.length);
  folderSweep.list.splice(folderSweep.index, 0, entry.group);
  pickFolderSamples();
  renderFolders();
}

function folderToGrid() {
  const group = currentFolder();
  if (!group) return;
  state.settings.dgridFolders = [group.folder];
  state.folderCleared.dgrid = false;
  sweepState("dgrid").built = false;
  renderFolderFilter("dgrid");
  queueSettingsSave();
  setMode("dgrid");
}

registerMode("dfolders", {
  enter: async () => {
    syncSettingControls(el("dfoldersDrawer"));
    renderCleanupMeters();
    await ensureKeptLoaded();
    if (state.currentMode !== "dfolders") return;
    if (!folderSweep.built || folderSweep.library !== state.currentMediaDirectory) {
      buildFolderSweep();
    } else {
      // Deleted elsewhere since: recount what is left of each folder.
      const known = new Set([...(state.library.images || []), ...(state.library.videos || [])].map((item) => item.path));
      folderSweep.list = folderSweep.list
        .map((group) => {
          const items = group.items.filter((item) => known.has(item.path));
          return { ...group, items, bytes: items.reduce((sum, item) => sum + (item.size || 0), 0) };
        })
        .filter((group) => group.items.length);
      folderSweep.samples = folderSweep.samples.filter((item) => known.has(item.path));
      if (!folderSweep.samples.length) pickFolderSamples();
    }
    renderFolders();
  },
  quiet: () => closeCleanupViewer(),
  refresh: () => {
    syncSettingControls(el("dfoldersDrawer"));
    folderSweep.built = false;
    if (state.currentMode === "dfolders") MODE_HANDLERS.dfolders.enter();
  },
  next: skipFolder,
  key: (key, lower) => {
    if (viewerKey(key, lower)) return true;
    if (lower === "k") return keepFolder(), true;
    if (lower === "s" || key === "ArrowDown") return skipFolder(), true;
    if (lower === "u") return undoFolder(), true;
    if (lower === "m") return pickFolderSamples(), renderFolders(), true;
    if (lower === "g") return folderToGrid(), true;
    return false;
  },
});

/* ---- Swipe: frame strip, speed, Blitz ---- */

const frames = { token: 0, video: null };

// Six stills across a clip under the card: see what is in it without
// watching, and jump to any of them.
async function renderFrameStrip(item) {
  const strip = el("dangerousFrames");
  strip.classList.remove("is-failed");
  frames.token += 1;
  const token = frames.token;
  if (frames.video) {
    frames.video.removeAttribute("src");
    frames.video.load();
    frames.video = null;
  }
  const show = item?.kind === "video" && state.settings.dangerousFrames !== false && state.currentMode === "dangerous";
  strip.hidden = !show;
  if (!show) {
    strip.replaceChildren();
    return;
  }
  const buttons = Array.from({ length: 6 }, (_, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "frame-cell";
    button.disabled = true;
    button.setAttribute("aria-label", `Jump to part ${index + 1} of 6`);
    return button;
  });
  strip.replaceChildren(...buttons);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  frames.video = video;
  const once = (type, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    video.addEventListener(type, () => { clearTimeout(timer); resolve(); }, { once: true });
    video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("error")); }, { once: true });
  });
  try {
    video.src = mediaUrl(item.path);
    await once("loadedmetadata", 15000);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration) throw new Error("no duration");
    for (const [index, button] of buttons.entries()) {
      const at = (duration * (index + 0.5)) / 6;
      video.currentTime = at;
      await once("seeked", 10000);
      if (token !== frames.token || state.currentMode !== "dangerous") return;
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = Math.max(1, Math.round((160 * (video.videoHeight || 9)) / (video.videoWidth || 16)));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const time = document.createElement("span");
      time.textContent = formatClock(at);
      button.replaceChildren(canvas, time);
      button.disabled = false;
      button.addEventListener("click", () => {
        const main = el("dangerousVideo");
        try {
          main.currentTime = at;
        } catch {
          return;
        }
        main.muted = !state.audioUnlocked;
        main.play().catch(() => {});
      });
    }
  } catch {
    if (token === frames.token) strip.classList.add("is-failed");
  } finally {
    if (token === frames.token) {
      video.removeAttribute("src");
      video.load();
      frames.video = null;
    }
  }
}

const SPEEDS = [1, 1.5, 2];
let swipeSpeed = 1;

function cycleSwipeSpeed() {
  swipeSpeed = SPEEDS[(SPEEDS.indexOf(swipeSpeed) + 1) % SPEEDS.length];
  applySwipeSpeed();
}

function applySwipeSpeed() {
  const video = el("dangerousVideo");
  video.defaultPlaybackRate = swipeSpeed;
  video.playbackRate = swipeSpeed;
  el("dangerousSpeed").textContent = `${swipeSpeed}×`;
  el("dangerousSpeed").setAttribute("aria-label", `Playback speed ${swipeSpeed} times`);
}

const blitz = { running: false, endsAt: 0, timer: 0, count: 0, freed: 0, seconds: 60 };

function toggleBlitz() {
  if (blitz.running) endBlitz(true);
  else startBlitz();
}

function startBlitz() {
  if (state.currentMode !== "dangerous" || !dangerous.items[dangerous.index]) return;
  blitz.seconds = Number(state.settings.blitzSeconds) || 60;
  Object.assign(blitz, { running: true, endsAt: Date.now() + blitz.seconds * 1000, count: 0, freed: 0 });
  el("dangerousBlitzButton").classList.add("active");
  el("dangerousBlitzButton").querySelector(".label").textContent = "Stop";
  el("dangerousBlitz").hidden = false;
  blitz.timer = setInterval(tickBlitz, 200);
  tickBlitz();
}

function tickBlitz() {
  if (!blitz.running) return;
  if (state.currentMode !== "dangerous" || document.hidden) {
    endBlitz(true);
    return;
  }
  const left = Math.max(0, blitz.endsAt - Date.now());
  el("dangerousBlitz").textContent = `${formatClock(Math.ceil(left / 1000))} · ${plural(blitz.count, "file", "files")} · ${formatBytes(blitz.freed)}`;
  el("dangerousBlitz").classList.toggle("is-ending", left < 10000);
  if (!left) endBlitz(false);
}

function endBlitz(stopped) {
  if (!blitz.running) return;
  blitz.running = false;
  clearInterval(blitz.timer);
  el("dangerousBlitz").hidden = true;
  el("dangerousBlitzButton").classList.remove("active");
  el("dangerousBlitzButton").querySelector(".label").textContent = "Blitz";
  if (stopped) {
    toast(`Blitz stopped: ${plural(blitz.count, "file", "files")}, ${formatBytes(blitz.freed)} freed.`);
    return;
  }
  const best = Number(state.settings.blitzBest) || 0;
  const record = blitz.count > best;
  if (record) {
    state.settings.blitzBest = blitz.count;
    queueSettingsSave();
  }
  toast(`Blitz over: ${plural(blitz.count, "file", "files")} in ${blitz.seconds}s, ${formatBytes(blitz.freed)} freed.${record ? " New best!" : ` Best: ${best}.`}`, 9000);
}

/* ---- wiring ---- */

function bindCleanup() {
  ["dgrid", "djunk"].forEach((mode) => {
    el(`${mode}Commit`).addEventListener("click", () => commitSweep(mode));
    el(`${mode}Skip`).addEventListener("click", () => skipSweepPage(mode));
    el(`${mode}MarkAll`).addEventListener("click", () => markWholePage(mode));
    el(`${mode}Undo`).addEventListener("click", () => undoSweep(mode));
  });
  el("dsimilarCommit").addEventListener("click", () => commitSet());
  el("dsimilarKeepAll").addEventListener("click", () => commitSet(true));
  el("dsimilarSkip").addEventListener("click", skipSet);
  el("dsimilarUndo").addEventListener("click", undoSet);
  el("dsimilarScanToggle").addEventListener("click", toggleScan);
  el("dsimilarScanShow").addEventListener("click", () => {
    flushPrints();
    buildSimilarSets();
  });
  el("dfoldersDelete").addEventListener("click", deleteFolder);
  el("dfoldersKeep").addEventListener("click", keepFolder);
  el("dfoldersSkip").addEventListener("click", skipFolder);
  el("dfoldersUndo").addEventListener("click", undoFolder);
  el("dfoldersMore").addEventListener("click", () => { pickFolderSamples(); renderFolders(); });
  el("dfoldersToGrid").addEventListener("click", folderToGrid);
  el("cleanupViewerClose").addEventListener("click", closeCleanupViewer);
  el("cleanupViewer").addEventListener("click", (event) => {
    if (event.target === el("cleanupViewer")) closeCleanupViewer();
  });
  el("cleanupViewerMark").addEventListener("click", () => {
    if (!viewer.onToggle) return;
    viewer.onToggle(viewer.item);
    syncViewerMark();
  });

  // Swipe's new controls.
  el("dangerousLove").addEventListener("click", () => actDangerous("love"));
  el("dangerousBlitzButton").addEventListener("click", toggleBlitz);
  el("dangerousSpeed").addEventListener("click", cycleSwipeSpeed);
  el("dangerousVideo").addEventListener("loadedmetadata", applySwipeSpeed);

  // Every Dangerous drawer is described in its markup (data-setting).
  const onChange = (mode) => (key) => {
    if (key === "cleanupGoalGb") {
      renderCleanupMeters();
      CLEANUP_DRAWERS.forEach((other) => syncSettingControls(el(`${other}Drawer`)));
      return;
    }
    if (mode === "dangerous") {
      if (key === "dangerousOrder") startDangerous(true);
      else renderDangerous();
      syncDrawerSummaries();
      return;
    }
    if (key === "dsimilarStrictness") {
      similar.built = false;
      if (state.currentMode === "dsimilar") buildSimilarSets();
      return;
    }
    invalidateMediaPools();
    refreshMode(mode);
  };
  CLEANUP_DRAWERS.forEach((mode) => bindSettingControls(el(`${mode}Drawer`), onChange(mode)));
  syncSettingControls(el("dangerousDrawer"));
  renderCleanupMeters();
}

const CLEANUP_DRAWERS = ["dangerous", "dgrid", "djunk", "dsimilar", "dfolders"];

document.addEventListener("DOMContentLoaded", bindCleanup);
