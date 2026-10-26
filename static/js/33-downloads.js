/* ==========================================================================
   Downloads — simp, run by the server

   Paste SimpCity thread links, pull pages of your bookmarks, retry what
   failed, and check a model's thread for new posts (here, or with New posts
   on its model page). Settings per model pick what to take from one model's
   thread (which pages, photos or videos, how many new files, newest first);
   the server keeps them and applies them to every download of that model.
   The server runs simp one job at a time (simpjobs.py); this page starts
   jobs, follows the running one's output and cancels.
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
  logView: { job: null, text: null, open: new Set() },
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
    if (document.hidden || state.locked) {
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
    ["dlNow", "dlLaterSection", "dlFailedSection", "dlThreadsSection", "dlRulesSection"].forEach((id) => { el(id).hidden = true; });
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
  el("dlStats").replaceChildren(...downloadTiles(tiles));

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
  renderDownloadLater(status.later || [], jobs);
  renderDownloadFailed(status.failed || []);
  renderDownloadThreads(status.threads || []);
  renderModelRules();
  syncDownloadNow();
}

function downloadTiles(tiles) {
  return tiles.map((tile) => {
    const box = document.createElement("div");
    box.className = `ranked-stat${tile.tone ? ` is-${tile.tone}` : ""}`;
    box.innerHTML = "<strong></strong><span></span>";
    box.querySelector("strong").textContent = tile.value;
    box.querySelector("span").textContent = tile.label;
    return box;
  });
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

// Bunkr links simp saved with --slow-later (simpjobs.py SLOW_LATER): the
// server downloads them after every other waiting job, on its own. Shown so
// what is still to come is visible, and to start them again after a failure.
function renderDownloadLater(later, jobs) {
  el("dlLaterSection").hidden = !later.length;
  if (!later.length) return;
  const job = jobs.find((entry) => entry.action === "later" && ["queued", "running", "held"].includes(entry.status));
  el("dlLaterRun").hidden = !!job;
  el("dlLaterText").textContent = job?.status === "running"
    ? "Downloading now. A new download you start goes first; these go on after it."
    : job
      ? "These download after everything else that is waiting. Bunkr hands out one file at a time per server, so they take long."
      : "Nothing is downloading these. They stopped part way or failed: Download now picks up where they stopped.";
  el("dlLater").replaceChildren(...later.map((row) => {
    const item = document.createElement("li");
    const text = document.createElement("div");
    text.className = "dl-row-text";
    const name = document.createElement("strong");
    name.textContent = row.model;
    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = `${plural(row.links, "Bunkr link", "Bunkr links")} · saved ${downloadWhen(row.savedAt)}`;
    text.append(name, meta);
    item.append(text);
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
    const brief = ruleBrief(modelRule(thread.model));
    if (brief) {
      const rule = document.createElement("span");
      rule.className = "dl-rule-brief";
      rule.textContent = `Downloads: ${brief}`;
      text.append(rule);
    }
    const actions = document.createElement("div");
    actions.className = "dl-row-actions";
    actions.append(downloadButton("New posts", () => submitDownload({ action: "update", model: thread.model })));
    if (modelRulesReady()) {
      actions.append(ruleSettingsButton(thread.model, thread.model, () => openRuleDialog({
        target: { model: thread.model, url: thread.url, byUrl: false },
        go: () => submitDownload({ action: "update", model: thread.model }),
      })));
    }
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
  renderDownloadProgress(job);
  el("dlCancel").hidden = job.status !== "running";
  el("dlCancel").onclick = () => cancelDownload(job);
  el("dlJobs").querySelectorAll("li").forEach((row, index) => row.classList.toggle("is-shown", jobs[index]?.id === job.id));
  return job;
}

/* ---- cyberdrop-dl's part of the running job ----
   The server reads cyberdrop-dl's log, database and .part files
   (SimpJobs.progress in simpjobs.py): what downloads now and how fast, what
   waits, what finished or failed, and a rough time left. A server from
   before this sends no progress, and the block stays hidden. */

function downloadRate(bytesPerSecond) {
  if (bytesPerSecond == null) return "…";
  return bytesPerSecond < 1000 * 1024 ? `${Math.round(bytesPerSecond / 1024)} KB/s` : `${formatBytes(bytesPerSecond)}/s`;
}

function downloadDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

