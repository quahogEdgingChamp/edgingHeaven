/* ==========================================================================
   Bookmarks — your SimpCity bookmarks, with previews

   Every bookmarked model thread, as `simp bookmarks --save` last read them
   (Refresh from SimpCity runs that as a download job). A model you already
   have shows three of its own photos, loved and kept first, and what you
   kept of it; one you don't shows three small pictures simp saved from its
   thread. All pictures come from this server, never from SimpCity itself.
   Download takes the thread, as that model's download settings allow;
   Settings next to it edits them (thread pages, photos or videos, how many),
   on a server that keeps them, and a card says when a model has some.
   Twitter edits the model's Twitter / X account (43-twitter.js).

   This page is where every "what to download, from where" lives, in three
   tabs: Bookmarks (the cards), Per model (Settings per model, Twitter / X,
   known threads with New posts) and Add & login (thread links, pages of
   the bookmark list, the SimpCity login). The Downloads page only reports.
   ========================================================================== */

const BOOKMARK_BATCH = 48;
const bookmarkPage = { data: null, loading: null, error: "", filter: "all", search: "", shown: BOOKMARK_BATCH,
  timer: 0, searchTimer: 0, signature: "", tab: "list" };
const BOOKMARK_TABS = { list: "bmPanelList", models: "bmPanelModels", add: "bmPanelAdd" };

MODE_CARDS.push({
  mode: "bookmarks",
  name: "Bookmarks",
  blurb: "Your SimpCity bookmarks, and what to download for each model: SimpCity, Twitter / X.",
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
  if (downloadsActive()) followBookmarkRefresh();
}

// While jobs run, keep what this page shows current: a bookmark refresh
// saves the list every ten models (show it grow); a login check, a Twitter
// download or New posts change the login line, last downloads, known threads.
function followBookmarkRefresh() {
  window.clearTimeout(bookmarkPage.timer);
  bookmarkPage.timer = window.setTimeout(async () => {
    if (state.currentMode !== "bookmarks") return;
    if (!document.hidden && !state.locked) {
      const listing = bookmarkRefreshJob();
      await Promise.all([loadDownloadStatus(), listing ? loadBookmarks() : null]);
      if (state.currentMode !== "bookmarks") return;
      renderBookmarks();
    }
    if (downloadsActive() || bookmarkRefreshJob() || document.hidden) followBookmarkRefresh();
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
  renderModelSettings();

  const rows = bookmarkRows(models);
  el("bmEmpty").hidden = rows.length > 0 || !state.features.has("bookmarks");
  el("bmEmpty").textContent = all.length
    ? "No bookmark matches."
    : "No bookmarks yet. Refresh from SimpCity reads your bookmark list and saves three pictures of each model you don't have yet. The first time takes about 10–15 minutes.";

  // Only rebuild the grid when what it shows changed: rebuilding reloads every picture.
  const signature = [data?.updatedAt, all.length, bookmarkPage.filter, bookmarkPage.search, bookmarkPage.shown, have, state.library.updatedAt,
    modelRulesReady(), JSON.stringify(modelRulesReady() ? status?.rules || {} : {}),
    twitterReady(), JSON.stringify(twitterReady() ? status?.twitterAccounts || {} : {})].join("|");
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
  body.append(title, meta);
  // What the one-tap Download will take, when this model has settings.
  const brief = ruleBrief(modelRule(row.model));
  if (brief) {
    const rule = document.createElement("span");
    rule.className = "bm-rule";
    rule.textContent = `Downloads: ${brief}`;
    body.append(rule);
  }
  const account = twitterAccount(row.model);
  if (account) {
    const line = document.createElement("span");
    line.className = "bm-rule bm-twitter";
    line.textContent = `Twitter: ${twitterBrief(account)}`;
    body.append(line);
  }
  const actions = document.createElement("div");
  actions.className = "bm-actions";
  if (row.url) {
    actions.append(downloadButton(info ? "New posts" : "Download", () =>
      submitDownload({ action: "thread", urls: [row.url] }, info ? `Checking ${row.title} for new posts. Follow it in Downloads.` : `Queued: ${row.title}. Follow it in Downloads.`),
      info ? "ghost-button small-button" : "primary-button small-button"));
  }
  if (modelRulesReady()) {
    actions.append(ruleSettingsButton(row.model, row.title, () => openRuleDialog({
      title: row.title,
      target: { model: row.model, url: row.url || modelThreadUrl(row.model), byUrl: false },
      go: row.url ? () => submitDownload({ action: "thread", urls: [row.url] }, `Queued: ${row.title}. Follow it in Downloads.`) : null,
    })));
  }
  if (twitterReady()) {
    const twitterButton = downloadButton("Twitter", () => openTwitterSheet(row.model));
    twitterButton.dataset.twitterModel = row.model;
    twitterButton.setAttribute("aria-haspopup", "dialog");
    twitterButton.setAttribute("aria-label", `Twitter / X for ${row.title}`);
    actions.append(twitterButton);
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
  body.append(actions);
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

// Bookmarks / Per model / Add & login.
function showBookmarkTab(tab) {
  if (!BOOKMARK_TABS[tab]) return;
  bookmarkPage.tab = tab;
  el("bmTabs").querySelectorAll("[data-bm-tab]").forEach((button) => {
    const on = button.dataset.bmTab === tab;
    button.classList.toggle("active", on);
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
  });
  Object.entries(BOOKMARK_TABS).forEach(([name, id]) => { el(id).hidden = name !== tab; });
}

function bindBookmarks() {
  showBookmarkTab(bookmarkPage.tab);
  el("bmTabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-bm-tab]");
    if (button) showBookmarkTab(button.dataset.bmTab);
  });
  // Arrow keys move between the tabs (the tab pattern).
  el("bmTabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const names = Object.keys(BOOKMARK_TABS);
    const at = names.indexOf(bookmarkPage.tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? names.length - 1
      : (at + (event.key === "ArrowRight" ? 1 : names.length - 1)) % names.length;
    showBookmarkTab(names[next]);
    el("bmTabs").querySelector(`[data-bm-tab="${names[next]}"]`).focus();
  });
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
