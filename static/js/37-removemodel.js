/* ==========================================================================
   Remove a model (Settings, and Remove… on a Bookmarks card)

   Pick a model, see what removing it erases, type its name, delete. Two
   scopes, both permanent (nothing goes through the trash):
   - From the drive: its folder, its files in the trash, half-finished
     downloads, everything the app remembers about its files, and downloads
     waiting for it (failed files, Bunkr links). The downloader still
     remembers what it fetched, so downloading it again brings only new posts.
   - Full reset: also the downloader's memory of it (the thread, every link
     and cyberdrop-dl file it fetched), so downloading again starts over at
     page 1 and fetches everything.
   ========================================================================== */

const modelReset = { model: "", preview: null, scope: "drive", loading: 0, running: false };

function modelResetSupported() {
  return state.features.has("modelReset");
}

// Every model there is something of: a folder in the library, or simp's
// records of a thread, failed files or Bunkr links waiting.
function resettableModels() {
  const library = libraryModels();
  const names = new Set(library.keys());
  const status = downloads.status;
  [...(status?.threads || []), ...(status?.failed || []), ...(status?.later || [])]
    .forEach((row) => row.model && names.add(row.model));
  return [...names]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => ({ name, files: library.get(name)?.files || 0 }));
}

async function syncModelResetCard() {
  const card = el("modelResetCard");
  card.hidden = !modelResetSupported();
  if (card.hidden) return;
  // The downloader's models too, when it is set up; the library's alone otherwise.
  if (state.features.has("simp") && !downloads.status) await loadDownloadStatus();
  renderModelResetPicker();
}

function renderModelResetPicker() {
  const pick = el("modelResetPick");
  const models = resettableModels();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = models.length ? "Choose a model…" : "No models yet";
  pick.replaceChildren(first, ...models.map(({ name, files }) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = files ? `${name} · ${plural(files, "file", "files")}` : `${name} · not on the drive`;
    return option;
  }));
  // A model removed meanwhile (here or on another device) drops out.
  if (modelReset.model && !models.some(({ name }) => name === modelReset.model)) {
    modelReset.model = "";
    modelReset.preview = null;
  }
  pick.value = modelReset.model;
  renderModelReset();
}

async function chooseModelReset(model) {
  modelReset.model = model;
  modelReset.preview = null;
  el("modelResetConfirm").value = "";
  const ticket = ++modelReset.loading;
  renderModelReset();
  if (!model) return;
  try {
    const preview = await fetchJson(`/api/model-reset?model=${encodeURIComponent(model)}`);
    if (ticket !== modelReset.loading) return;
    modelReset.preview = preview;
    // Nothing on the drive: only a full reset has anything to do.
    modelReset.scope = !preview.drive ? "full" : "drive";
  } catch (error) {
    if (ticket !== modelReset.loading) return;
    modelReset.preview = { error: error.message };
  }
  renderModelReset();
}

function modelResetFacts(preview) {
  const facts = [];
  const add = (label, text) => text && facts.push([label, text]);
  const drive = preview.drive;
  const records = preview.records || {};
  if (drive?.onDrive) {
    const other = drive.files - drive.media;
    add("On the drive", `${plural(drive.media, "photo or video", "photos and videos")}`
      + `${other > 0 ? ` and ${plural(other, "other file", "other files")}` : ""}, ${formatBytes(drive.bytes)}`);
  }
  if (drive?.trashFiles) add("In the trash", `${plural(drive.trashFiles, "file", "files")}, ${formatBytes(drive.trashBytes)}`);
  if (records.stagingFiles) {
    add("Half-downloaded", `${plural(records.stagingFiles, "file", "files")}, ${formatBytes(records.stagingBytes)}, not in the library yet`);
  }
  const given = drive?.remembered || {};
  add("Your ratings", [
    given.kept && `${given.kept.toLocaleString()} kept`,
    given.loved && `${given.loved.toLocaleString()} loved`,
    given.passed && `${given.passed.toLocaleString()} passed`,
    given.marked && plural(given.marked, "clip with marks", "clips with marks"),
    given.dueled && `${given.dueled.toLocaleString()} duel-ranked`,
    given.keptInDangerous && `${given.keptInDangerous.toLocaleString()} kept in Dangerous`,
  ].filter(Boolean).join(", "));
  add("Waiting to download", [
    records.failed && plural(records.failed, "failed file to retry", "failed files to retry"),
    records.later && plural(records.later, "Bunkr link", "Bunkr links"),
  ].filter(Boolean).join(", "));
  add("Downloader remembers", [
    records.thread && (records.lastPage ? `the thread, read to page ${records.lastPage}` : "the thread"),
    records.links && plural(records.links, "link fetched", "links fetched"),
    records.cdlFiles && plural(records.cdlFiles, "cyberdrop-dl file", "cyberdrop-dl files"),
  ].filter(Boolean).join(", "));
  return facts;
}