function renderDownloadProgress(job) {
  const progress = downloads.status?.progress;
  const box = el("dlProgress");
  box.hidden = !progress || progress.jobId !== job.id || job.status !== "running";
  if (box.hidden) return;
  const tiles = [];
  if (progress.phase === "scanning") {
    tiles.push({ value: progress.linksChecked.toLocaleString(), label: "links looked up so far", tone: "keep" });
  } else {
    tiles.push({ value: downloadRate(progress.speed), label: `${plural(progress.downloading, "file", "files")} downloading now`, tone: "keep" });
    const hosts = Object.entries(progress.waitingByHost || {}).map(([host, count]) => `${count} ${host}`).join(", ");
    tiles.push({ value: progress.waiting.toLocaleString(), label: progress.waiting ? `waiting · ${hosts}` : "nothing waiting" });
    tiles.push({ value: progress.done.toLocaleString(), label: `done this run · ${formatBytes(progress.doneBytes)}` });
    const eta = progress.etaSeconds;
    tiles.push(eta
      ? { value: `~${downloadDuration(eta)}`, label: `left · done around ${new Date(Date.now() + eta * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} at ${progress.filesPerHour} files/h` }
      : { value: "--", label: progress.waiting ? "time left: too early to tell" : "time left" });
  }
  if (progress.failed) {
    const [reason] = progress.failedReasons[0] || [""];
    tiles.push({ value: progress.failed.toLocaleString(), label: `failed${reason ? ` · ${reason}` : ""}`, tone: "pass" });
  }
  el("dlProgressStats").replaceChildren(...downloadTiles(tiles));

  el("dlProgressFiles").replaceChildren(...progress.active.map((file) => {
    const row = document.createElement("li");
    const text = document.createElement("div");
    text.className = "dl-row-text";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = [`${formatBytes(file.bytes)} so far`, file.speed == null ? "" : downloadRate(file.speed),
      file.host ? `from ${file.host}` : "", file.startedAt ? `started ${downloadWhen(file.startedAt)}` : ""].filter(Boolean).join(" · ");
    text.append(name, meta);
    row.append(text);
    return row;
  }));

  const hints = [];
  // cyberdrop-dl's Bunkr downloader takes one file at a time from each Bunkr
  // server (it gets refused otherwise), so a big album there queues up.
  if (progress.waitingByHost?.bunkr) {
    hints.push("Bunkr files download one at a time per Bunkr server, so they wait in line; other hosts download alongside.");
  }
  if (progress.failed) {
    hints.push("cyberdrop-dl does not try failed files again in this run. When the job ends, New posts on this model tries them again and skips what is already here.");
  }
  el("dlProgressHint").textContent = hints.join(" ");
  el("dlProgressHint").hidden = !hints.length;
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
  renderDownloadLog(pre, job.id, downloads.logText);
  // Follow new output, unless you scrolled up to read.
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

/* ---- the output, made readable ----
   simp and cyberdrop-dl write for a 120-column terminal (simpjobs.py sets
   COLUMNS=120): rich breaks long lines at column 120, cyberdrop-dl pads its
   WARNING/ERROR records with spaces and indents their continuation lines, and
   simp prints one tracking line per file. The page joins the broken lines back
   and turns the text into blocks: file lines fold into one group with counts,
   the long cyberdrop-dl command and tracebacks fold away, levels get labels.
   The raw text stays in textContent (tests and copy-paste read it). */

const LOG_WIDTH = 120;
const LOG_LEVEL_RE = /^(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s{2,}(.*)$/;
// A line starting with one of these is new output, never the tail of a broken line.
const LOG_START_RE = /^(\$ |Summary:|Running |Model folder:|thread \(|later \(|Estimate:|Signed in|Session OK|whereto|direct downloads|Retry with|(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s|[╭│╰]|\w+(Error|Exception)\b|Traceback)/;
// "    [ok] model | thread p.3 | image | bbimage | host | name (123 B)". Logs
// from before 2026-09-29 lost "[ok]" to rich markup: five spaces instead.
const LOG_ITEM_RE = /^ {4}(?:\[(\w+)\] | )(\S.*?) \| thread (p\.\S+) \| (\w+) \| ([^|]+?) \| ([^|\s]+)(?: \| (.*))?$/;
// Records that show up on every cyberdrop-dl run and mean nothing to you.
// "    + slug  (Thread title)" from `simp bookmarks`.
const LOG_BOOKMARK_RE = /^ {4}\+ (\S+)\s+\((.*)\)$/;
const LOG_NOISE_RE = /Deleted conflicting old|'ssl_context' config option is deprecated|Unable to parse upload date/;

function logicalLogLines(text) {
  const out = [];
  let prev = null; // raw text of the last physical line, to judge a break
  let record = false; // inside a cyberdrop-dl WARNING/ERROR record
  let panel = null;
  for (const raw of text.split("\n")) {
    if (panel) {
      panel.lines.push(raw.trimEnd());
      if (/^╰/.test(raw)) panel = null;
      prev = null;
      continue;
    }
    if (/^╭/.test(raw)) {
      panel = { panel: true, lines: [raw.trimEnd()] };
      out.push(panel);
      record = false;
      prev = null;
      continue;
    }
    if (record && /^ {9}/.test(raw) && raw.trim()) {
      out[out.length - 1] += joinLogBreak(prev) + raw.trim();
      prev = raw;
      continue;
    }
    record = LOG_LEVEL_RE.test(raw);
    // rich moves a word to the next line when it would cross column 120.
    const word = raw.split(" ", 1)[0];
    const broken = prev !== null && /^\S/.test(raw) && !LOG_START_RE.test(raw)
      && prev.trimEnd().length + 1 + word.length > LOG_WIDTH;
    if (broken && typeof out[out.length - 1] === "string") {
      out[out.length - 1] += joinLogBreak(prev) + raw.trimEnd();
    } else {
      out.push(raw.trimEnd());
    }
    prev = raw;
  }
  return out;
}

// rich breaks at a space (and drops it) unless one word fills the whole line.
function joinLogBreak(prev) {
  return prev && prev.length >= LOG_WIDTH && !/\s$/.test(prev) ? "" : " ";
}

function logSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function parseLogItem(line) {
  const match = LOG_ITEM_RE.exec(line);
  if (!match) return null;
  const [, status, model, page, kind, source, host, detail = ""] = match;
  const item = { status: status || "", model, page, kind, source, host, name: detail, meta: "" };
  const sized = /^(.*) \((\d+) B\)$/.exec(detail);
  if (sized) {
    item.name = sized[1];
    item.meta = logSize(Number(sized[2]));
    item.status ||= "ok";
  } else if (/^https?:\/\//.test(detail)) {
    item.name = detail.replace(/^https?:\/\/[^/]+/, "") || detail;
    item.status ||= "cdl";
  }
  return item;
}

function logText(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderLogGroup(items) {
  // Before 2026-09-29 the status was lost; a failure is followed by its URL.
  items.forEach((item) => { item.status ||= item.url ? "fail" : "skip"; });
  const counts = {};
  items.forEach((item) => { counts[item.status || "other"] = (counts[item.status || "other"] || 0) + 1; });
  const queued = items.every((item) => item.status === "cdl");
  const box = logText("details", "log-group");
  const summary = logText("summary");
  summary.append(logText("strong", "", queued
    ? `${items.length} link${items.length === 1 ? "" : "s"} for cyberdrop-dl`
    : `${items.length} file${items.length === 1 ? "" : "s"}`));
  const labels = { ok: "downloaded", skip: "skipped", fail: "failed" };
  for (const status of ["ok", "skip", "fail"]) {
    if (counts[status]) summary.append(logText("span", `log-count is-${status}`, `${counts[status]} ${labels[status]}`));
  }
  if (items.some((item) => item.status === "fail")) box.classList.add("has-fail");
  const list = logText("ol", "log-items");
  for (const item of items) {
    const row = logText("li", `log-item is-${item.status || "other"}`);
    row.append(logText("span", "log-kind", item.kind));
    const body = logText("span", "log-item-body");
    // A failed line's detail is the reason; its URL follows on the next line.
    const failed = item.status === "fail" && item.url;
    const name = failed ? item.url.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() : item.name;
    body.append(logText("span", "log-name", name || item.url || item.host));
    const meta = [failed ? item.name : item.meta, item.host, `thread ${item.page}`].filter(Boolean).join(" · ");
    body.append(logText("span", "log-meta", meta));
    if (item.url) body.append(logText("span", "log-meta log-url", item.url));
    row.append(body);
    list.append(row);
  }
  box.append(summary, list);
  return box;
}

// A run of cyberdrop-dl WARNING/ERROR records folds into one line with counts.
function renderLogRecords(records) {
  const box = logText("details", "log-group log-records");
  const summary = logText("summary");
  summary.append(logText("strong", "", "cyberdrop-dl"));
  const errors = records.filter((record) => /^(ERROR|CRITICAL)/.test(record)).length;
  const warnings = records.filter((record) => record.startsWith("WARNING")).length;
  const others = records.length - errors - warnings;
  if (errors) summary.append(logText("span", "log-count is-fail", `${errors} error${errors === 1 ? "" : "s"}`));
  if (warnings) summary.append(logText("span", "log-count", `${warnings} warning${warnings === 1 ? "" : "s"}`));
  if (others) summary.append(logText("span", "log-count", `${others} other`));
  if (errors) box.classList.add("has-fail");
  const list = logText("div", "log-items");
  records.forEach((record) => list.append(renderLogLine(record)));
  box.append(summary, list);
  return box;
}

function renderLogBookmarks(rows) {
  const box = logText("details", "log-group");
  const summary = logText("summary");
  summary.append(logText("strong", "", `${rows.length} bookmark${rows.length === 1 ? "" : "s"}`));
  const list = logText("ol", "log-items");
  for (const [, slug, title] of rows) {
    const row = logText("li", "log-item");
    const body = logText("span", "log-item-body");
    body.append(logText("span", "log-name", slug), logText("span", "log-meta", title.replace(/\s+/g, " ")));
    row.append(body);
    list.append(row);
  }
  box.append(summary, list);
  return box;
}

function renderLogPanel(lines, error) {
  const inner = lines.slice(1, -1).map((line) => line.replace(/^│ ?|\s*│$/g, "").trimEnd());
  const title = (/^╭─+ (.*?) ─/.exec(lines[0]) || [])[1] || "Output";
  if (/^Traceback/.test(title) || inner.length > 12) {
    const box = logText("details", "log-panel");
    box.append(logText("summary", "", error || `${title} (${inner.length} lines)`));
    box.append(logText("pre", "", inner.join("\n")));
    return box;
  }
  // cyberdrop-dl's short "Error" boxes: one message, rewrapped by the page.
  const box = logText("div", "log-rec is-error");
  box.append(logText("span", "log-level", title), logText("span", "log-msg", inner.map((line) => line.trim()).join(" ")));
  return box;
}

function renderLogLine(line) {
  const indent = Math.min(3, Math.floor((line.length - line.trimStart().length) / 2));
  const text = line.trim();
  let node;
  let match;
  if (text.startsWith("$ ")) {
    node = logText("div", "log-cmd", text);
  } else if ((match = LOG_LEVEL_RE.exec(line))) {
    const level = match[1].toLowerCase();
    node = logText("div", `log-rec is-${level === "critical" ? "error" : level}`);
    if (LOG_NOISE_RE.test(match[2])) node.classList.add("is-noise");
    const [message, referer] = match[2].split(/\s+-> Referer:\s+/);
    const body = logText("span", "log-msg", message);
    if (referer) body.append(" ", logText("span", "log-meta", `from ${referer}`));
    node.append(logText("span", "log-level", level === "warning" ? "warn" : level), body);
  } else if ((match = /^Running (\S+)(.*)$/.exec(text))) {
    node = logText("details", "log-run");
    node.append(logText("summary", "", `Running ${match[1].split("/").pop()}`), logText("code", "", text.slice(8)));
  } else if (text.startsWith("Summary:") || text.startsWith("Estimate:")) {
    node = logText("div", "log-summary", text);
  } else if ((match = /^(.*?)\s+[━╸╺ ]*━[━╸╺ ]*\s+(\d+)\/(\d+)\s*(.*)$/.exec(text))) {
    const [, label, done, total, time] = match;
    node = logText("div", "log-progress");
    const bar = logText("span", "log-bar");
    bar.style.setProperty("--done", `${Math.round((Number(done) / Math.max(1, Number(total))) * 100)}%`);
    node.append(logText("span", "", label), bar, logText("span", "log-meta", `${done}/${total} ${time}`.trim()));
  } else if (/^(thread|later) \(\d+\/\d+\)/.test(text) || text.startsWith("Model folder:")) {
    node = logText("div", "log-head", text);
  } else {
    node = logText("div", "log-line", text);
    if (/^(Retry with|album\/host totals|resolve cache|Wrote \d|later: \d)/.test(text)) node.classList.add("is-hint");
    else if (/\b(fail(ed)?|error|could not|exited [1-9]|no space)\b/i.test(text) && !/\b0 fail/.test(text)) node.classList.add("is-error");
  }
  if (indent) node.style.setProperty("--indent", indent);
  return node;
}

function renderDownloadLog(box, jobId, text) {
  const view = downloads.logView;
  if (view.job !== jobId) {
    view.job = jobId;
    view.open = new Set();
  } else if (view.text === text && box.childElementCount) {
    return;
  }
  view.text = text;
  const lines = logicalLogLines(text || "No output yet.");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (typeof line !== "string") {
      // A traceback box is followed by the one line that says what went wrong.
      const next = lines[index + 1];
      const error = typeof next === "string" && /^\w+(Error|Exception)\b/.test(next) ? next : "";
      if (error) index += 1;
      blocks.push(renderLogPanel(line.lines, error));
      continue;
    }
    if (LOG_BOOKMARK_RE.test(line)) {
      const rows = [LOG_BOOKMARK_RE.exec(line)];
      while (typeof lines[index + 1] === "string" && LOG_BOOKMARK_RE.test(lines[index + 1])) {
        rows.push(LOG_BOOKMARK_RE.exec(lines[index + 1]));
        index += 1;
      }
      blocks.push(renderLogBookmarks(rows));
      continue;
    }
    if (LOG_LEVEL_RE.test(line)) {
      const records = [line];
      while (typeof lines[index + 1] === "string" && LOG_LEVEL_RE.test(lines[index + 1])) {
        records.push(lines[index + 1]);
        index += 1;
      }
      if (records.length < 4) records.forEach((record) => blocks.push(renderLogLine(record)));
      else blocks.push(renderLogRecords(records));
      continue;
    }
    const item = parseLogItem(line);
    if (!item) {
      if (line.trim()) blocks.push(renderLogLine(line));
      continue;
    }
    const items = [item];
    while (index + 1 < lines.length && typeof lines[index + 1] === "string") {
      const nextLine = lines[index + 1];
      const url = /^ {9}(https?:\/\/\S+)$/.exec(nextLine);
      if (url) {
        items[items.length - 1].url = url[1];
        index += 1;
        continue;
      }
      const next = parseLogItem(nextLine);
      if (!next) break;
      items.push(next);
      index += 1;
    }
    blocks.push(renderLogGroup(items));
  }
  // Keep what you opened open while new output arrives.
  blocks.forEach((block, index) => {
    if (block.tagName !== "DETAILS") return;
    const key = `${index}:${block.className}`;
    block.open = view.open.has(key);
    block.addEventListener("toggle", () => (block.open ? view.open.add(key) : view.open.delete(key)));
  });
  const scroll = box.scrollTop;
  box.replaceChildren(...blocks);
  box.scrollTop = scroll;
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

/* ---- settings per model ----
   What to take from one model's SimpCity thread: which of its pages (pages
   of the thread, not of the bookmark list), photos or videos only, at most so
   many new files, newest posts first. Saved on the server for that model
   (POST /api/simp/rules), and the server applies them by itself to every
   download of it: New posts, Check all, bookmark downloads, one-tap
   Download, pasted links. Jobs carry no options. Edited here under Settings
   per model, and in the sheet behind Download settings on a model page,
   Settings on a bookmark and on a known thread. A server from before this
   (no status.modelRules) would ignore them, so there every control stays
   hidden: "pages 1-3" must never look applied when it is not. */

const DOWNLOAD_OPTION_DEFAULTS = Object.freeze({ threadPages: "", only: "", maxFiles: "", order: "oldest" });
const DOWNLOAD_ONLY = [["", "Photos and videos"], ["images", "Photos"], ["videos", "Videos"]];
const DOWNLOAD_MAX_FILES = 100000;
const DOWNLOAD_PAGES_HINT = "1-3, 1,3,4, 10- or last 5";
// A thread link as the server takes it (simpjobs.py THREAD_URL_RE).
const SIMPCITY_THREAD_RE = /^https:\/\/simpcity\.[a-z]{2,12}\/threads\/[^/\s?#]+\.\d+\/$/;
// The sheet: its options control, the model it edits and how to download it.
const downloadDialog = { control: null, opener: null, openerModel: "", target: null, go: null };
// The Downloads page's editor; the signatures spare rebuilding unchanged lists.
const ruleEditor = { target: null, control: null, listSignature: "", choicesSignature: "", bookmarksAsked: false };

function modelRulesReady(status = downloads.status) {
  return status?.modelRules === true;
}

function modelRule(model) {
  return (modelRulesReady() && model && downloads.status?.rules?.[model]) || null;
}

// A saved rule as a control's fields (text, as typed); defaults for none.
function ruleValues(rule) {
  return {
    threadPages: typeof rule?.threadPages === "string" ? rule.threadPages : "",
    only: rule?.only === "images" || rule?.only === "videos" ? rule.only : "",
    maxFiles: rule?.maxFiles > 0 ? String(rule.maxFiles) : "",
    order: rule?.order === "newest" ? "newest" : "oldest",
  };
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function upperFirst(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "videos only · pages 1–3": a saved rule in a few words, "" for none.
function ruleBrief(rule) {
  if (!rule) return "";
  const pages = parseThreadPages(rule.threadPages);
  return [
    rule.only === "images" ? "photos only" : rule.only === "videos" ? "videos only" : "",
    pages?.parts.length ? lowerFirst(threadPagesWords(pages.parts)) : !pages ? `pages ${rule.threadPages}` : "",
    rule.maxFiles > 0 ? `at most ${plural(rule.maxFiles, "new file", "new files")}` : "",
    rule.order === "newest" ? "newest posts first" : "",
  ].filter(Boolean).join(" · ");
}

// "1-3", "1,3,4", "10-", "last 5", "1-2,last 3": the list the server takes.
// Gives the parts and the list cleaned up ("" for every page), or null when
// it is not one.
function parseThreadPages(typed) {
  const clean = String(typed || "").trim().toLowerCase().replace(/[–—]/g, "-");
  if (!clean || clean === "all") return { text: "", parts: [] };
  const parts = [];
  for (const piece of clean.split(",").map((part) => part.trim()).filter(Boolean)) {
    let match;
    if ((match = /^(\d+)$/.exec(piece))) parts.push({ from: Number(match[1]), to: Number(match[1]) });
    else if ((match = /^(\d+)\s*-\s*(\d*)$/.exec(piece))) parts.push({ from: Number(match[1]), to: match[2] ? Number(match[2]) : null });
    else if ((match = /^last\s*(\d+)$/.exec(piece))) parts.push({ last: Number(match[1]) });
    else return null;
    const part = parts[parts.length - 1];
    if (part.last === 0 || part.from === 0 || (part.to != null && part.to < part.from)) return null;
  }
  if (!parts.length) return null;
  const text = parts.map((part) => (part.last ? `last ${part.last}`
    : part.to == null ? `${part.from}-` : part.to === part.from ? `${part.from}` : `${part.from}-${part.to}`)).join(",");
  return { text, parts };
}

// "Pages 1–3, the last 2", "Page 10 to the end", "The last 5 pages".
function threadPagesWords(parts) {
  if (parts.length === 1 && parts[0].last) return parts[0].last === 1 ? "The last page" : `The last ${parts[0].last} pages`;
  const words = parts.map((part) => (part.last ? `the last${part.last === 1 ? "" : ` ${part.last}`}`
    : part.to == null ? `${part.from} to the end` : part.to === part.from ? `${part.from}` : `${part.from}–${part.to}`));
  const many = parts.length > 1 || (parts[0].to != null && parts[0].to !== parts[0].from);
  return `${many ? "Pages" : "Page"} ${words.join(", ")}`;
}

// What a control's fields ask for: the rule fields to save (only those that
// are not the default), the sentence that says it, or what is wrong.
function downloadOptionsRequest(values) {
  const pages = parseThreadPages(values.threadPages);
  const maxText = String(values.maxFiles ?? "").trim();
  const maxFiles = maxText === "" ? 0 : Number(maxText);
  let error = "";
  if (!pages) error = `Thread pages “${values.threadPages.trim()}” is not a page list. Try ${DOWNLOAD_PAGES_HINT}.`;
  else if (!Number.isInteger(maxFiles) || maxFiles < 0 || maxFiles > DOWNLOAD_MAX_FILES) {
    error = `Max new files takes a whole number up to ${DOWNLOAD_MAX_FILES.toLocaleString()}; leave it empty for all of them.`;
  }
  const fields = {};
  if (pages?.text) fields.threadPages = pages.text;
  if (values.only === "images" || values.only === "videos") fields.only = values.only;
  if (maxFiles > 0 && !error) fields.maxFiles = maxFiles;
  if (values.order === "newest") fields.order = "newest";
  const words = error || (!Object.keys(fields).length ? "Everything in the thread" : [
    pages.parts.length ? threadPagesWords(pages.parts) : "All pages",
    fields.only === "images" ? "photos only" : fields.only === "videos" ? "videos only" : "",
    fields.maxFiles ? `at most ${plural(fields.maxFiles, "new file", "new files")}` : "",
    fields.order ? "newest posts first" : "",
  ].filter(Boolean).join(" · "));
  return { fields, words, error, pagesBad: !pages };
}

// The control itself. `prefix` keeps its ids apart from the other copy.
function buildDownloadOptions(prefix) {
  const box = document.createElement("div");
  box.className = "dl-options";
  box.innerHTML = `
    <div class="dl-fields">
      <label class="setup-path"><span>Thread pages</span><input id="${prefix}Pages" type="text" placeholder="all" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="${prefix}Hint" /></label>
      <label class="setup-path"><span>Max new files</span><input id="${prefix}Max" type="number" min="0" max="${DOWNLOAD_MAX_FILES}" step="1" placeholder="all" inputmode="numeric" aria-describedby="${prefix}Hint" /></label>
    </div>
    <p id="${prefix}Hint" class="subtle dl-options-hint">Pages: ${DOWNLOAD_PAGES_HINT} (the newest five). Max counts only files that are new here, per download.</p>
    <div class="setup-path">
      <span id="${prefix}OnlyLabel">Type</span>
      <div class="segmented" role="group" aria-labelledby="${prefix}OnlyLabel">
        ${DOWNLOAD_ONLY.map(([value, label]) => `<button type="button" class="segment" data-only="${value}" aria-pressed="false">${label}</button>`).join("")}
      </div>
    </div>
    <button type="button" class="switch-row" role="switch" aria-checked="false"><span>Newest posts first</span><i aria-hidden="true"></i></button>
    <div class="dl-options-foot">
      <p class="drawer-summary dl-options-readback" aria-live="polite"></p>
      <button type="button" class="text-button small-button">Reset</button>
    </div>`;
  const pages = box.querySelector(`#${prefix}Pages`);
  const max = box.querySelector(`#${prefix}Max`);
  const order = box.querySelector(".switch-row");
  const control = { box, pages, values: { ...DOWNLOAD_OPTION_DEFAULTS } };

  control.request = () => downloadOptionsRequest(control.values);
  control.sync = () => {
    const { values } = control;
    box.querySelectorAll("[data-only]").forEach((button) => {
      const on = button.dataset.only === values.only;
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", String(on));
    });
    order.setAttribute("aria-checked", String(values.order === "newest"));
    const request = control.request();
    const readback = box.querySelector(".dl-options-readback");
    readback.textContent = request.words;
    readback.classList.toggle("is-error", !!request.error);
    pages.setAttribute("aria-invalid", String(request.pagesBad));
    max.setAttribute("aria-invalid", String(!!request.error && !request.pagesBad));
  };
  control.set = (values) => {
    control.values = { ...values };
    pages.value = values.threadPages;
    max.value = values.maxFiles;
    control.sync();
  };
  const change = (patch) => {
    Object.assign(control.values, patch);
    control.sync();
  };

  pages.addEventListener("input", () => change({ threadPages: pages.value }));
  // A number field reads "" while what is typed is not a number yet.
  max.addEventListener("input", () => change({ maxFiles: max.value }));
  box.querySelector(".segmented").addEventListener("click", (event) => {
    const button = event.target.closest("[data-only]");
    if (button) change({ only: button.dataset.only });
  });
  order.addEventListener("click", () => change({ order: control.values.order === "newest" ? "oldest" : "newest" }));
  box.querySelector(".dl-options-foot .text-button").addEventListener("click", () => control.set(DOWNLOAD_OPTION_DEFAULTS));
  control.set(control.values);
  return control;
}

// unreadPages: pages up to lastPage that a run taking only some pages skipped.
function threadReadWords(thread) {
  if (!thread?.lastPage) return "simp has not read this thread yet.";
  const unread = thread.unreadPages || 0;
  return unread > 0
    ? `simp knows ${plural(thread.lastPage, "page", "pages")} of this thread; ${unread.toLocaleString()} of them not read yet.`
    : `simp has read ${plural(thread.lastPage, "page", "pages")} of this thread.`;
}

function knownThread(model) {
  return (downloads.status?.threads || []).find((thread) => thread.model === model) || null;
}

function bookmarkFor(model) {
  return (bookmarkPage.data?.bookmarks || []).find((row) => row.model === model) || null;
}

// Where a model downloads from: its known thread, the link its settings were
// saved from, or its bookmark.
function modelThreadUrl(model) {
  return knownThread(model)?.url || downloads.status?.rules?.[model]?.url || bookmarkFor(model)?.url || "";
}

// New posts for a model simp knows; its whole thread (as its settings allow)
// for one it does not. null when there is no link to download from.
function downloadModelPayload(model, url = modelThreadUrl(model)) {
  if (knownThread(model)) return { action: "update", model };
  return url ? { action: "thread", urls: [url] } : null;
}

// A pasted thread link: the folder it downloads into, as the server names it
// (simpjobs.py normalize_thread_url and thread_slug). The server's answer
// to a save says the name for certain.
function threadLinkTarget(text) {
  let url = String(text || "").trim().split("#", 1)[0].split("?", 1)[0].replace(/\/(?:page|post)-\d+\/?$/, "/");
  if (!url.endsWith("/")) url += "/";
  if (!SIMPCITY_THREAD_RE.test(url)) return null;
  let part = url.slice(0, -1).split("/").pop();
  try {
    part = decodeURIComponent(part);
  } catch (error) {
    /* a stray % stays as it is */
  }
  const model = part.replace(/\.\d+$/, "").replace(/\s+/g, " ").replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/^[ ._]+|[ ._]+$/g, "") || "untitled";
  return { model, url, byUrl: true };
}

// Saves `values` as the target's settings (clear: none, which deletes them),
// then, with go, starts its download: go(model) resolves to the job or null.
// Resolves to the server's answer plus the job, or null when the save failed
// (a toast says why).
async function saveModelRule(target, values, { clear = false, go = null } = {}) {
  let fields = {};
  if (!clear) {
    const request = downloadOptionsRequest(values);
    if (request.error) {
      toast(request.error);
      return null;
    }
    fields = request.fields;
  }
  let result;
  try {
    result = await postJson("/api/simp/rules", { ...(target.byUrl ? { url: target.url } : { model: target.model }), ...fields });
  } catch (error) {
    if (!error.locked) toast(error.message);
    return null;
  }
  const model = result.model || target.model;
  applyModelRules(result.rules, model);
  if (go) return { ...result, model, job: await go(model) };
  toast(result.rule ? `Saved for ${folderLabel(model)}: ${ruleBrief(result.rule)}.` : `No settings for ${folderLabel(model)}: its downloads take everything again.`);
  return { ...result, model, job: null };
}

// The server's rules after a save, shown everywhere they appear.
function applyModelRules(rules, changed) {
  if (downloads.status && rules && typeof rules === "object") downloads.status.rules = rules;
  // The editor holding that model shows what is saved now.
  if (changed && ruleEditor.target?.model === changed) ruleEditor.control.set(ruleValues(modelRule(changed)));
  if (state.currentMode === "downloads" && downloads.status) {
    renderDownloadThreads(downloads.status.threads || []);
    renderModelRules();
  }
  if (state.currentMode === "ranked" && state.ranked.model) syncModelRule(state.ranked.model);
  if (state.currentMode === "bookmarks") renderBookmarks();
}

/* ---- Settings per model, on the Downloads page ---- */

// Model → what the suggestion says about it: models with settings, with a
// known thread, and bookmarked.
function ruleChoices() {
  const choices = new Map();
  const add = (model, label) => {
    if (model && !choices.has(model)) choices.set(model, label);
  };
  Object.keys(downloads.status?.rules || {}).forEach((model) => add(model, "has settings"));
  (downloads.status?.threads || []).forEach((thread) => add(thread.model, "known thread"));
  (bookmarkPage.data?.bookmarks || []).forEach((row) => add(row.model, row.title && row.title !== row.model ? row.title : "bookmarked"));
  return choices;
}

function renderRuleChoices() {
  const choices = [...ruleChoices()].sort(([a], [b]) => a.localeCompare(b));
  const signature = JSON.stringify(choices);
  if (signature === ruleEditor.choicesSignature) return;
  ruleEditor.choicesSignature = signature;
  el("dlRuleModelList").replaceChildren(...choices.map(([model, label]) => {
    const option = document.createElement("option");
    option.value = model;
    option.label = label;
    return option;
  }));
}

// The bookmark list only loads once the chooser is used.
async function loadRuleChoices() {
  if (bookmarkPage.data || !state.features.has("bookmarks")) return;
  await loadBookmarks();
  renderRuleChoices();
  if (!ruleEditor.target && el("dlRuleModel").value.trim()) chooseRuleTarget(false);
}

// What the chooser holds: a thread link, a model name or a bookmark's title.
function resolveRuleTarget(typed) {
  if (!typed) return null;
  const link = threadLinkTarget(typed);
  if (link) return link;
  const needle = typed.toLowerCase();
  const model = [...ruleChoices().keys()].find((name) => name.toLowerCase() === needle)
    || (bookmarkPage.data?.bookmarks || []).find((row) => row.title?.toLowerCase() === needle)?.model;
  return model ? { model, url: modelThreadUrl(model), byUrl: false } : null;
}

// final: the field was left or Enter pressed, so a name that matches
// nothing is said to; while typing it only hides the editor.
function chooseRuleTarget(final) {
  const typed = el("dlRuleModel").value.trim();
  const target = resolveRuleTarget(typed);
  const hint = el("dlRuleHint");
  const current = ruleEditor.target;
  hint.classList.toggle("is-error", !target && !!typed && final);
  hint.textContent = !target && typed && final ? "No model by that name. Pick one from the list, or paste its SimpCity thread link." : "";
  if (!target) {
    ruleEditor.target = null;
    el("dlRuleEditor").hidden = true;
    return;
  }
  if (current && current.model === target.model && current.byUrl === target.byUrl && current.url === target.url) return;
  showRuleEditor(target);
}

function showRuleEditor(target) {
  ruleEditor.target = target;
  el("dlRuleEditor").hidden = false;
  ruleEditor.control.set(ruleValues(modelRule(target.model)));
  syncRuleEditor();
}

function syncRuleEditor() {
  const { target } = ruleEditor;
  if (!target) return;
  const rule = modelRule(target.model);
  el("dlRuleName").textContent = folderLabel(target.model);
  el("dlRuleMeta").textContent = [target.byUrl ? "From the thread link." : "", threadReadWords(knownThread(target.model))].filter(Boolean).join(" ");
  el("dlRuleSaved").textContent = rule ? `Saved: ${ruleBrief(rule)}.` : "Nothing saved yet: its downloads take everything.";
  el("dlRuleClear").hidden = !rule;
  el("dlRuleGo").hidden = !downloadModelPayload(target.model, target.url);
}

async function saveRuleEditor({ download = false, clear = false } = {}) {
  const { target, control } = ruleEditor;
  if (!target) return;
  if (!clear && control.request().error) {
    toast(control.request().error);
    control.pages.focus();
    return;
  }
  const buttons = ["dlRuleSave", "dlRuleGo", "dlRuleClear"].map(el);
  buttons.forEach((button) => { button.disabled = true; });
  const url = target.url;
  const result = await saveModelRule(target, control.values, {
    clear,
    go: download ? (model) => submitDownload(downloadModelPayload(model, url)) : null,
  });
  buttons.forEach((button) => { button.disabled = false; });
  // A link names its model for certain only once the server has read it.
  if (result && ruleEditor.target === target && result.model !== target.model) {
    target.model = result.model;
    ruleEditor.control.set(ruleValues(modelRule(result.model)));
  }
  syncRuleEditor();
}

function editModelRule(model) {
  el("dlRuleModel").value = model;
  el("dlRuleHint").textContent = "";
  showRuleEditor({ model, url: modelThreadUrl(model), byUrl: false });
  el("dlRulesSection").scrollIntoView({ block: "start", behavior: "smooth" });
  el("dlRuleName").focus({ preventScroll: true });
}

function renderModelRules() {
  const status = downloads.status;
  const ready = modelRulesReady(status) && !!(status.installed && status.configured);
  el("dlRulesSection").hidden = !ready;
  if (!ready) return;
  renderRuleChoices();
  syncRuleEditor();
  const rules = Object.entries(status.rules || {}).sort(([a], [b]) => a.localeCompare(b));
  el("dlRulesEmpty").hidden = rules.length > 0;
  // A model saved by name with no thread yet downloads from its bookmark: load them, once.
  if (!bookmarkPage.data && !ruleEditor.bookmarksAsked && state.features.has("bookmarks")
    && rules.some(([model]) => !downloadModelPayload(model))) {
    ruleEditor.bookmarksAsked = true;
    loadBookmarks().then(() => bookmarkPage.data && state.currentMode === "downloads" && renderModelRules());
  }
  const signature = JSON.stringify([rules, (status.threads || []).map((thread) => thread.model), !!bookmarkPage.data]);
  if (signature === ruleEditor.listSignature) return;
  ruleEditor.listSignature = signature;
  el("dlRules").replaceChildren(...rules.map(([model, rule]) => {
    const item = document.createElement("li");
    const text = document.createElement("div");
    text.className = "dl-row-text";
    const name = document.createElement("strong");
    name.textContent = folderLabel(model);
    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = [upperFirst(ruleBrief(rule)), knownThread(model) ? "" : "not downloaded yet"].filter(Boolean).join(" · ");
    text.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "dl-row-actions";
    const edit = downloadButton("Edit", () => editModelRule(model));
    edit.setAttribute("aria-label", `Edit the settings for ${folderLabel(model)}`);
    actions.append(edit);
    const payload = downloadModelPayload(model);
    if (payload) {
      const go = downloadButton("Download", () => submitDownload(downloadModelPayload(model) || payload));
      go.setAttribute("aria-label", `Download ${folderLabel(model)}`);
      actions.append(go);
    }
    const remove = downloadButton("Remove", () => saveModelRule({ model, byUrl: false }, null, { clear: true }), "text-button small-button dl-rule-remove");
    remove.setAttribute("aria-label", `Remove the settings for ${folderLabel(model)}`);
    actions.append(remove);
    item.append(text, actions);
    return item;
  }));
}

function bindRuleEditor() {
  ruleEditor.control = buildDownloadOptions("dlRuleOpt");
  el("dlRuleOptions").append(ruleEditor.control.box);
  const input = el("dlRuleModel");
  input.addEventListener("focus", loadRuleChoices);
  input.addEventListener("input", () => chooseRuleTarget(false));
  input.addEventListener("change", () => chooseRuleTarget(true));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    chooseRuleTarget(true);
  });
  el("dlRuleOptions").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.tagName !== "INPUT") return;
    event.preventDefault();
    saveRuleEditor();
  });
  el("dlRuleSave").addEventListener("click", () => saveRuleEditor());
  el("dlRuleGo").addEventListener("click", () => saveRuleEditor({ download: true }));
  el("dlRuleClear").addEventListener("click", () => saveRuleEditor({ clear: true }));
}

/* ---- the Download settings sheet (model page, bookmarks, known threads) ---- */

// target: { model, url, byUrl }; go(model) starts its download (Save and
// download), resolving to the job or null; without go that button is hidden.
function openRuleDialog({ title, target, go = null }) {
  const dialog = el("dlDialog");
  if (!downloadDialog.control) {
    downloadDialog.control = buildDownloadOptions("dlDialogOpt");
    el("dlDialogBody").append(downloadDialog.control.box);
  }
  downloadDialog.target = target;
  downloadDialog.go = go;
  downloadDialog.control.set(ruleValues(modelRule(target.model)));
  downloadDialog.opener = document.activeElement;
  downloadDialog.openerModel = document.activeElement?.dataset?.ruleModel || "";
  el("dlDialogTitle").textContent = title || folderLabel(target.model);
  syncRuleDialog();
  dialog.hidden = false;
  window.requestAnimationFrame(() => dialog.classList.add("open"));
  // Not the page field: on a phone that pops the keyboard over the sheet.
  el("dlDialogClose").focus({ preventScroll: true });
}

function syncRuleDialog() {
  const { target, go } = downloadDialog;
  const rule = modelRule(target.model);
  el("dlDialogMeta").textContent = [threadReadWords(knownThread(target.model)),
    rule ? `Saved: ${ruleBrief(rule)}.` : "Nothing saved yet: its downloads take everything."].join(" ");
  el("dlDialogClear").hidden = !rule;
  el("dlDialogGo").hidden = !go;
}

function closeDownloadDialog() {
  const dialog = el("dlDialog");
  if (dialog.hidden) return;
  dialog.classList.remove("open");
  downloadDialog.go = null;
  // A list re-rendered after the save replaced the button that opened it: its twin.
  let opener = downloadDialog.opener;
  if (!opener?.isConnected && downloadDialog.openerModel) {
    opener = [...document.querySelectorAll("[data-rule-model]")].find((node) => node.dataset.ruleModel === downloadDialog.openerModel);
  }
  if (opener?.getClientRects().length) opener.focus({ preventScroll: true });
  window.setTimeout(() => {
    if (!dialog.classList.contains("open")) dialog.hidden = true;
  }, 180);
}

// action: "save", "go" (save and download) or "clear".
async function submitRuleDialog(action) {
  const { control, target, go } = downloadDialog;
  if (!target || el("dlDialog").hidden || el("dlDialogSave").disabled) return;
  if (action !== "clear" && control.request().error) {
    toast(control.request().error);
    control.pages.focus();
    return;
  }
  const buttons = ["dlDialogSave", "dlDialogGo", "dlDialogClear"].map(el);
  buttons.forEach((button) => { button.disabled = true; });
  const result = await saveModelRule(target, control.values, { clear: action === "clear", go: action === "go" ? go : null });
  buttons.forEach((button) => { button.disabled = false; });
  if (result && (action !== "go" || result.job)) {
    closeDownloadDialog();
  } else if (result) {
    syncRuleDialog(); // saved, but the download did not start: stay, say what is saved
  }
}

function bindDownloadDialog() {
  const dialog = el("dlDialog");
  el("dlDialogClose").addEventListener("click", closeDownloadDialog);
  el("dlDialogCancel").addEventListener("click", closeDownloadDialog);
  el("dlDialogSave").addEventListener("click", () => submitRuleDialog("save"));
  el("dlDialogGo").addEventListener("click", () => submitRuleDialog("go"));
  el("dlDialogClear").addEventListener("click", () => submitRuleDialog("clear"));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDownloadDialog();
  });
  // The sheet owns the keyboard while open: Esc closes it, Tab stays inside,
  // and the page's own keys (mode shortcuts) wait.
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeDownloadDialog();
    } else if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll("button, input")].filter((node) => !node.disabled && node.getClientRects().length);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === "Enter" && event.target.tagName === "INPUT") {
      event.preventDefault();
      submitRuleDialog("save");
    }
  });
}

