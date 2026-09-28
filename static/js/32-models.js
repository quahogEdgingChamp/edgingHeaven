/* ==========================================================================
   Collection, continued — a page per model, and your session history

   A model page is Collection narrowed to one top-level folder: what is in
   it, what you kept and loved, its best files by Duel rank, and one tap into
   Spotlight, Duel, Ladder or the Gallery with exactly that model.

   Session history is every Session, Beat, Red light, Dice, Ladder and
   Spotlight run of a minute or more, as the server logged it.
   ========================================================================== */

const MODEL_GRID_SIZE = 36;

function modelItems(model) {
  return [
    ...(state.library.images || []).map((item) => ({ ...item, kind: "photo" })),
    ...(state.library.videos || []).map((item) => ({ ...item, kind: "video" })),
  ].filter((item) => inModel(item, model));
}

function modelFolders(model) {
  return (state.library.folders || []).filter((folder) => (model ? folder === model || folder.startsWith(`${model}/`) : !folder));
}

function openModelPage(model) {
  state.ranked.model = model;
  renderRanked();
  el("rankedScroller").scrollTo(0, 0);
}

function closeModelPage() {
  state.ranked.model = null;
  renderRanked();
}

async function renderModelPage(model) {
  el("rankedOverview").hidden = true;
  el("rankedModelPage").hidden = false;
  const items = modelItems(model);
  el("modelName").textContent = folderLabel(model);

  if (!duel.ratings) {
    loadDuelRatings().then(() => state.currentMode === "ranked" && state.ranked.model === model && renderModelPage(model));
  }
  if (!seenState.loaded) {
    loadSeen().then(() => state.currentMode === "ranked" && state.ranked.model === model && renderModelPage(model));
  }

  const kept = items.filter(isKept);
  const loved = items.filter((item) => item.rating === "love").length;
  const videos = items.filter((item) => item.kind === "video").length;
  const seen = items.filter((item) => seenAt(item.path)).length;
  const ranked = items.filter((item) => duelRating(item.path).n).length;
  const moments = items.reduce((sum, item) => sum + (marksFor(item.path)?.length || 0), 0);
  const tiles = [
    { value: items.length.toLocaleString(), label: `files · ${(items.length - videos).toLocaleString()} photos, ${videos.toLocaleString()} videos` },
    { value: kept.length.toLocaleString(), label: `kept · ${items.length ? formatPercent(kept.length / items.length) : "--"} of this model`, tone: "keep" },
    { value: loved.toLocaleString(), label: "loved", tone: "love" },
    { value: items.length ? formatPercent(seen / items.length) : "--", label: "looked at" },
    { value: ranked.toLocaleString(), label: "duel-ranked" },
  ];
  if (moments) tiles.push({ value: moments.toLocaleString(), label: "marked moments" });
  el("modelStats").replaceChildren(...tiles.map((tile) => {
    const box = document.createElement("div");
    box.className = `ranked-stat${tile.tone ? ` is-${tile.tone}` : ""}`;
    box.innerHTML = "<strong></strong><span></span>";
    box.querySelector("strong").textContent = tile.value;
    box.querySelector("span").textContent = tile.label;
    return box;
  }));

  // Sub-folders: where this model's files live, and what you kept from each.
  const counts = new Map();
  items.forEach((item) => {
    const folder = item.folder || "";
    const row = counts.get(folder) || { folder, total: 0, kept: 0 };
    row.total += 1;
    row.kept += isKept(item) ? 1 : 0;
    counts.set(folder, row);
  });
  const subs = [...counts.values()].sort((a, b) => b.kept - a.kept || b.total - a.total);
  el("modelFolders").hidden = subs.length < 2;
  el("modelFolderList").replaceChildren(...subs.map((row) => {
    const entry = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = row.folder === model ? "Loose files" : row.folder.slice(model.length + 1) || folderLabel(row.folder);
    const meta = document.createElement("b");
    meta.textContent = `${row.kept.toLocaleString()} kept / ${row.total.toLocaleString()}`;
    entry.append(name, meta);
    return entry;
  }));

  // Best of: duel rank first, then loved, then newest kept.
  const stamp = (item) => Date.parse(item.ratedAt) || 0;
  const best = (kept.length ? kept : items).slice().sort((a, b) => {
    const ra = duelRating(a.path);
    const rb = duelRating(b.path);
    return (rb.n ? rb.r : 0) - (ra.n ? ra.r : 0) || (b.rating === "love") - (a.rating === "love") || stamp(b) - stamp(a);
  }).slice(0, MODEL_GRID_SIZE);
  el("modelGridTitle").textContent = kept.length ? (ranked ? "Best by duel rank" : "What you kept") : "Everything here";
  state.gallery.items = best;
  const grid = el("modelGrid");
  grid.querySelectorAll("video").forEach(releaseVideo);
  state.ranked.observer?.disconnect();
  state.ranked.observer = videoTileObserver(el("rankedScroller"));
  grid.replaceChildren(...best.map((item, index) => buildGalleryTile(item, index)));
  grid.querySelectorAll(".gallery-tile.is-video").forEach((tile) => state.ranked.observer.observe(tile));
  if (state.gallery.sizeObserver) state.gallery.sizeObserver.observe(grid);
  syncGalleryTileSizeFor(grid);

  el("modelDuel").disabled = items.length < 2;
  el("modelLadder").disabled = kept.length < 2;
  syncModelUpdate(model);
}

