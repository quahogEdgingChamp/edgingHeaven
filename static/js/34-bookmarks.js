/* ==========================================================================
   Bookmarks — your SimpCity bookmarks, with previews

   Every bookmarked model thread, as `simp bookmarks --save` last read them
   (Refresh from SimpCity runs that as a download job). A model you already
   have shows three of its own photos, loved and kept first, and what you
   kept of it; one you don't shows three small pictures simp saved from its
   thread. All pictures come from this server, never from SimpCity itself.
   ========================================================================== */

const BOOKMARK_BATCH = 48;
const bookmarkPage = { data: null, loading: null, error: "", filter: "all", search: "", shown: BOOKMARK_BATCH,
  timer: 0, searchTimer: 0, signature: "" };

MODE_CARDS.push({
  mode: "bookmarks",
  name: "Bookmarks",
  blurb: "Your SimpCity bookmarks with previews, and which models you already have.",
  icon: "M7 4h10v16l-5-4-5 4z",
  stat: () => {
    if (!state.features.has("bookmarks")) return "needs server update";
    const count = bookmarkPage.data?.bookmarks?.length;
    return count ? plural(count, "model", "models") : "SimpCity";
  },
});

registerMode("bookmarks", {
  enter() {
    enterBookmarks();
  },
  quiet() {
    window.clearTimeout(bookmarkPage.timer);
  },
  // The library changed (a download finished and rescanned): who is in it.
  refresh() {
    if (state.currentMode === "bookmarks") renderBookmarks(true);
  },
});

async function loadBookmarks() {
  if (!state.features.has("bookmarks")) return null;
  bookmarkPage.loading ||= fetchJson("/api/simp/bookmarks")
    .then((data) => {
      bookmarkPage.data = data;
      bookmarkPage.error = "";
      return data;
    })
    .catch((error) => {
      if (!error.locked) bookmarkPage.error = error.message;
      return bookmarkPage.data;
    })
    .finally(() => {
      bookmarkPage.loading = null;
    });
  return bookmarkPage.loading;
}

function bookmarkRefreshJob() {
  return (downloads.status?.jobs || []).find((job) => job.action === "bookmarks-sync" && ["queued", "running"].includes(job.status));
}

async function enterBookmarks() {
  window.clearTimeout(bookmarkPage.timer);
  renderBookmarks();
  await Promise.all([loadBookmarks(), loadDownloadStatus()]);
  if (state.currentMode !== "bookmarks") return;
  renderBookmarks();
  if (bookmarkRefreshJob()) followBookmarkRefresh();
}

// While a refresh runs, simp saves the list every ten models: show it grow.
function followBookmarkRefresh() {
  window.clearTimeout(bookmarkPage.timer);
  bookmarkPage.timer = window.setTimeout(async () => {
    if (state.currentMode !== "bookmarks") return;
    if (!document.hidden && !state.panic && !state.locked) {
      await Promise.all([loadDownloadStatus(), loadBookmarks()]);
      if (state.currentMode !== "bookmarks") return;
      renderBookmarks();
    }
    if (bookmarkRefreshJob() || document.hidden) followBookmarkRefresh();
  }, 4000);
}

// Top-level folder → what the library holds of that model.
function libraryModels() {
  const models = new Map();
  const add = (item, isPhoto) => {
    const model = (item.folder || "").split("/")[0];
    if (!model) return;
    const entry = models.get(model) || { files: 0, kept: 0, photos: [] };
    entry.files += 1;
    entry.kept += isKept(item) ? 1 : 0;
    if (isPhoto) entry.photos.push(item);
    models.set(model, entry);
  };
  (state.library.images || []).forEach((item) => add(item, true));
  (state.library.videos || []).forEach((item) => add(item, false));
  return models;
}

// Three photos of a model you have: loved, then kept, then spread across the rest.
function libraryPreviewPhotos(photos, count = 3) {
  const kept = photos.filter(isKept).sort((a, b) => (b.rating === "love") - (a.rating === "love"));
  const picks = kept.slice(0, count);
  const rest = photos.filter((item) => !isKept(item));
  for (let step = 0; picks.length < count && step < count; step += 1) {
    const item = rest[Math.floor((step * rest.length) / count)];
    if (item && !picks.includes(item)) picks.push(item);
  }
  return picks;
}

