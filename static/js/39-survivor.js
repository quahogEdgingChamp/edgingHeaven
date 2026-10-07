/* ==========================================================================
   Survivor (Dangerous) — Duel where the loser goes

   Two files from one folder: tap the one that stays, and the other goes to
   the trash. The files with the fewest wins are paired first, so everyone
   fights once before anyone fights twice, like the rounds of a knockout. It
   ends when the folder is down to the size you chose (half, a third, a
   quarter, or a fixed number), and the survivors can be kept, or kept with
   the top three Loved. Loved files sit out unless that is switched off.

   Nothing is erased here: a loser moves into .heaven-trash like every
   Dangerous delete, and Undo brings it back.
   ========================================================================== */

const survivor = {
  arena: [], wins: new Map(), start: 0, target: 0, freed: 0, pair: [], lastPair: "",
  busy: false, built: false, signature: "", settled: false, observer: null,
};
const SURVIVOR_SHARES = { half: 1 / 2, third: 1 / 3, quarter: 1 / 4 };

Object.assign(PLAY_SETTING_CHOICES, {
  survivorKind: ["photos", "videos", "all"],
  survivorTarget: ["half", "third", "quarter", 10, 25, 50],
});
PLAY_SETTING_SWITCHES.push("survivorLovedSafe");

registerModeUI("survivor", {
  card: {
    name: "Survivor",
    blurb: "Two files from one folder: tap the one that stays, the other goes to the trash. Until only the best are left.",
    icon: "M4 18h16M5 18 3.5 8l4.5 3.5L12 5l4 6.5L20.5 8 19 18",
    stat: () => (survivor.built && survivor.arena.length > survivor.target ? `${survivor.arena.length.toLocaleString()} left` : "loser goes"),
  },
  summary: () => {
    const folder = survivorFolderName();
    if (folder === null) return "Survivor needs a folder with at least two files of this kind.";
    const count = survivor.built ? survivor.arena.length : survivorItems(folder).length;
    const target = survivor.built ? survivor.target : survivorTarget(count);
    const kind = { photos: "photos", videos: "clips", all: "files" }[state.settings.survivorKind] || "files";
    const safe = state.settings.survivorLovedSafe !== false ? " Loved files sit out." : "";
    return `${folderLabel(folder) || "Library root"}: ${plural(count, kind.replace(/s$/, ""), kind)} fight until ${target.toLocaleString()} ${target === 1 ? "is" : "are"} left.${safe}`;
  },
  defaults: { survivorFolder: "", survivorKind: "photos", survivorTarget: "half", survivorLovedSafe: true, cleanupGoalGb: 0 },
});
MODE_SETTING_KEYS.survivor.push(...THRILL_KEYS);

/* ---- who fights ---- */

function survivorCandidates() {
  const kind = state.settings.survivorKind || "photos";
  const safe = state.settings.survivorLovedSafe !== false;
  const items = [];
  if (kind !== "videos") (state.library.images || []).forEach((item) => items.push({ ...item, kind: "photo" }));
  if (kind !== "photos") (state.library.videos || []).forEach((item) => items.push({ ...item, kind: "video" }));
  return safe ? items.filter((item) => item.rating !== "love") : items;
}

function survivorItems(folder) {
  return survivorCandidates().filter((item) => inModel(item, folder));
}

// Every folder (models and the folders inside them) with how many files of
// the chosen kind it holds, a model first and its own folders under it.
function survivorFolderList() {
  const counts = new Map();
  survivorCandidates().forEach((item) => {
    const parts = (item.folder || "").split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const key = parts.slice(0, depth).join("/");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });
  const rows = [...counts].filter(([, count]) => count >= 2).map(([folder, count]) => ({ folder, count, model: folder.split("/")[0] }));
  const modelSize = new Map(rows.filter((row) => !row.folder.includes("/")).map((row) => [row.model, row.count]));
  return rows.sort((a, b) => (modelSize.get(b.model) || 0) - (modelSize.get(a.model) || 0)
    || a.model.localeCompare(b.model)
    || (a.folder.includes("/") ? 1 : 0) - (b.folder.includes("/") ? 1 : 0)
    || b.count - a.count
    || a.folder.localeCompare(b.folder));
}

