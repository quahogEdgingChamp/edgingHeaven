/* ==========================================================================
   Downloads — simp, run by the server

   Paste SimpCity thread links, pull pages of your bookmarks, retry what
   failed, and check a model's thread for new posts (here, or with New posts
   on its model page). The server runs simp one job at a time (simpjobs.py);
   this page starts jobs, follows the running one's output and cancels.
   Finished jobs rescan the library, and the page's usual library check picks
   the new files up.

   Needs the server feature "simp"; until the server is restarted with it,
   the page says so and sends nothing.
   ========================================================================== */

const downloads = {
  status: null,
  error: "",
  timer: 0,
  loading: null,
  // The job whose output is shown; picked by hand, or the running/latest one.
  logJob: null,
  logPinned: false,
  logOffset: 0,
  logText: "",
  logDone: false,
};
const DOWNLOAD_LOG_TAIL = 64 * 1024;
const DOWNLOAD_LOG_KEEP = 200_000;
const DOWNLOAD_STATUS = {
  queued: "Waiting", running: "Running", done: "Done", failed: "Some failed", error: "Error",
  cancelled: "Cancelled", interrupted: "Interrupted", full: "Drive full", held: "Waiting for space",
};
// What the running (or last) job has added to the library so far, newest first.
const downloadArrivals = { job: null, count: -1, paths: [], signature: "", observer: null };
const ARRIVALS_SHOWN = 48;

MODE_CARDS.push({
  mode: "downloads",
  name: "Downloads",
  blurb: "New models and new posts from SimpCity, straight onto the drive.",
  icon: "M12 4v11M7 10l5 5 5-5M5 20h14",
  stat: () => {
    if (!state.features.has("simp")) return "needs server update";
    const jobs = downloads.status?.jobs || [];
    const running = jobs.find((job) => job.status === "running");
    const waiting = jobs.filter((job) => job.status === "queued").length;
    if (running) return waiting ? `downloading · ${waiting} waiting` : "downloading";
    const failed = downloads.status?.failed?.length || 0;
    return failed ? `${plural(failed, "model", "models")} to retry` : "SimpCity";
  },
});

registerMode("downloads", {
  enter() {
    downloadArrivals.signature = ""; // leaving released its pictures
    refreshDownloads();
  },
  quiet() {
    window.clearTimeout(downloads.timer);
    downloadArrivals.observer?.disconnect();
  },
  // New files merged into the library (see applyLibraryAdditions).
  refresh() {
    if (state.currentMode === "downloads" && downloads.status) renderDownloadArrivals(syncDownloadNow());
  },
});

function downloadsActive(status = downloads.status) {
  return (status?.jobs || []).some((job) => job.status === "running" || job.status === "queued");
}

async function loadDownloadStatus() {
  if (!state.features.has("simp")) return null;
  downloads.loading ||= fetchJson("/api/simp/status")
    .then((status) => {
      downloads.status = status;
      downloads.error = "";
      return status;
    })
    .catch((error) => {
      if (!error.locked) downloads.error = error.message;
      return downloads.status;
    })
    .finally(() => {
      downloads.loading = null;
    });
  return downloads.loading;
}

async function refreshDownloads() {
  window.clearTimeout(downloads.timer);
  await loadDownloadStatus();
  if (state.currentMode !== "downloads") return;
  renderDownloads();
  await followDownloadLog();
  await followDownloadArrivals(syncDownloadNow());
  // Quick while something runs, slow otherwise; never while hidden or locked.
  downloads.timer = window.setTimeout(() => {
    if (state.currentMode !== "downloads") return;
    if (document.hidden || state.panic || state.locked) {
      downloads.timer = window.setTimeout(() => refreshDownloads(), 2000);
      return;
    }
    refreshDownloads();
  }, downloadsActive() ? 2000 : 15000);
}

function downloadNotice(status) {
  if (!state.features.has("simp")) return "Downloads need the updated server. Restart edging-heaven.service to turn them on.";
  if (downloads.error) return downloads.error;
  if (!status) return "Loading…";
  if (!status.installed) return "simp is not installed on the server yet (scrprsimp/.venv). See deploy/EDGING-HEAVEN.md.";
  if (!status.configured) return "simp is not set up on the server yet: its config.toml is missing. See deploy/EDGING-HEAVEN.md.";
  if (!status.targetReady) return `The download folder ${status.target} is not there. Is the drive plugged in?`;
  return "";
}

