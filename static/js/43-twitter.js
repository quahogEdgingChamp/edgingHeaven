/* ---- Twitter / X, per model ----
   A model can have one Twitter / X account. simp downloads that account's
   own posts (photos, videos or both, at most so many new files) into the
   model's Twitter folder (`simp twitter`, scrprsimp/src/simp/twitter.py).
   Saved on the server (POST /api/simp/twitter); a download is a job
   {action: "twitter", models}. Edited in one sheet, opened from the
   Downloads page (Add, Edit) and the model page (Twitter / X). A server from
   before this (no status.twitter) hides every part of it. */

const TWITTER_HOSTS = ["x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com", "fixvx.com", "nitter.net"];
// x.com/<these> are pages, not accounts (simpjobs.py TWITTER_NOT_HANDLES).
const TWITTER_NOT_HANDLES = new Set(["home", "explore", "search", "notifications", "messages", "settings", "i", "intent",
  "share", "compose", "login", "logout", "signup", "tos", "privacy", "hashtag", "jobs", "lists", "about"]);
const TWITTER_MAX_FILES = 100000;
const twitterSheet = { model: "", opener: null, values: { handle: "", only: "", maxFiles: "", reposts: false }, listSignature: "" };

function twitterReady(status = downloads.status) {
  return state.features.has("simp") && status?.twitter === true && !!(status.installed && status.configured);
}

function twitterAccount(model) {
  return (twitterReady() && model && downloads.status?.twitterAccounts?.[model]) || null;
}

// "@anna", "anna", "https://x.com/anna/media?s=20" → "anna"; null otherwise.
// The same rules as the server's parse_twitter_handle, so the sheet can say
// what is wrong before saving; the server checks again.
function parseTwitterHandle(text) {
  let handle = String(text || "").trim();
  if (handle.startsWith("@")) {
    handle = handle.slice(1);
  } else if (handle.includes("/") || handle.includes(".")) {
    let url;
    try {
      url = new URL(handle.includes("://") ? handle : `https://${handle}`);
    } catch (error) {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^(www|mobile)\./, "");
    if (!["http:", "https:"].includes(url.protocol) || !TWITTER_HOSTS.includes(host)) return null;
    handle = (url.pathname.split("/").filter(Boolean)[0] || "").replace(/^@/, "");
  }
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) && !TWITTER_NOT_HANDLES.has(handle.toLowerCase()) ? handle : null;
}

// "@anna · videos only · at most 40 new files · with reposts"
function twitterBrief(account) {
  if (!account) return "";
  return [
    `@${account.handle}`,
    account.only === "images" ? "photos only" : account.only === "videos" ? "videos only" : "",
    account.maxFiles > 0 ? `at most ${plural(account.maxFiles, "new file", "new files")}` : "",
    account.reposts ? "with reposts" : "",
  ].filter(Boolean).join(" · ");
}

// When it last ran and what came of it.
function twitterRunWords(model) {
  const run = downloads.status?.twitterRuns?.[model];
  if (!run?.checkedAt) return "Not downloaded yet.";
  return [`Last download ${downloadWhen(run.checkedAt)}`, `${plural(run.new || 0, "new file", "new files")}`,
    run.failed ? `${run.failed.toLocaleString()} failed (the next download tries them again)` : ""].filter(Boolean).join(" · ") + ".";
}

function downloadTwitter(model) {
  return submitDownload({ action: "twitter", models: [model] }, `Downloading ${folderLabel(model)} from Twitter. Follow it in Downloads.`);
}

/* ---- the Downloads page section ---- */