function modelModeWith(mode, model, filter) {
  state.settings[`${mode}Folders`] = modelFolders(model);
  state.folderCleared[mode] = false;
  if (filter) state.settings[`${mode}RatingFilter`] = filter;
  invalidateMediaPools();
  renderFolderFilter(mode);
  syncRatingFilter(mode);
  queueSettingsSave();
  setMode(mode);
}

function bindModelPage() {
  el("modelSpotlight").addEventListener("click", () => playModelInSpotlight(state.ranked.model));
  el("modelGallery").addEventListener("click", () => {
    const model = state.ranked.model;
    state.settings.galleryRatingFilter = "all";
    modelModeWith("gallery", model);
    renderGallery(true);
  });
  el("modelDuel").addEventListener("click", () => {
    const model = state.ranked.model;
    const kept = modelItems(model).filter(isKept).length;
    modelModeWith("duel", model, kept >= 2 ? "liked" : "all");
  });
  el("modelLadder").addEventListener("click", () => modelModeWith("ladder", state.ranked.model, "liked"));
}

/* ---- session history ---- */

const SESSION_MODE_NAMES = { session: "Session", beat: "Beat", redlight: "Red light", dice: "Dice", escalation: "Escalation", ladder: "Ladder", spotlight: "Spotlight", highlights: "Highlights" };

async function loadSessionHistory() {
  if (!state.features.has("sessions")) return [];
  sessionHistory ||= fetchJson("/api/sessions").then((payload) => payload.sessions || []).catch(() => []);
  return sessionHistory;
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// Consecutive days, up to today (or yesterday: today is not over yet),
// with at least one session.
function sessionStreak(sessions) {
  const days = new Set(sessions.map((entry) => dayKey(new Date(entry.endedAt))));
  const cursor = new Date();
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

async function renderSessionHistory() {
  const section = el("sessionHistory");
  const sessions = await loadSessionHistory();
  if (state.currentMode !== "ranked" || state.ranked.model != null) return;
  section.hidden = !sessions.length;
  if (!sessions.length) return;

  const monthAgo = Date.now() - 30 * 86400000;
  const recent = sessions.filter((entry) => Date.parse(entry.endedAt) >= monthAgo);
  const minutes = recent.reduce((sum, entry) => sum + entry.seconds, 0) / 60;
  const longest = sessions.reduce((best, entry) => (entry.seconds > best.seconds ? entry : best), sessions[0]);
  const withEdges = recent.filter((entry) => entry.edges > 0);
  const tiles = [
    { value: recent.length.toLocaleString(), label: "sessions in 30 days" },
    { value: `${Math.round(minutes).toLocaleString()} min`, label: "in 30 days" },
    { value: formatClock(longest.seconds), label: `longest · ${SESSION_MODE_NAMES[longest.mode] || longest.mode}` },
    { value: `${sessionStreak(sessions)}`, label: "day streak" },
    { value: withEdges.length ? (withEdges.reduce((sum, entry) => sum + entry.edges, 0) / withEdges.length).toFixed(1) : "--", label: "edges per session" },
  ];
  el("sessionStats").replaceChildren(...tiles.map((tile) => {
    const box = document.createElement("div");
    box.className = "ranked-stat";
    box.innerHTML = "<strong></strong><span></span>";
    box.querySelector("strong").textContent = tile.value;
    box.querySelector("span").textContent = tile.label;
    return box;
  }));

  // Minutes per day, 30 days, the same chart as Kept per day.
  const chart = el("sessionChart");
  const days = [];
  const index = new Map();
  const today = new Date();
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    index.set(dayKey(date), days.length);
    days.push({ date, minutes: 0 });
  }
  recent.forEach((entry) => {
    const slot = index.get(dayKey(new Date(entry.endedAt)));
    if (slot !== undefined) days[slot].minutes += entry.seconds / 60;
  });
  const peak = Math.max(1, ...days.map((day) => day.minutes));
  const label = (date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  chart.setAttribute("aria-label", `Minutes per day for the last 30 days, ${Math.round(minutes)} in total.`);
  const top = document.createElement("span");
  top.className = "peak";
  top.textContent = `${Math.round(peak)} min`;
  const tip = document.createElement("span");
  tip.className = "ranked-activity-tip";
  chart.replaceChildren(top, ...days.map((day) => {
    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.height = `${(day.minutes / peak) * 100}%`;
    bar.append(fill);
    bar.addEventListener("pointerenter", () => {
      tip.textContent = `${label(day.date)} · ${Math.round(day.minutes)} min`;
      bar.append(tip);
    });
    bar.addEventListener("pointerleave", () => tip.remove());
    return bar;
  }));

  el("sessionRecent").replaceChildren(...sessions.slice(-8).reverse().map((entry) => {
    const row = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = SESSION_MODE_NAMES[entry.mode] || entry.mode;
    const when = document.createElement("span");
    when.className = "subtle";
    when.textContent = new Date(entry.endedAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const what = document.createElement("span");
    what.className = "session-row-meta";
    what.textContent = [formatClock(entry.seconds), entry.edges ? plural(entry.edges, "edge", "edges") : "", entry.ending === "deny" ? "denied" : entry.ending === "finish" ? "finished" : ""].filter(Boolean).join(" · ");
    row.append(name, when, what);
    return row;
  }));
}

async function clearSessionHistory() {
  if (!window.confirm("Forget every logged session? Ratings, keeps and duels are not touched.")) return;
  try {
    await postJson("/api/sessions-clear", {});
    sessionHistory = null;
    renderSessionHistory();
    toast("Session history cleared.");
  } catch (error) {
    toast(error.message);
  }
}
