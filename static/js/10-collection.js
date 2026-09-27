/* ==========================================================================
   Ranked — what you actually keep

   Every other mode looks forward: here is something new, yes or no. This one
   looks back. It answers "which folders am I actually into" with the only
   honest signal the app has -- the keep rate, not the file count -- and puts
   everything you kept in one grid.
   ========================================================================== */

const RANKED_PAGE_SIZE = 120;

function rankedPool() {
  const kind = state.settings.rankedKind || "all";
  const pool = [];
  if (kind !== "videos") {
    pool.push(...(state.library.images || []).map((item) => ({ ...item, kind: "photo" })));
  }
  if (kind !== "photos") {
    pool.push(...(state.library.videos || []).map((item) => ({ ...item, kind: "video" })));
  }
  return pool;
}

function rankedKeeps() {
  const items = rankedPool().filter(isKept);
  const sort = state.settings.rankedSort || "recent";
  const stamp = (item) => (item.ratedAt ? Date.parse(item.ratedAt) || 0 : 0);

  if (sort === "recent") {
    // Anything rated before the app recorded times has no stamp; it sorts to
    // the back rather than pretending to be from 1970.
    items.sort((a, b) => stamp(b) - stamp(a) || a.path.localeCompare(b.path));
  } else if (sort === "oldest") {
    items.sort((a, b) => {
      const left = stamp(a) || Infinity;
      const right = stamp(b) || Infinity;
      return left - right || a.path.localeCompare(b.path);
    });
  } else if (sort === "largest") {
    items.sort((a, b) => (b.size || 0) - (a.size || 0));
  } else if (sort === "duel") {
    // Ranked first, by Elo; never-dueled files after, newest kept first.
    const score = (item) => (duel.ratings?.[item.path]?.n ? duel.ratings[item.path].r : -Infinity);
    items.sort((a, b) => score(b) - score(a) || stamp(b) - stamp(a));
  } else if (sort === "loved") {
    items.sort((a, b) => (b.rating === "love") - (a.rating === "love") || stamp(b) - stamp(a));
  } else if (sort === "folder") {
    items.sort((a, b) => a.path.localeCompare(b.path));
  } else {
    items.sort((a, b) => a.name.localeCompare(b.name));
  }
  return items;
}

// One row per model: a top-level folder and everything under it, so a
// model's download folders ("Loose Files (Bunkr)") count together.
function rankedModelRows() {
  const rows = new Map();
  for (const key of ["images", "videos"]) {
    for (const item of state.library[key] || []) {
      const folder = item.folder || "";
      const model = folder.split("/")[0];
      let row = rows.get(model);
      if (!row) {
        row = { model, total: 0, liked: 0, loved: 0, disliked: 0, subs: new Map() };
        rows.set(model, row);
      }
      row.total += 1;
      if (isKept(item)) {
        row.liked += 1;
        row.loved += item.rating === "love" ? 1 : 0;
        row.subs.set(folder, (row.subs.get(folder) || 0) + 1);
      } else if (item.rating === "dislike") {
        row.disliked += 1;
      }
    }
  }
  // Ranked by how much you kept; nearly everything rated is a keep, so a
  // keep rate would put every model at 100%.
  return [...rows.values()]
    .filter((row) => row.liked > 0)
    .sort((a, b) => b.liked - a.liked || b.total - a.total || a.model.localeCompare(b.model));
}

function formatPercent(fraction) {
  const value = fraction * 100;
  if (value > 0 && value < 1) return "<1%";
  return `${value < 10 && value % 1 ? value.toFixed(1) : Math.round(value)}%`;
}

function formatBytes(bytes) {
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024 ** 2) return `${(mb / 1024 ** 2).toFixed(2)} TB`;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function renderRanked() {
  if (state.settings.rankedSort === "duel" && !duel.ratings) {
    loadDuelRatings().then(() => state.currentMode === "ranked" && renderRanked());
  }
  renderFavoriteLaunchers(controls.rankedPlay, "Play what you kept");
  if (state.ranked.model !== undefined && state.ranked.model !== null) {
    renderModelPage(state.ranked.model);
    return;
  }
  el("rankedOverview").hidden = false;
  el("rankedModelPage").hidden = true;
  renderRankedStats();
  renderRankedActivity();
  renderSessionHistory();
  renderRankedFolders();
  renderRankedKeeps();
  syncSegmented(controls.rankedKind, "rankedKind", state.settings.rankedKind);
  controls.rankedSort.value = state.settings.rankedSort;
}