function renderTwitterAccounts() {
  const ready = twitterReady();
  el("dlTwitterSection").hidden = !ready;
  if (!ready) return;
  const accounts = Object.entries(downloads.status.twitterAccounts || {}).sort(([a], [b]) => a.localeCompare(b));
  el("twEmpty").hidden = accounts.length > 0;
  el("twAll").hidden = accounts.length < 2;
  renderTwitterModelChoices();
  const signature = JSON.stringify([accounts, downloads.status.twitterRuns || {}]);
  if (signature === twitterSheet.listSignature) return;
  twitterSheet.listSignature = signature;
  el("twAccounts").replaceChildren(...accounts.map(([model, account]) => {
    const item = document.createElement("li");
    const text = document.createElement("div");
    text.className = "dl-row-text";
    const name = document.createElement("strong");
    name.textContent = folderLabel(model);
    const brief = document.createElement("span");
    brief.className = "dl-rule-brief";
    brief.textContent = twitterBrief(account);
    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = twitterRunWords(model);
    text.append(name, brief, meta);
    const actions = document.createElement("div");
    actions.className = "dl-row-actions";
    const go = downloadButton("Download", () => downloadTwitter(model));
    go.setAttribute("aria-label", `Download ${folderLabel(model)} from Twitter`);
    const edit = downloadButton("Edit", () => openTwitterSheet(model));
    edit.dataset.twitterModel = model;
    edit.setAttribute("aria-haspopup", "dialog");
    edit.setAttribute("aria-label", `Twitter settings for ${folderLabel(model)}`);
    actions.append(go, edit);
    item.append(text, actions);
    return item;
  }));
}

// Suggestions for the Model field: library folders, known threads, accounts.
function renderTwitterModelChoices() {
  const models = new Set([...libraryModels().keys(), ...(downloads.status?.threads || []).map((thread) => thread.model),
    ...Object.keys(downloads.status?.twitterAccounts || {})]);
  const sorted = [...models].sort((a, b) => a.localeCompare(b));
  const list = el("twModelList");
  if (list.dataset.signature === sorted.join("\n")) return;
  list.dataset.signature = sorted.join("\n");
  list.replaceChildren(...sorted.map((model) => {
    const option = document.createElement("option");
    option.value = model;
    return option;
  }));
}

// A folder name the server takes (simpjobs.py valid_model).
function validModelName(name) {
  return !!name && name.length <= 255 && !name.includes("/") && !name.includes("\0") && !name.startsWith(".");
}

// Add: a model (one there is, or a new folder) and an account; with no model
// typed, the folder is named after the account.
function startTwitterAdd() {
  const typedHandle = el("twAddHandle").value.trim();
  const handle = parseTwitterHandle(typedHandle);
  const model = el("twAddModel").value.trim() || handle || "";
  const hint = el("twAddHint");
  let problem = "";
  if (typedHandle && !handle) problem = "That is not a Twitter / X account. Paste its link (https://x.com/name) or @name.";
  else if (!model) problem = "Type a model, or paste the account's link.";
  else if (!validModelName(model)) problem = "A model is one folder name: no “/”, and not starting with a dot.";
  hint.textContent = problem;
  hint.classList.toggle("is-error", !!problem);
  if (problem) return;
  openTwitterSheet(model, handle ? { handle: `@${handle}` } : {});
  twitterSheet.fromAdd = true;
}

/* ---- the sheet ---- */

function twitterRequest(values) {
  const handle = parseTwitterHandle(values.handle);
  const maxText = String(values.maxFiles ?? "").trim();
  const maxFiles = maxText === "" ? 0 : Number(maxText);
  let error = "";
  if (!values.handle.trim()) error = "Paste the account's link (https://x.com/name) or @name.";
  else if (!handle) error = `“${values.handle.trim()}” is not a Twitter / X account. Paste its link or @name.`;
  else if (!Number.isInteger(maxFiles) || maxFiles < 0 || maxFiles > TWITTER_MAX_FILES) {
    error = `Max new files takes a whole number up to ${TWITTER_MAX_FILES.toLocaleString()}; leave it empty for all of them.`;
  }
  const fields = { handle: handle || "", only: values.only, maxFiles: error ? 0 : maxFiles, reposts: !!values.reposts };
  const words = error || [
    `From @${handle}:`,
    values.only === "images" ? "photos only" : values.only === "videos" ? "videos only" : "photos and videos",
    maxFiles ? `· at most ${plural(maxFiles, "new file", "new files")} per download` : "· everything new",
    values.reposts ? "· with reposts" : "",
  ].filter(Boolean).join(" ");
  return { fields, words, error };
}