function renderDownloads() {
  const status = downloads.status;
  const notice = downloadNotice(status);
  el("dlNotice").textContent = notice;
  el("dlNotice").hidden = !notice;
  const usable = !!(status?.installed && status?.configured && state.features.has("simp"));
  el("dlForms").hidden = !usable;
  el("dlStats").hidden = !usable;
  if (!status) {
    ["dlNow", "dlFailedSection", "dlThreadsSection"].forEach((id) => { el(id).hidden = true; });
    el("dlJobs").replaceChildren();
    el("dlJobsEmpty").hidden = !state.features.has("simp");
    return;
  }

  const jobs = status.jobs || [];
  const running = jobs.find((job) => job.status === "running");
  const waiting = jobs.filter((job) => job.status === "queued").length;
  const auth = status.auth || {};
  const tiles = [
    {
      value: auth.ok === true ? "Signed in" : auth.ok === false ? "Signed out" : status.cookies?.present ? "Unchecked" : "No cookies",
      label: auth.checkedAt ? `checked ${downloadWhen(auth.checkedAt)}` : "SimpCity login",
      tone: auth.ok === true ? "keep" : auth.ok === false ? "pass" : "",
    },
    { value: running ? "Running" : "Idle", label: waiting ? `${waiting} waiting` : "nothing waiting", tone: running ? "keep" : "" },
    { value: (status.failed?.length || 0).toLocaleString(), label: "models with failed files", tone: status.failed?.length ? "pass" : "" },
    {
      value: status.freeBytes == null ? "--" : formatBytes(status.freeBytes),
      label: status.reserveBytes ? `free on the drive · keeps ${formatBytes(status.reserveBytes)} spare` : "free on the drive",
      tone: status.reserveBytes && status.freeBytes != null && status.freeBytes < status.resumeBytes ? "pass" : "",
    },
  ];
  el("dlStats").replaceChildren(...tiles.map((tile) => {
    const box = document.createElement("div");
    box.className = `ranked-stat${tile.tone ? ` is-${tile.tone}` : ""}`;
    box.innerHTML = "<strong></strong><span></span>";
    box.querySelector("strong").textContent = tile.value;
    box.querySelector("span").textContent = tile.label;
    return box;
  }));

  const cookies = status.cookies || {};
  const expires = Date.parse(cookies.loginExpiresAt);
  const daysLeft = expires ? Math.floor((expires - Date.now()) / 86400000) : null;
  el("dlAuth").textContent = [
    cookies.present ? `cookies.txt uploaded ${downloadWhen(cookies.updatedAt)}.` : "No cookies.txt on the server yet.",
    // The "stay logged in" cookie is what ends the login; SimpCity renews the rest itself.
    daysLeft == null ? "" : daysLeft < 0 ? "Its login ran out: upload a fresh one."
      : `Its login lasts until ${new Date(expires).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}${daysLeft <= 14 ? `, ${plural(daysLeft, "day", "days")} from now: upload a fresh one soon` : ""}.`,
    auth.ok === true ? "The login worked." : auth.ok === false ? `The login failed: ${auth.message || "upload new cookies."}` : auth.message || "",
  ].filter(Boolean).join(" ");
  el("dlAuth").classList.toggle("is-error", auth.ok === false || (daysLeft != null && daysLeft <= 14));
  el("dlTarget").textContent = status.target ? `into ${status.target}` : "";

  renderDownloadHeld(status, jobs.filter((job) => job.status === "held"));
  renderDownloadJobs(jobs);
  renderDownloadFailed(status.failed || []);
  renderDownloadThreads(status.threads || []);
  syncDownloadNow();
}

function downloadWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function downloadElapsed(job) {
  const start = Date.parse(job.startedAt);
  if (!start) return "";
  const end = job.endedAt ? Date.parse(job.endedAt) : Date.now();
  return formatClock(Math.max(0, Math.round((end - start) / 1000)));
}