// The chosen folder, or the biggest model when none is chosen (or it is gone).
function survivorFolderName() {
  const list = survivorFolderList();
  const chosen = typeof state.settings.survivorFolder === "string" ? state.settings.survivorFolder : "";
  if (chosen && list.some((row) => row.folder === chosen)) return chosen;
  const models = list.filter((row) => !row.folder.includes("/"));
  return models.length ? models.sort((a, b) => b.count - a.count)[0].folder : null;
}

function survivorTarget(count) {
  const setting = state.settings.survivorTarget;
  const share = SURVIVOR_SHARES[setting];
  return share ? Math.max(1, Math.ceil(count * share)) : Math.min(count, Number(setting) || 25);
}

function survivorSignature(folder) {
  return [state.currentMediaDirectory, folder, state.settings.survivorKind, state.settings.survivorTarget, state.settings.survivorLovedSafe !== false].join("|");
}

function buildSurvivor() {
  const folder = survivorFolderName();
  const items = folder === null ? [] : survivorItems(folder);
  shuffleArray(items);
  Object.assign(survivor, {
    arena: items, wins: new Map(), start: items.length, target: survivorTarget(items.length), freed: 0,
    pair: [], lastPair: "", built: true, settled: false, signature: survivorSignature(folder),
  });
}

function winsOf(item) {
  return survivor.wins.get(item.path) || 0;
}

function survivorFighting() {
  return survivor.arena.length > survivor.target && survivor.arena.length >= 2;
}

// Photos fight photos and clips fight clips. Among them, the files with the
// fewest wins, so a round finishes before the next begins.
function pickSurvivorPair() {
  if (!survivorFighting()) return [];
  let pool = survivor.arena;
  if (state.settings.survivorKind === "all") {
    const groups = [pool.filter((item) => item.kind === "photo"), pool.filter((item) => item.kind === "video")].filter((group) => group.length >= 2);
    if (groups.length) {
      const total = groups.reduce((sum, group) => sum + group.length, 0);
      pool = Math.random() * total < groups[0].length ? groups[0] : groups[groups.length - 1];
    }
  }
  const low = Math.min(...pool.map(winsOf));
  const tier = pool.filter((item) => winsOf(item) === low);
  const first = randomOf(tier);
  const rest = pool.filter((item) => item !== first);
  const restLow = Math.min(...rest.map(winsOf));
  let options = rest.filter((item) => winsOf(item) === restLow);
  // Not the same two again straight after a New pair.
  const fresh = options.filter((item) => [first.path, item.path].sort().join("\n") !== survivor.lastPair);
  if (fresh.length) options = fresh;
  const second = randomOf(options);
  survivor.lastPair = [first.path, second.path].sort().join("\n");
  return Math.random() < 0.5 ? [first, second] : [second, first];
}

function nextSurvivorPair() {
  survivor.pair = pickSurvivorPair();
  survivor.pair.forEach((item) => markSeen(item.path));
  renderSurvivor();
}

/* ---- the arena ---- */

function survivorSides() {
  return [el("survivorLeft"), el("survivorRight")];
}