// A "Settings" button that opens the sheet for one model; data-rule-model
// lets focus find its replacement after a re-render.
function ruleSettingsButton(model, label, open) {
  const button = downloadButton("Settings", open);
  button.dataset.ruleModel = model;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-label", `Download settings for ${label}`);
  return button;
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
  bindRuleEditor();
  bindDownloadDialog();
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
    const ruled = modelRulesReady() && Object.keys(downloads.status?.rules || {}).length;
    const rules = ruled ? `\nModels with download settings follow them (${plural(ruled, "model", "models")}).` : "";
    if (!window.confirm(`Download ${limit ? `the first ${limit} models on ` : "every model on "}${what}? This can take hours.${rules}`)) return;
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
  el("dlLaterRun").addEventListener("click", () => submitDownload({ action: "later" }));
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
  el("modelDownload").addEventListener("click", () => {
    const model = state.ranked.model;
    openRuleDialog({
      target: { model, url: modelThreadUrl(model), byUrl: false },
      go: () => submitDownload({ action: "update", model }),
    });
  });
}

// Model page: New posts and Download settings when simp knows the model's
// thread (Download settings only on a server that keeps them), and what its
// downloads are limited to, so a filtered model looks filtered.
async function syncModelUpdate(model) {
  const button = el("modelUpdate");
  const sync = () => {
    const thread = knownThread(model);
    button.hidden = !thread;
    el("modelDownload").hidden = !thread || !modelRulesReady();
    syncModelRule(model);
    return thread;
  };
  sync();
  if (!state.features.has("simp")) return;
  await loadDownloadStatus();
  if (state.ranked.model !== model) return;
  const thread = sync();
  if (thread) button.title = `Download what is new in ${thread.url}`;
}

function syncModelRule(model) {
  const brief = ruleBrief(modelRule(model));
  el("modelRule").textContent = brief ? `Downloads: ${brief}` : "";
  el("modelRule").hidden = !brief;
}