function renderRankedStats() {
  const photos = state.library.images || [];
  const videos = state.library.videos || [];
  const all = [...photos, ...videos];
  const kept = all.filter(isKept);
  const keptPhotos = photos.filter(isKept).length;
  const loved = all.filter((item) => item.rating === "love").length;
  const disliked = all.filter((item) => item.rating === "dislike").length;
  const weekAgo = Date.now() - 7 * 86400000;
  const thisWeek = kept.filter((item) => (Date.parse(item.ratedAt) || 0) >= weekAgo).length;
  const keptBytes = kept.reduce((sum, item) => sum + (item.size || 0), 0);

  if (!seenState.loaded) loadSeen().then(() => state.currentMode === "ranked" && renderRankedStats());
  const seen = all.filter((item) => seenAt(item.path)).length;

  const tiles = [
    { value: kept.length.toLocaleString(), label: `kept · ${keptPhotos.toLocaleString()} photos, ${(kept.length - keptPhotos).toLocaleString()} videos`, tone: "keep" },
    { value: loved.toLocaleString(), label: "loved — your top tier", tone: "love" },
    { value: thisWeek.toLocaleString(), label: "kept in the last 7 days", tone: "" },
    { value: formatBytes(keptBytes), label: "of files kept", tone: "" },
    { value: all.length ? formatPercent(seen / all.length) : "--", label: `of the library looked at (${seen.toLocaleString()} of ${all.length.toLocaleString()})`, tone: "" },
  ];
  // Passing only means something once you actually pass on things.
  if (disliked) {
    tiles.push({ value: disliked.toLocaleString(), label: "passed", tone: "pass" });
    tiles.push({ value: formatPercent(kept.length / (kept.length + disliked)), label: "keep rate", tone: "" });
  }

  controls.rankedStats.innerHTML = "";
  tiles.forEach((tile) => {
    const box = document.createElement("div");
    box.className = `ranked-stat${tile.tone ? ` is-${tile.tone}` : ""}`;
    const value = document.createElement("strong");
    value.textContent = tile.value;
    const label = document.createElement("span");
    label.textContent = tile.label;
    box.append(value, label);
    controls.rankedStats.appendChild(box);
  });
}

// Keeps per day over the last 30 days, from each keep's timestamp.
function renderRankedActivity() {
  const DAYS = 30;
  const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const days = [];
  const index = new Map();
  const today = new Date();
  for (let offset = DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    index.set(dayKey(date), days.length);
    days.push({ date, count: 0 });
  }
  for (const key of ["images", "videos"]) {
    for (const item of state.library[key] || []) {
      if (!isKept(item) || !item.ratedAt) continue;
      const slot = index.get(dayKey(new Date(item.ratedAt)));
      if (slot !== undefined) days[slot].count += 1;
    }
  }
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const section = document.getElementById("rankedActivity");
  section.hidden = !total;
  if (!total) return;

  const peak = days.reduce((best, day) => (day.count > best.count ? day : best), days[0]);
  const activeDays = days.filter((day) => day.count).length;
  const label = (date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  document.getElementById("rankedActivityNote").textContent =
    `${total.toLocaleString()} in 30 days · ${activeDays} active day${activeDays === 1 ? "" : "s"} · best ${label(peak.date)} (${peak.count})`;

  const chart = document.getElementById("rankedActivityChart");
  chart.replaceChildren();
  chart.setAttribute("aria-label", `Kept per day for the last 30 days: ${total} in total, most on ${label(peak.date)} with ${peak.count}.`);
  const top = document.createElement("span");
  top.className = "peak";
  top.textContent = String(peak.count);
  chart.append(top);
  const tip = document.createElement("span");
  tip.className = "ranked-activity-tip";
  days.forEach((day) => {
    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.height = `${(day.count / peak.count) * 100}%`;
    bar.append(fill);
    // The hover target is the whole column, not just the (maybe tiny) bar.
    bar.addEventListener("pointerenter", () => {
      tip.textContent = `${label(day.date)} · ${day.count} kept`;
      bar.append(tip);
    });
    bar.addEventListener("pointerleave", () => tip.remove());
    chart.append(bar);
  });
  let axis = chart.nextElementSibling;
  if (!axis?.classList.contains("ranked-activity-axis")) {
    axis = document.createElement("div");
    axis.className = "ranked-activity-axis";
    chart.after(axis);
  }
  axis.replaceChildren(...[label(days[0].date), "today"].map((text) => Object.assign(document.createElement("span"), { textContent: text })));

  document.getElementById("rankedActivityRows").replaceChildren(...days.filter((day) => day.count).reverse().map((day) => {
    const row = document.createElement("tr");
    row.innerHTML = "<td></td><td></td>";
    row.cells[0].textContent = label(day.date);
    row.cells[1].textContent = String(day.count);
    return row;
  }));
}

function renderRankedFolders() {
  const rows = rankedModelRows();
  controls.rankedFolders.innerHTML = "";

  if (!rows.length) {
    controls.rankedFolderNote.textContent = "Keep a few things and this fills in.";
    return;
  }
  controls.rankedFolderNote.textContent = `${rows.length} model${rows.length === 1 ? "" : "s"} with keeps`;
  const most = rows[0].liked;
  const shown = state.ranked.allModels ? rows : rows.slice(0, 12);
  const more = el("rankedModelsMore");
  more.hidden = rows.length <= 12;
  more.textContent = state.ranked.allModels ? "Show the top 12" : `Show all ${rows.length} models`;

  shown.forEach((row, index) => {
    const entry = document.createElement("li");
    entry.className = "ranked-folder";

    const rank = document.createElement("span");
    rank.className = "ranked-rank";
    rank.textContent = String(index + 1);

    const body = document.createElement("div");
    body.className = "ranked-folder-body";

    // The name opens the model's own page.
    const name = document.createElement("button");
    name.type = "button";
    name.className = "ranked-model-link";
    name.textContent = folderLabel(row.model);
    name.addEventListener("click", () => openModelPage(row.model));

    // Bars compare models with each other: the leader fills the row.
    const bar = document.createElement("div");
    bar.className = "ranked-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(2, (row.liked / most) * 100)}%`;
    bar.appendChild(fill);

    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = `${row.liked.toLocaleString()} kept${row.loved ? ` · ${row.loved.toLocaleString()} loved` : ""} · ${formatPercent(row.liked / row.total)} of ${row.total.toLocaleString()} files`;

    body.append(name, bar, meta);
    if (row.subs.size > 1) {
      const subs = document.createElement("span");
      subs.className = "ranked-subs";
      subs.textContent = "Most from: " + [...row.subs]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([folder, count]) => `${folder === row.model ? "loose files" : folder.slice(row.model.length + 1)} ${count}`)
        .join(" · ");
      subs.title = [...row.subs].sort((a, b) => b[1] - a[1]).map(([folder, count]) => `${folderLabel(folder)}: ${count}`).join("\n");
      body.append(subs);
    }

    // Jumping straight into a folder you like is the whole point of a
    // leaderboard, so a row is a shortcut into the gallery filtered to it.
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "ghost-button small-button";
    jump.textContent = "Browse";
    jump.addEventListener("click", () => {
      state.settings.galleryFolders = (state.library.folders || []).filter((folder) =>
        row.model ? folder === row.model || folder.startsWith(`${row.model}/`) : !folder);
      state.folderCleared.gallery = false;
      state.settings.galleryRatingFilter = "all";
      invalidateMediaPools();
      renderFolderFilter("gallery");
      syncSegmented(controls.galleryRatingFilter, "ratingFilter", "all");
      queueSettingsSave();
      setMode("gallery");
      renderGallery(true);
    });

    entry.append(rank, body, jump);
    controls.rankedFolders.appendChild(entry);
  });
}