function bookmarkRows(models) {
  const rows = bookmarkPage.data?.bookmarks || [];
  const needle = bookmarkPage.search.trim().toLowerCase();
  return rows.filter((row) => {
    const have = models.has(row.model);
    if (bookmarkPage.filter === "missing" && have) return false;
    if (bookmarkPage.filter === "have" && !have) return false;
    return !needle || row.title.toLowerCase().includes(needle) || row.model.toLowerCase().includes(needle);
  });
}

function renderBookmarks(force = false) {
  const status = downloads.status;
  const notice = !state.features.has("bookmarks")
    ? "Bookmarks need the updated server. Restart edging-heaven.service to turn them on."
    : !status || !status.installed || !status.configured ? downloadNotice(status) : bookmarkPage.error;
  el("bmNotice").textContent = notice;
  el("bmNotice").hidden = !notice;

  const data = bookmarkPage.data;
  const models = libraryModels();
  const all = data?.bookmarks || [];
  const have = all.filter((row) => models.has(row.model)).length;
  const refreshing = bookmarkRefreshJob();
  const usable = !!(status?.installed && status?.configured && state.features.has("bookmarks"));

  el("bmStats").hidden = !all.length;
  el("bmStats").replaceChildren(...[
    { value: all.length.toLocaleString(), label: "bookmarked models" },
    { value: have.toLocaleString(), label: "in your library", tone: "keep" },
    { value: (all.length - have).toLocaleString(), label: "not downloaded yet" },
  ].map((tile) => {
    const box = document.createElement("div");
    box.className = `ranked-stat${tile.tone ? ` is-${tile.tone}` : ""}`;
    box.innerHTML = "<strong></strong><span></span>";
    box.querySelector("strong").textContent = tile.value;
    box.querySelector("span").textContent = tile.label;
    return box;
  }));

  el("bmRefresh").disabled = !usable || !!refreshing;
  setButtonLabel(el("bmRefresh"), refreshing ? "Refreshing…" : "Refresh from SimpCity", "i-refresh");
  const missing = all.filter((row) => !models.has(row.model) && row.url);
  el("bmDownloadMissing").hidden = !usable || !missing.length || bookmarkPage.filter === "have";
  el("bmDownloadMissing").textContent = `Download the rest (${missing.length.toLocaleString()})`;
  el("bmMeta").textContent = [
    data?.updatedAt ? `From SimpCity ${downloadWhen(data.updatedAt)}.` : "",
    data?.updatedAt && !data.complete && !refreshing ? "The last refresh stopped early, so some bookmarks may be missing." : "",
    refreshing ? `Reading your bookmarks from SimpCity (${DOWNLOAD_STATUS[refreshing.status].toLowerCase()}). The list fills in as it goes; follow it in Downloads.` : "",
  ].filter(Boolean).join(" ");

  const rows = bookmarkRows(models);
  el("bmEmpty").hidden = rows.length > 0 || !state.features.has("bookmarks");
  el("bmEmpty").textContent = all.length
    ? "No bookmark matches."
    : "No bookmarks yet. Refresh from SimpCity reads your bookmark list and saves three pictures of each model you don't have yet. The first time takes about 10–15 minutes.";

  // Only rebuild the grid when what it shows changed: rebuilding reloads every picture.
  const signature = [data?.updatedAt, all.length, bookmarkPage.filter, bookmarkPage.search, bookmarkPage.shown, have, state.library.updatedAt].join("|");
  if (!force && signature === bookmarkPage.signature && el("bmGrid").childElementCount) return;
  bookmarkPage.signature = signature;
  el("bmGrid").replaceChildren(...rows.slice(0, bookmarkPage.shown).map((row) => bookmarkCard(row, models.get(row.model))));
  el("bmMore").hidden = rows.length <= bookmarkPage.shown;
}