function renderSurvivor() {
  if (state.currentMode !== "survivor") return;
  const fighting = survivorFighting() && survivor.pair.length === 2;
  const done = survivor.built && survivor.start > survivor.target && !survivorFighting();
  el("survivorArena").hidden = !fighting;
  el("survivorActions").hidden = !fighting;
  el("survivorDone").hidden = !done;
  el("survivorEmpty").hidden = fighting || done;
  syncSurvivorHead();
  survivorSides().forEach((side, index) => {
    const item = survivor.pair[index];
    const image = side.querySelector("img");
    const video = side.querySelector("video");
    side.classList.remove("won", "lost", "is-champ");
    if (!fighting || !item) {
      releaseVideo(video);
      image.removeAttribute("src");
      return;
    }
    const isVideo = item.kind === "video";
    image.hidden = isVideo;
    video.hidden = !isVideo;
    if (isVideo) {
      image.removeAttribute("src");
      video.muted = true;
      const token = loadVideoSource(video, item);
      video.addEventListener("loadedmetadata", () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        playWhenReady(video, token, clipStart(item.path, duration, duration > 6 ? duration * (0.2 + Math.random() * 0.5) : 0));
      }, { once: true });
    } else {
      releaseVideo(video);
      image.dataset.path = item.path;
      image.src = mediaUrl(item.path);
    }
    const wins = winsOf(item);
    // The one file with the most wins (from two up); a tie has no champion.
    const best = Math.max(...survivor.arena.map(winsOf));
    const champ = wins >= 2 && wins === best && survivor.arena.filter((other) => winsOf(other) === best).length === 1;
    side.classList.toggle("is-champ", champ);
    side.querySelector(".duel-caption strong").textContent = item.name;
    side.querySelector(".duel-caption small").textContent = [
      champ ? `Champion · ${plural(wins, "win", "wins")}` : wins ? plural(wins, "win", "wins") : "first fight",
      formatSize(item.size || 0),
      item.rating === "like" ? "liked" : item.rating === "love" ? "loved" : "",
    ].filter(Boolean).join(" · ");
    side.title = item.path;
    side.setAttribute("aria-label", `Keep ${item.name}; the other goes to the trash`);
  });
  if (done) renderSurvivorDone();
  else if (!fighting) syncSurvivorEmpty();
  syncSurvivorActions();
  syncDrawerSummaries();
}

function syncSurvivorHead() {
  const folder = survivorFolderName();
  const [model, ...rest] = (folder ?? "").split("/");
  el("survivorModel").textContent = folder === null ? "" : model || "Library root";
  el("survivorWhere").textContent = rest.length ? rest.join(" / ") : folder === null ? "" : "Everything in this model";
  const left = survivor.arena.length;
  const toGo = Math.max(0, left - survivor.target);
  const span = Math.max(1, survivor.start - survivor.target);
  const round = left ? Math.min(...survivor.arena.map(winsOf)) + 1 : 1;
  el("survivorStatus").textContent = !survivor.built || survivor.start <= survivor.target
    ? ""
    : toGo
      ? `Round ${round} · ${left.toLocaleString()} left, down to ${survivor.target.toLocaleString()} · ${plural(toGo, "fight", "fights")} to go`
      : `${plural(left, "survivor", "survivors")} of ${survivor.start.toLocaleString()}`;
  el("survivorBar").style.setProperty("--fill", `${Math.round(((survivor.start - left) / span) * 100)}%`);
  el("survivorBar").hidden = !survivor.built || survivor.start <= survivor.target;
  el("survivorProgress").textContent = survivor.built && survivor.start > survivor.target ? `${left.toLocaleString()} → ${survivor.target.toLocaleString()}` : "";
}

function syncSurvivorEmpty() {
  const folder = survivorFolderName();
  const count = survivor.arena.length;
  el("survivorEmptyTitle").textContent = folder === null ? "Nothing to fight." : "Already small enough.";
  el("survivorEmptyText").textContent = folder === null
    ? "Survivor needs a folder with at least two files of the chosen kind. Change Media under Adjust, or switch off Loved files sit out."
    : `${folderLabel(folder) || "This folder"} has ${plural(count, "file", "files")} in the fight, which is already at your target. Pick a bigger folder or a smaller target under Adjust.`;
}