function renderRankedKeeps() {
  const items = rankedKeeps();
  // The lightbox reads state.gallery.items, so point it at this list while
  // Ranked is what is on screen.
  state.gallery.items = items;
  state.gallery.page = 0;

  controls.rankedGrid.querySelectorAll("video").forEach(releaseVideo);
  controls.rankedGrid.innerHTML = "";
  controls.rankedEmpty.hidden = items.length > 0;

  if (!items.length) {
    controls.rankedEmpty.textContent =
      "Nothing kept yet. Rate some photos in Photo deck or clips in Video deck and they land here.";
    return;
  }

  state.ranked.observer?.disconnect();
  state.ranked.observer = videoTileObserver(controls.rankedScroller);

  const slice = items.slice(0, RANKED_PAGE_SIZE);
  const fragment = document.createDocumentFragment();
  slice.forEach((item, index) => fragment.appendChild(buildGalleryTile(item, index)));
  controls.rankedGrid.appendChild(fragment);
  controls.rankedGrid.querySelectorAll(".gallery-tile.is-video").forEach((tile) => {
    state.ranked.observer.observe(tile);
  });

  controls.rankedGrid.parentElement.querySelectorAll(".ranked-more").forEach((node) => node.remove());
  if (items.length > RANKED_PAGE_SIZE) {
    const more = document.createElement("p");
    more.className = "subtle ranked-empty ranked-more";
    more.textContent = `Showing the first ${RANKED_PAGE_SIZE.toLocaleString()} of ${items.length.toLocaleString()}. Narrow it with the sort and type filters.`;
    controls.rankedGrid.after(more);
  }
  observeGalleryTileSize();
  syncGalleryTileSizeFor(controls.rankedGrid);
}

function bindRankedEvents() {
  bindSegmented(controls.rankedKind, "rankedKind", (value) => {
    state.settings.rankedKind = value;
    renderRanked();
    queueSettingsSave();
  });

  controls.rankedSort.addEventListener("change", (event) => {
    state.settings.rankedSort = event.target.value;
    renderRanked();
    queueSettingsSave();
  });
  el("rankedModelsMore").addEventListener("click", () => {
    state.ranked.allModels = !state.ranked.allModels;
    renderRankedFolders();
  });
  el("modelBack").addEventListener("click", closeModelPage);
  bindModelPage();
  el("sessionHistoryClear").addEventListener("click", clearSessionHistory);
}