function syncTwitterSheet() {
  const { values, model } = twitterSheet;
  el("twOnly").querySelectorAll("[data-only]").forEach((button) => {
    const on = button.dataset.only === values.only;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  });
  el("twReposts").setAttribute("aria-checked", String(!!values.reposts));
  const request = twitterRequest(values);
  const readback = el("twReadback");
  // Nothing typed yet is not an error to shout about.
  readback.textContent = values.handle.trim() ? request.words : "Into its Twitter folder, newest posts first.";
  readback.classList.toggle("is-error", !!request.error && !!values.handle.trim());
  el("twHandle").setAttribute("aria-invalid", String(!!values.handle.trim() && !parseTwitterHandle(values.handle)));
  const account = twitterAccount(model);
  el("twDialogMeta").textContent = account ? `Saved: ${twitterBrief(account)}. ${twitterRunWords(model)}` : "No account saved for this model yet.";
  el("twRemove").hidden = !account;
}

function openTwitterSheet(model, preset = {}) {
  const account = twitterAccount(model);
  twitterSheet.model = model;
  twitterSheet.fromAdd = false;
  twitterSheet.values = {
    handle: preset.handle || (account ? `@${account.handle}` : ""),
    only: account?.only === "images" || account?.only === "videos" ? account.only : "",
    maxFiles: account?.maxFiles > 0 ? String(account.maxFiles) : "",
    reposts: account?.reposts === true,
  };
  el("twHandle").value = twitterSheet.values.handle;
  el("twMax").value = twitterSheet.values.maxFiles;
  el("twDialogTitle").textContent = folderLabel(model);
  twitterSheet.opener = document.activeElement;
  syncTwitterSheet();
  const dialog = el("twDialog");
  dialog.hidden = false;
  window.requestAnimationFrame(() => dialog.classList.add("open"));
  // An empty account field takes the focus; otherwise not, so a phone keeps its keyboard down.
  (twitterSheet.values.handle ? el("twDialogClose") : el("twHandle")).focus({ preventScroll: true });
}

function closeTwitterSheet() {
  const dialog = el("twDialog");
  if (dialog.hidden) return;
  dialog.classList.remove("open");
  // A list re-rendered after the save replaced the button that opened it: its twin.
  let opener = twitterSheet.opener;
  if (!opener?.isConnected) {
    opener = [...document.querySelectorAll("[data-twitter-model]")].find((node) => node.dataset.twitterModel === twitterSheet.model);
  }
  if (opener?.getClientRects().length) opener.focus({ preventScroll: true });
  window.setTimeout(() => {
    if (!dialog.classList.contains("open")) dialog.hidden = true;
  }, 180);
}