function downloadButton(label, onClick, className = "ghost-button small-button") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderDownloadJobs(jobs) {
  el("dlJobsEmpty").hidden = jobs.length > 0;
  el("dlJobs").replaceChildren(...jobs.map((job) => {
    const row = document.createElement("li");
    row.classList.toggle("is-shown", job.id === downloads.logJob);
    const badge = document.createElement("span");
    badge.className = `dl-badge is-${job.status}`;
    badge.textContent = DOWNLOAD_STATUS[job.status] || job.status;
    const text = document.createElement("div");
    text.className = "dl-row-text";
    const name = document.createElement("strong");
    name.textContent = job.label;
    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = [downloadWhen(job.createdAt), downloadElapsed(job), job.summary].filter(Boolean).join(" · ");
    text.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "dl-row-actions";
    if (!["queued", "held"].includes(job.status)) {
      actions.append(downloadButton("Output", () => showDownloadLog(job.id)));
    }
    if (["queued", "held"].includes(job.status)) {
      actions.append(downloadButton("Cancel", () => cancelDownload(job), "danger-button small-button"));
    }
    row.append(badge, text, actions);
    return row;
  }));
}

function renderDownloadFailed(failed) {
  el("dlFailedSection").hidden = !failed.length;
  el("dlRetryAll").hidden = failed.length < 2;
  el("dlFailed").replaceChildren(...failed.map((row) => {
    const item = document.createElement("li");
    const text = document.createElement("div");
    text.className = "dl-row-text";
    const name = document.createElement("strong");
    name.textContent = row.model;
    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = [row.files ? plural(row.files, "file", "files") : "", row.cyberdrop ? "a cyberdrop-dl run (hosts like Bunkr, GoFile)" : ""]
      .filter(Boolean).join(" and ") + " failed";
    text.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "dl-row-actions";
    actions.append(downloadButton("Retry", () => submitDownload({ action: "retry", models: [row.model] })));
    item.append(text, actions);
    return item;
  }));
}

function renderDownloadThreads(threads) {
  el("dlThreadsSection").hidden = !threads.length;
  el("dlThreads").replaceChildren(...threads.map((thread) => {
    const item = document.createElement("li");
    const text = document.createElement("div");
    text.className = "dl-row-text";
    const name = document.createElement("strong");
    name.textContent = thread.model;
    const meta = document.createElement("span");
    meta.className = "subtle dl-url";
    meta.textContent = thread.lastPage ? `read to page ${thread.lastPage} · ${thread.url}` : thread.url;
    text.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "dl-row-actions";
    actions.append(downloadButton("New posts", () => submitDownload({ action: "update", model: thread.model })));
    item.append(text, actions);
    return item;
  }));
}

// The drive reached its reserve: what is waiting, and whether there is room yet.
function renderDownloadHeld(status, held) {
  el("dlHeld").hidden = !held.length;
  if (!held.length) return;
  const room = status.freeBytes == null || !status.resumeBytes || status.freeBytes >= status.resumeBytes;
  el("dlHeldText").textContent = `${plural(held.length, "download is", "downloads are")} waiting for space. `
    + (status.freeBytes == null ? "" : `${formatBytes(status.freeBytes)} free; `)
    + (room ? "that is enough to go on. " : `resuming needs more than ${formatBytes(status.resumeBytes)}. Free some in Dangerous, then Settings → Empty trash. `)
    + "Files already downloaded are not fetched again.";
  el("dlResume").disabled = !room;
}

async function resumeHeldDownloads() {
  try {
    const result = await postJson("/api/simp/resume", {});
    toast(`Resumed ${plural(result.resumed, "download", "downloads")}.`);
  } catch (error) {
    if (!error.locked) toast(error.message);
  }
  refreshDownloads();
}

async function dropHeldDownloads() {
  const held = (downloads.status?.jobs || []).filter((job) => job.status === "held");
  if (!held.length || !window.confirm(`Drop ${plural(held.length, "download", "downloads")} waiting for space? You can start them again later; nothing downloaded is lost.`)) return;
  for (const job of held) {
    try {
      await postJson(`/api/simp/jobs/${job.id}/cancel`, {});
    } catch (error) {
      if (!error.locked) toast(error.message);
    }
  }
  refreshDownloads();
}

/* ---- what has arrived so far ---- */

async function followDownloadArrivals(job) {
  if (!job || !job.arrived) {
    renderDownloadArrivals(job);
    return;
  }
  if (job.id !== downloadArrivals.job || job.arrived !== downloadArrivals.count) {
    try {
      const { paths } = await fetchJson(`/api/simp/jobs/${job.id}/arrivals`);
      Object.assign(downloadArrivals, { job: job.id, count: job.arrived, paths });
    } catch (error) {
      return;
    }
    // Pull the new files into this page's library now, not at the next poll.
    const known = new Set(state.library.images.map((item) => item.path).concat(state.library.videos.map((item) => item.path)));
    if (downloadArrivals.paths.some((path) => !known.has(path))) {
      try {
        await refreshLibrary();
      } catch (error) {
        /* the regular poll retries */
      }
    }
  }
  renderDownloadArrivals(job);
}