function syncSurvivorActions() {
  const busy = survivor.busy || cleanup.busy;
  const fighting = survivorFighting() && survivor.pair.length === 2;
  survivorSides().forEach((side) => (side.disabled = busy || !fighting || !state.canTrash));
  el("survivorBothGo").disabled = busy || !fighting || !state.canTrash || survivor.arena.length - 2 < survivor.target;
  el("survivorSkip").disabled = busy || !fighting;
  el("survivorBothStay").disabled = busy || !fighting;
  el("survivorUndo").disabled = busy || !cleanup.history.some((entry) => entry.mode === "survivor");
  el("survivorReadOnly").hidden = state.canTrash !== false;
  const done = !el("survivorDone").hidden;
  ["survivorKeepAll", "survivorKeepLove", "survivorCutAgain"].forEach((id) => (el(id).disabled = busy || !done));
  el("survivorKeepAll").hidden = el("survivorKeepLove").hidden = survivor.settled;
  el("survivorCutAgain").disabled ||= nextCutTarget() >= survivor.arena.length;
}

const survivorWait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

// Deletes `losers` (one, or both with Both go) and moves the rest a round on.
async function survivorFight(losers, winners) {
  if (survivor.busy || cleanup.busy || survivor.pair.length < 2 || state.currentMode !== "survivor") return;
  if (losers.length && !state.canTrash) {
    toast("This drive is read-only. Nothing was deleted.");
    return;
  }
  survivor.busy = true;
  syncSurvivorActions();
  const sides = survivorSides();
  const pair = [...survivor.pair];
  pair.forEach((item, index) => sides[index].classList.add(losers.includes(item) ? "lost" : "won"));
  thrillBurn(pair.map((item, index) => (losers.includes(item) ? sides[index] : null)));
  const settle = survivorWait(REDUCED_MOTION.matches ? 0 : 480);
  let saved = false;
  try {
    const result = losers.length ? await cleanupDelete(losers) : { trashed: [], failed: [], bytes: 0, library: state.currentMediaDirectory };
    if (losers.length && !result.trashed.length) throw new Error(result.failed[0]?.error || "Could not delete that file.");
    const winsBefore = Object.fromEntries(winners.map((item) => [item.path, winsOf(item)]));
    winners.forEach((item) => survivor.wins.set(item.path, winsOf(item) + 1));
    const gone = new Set(result.trashed.map((entry) => entry.item.path));
    survivor.arena = survivor.arena.filter((item) => !gone.has(item.path));
    survivor.freed += result.bytes || 0;
    cleanup.history.push({ mode: "survivor", trashed: result.trashed, kept: [], pair, winsBefore, bytes: result.bytes || 0, bothStay: !losers.length, library: result.library });
    // Both stay is a keep for the toy and the sounds, not a saved keep.
    if (!losers.length) thrillCount("keep", 0, 2);
    saved = true;
  } catch (error) {
    if (!(error instanceof LockedError)) toast(error.message || "Could not delete. Both are still here.");
  }
  await settle;
  survivor.busy = false;
  if (saved) nextSurvivorPair();
  else renderSurvivor();
}

function survivorPick(index) {
  const pair = survivor.pair;
  if (pair.length < 2) return;
  survivorFight([pair[1 - index]], [pair[index]]);
}

function survivorSkip() {
  if (survivor.busy || cleanup.busy || !survivorFighting()) return;
  nextSurvivorPair();
}

async function undoSurvivor() {
  if (survivor.busy) return;
  const entry = await cleanupUndo("survivor");
  if (!entry) return;
  const known = new Set([...(state.library.images || []), ...(state.library.videos || [])].map((item) => item.path));
  const present = new Set(survivor.arena.map((item) => item.path));
  survivor.arena.push(...entry.pair.filter((item) => known.has(item.path) && !present.has(item.path)));
  Object.entries(entry.winsBefore || {}).forEach(([path, wins]) => (wins ? survivor.wins.set(path, wins) : survivor.wins.delete(path)));
  survivor.freed = Math.max(0, survivor.freed - (entry.bytes || 0));
  if (entry.bothStay) thrillCount("unkeep", 0, 2);
  for (const { path, previous, item } of entry.loved || []) {
    try {
      await postJson("/api/rating", { path, rating: previous });
      recordRating(path, previous, item);
    } catch (error) {
      toast(error.message);
    }
  }
  if (entry.settle) survivor.settled = false;
  survivor.pair = entry.pair.length === 2 && entry.pair.every((item) => survivor.arena.some((a) => a.path === item.path)) ? entry.pair : pickSurvivorPair();
  renderSurvivor();
}