// action: "save", "go" (save and download) or "remove".
async function submitTwitterSheet(action) {
  const { model, values } = twitterSheet;
  if (!model || el("twDialog").hidden || el("twSave").disabled) return;
  const request = twitterRequest(values);
  if (action !== "remove" && request.error) {
    toast(request.error);
    el("twHandle").focus();
    return;
  }
  if (action === "remove" && !window.confirm(`Remove the Twitter account of ${folderLabel(model)}? Files already downloaded stay.`)) return;
  const buttons = ["twSave", "twGo", "twRemove"].map(el);
  buttons.forEach((button) => { button.disabled = true; });
  let result = null;
  try {
    result = await postJson("/api/simp/twitter", action === "remove" ? { model, handle: "" } : { model, ...request.fields });
  } catch (error) {
    if (!error.locked) toast(error.message);
  }
  buttons.forEach((button) => { button.disabled = false; });
  // A disabled button drops the focus to the page, where Esc and Tab no longer reach the sheet.
  if (!el("twDialog").contains(document.activeElement)) el({ save: "twSave", go: "twGo", remove: "twRemove" }[action]).focus({ preventScroll: true });
  if (!result) return;
  if (downloads.status) downloads.status.twitterAccounts = result.accounts || {};
  twitterSheet.listSignature = "";
  if (state.currentMode === "downloads") renderTwitterAccounts();
  if (state.currentMode === "ranked" && state.ranked.model) syncModelTwitter(state.ranked.model);
  if (twitterSheet.fromAdd && result.account) {
    el("twAddModel").value = "";
    el("twAddHandle").value = "";
  }
  if (action === "go") {
    if (await downloadTwitter(model)) closeTwitterSheet();
    else syncTwitterSheet(); // saved, but the download did not start: stay, say what is saved
    return;
  }
  toast(result.account ? `Saved for ${folderLabel(model)}: ${twitterBrief(result.account)}.` : `No Twitter account for ${folderLabel(model)} now. Its files stay.`);
  closeTwitterSheet();
}

/* ---- the model page ---- */

// Called with the model page's other download buttons (33-downloads.js syncModelUpdate).
function syncModelTwitter(model) {
  const ready = twitterReady();
  const account = twitterAccount(model);
  el("modelTwitter").hidden = !ready;
  el("modelTwitter").dataset.twitterModel = model;
  el("modelTwitterGo").hidden = !account;
  el("modelTwitterGo").title = account ? `Download what is new from @${account.handle}` : "";
  el("modelTwitterLine").textContent = account ? `Twitter: ${twitterBrief(account)}` : "";
  el("modelTwitterLine").hidden = !account;
}

function bindTwitter() {
  const dialog = el("twDialog");
  el("twHandle").addEventListener("input", () => {
    twitterSheet.values.handle = el("twHandle").value;
    syncTwitterSheet();
  });
  el("twMax").addEventListener("input", () => {
    twitterSheet.values.maxFiles = el("twMax").value;
    syncTwitterSheet();
  });
  el("twOnly").addEventListener("click", (event) => {
    const button = event.target.closest("[data-only]");
    if (!button) return;
    twitterSheet.values.only = button.dataset.only;
    syncTwitterSheet();
  });
  el("twReposts").addEventListener("click", () => {
    twitterSheet.values.reposts = !twitterSheet.values.reposts;
    syncTwitterSheet();
  });
  el("twSave").addEventListener("click", () => submitTwitterSheet("save"));
  el("twGo").addEventListener("click", () => submitTwitterSheet("go"));
  el("twRemove").addEventListener("click", () => submitTwitterSheet("remove"));
  el("twCancel").addEventListener("click", closeTwitterSheet);
  el("twDialogClose").addEventListener("click", closeTwitterSheet);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeTwitterSheet();
  });
  // The sheet owns the keyboard while open: Esc closes it, Tab stays inside,
  // and the page's own keys (mode shortcuts) wait.
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeTwitterSheet();
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
      submitTwitterSheet("save");
    }
  });

  el("twAddGo").addEventListener("click", startTwitterAdd);
  ["twAddModel", "twAddHandle"].forEach((id) => el(id).addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    startTwitterAdd();
  }));
  el("twAll").addEventListener("click", () => {
    const count = Object.keys(downloads.status?.twitterAccounts || {}).length;
    submitDownload({ action: "twitter", models: [] }, `Downloading from ${plural(count, "Twitter account", "Twitter accounts")}.`);
  });
  el("modelTwitter").addEventListener("click", () => openTwitterSheet(state.ranked.model));
  el("modelTwitterGo").addEventListener("click", () => downloadTwitter(state.ranked.model));
}