function renderModelReset() {
  const preview = modelReset.preview;
  const details = el("modelResetDetails");
  const status = el("modelResetStatus");
  status.hidden = !modelReset.model || !!(preview && !preview.error);
  status.textContent = preview?.error || "Looking at what is stored…";
  details.hidden = !preview || !!preview.error;
  if (details.hidden) return;

  el("modelResetFacts").replaceChildren(...modelResetFacts(preview).map(([label, text]) => {
    const row = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = `${label}: `;
    row.append(name, text);
    return row;
  }));

  // Without any downloader records both scopes do the same; without anything
  // on the drive only a full reset has work to do.
  const known = !!preview.records?.known;
  el("modelResetScope").hidden = !known;
  if (!known) modelReset.scope = "drive";
  el("modelResetScope").querySelector('[data-reset-scope="drive"]').disabled = !preview.drive;
  syncSegmented(el("modelResetScope"), "resetScope", modelReset.scope);
  const full = modelReset.scope === "full";
  el("modelResetScopeHint").textContent = !known
    ? "The downloader has nothing on this model, so this deletes its files and what the app remembers about them."
    : full
      ? "Deletes everything above, and the downloader forgets the model completely: downloading its thread again starts at page 1 and fetches everything, like the first time."
      : "Deletes everything above except what the downloader remembers. Downloading the thread again brings only posts that are new since the last download; the files you remove stay gone.";

  const busy = preview.busy?.[modelReset.scope] || "";
  el("modelResetBusy").hidden = !busy;
  el("modelResetBusy").textContent = busy;
  el("modelResetName").textContent = modelReset.model;
  const typed = el("modelResetConfirm").value.trim() === modelReset.model;
  const go = el("modelResetGo");
  go.disabled = !typed || !!busy || modelReset.running;
  go.textContent = modelReset.running ? "Deleting…" : full ? "Delete and forget for good" : "Delete for good";
}

async function runModelReset() {
  const model = modelReset.model;
  const full = modelReset.scope === "full";
  if (!model || modelReset.running) return;
  modelReset.running = true;
  renderModelReset();
  try {
    const result = await postJson("/api/model-reset", {
      model, confirm: el("modelResetConfirm").value.trim(), library: state.currentMediaDirectory, full,
    });
    forgetModelLocally(model);
    const free = Number.isFinite(result.freeBytes) ? ` ${formatBytes(result.freeBytes)} free on the drive now.` : "";
    toast(`Removed ${model}${full ? " and the downloader's memory of it" : ""}. Freed ${formatBytes(result.freedBytes)}.${free}`, 10000);
    modelReset.model = "";
    modelReset.preview = null;
    el("modelResetConfirm").value = "";
    await loadState({ rebuild: true });
    if (state.features.has("simp")) await loadDownloadStatus();
    if (state.currentMode === "bookmarks") renderBookmarks(true);
  } catch (error) {
    toast(error.message);
    // Why it was refused (a download started meanwhile) is in a fresh preview.
    if (modelReset.model === model) await chooseModelReset(model);
  } finally {
    modelReset.running = false;
    renderModelResetPicker();
  }
}

// Its files are gone: undo can no longer bring any of them back, and its
// model page has nothing to show.
function forgetModelLocally(model) {
  const hers = (path) => typeof path === "string" && path.startsWith(`${model}/`);
  dangerous.history = dangerous.history.filter((entry) => !hers(entry.item?.path));
  cleanup.history = cleanup.history.filter((entry) =>
    !entry.trashed.some((done) => hers(done.item?.path)) && !(entry.kept || []).some((kept) => hers(kept?.path ?? kept)));
  syncCleanupButtons();
  syncDangerousActions();
  if (state.ranked.model === model) state.ranked.model = null;
}

// Remove… on a Bookmarks card: Settings, with that model picked.
async function openModelReset(model) {
  state.themePanelVisible = true;
  state.setupVisible = false;
  syncLibraryChrome();
  await syncModelResetCard();
  el("modelResetPick").value = model;
  if (el("modelResetPick").value !== model) return;
  await chooseModelReset(model);
  el("modelResetCard").scrollIntoView({ block: "start", behavior: "smooth" });
}

function bindModelReset() {
  el("modelResetPick").addEventListener("change", (event) => chooseModelReset(event.target.value));
  bindSegmented(el("modelResetScope"), "resetScope", (value) => {
    modelReset.scope = value === "full" ? "full" : "drive";
    renderModelReset();
  });
  el("modelResetConfirm").addEventListener("input", renderModelReset);
  el("modelResetConfirm").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !el("modelResetGo").disabled) runModelReset();
  });
  el("modelResetGo").addEventListener("click", runModelReset);
}