/* ---- the end: who survived ---- */

function survivorsByWins() {
  return [...survivor.arena].sort((a, b) => winsOf(b) - winsOf(a) || (b.size || 0) - (a.size || 0));
}

function renderSurvivorDone() {
  const list = survivorsByWins();
  const deleted = survivor.start - list.length;
  el("survivorDoneTitle").textContent = survivor.settled ? "Survivors kept." : `${plural(list.length, "survivor", "survivors")}.`;
  el("survivorDoneText").textContent = survivor.settled
    ? "They will not come up again in the other Dangerous modes while Hide kept is on. Cut again, or pick another folder under Adjust."
    : `${plural(deleted, "file", "files")} lost and went to the trash${survivor.freed ? `, ${formatBytes(survivor.freed)} freed` : ""}. Keep the survivors so the other Dangerous modes skip them, or cut again.`;
  el("survivorKeepAll").querySelector("span").textContent = `Keep all ${list.length.toLocaleString()}`;
  el("survivorCutAgain").querySelector("span").textContent = `Cut to ${nextCutTarget().toLocaleString()}`;
  const grid = el("survivorGrid");
  survivor.observer?.disconnect();
  survivor.observer = videoTileObserver(null);
  grid.querySelectorAll("video").forEach(releaseVideo);
  const shown = list.slice(0, PHONE.matches ? 6 : 20);
  grid.dataset.count = String(shown.length);
  grid.replaceChildren(...shown.map((item, index) => cleanupTile(item, {
    marked: false,
    // Champion only when one file won more than every other.
    badges: index < 3 && winsOf(item) ? [index === 0 && winsOf(item) > winsOf(list[1] || {}) ? `Champion · ${plural(winsOf(item), "win", "wins")}` : plural(winsOf(item), "win", "wins")] : [],
    onToggle: (it) => openCleanupViewer(it, { isMarked: () => false, onToggle: null }),
    onOpen: (it) => openCleanupViewer(it, { isMarked: () => false, onToggle: null }),
    observer: survivor.observer,
  })));
  requestAnimationFrame(() => fitGridRows(grid));
  playTileClips(grid, shown);
  el("survivorMore").textContent = list.length > shown.length ? `and ${plural(list.length - shown.length, "more", "more")}` : "";
}

// A fraction cuts by that fraction again; a fixed number halves what is left.
function nextCutTarget() {
  const count = survivor.arena.length;
  return SURVIVOR_SHARES[state.settings.survivorTarget] ? survivorTarget(count) : Math.max(1, Math.ceil(count / 2));
}

async function keepSurvivors(love) {
  if (survivor.busy || cleanup.busy) return;
  survivor.busy = true;
  syncSurvivorActions();
  const list = survivorsByWins();
  const loved = [];
  try {
    await cleanupKeep(list);
    if (love) {
      for (const item of list.slice(0, 3)) {
        if (item.rating === "love") continue;
        const previous = item.rating ?? null;
        await postJson("/api/rating", { path: item.path, rating: "love" });
        recordRating(item.path, "love", item);
        loved.push({ path: item.path, previous, item });
      }
    }
    cleanup.history.push({ mode: "survivor", trashed: [], kept: list, pair: [], winsBefore: {}, loved, settle: true, library: state.currentMediaDirectory });
    survivor.settled = true;
    const context = thrillAudio();
    if (context) arpeggio([523, 659, 784, 1047, 1319], context.currentTime, 0.08, 0.14);
    buzz([40, 30, 40, 30, 90]);
    if (loved.length) toast(`Kept ${plural(list.length, "survivor", "survivors")} and Loved the top ${loved.length}.`);
  } catch (error) {
    if (!(error instanceof LockedError)) toast(error.message);
  } finally {
    survivor.busy = false;
    renderSurvivor();
  }
}

