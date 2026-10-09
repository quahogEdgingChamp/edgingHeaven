/* ==========================================================================
   Choosing what to show next

   Picking an item uniformly at random is not the same as browsing the
   library evenly, because folders are not the same size. In a real library
   the biggest folder can hold 1,000 files and the smallest 12, so uniform
   picking makes the big one 87x more likely and a handful of folders take
   most of the airtime -- every mode ends up replaying the same few.

   So the pick happens in two steps: choose a *folder* first, then an item
   inside it. Every folder then gets the same share of the screen whatever
   its size, and a 12-file folder is no longer invisible. `balancedFolders`
   turns this off and restores flat, per-file random.
   ========================================================================== */

function foldersAreBalanced() {
  return state.settings.balancedFolders !== false;
}

function groupByFolder(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.folder || "";
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

function randomOf(items) {
  return items.length ? items[Math.floor(Math.random() * items.length)] : null;
}

// One item, chosen folder-first. `recentPaths` is skipped where it can be,
// and folders holding a recent pick are deprioritised so the wall/stream
// moves on to a different folder rather than digging through the same one.
// `mode` is the asking mode; in smart order the pick is scored (42-smart.js).
function pickBalanced(items, recentPaths, avoidPath, mode = null) {
  if (!items.length) {
    return null;
  }
  if (smartOn(mode)) {
    return smartPick(items, recentPaths, avoidPath, mode);
  }
  if (!foldersAreBalanced()) {
    return pickFlat(items, recentPaths, avoidPath);
  }

  const recent = new Set(recentPaths || []);
  const groups = groupByFolder(items);

  // Folders still holding something unseen, keyed to those items so the
  // choice of folder and the choice of item do not filter the list twice.
  const fresh = new Map();
  for (const [folder, bucket] of groups) {
    const unseen = bucket.filter((item) => !recent.has(item.path) && item.path !== avoidPath);
    if (unseen.length) {
      fresh.set(folder, unseen);
    }
  }

  // Everything has been seen recently: fall back to any folder, then to any
  // item in it, rather than returning nothing.
  const pool = fresh.size ? fresh : groups;
  const folder = [...pool.keys()][Math.floor(Math.random() * pool.size)];
  const bucket = pool.get(folder);
  const notCurrent = bucket.filter((item) => item.path !== avoidPath);
  return randomOf(notCurrent.length ? notCurrent : bucket);
}

function pickFlat(items, recentPaths, avoidPath) {
  const recent = new Set(recentPaths || []);
  let candidates = items.filter((item) => !recent.has(item.path) && item.path !== avoidPath);
  if (!candidates.length) {
    candidates = items.filter((item) => item.path !== avoidPath);
  }
  if (!candidates.length) {
    candidates = items;
  }
  return randomOf(candidates);
}

function pickWithoutRepeats(items, recentPaths, avoidPath, mode = null) {
  return pickBalanced(items, recentPaths, avoidPath, mode);
}

function pickRandom(items, avoidPath, mode = null) {
  return pickBalanced(items, avoidPath ? [avoidPath] : [], avoidPath, mode);
}

function mediaUrl(path) {
  // A new representation key prevents mixing old cached MP4 ranges with
  // the virtual fast-start byte layout after an upgrade.
  return `/media?path=${encodeURIComponent(path)}&v=3`;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await parseJsonResponse(response);
  if (response.status === 401 && payload?.locked) {
    showLockScreen();
    throw new LockedError();
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const responsePayload = await parseJsonResponse(response);
  if (response.status === 401 && responsePayload?.locked) {
    showLockScreen();
    throw new LockedError();
  }
  if (!response.ok) {
    throw new Error(responsePayload?.error || `Request failed: ${response.status}`);
  }
  return responsePayload;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return { error: text };
  }
}

function formatTimestamp(value) {
  if (!value) {
    return "just now";
  }
  const date = new Date(value);
  return date.toLocaleString();
}

function setLabel(control, value) {
  control.textContent = value;
  if (value) {
    control.title = value;
  } else {
    control.removeAttribute("title");
  }
}

// Transient messages. They used to be written into the swipe/escalation
// status lines, where the next render overwrote them unseen.
function setStatus(message) {
  if (state.libraryReady) {
    toast(message);
  } else {
    controls.setupMessage.textContent = message;
  }
}

// A short buzz on phones that support it, so a rating is felt as well as seen.
function haptic() {
  try {
    navigator.vibrate?.(12);
  } catch (error) {
    /* optional */
  }
}

function syncLibraryChrome() {
  const setupOpen = !state.libraryReady || state.setupVisible;
  const themeOpen = state.libraryReady && state.themePanelVisible;
  controls.setupPanel.hidden = !setupOpen;
  controls.themePanel.hidden = !themeOpen;
  controls.mainContent.hidden = !state.libraryReady;
  controls.rescanButton.disabled = !state.libraryReady;
  // The launcher is the only way to change mode, so it lives and dies with
  // the library the same way the tab bar used to.
  controls.modeMenuButton.hidden = !state.libraryReady;
  controls.themeButton.hidden = !state.libraryReady;
  setButtonLabel(controls.themeButton, themeOpen ? "Close settings" : "Settings", themeOpen ? "i-close" : "i-gear");
  controls.themeButton.classList.toggle("active", themeOpen);
  controls.themeButton.setAttribute("aria-expanded", String(themeOpen));
  if (themeOpen && !state.privacySynced) {
    // Once per opening: it asks the server whether a PIN is set.
    state.privacySynced = true;
    syncPrivacyCards();
    syncModelResetCard();
  } else if (!themeOpen) {
    state.privacySynced = false;
  }
  // Closing the picker is only an option once there is a library to go back to.
  controls.setupCloseButton.hidden = !state.libraryReady;
  controls.mediaDirInput.value = state.currentMediaDirectory || "";
  controls.hubLibraryPath.textContent = state.currentMediaDirectory
    ? `${state.currentMediaDirectory} — updated ${formatTimestamp(state.library.updatedAt)}`
    : "No media folder selected yet.";

  if (state.libraryReady) {
    controls.libraryMeta.textContent = `${state.currentMediaDirectory} | updated ${formatTimestamp(state.library.updatedAt)}`;
    controls.setupMessage.textContent = "Pick a folder path or tap a quick pick to switch libraries.";
    return;
  }

  stopCornerClips();
  stopEscalation();
  pauseToktinderVideo();
  if (state.currentMediaDirectory) {
    controls.libraryMeta.textContent = `${state.currentMediaDirectory} | unavailable`;
    controls.setupMessage.textContent =
      "That folder is unavailable right now. Reconnect the drive; it will load automatically. You can also choose another folder.";
  } else {
    controls.libraryMeta.textContent = "No media folder selected yet.";
    controls.setupMessage.textContent =
      "Choose a folder on your server to start exploring your photos and videos.";
  }
}

function renderMediaChoices() {
  controls.mediaDirChoices.innerHTML = "";
  if (!state.mediaChoices.length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "No quick-pick folders detected.";
    controls.mediaDirChoices.appendChild(empty);
    return;
  }

  state.mediaChoices.forEach((path) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button choice-button";
    button.textContent = path;
    button.addEventListener("click", () => {
      controls.mediaDirInput.value = path;
      chooseMediaDirectory(path);
    });
    controls.mediaDirChoices.appendChild(button);
  });
}

async function chooseMediaDirectory(pathValue) {
  const path = pathValue.trim();
  if (!path) {
    controls.setupMessage.textContent = "Enter a media folder path.";
    return;
  }

  try {
    controls.setupMessage.textContent = `Loading ${path}...`;
    await postJson("/api/media-dir", { path });
    state.setupVisible = false;
    await loadState({ rebuild: true });
  } catch (error) {
    console.error(error);
    controls.setupMessage.textContent = error.message;
  }
}