function renderDownloadArrivals(job) {
  const section = el("dlArrivals");
  if (!job || job.id !== downloadArrivals.job || !downloadArrivals.paths.length) {
    section.hidden = true;
    return;
  }
  const byPath = new Map([
    ...state.library.images.map((item) => [item.path, { ...item, kind: "photo" }]),
    ...state.library.videos.map((item) => [item.path, { ...item, kind: "video" }]),
  ]);
  const items = downloadArrivals.paths.map((path) => byPath.get(path)).filter(Boolean).slice(0, ARRIVALS_SHOWN);
  section.hidden = !items.length;
  if (!items.length) return;
  const model = (items[0].folder || "").split("/")[0];
  el("dlArrivalsTitle").textContent = `${job.status === "running" ? "Arriving" : "Arrived"}: ${plural(job.arrived, "new file", "new files")}`
    + (job.arrived > items.length ? ` · newest ${items.length}` : "");
  el("dlArrivalsDangerous").onclick = () => sortModelInDangerous(model);
  el("dlArrivalsOpen").onclick = () => {
    setMode("ranked");
    openModelPage(model);
  };
  el("dlArrivalsDangerous").hidden = el("dlArrivalsOpen").hidden = !model;
  // Rebuilding reloads every picture, and would pull the preview out from
  // under you: only when the list changed, and not while it is open.
  const signature = `${job.id}|${items.length}|${items[0].path}|${items.map((item) => item.rating || "").join("")}`;
  if (signature === downloadArrivals.signature || !controls.galleryLightbox.hidden) return;
  downloadArrivals.signature = signature;
  state.gallery.items = items;
  const grid = el("dlArrivalsGrid");
  downloadArrivals.observer?.disconnect();
  downloadArrivals.observer = videoTileObserver(el("downloadsScroller"));
  grid.replaceChildren(...items.map((item, index) => buildGalleryTile(item, index)));
  grid.querySelectorAll(".gallery-tile.is-video").forEach((tile) => downloadArrivals.observer.observe(tile));
  syncGalleryTileSizeFor(grid);
}

/* ---- the running job's output ---- */

function syncDownloadNow() {
  const jobs = downloads.status?.jobs || [];
  let job = downloads.logPinned ? jobs.find((entry) => entry.id === downloads.logJob) : null;
  if (!job) {
    downloads.logPinned = false;
    job = jobs.find((entry) => entry.status === "running") || jobs.find((entry) => entry.status !== "queued");
  }
  if (!job) {
    el("dlNow").hidden = true;
    downloads.logJob = null;
    return null;
  }
  if (job.id !== downloads.logJob) {
    downloads.logJob = job.id;
    downloads.logOffset = -DOWNLOAD_LOG_TAIL;
    downloads.logText = "";
    downloads.logDone = false;
    el("dlLog").textContent = "";
  }
  el("dlNow").hidden = false;
  el("dlNowTitle").textContent = job.status === "running" ? `Running: ${job.label}` : job.label;
  el("dlNowMeta").textContent = [DOWNLOAD_STATUS[job.status] || job.status, downloadWhen(job.startedAt || job.createdAt), downloadElapsed(job)]
    .filter(Boolean).join(" · ");
  el("dlCancel").hidden = job.status !== "running";
  el("dlCancel").onclick = () => cancelDownload(job);
  el("dlJobs").querySelectorAll("li").forEach((row, index) => row.classList.toggle("is-shown", jobs[index]?.id === job.id));
  return job;
}