function cutAgain() {
  const target = nextCutTarget();
  if (survivor.busy || target >= survivor.arena.length) return;
  Object.assign(survivor, { start: survivor.arena.length, target, wins: new Map(), freed: 0, settled: false, lastPair: "" });
  nextSurvivorPair();
}

/* ---- control center: the folder list ---- */

function renderSurvivorFolderSelect() {
  const select = el("survivorFolder");
  const current = survivorFolderName();
  const rows = survivorFolderList();
  select.replaceChildren(...rows.map((row) => {
    const option = document.createElement("option");
    option.value = row.folder;
    const depth = row.folder ? row.folder.split("/").length - 1 : 0;
    const name = row.folder ? row.folder.split("/").pop() : "Library root";
    option.textContent = `${depth ? `${"  ".repeat(depth)}↳ ` : ""}${name} · ${row.count.toLocaleString()}`;
    option.selected = row.folder === current;
    return option;
  }));
  select.disabled = !rows.length;
}

function enterSurvivor() {
  syncSettingControls(el("survivorDrawer"));
  renderCleanupMeters();
  renderSurvivorFolderSelect();
  const folder = survivorFolderName();
  if (!survivor.built || survivor.signature !== survivorSignature(folder)) {
    buildSurvivor();
  } else {
    // Deleted or Loved elsewhere since: out of the fight.
    const still = new Set(survivorItems(folder).map((item) => item.path));
    survivor.arena = survivor.arena.filter((item) => still.has(item.path));
    survivor.pair = survivor.pair.filter((item) => still.has(item.path));
  }
  if (survivor.pair.length === 2) renderSurvivor();
  else nextSurvivorPair();
}

registerMode("survivor", {
  enter: enterSurvivor,
  quiet: () => closeCleanupViewer(),
  refresh: () => {
    syncSettingControls(el("survivorDrawer"));
    survivor.built = false;
    if (state.currentMode === "survivor") enterSurvivor();
  },
  next: survivorSkip,
  key: (key, lower) => {
    if (viewerKey(key, lower)) return true;
    if (focusOwnsKey(key)) return false;
    const fighting = survivorFighting() && survivor.pair.length === 2;
    if (key === "ArrowLeft" && fighting) return survivorPick(0), true;
    if (key === "ArrowRight" && fighting) return survivorPick(1), true;
    if (key === "ArrowUp" && fighting) return survivorFight([], [...survivor.pair]), true;
    if ((key === "ArrowDown" || lower === "s") && fighting) return survivorSkip(), true;
    if (lower === "x" && fighting && !el("survivorBothGo").disabled) return survivorFight([...survivor.pair], []), true;
    if (lower === "u") return undoSurvivor(), true;
    return false;
  },
});

document.addEventListener("DOMContentLoaded", () => {
  survivorSides().forEach((side, index) => side.addEventListener("click", () => survivorPick(index)));
  el("survivorBothGo").addEventListener("click", () => survivorFight([...survivor.pair], []));
  el("survivorBothStay").addEventListener("click", () => survivorFight([], [...survivor.pair]));
  el("survivorSkip").addEventListener("click", survivorSkip);
  el("survivorUndo").addEventListener("click", undoSurvivor);
  el("survivorKeepAll").addEventListener("click", () => keepSurvivors(false));
  el("survivorKeepLove").addEventListener("click", () => keepSurvivors(true));
  el("survivorCutAgain").addEventListener("click", cutAgain);
  el("survivorHeadButton").addEventListener("click", () => toggleDrawer("survivor"));
  el("survivorNewRun").addEventListener("click", () => {
    survivor.built = false;
    closeDrawers();
    enterSurvivor();
  });
  el("survivorFolder").addEventListener("change", (event) => {
    state.settings.survivorFolder = event.target.value;
    queueSettingsSave();
    enterSurvivor();
  });
});