function bookmarkCard(row, info) {
  const card = document.createElement("article");
  card.className = `bm-card${info ? " is-have" : ""}`;

  const strip = document.createElement("div");
  strip.className = "bm-previews";
  const sources = info ? libraryPreviewPhotos(info.photos).map((item) => mediaUrl(item.path)) : row.previews;
  sources.slice(0, 3).forEach((source) => {
    const image = document.createElement("img");
    image.loading = "lazy";
    image.decoding = "async";
    image.alt = "";
    image.src = source;
    image.addEventListener("error", () => image.remove(), { once: true });
    strip.append(image);
  });
  if (!sources.length) {
    const empty = document.createElement("span");
    empty.className = "bm-no-preview";
    empty.textContent = info ? "Videos only" : "No preview";
    strip.append(empty);
  }

  const body = document.createElement("div");
  body.className = "bm-body";
  const title = document.createElement("strong");
  title.className = "bm-title";
  title.textContent = row.title;
  const meta = document.createElement("span");
  meta.className = "subtle";
  const name = row.title.toLowerCase().replace(/[^a-z0-9]/g, "") === row.model.toLowerCase().replace(/[^a-z0-9]/g, "") ? "" : row.model;
  meta.textContent = [name, info ? `In library · ${plural(info.files, "file", "files")} · ${info.kept.toLocaleString()} kept` : "Not downloaded yet"]
    .filter(Boolean).join(" · ");
  const actions = document.createElement("div");
  actions.className = "bm-actions";
  if (row.url) {
    actions.append(downloadButton(info ? "New posts" : "Download", () =>
      submitDownload({ action: "thread", urls: [row.url] }, info ? `Checking ${row.title} for new posts. Follow it in Downloads.` : `Queued: ${row.title}. Follow it in Downloads.`),
      info ? "ghost-button small-button" : "primary-button small-button"));
  }
  if (info) {
    actions.append(downloadButton("Open", () => {
      setMode("ranked");
      openModelPage(row.model);
    }));
  }
  // Remove… for a model there is something of: files, or the downloader's records.
  if (modelResetSupported() && (info || (downloads.status?.threads || []).some((thread) => thread.model === row.model))) {
    actions.append(downloadButton("Remove…", () => openModelReset(row.model), "text-button bm-remove"));
  }
  if (row.url) {
    const link = document.createElement("a");
    link.className = "text-button bm-link";
    link.href = row.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "SimpCity";
    actions.append(link);
  }
  body.append(title, meta, actions);
  card.append(strip, body);
  return card;
}

async function refreshBookmarkList() {
  const job = await submitDownload({ action: "bookmarks-sync" },
    "Reading your bookmarks from SimpCity. The first time takes about 10–15 minutes.");
  if (job) {
    renderBookmarks();
    followBookmarkRefresh();
  }
}

async function downloadMissingBookmarks() {
  const models = libraryModels();
  const urls = (bookmarkPage.data?.bookmarks || []).filter((row) => !models.has(row.model) && row.url).map((row) => row.url);
  if (!urls.length) return;
  if (!window.confirm(`Download all ${plural(urls.length, "bookmarked model", "bookmarked models")} you don't have yet? That can take many hours and a lot of space on the drive.`)) return;
  // simp takes up to 20 threads per job, one after another.
  for (let start = 0; start < urls.length; start += 20) {
    if (!(await submitDownload({ action: "thread", urls: urls.slice(start, start + 20) },
      `Queued ${plural(urls.length, "model", "models")}. Follow them in Downloads.`))) break;
  }
}

function bindBookmarks() {
  syncSegmented(el("bmFilter"), "bmFilter", bookmarkPage.filter);
  bindSegmented(el("bmFilter"), "bmFilter", (value) => {
    bookmarkPage.filter = value;
    bookmarkPage.shown = BOOKMARK_BATCH;
    syncSegmented(el("bmFilter"), "bmFilter", value);
    renderBookmarks();
  });
  el("bmSearch").addEventListener("input", (event) => {
    window.clearTimeout(bookmarkPage.searchTimer);
    bookmarkPage.searchTimer = window.setTimeout(() => {
      bookmarkPage.search = event.target.value;
      bookmarkPage.shown = BOOKMARK_BATCH;
      renderBookmarks();
    }, 150);
  });
  el("bmMore").addEventListener("click", () => {
    bookmarkPage.shown += BOOKMARK_BATCH;
    renderBookmarks();
  });
  el("bmRefresh").addEventListener("click", refreshBookmarkList);
  el("bmDownloadMissing").addEventListener("click", downloadMissingBookmarks);
}