async function followDownloadLog() {
  const job = syncDownloadNow();
  if (!job || downloads.logDone) return;
  const finished = !["running", "queued"].includes(job.status);
  const pre = el("dlLog");
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  try {
    // A finished job's output is read to its end in one go; a running one
    // a chunk per poll.
    for (let round = 0; round < (finished ? 8 : 1); round += 1) {
      const chunk = await fetchJson(`/api/simp/jobs/${job.id}/log?offset=${downloads.logOffset}`);
      if (downloads.logJob !== job.id) return;
      downloads.logText = (downloads.logText + chunk.text.replace(/\r/g, "")).slice(-DOWNLOAD_LOG_KEEP);
      downloads.logOffset = chunk.offset;
      if (chunk.offset >= chunk.size) {
        downloads.logDone = finished;
        break;
      }
    }
  } catch (error) {
    if (!error.locked) downloads.logText ||= error.message;
  }
  pre.textContent = downloads.logText || "No output yet.";
  // Follow new output, unless you scrolled up to read.
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function showDownloadLog(jobId) {
  downloads.logPinned = true;
  downloads.logJob = jobId;
  downloads.logOffset = -DOWNLOAD_LOG_TAIL;
  downloads.logText = "";
  downloads.logDone = false;
  followDownloadLog();
  el("dlNow").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ---- starting and stopping jobs ---- */

async function submitDownload(payload, message) {
  try {
    const { job } = await postJson("/api/simp/jobs", payload);
    downloads.logPinned = false;
    toast(message || `Queued: ${job.label}.`);
    if (state.currentMode === "downloads") {
      await refreshDownloads();
    } else {
      loadDownloadStatus();
    }
    return job;
  } catch (error) {
    if (!error.locked) toast(error.message);
    return null;
  }
}

async function cancelDownload(job) {
  if (job.status === "running" && !window.confirm(`Stop “${job.label}”? Files already downloaded stay.`)) return;
  try {
    await postJson(`/api/simp/jobs/${job.id}/cancel`, {});
    toast(job.status === "running" ? "Stopping…" : "Removed.");
  } catch (error) {
    if (!error.locked) toast(error.message);
  }
  refreshDownloads();
}

async function uploadCookies(file) {
  if (!file) return;
  if (file.size > 512 * 1024) {
    toast("That is too big for a cookies.txt.");
    return;
  }
  try {
    const result = await postJson("/api/simp/cookies", { text: await file.text() });
    await submitDownload({ action: "check-auth" }, `Saved ${plural(result.cookies, "SimpCity cookie", "SimpCity cookies")}. Checking the login…`);
  } catch (error) {
    if (!error.locked) toast(error.message);
  }
}

function bindDownloads() {
  el("dlThreadGo").addEventListener("click", async () => {
    const urls = el("dlUrls").value.split(/\s+/).filter(Boolean);
    if (!urls.length) {
      toast("Paste a SimpCity thread link first.");
      return;
    }
    if (await submitDownload({ action: "thread", urls })) el("dlUrls").value = "";
  });
  el("dlBookmarksGo").addEventListener("click", () => {
    const pages = el("dlPages").value.trim().toLowerCase() || "1";
    const limit = Math.max(0, Math.round(Number(el("dlLimit").value) || 0));
    const what = pages === "all" ? "every page of your bookmarks" : `bookmarks page ${pages}`;
    if (!window.confirm(`Download ${limit ? `the first ${limit} models on ` : "every model on "}${what}? This can take hours.`)) return;
    submitDownload({ action: "bookmarks", pages, limit });
  });
  el("dlCheckAuth").addEventListener("click", () => submitDownload({ action: "check-auth" }, "Checking the SimpCity login…"));
  el("dlCookieButton").addEventListener("click", () => el("dlCookieFile").click());
  el("dlCookieFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    uploadCookies(file);
  });
  el("dlRetryAll").addEventListener("click", () => submitDownload({ action: "retry", models: [] }));
  el("dlResume").addEventListener("click", resumeHeldDownloads);
  el("dlDropHeld").addEventListener("click", dropHeldDownloads);
  el("dlUpdateAll").addEventListener("click", async () => {
    const urls = (downloads.status?.threads || []).map((thread) => thread.url);
    // One job per 20 threads: simp crawls them one after another anyway.
    for (let start = 0; start < urls.length; start += 20) {
      await submitDownload({ action: "thread", urls: urls.slice(start, start + 20) },
        `Checking ${plural(urls.length, "thread", "threads")} for new posts.`);
    }
  });
  el("modelUpdate").addEventListener("click", () => {
    const model = state.ranked.model;
    submitDownload({ action: "update", model }, `Checking ${folderLabel(model)} for new posts. Follow it in Downloads.`);
  });
}

// Model page: New posts, when simp knows the model's thread.
async function syncModelUpdate(model) {
  const button = el("modelUpdate");
  const known = () => (downloads.status?.threads || []).find((thread) => thread.model === model);
  button.hidden = !known();
  if (!state.features.has("simp")) return;
  await loadDownloadStatus();
  if (state.ranked.model !== model) return;
  const thread = known();
  button.hidden = !thread;
  if (thread) button.title = `Download what is new in ${thread.url}`;
}
