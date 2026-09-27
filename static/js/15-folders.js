/* ==========================================================================
   Folder picker

   The library is a tree (64 top-level folders, 55 below them on the real
   drive), so the picker is one too: a group row ticks or unticks everything
   under it, and a row's "Only" button narrows the mode to just that branch.
   Search flattens the tree to matching folders. Saved sets are named
   selections any mode can apply in one tap.

   The saved value keeps its old meaning so every older state.json still
   works: [] is "the whole library", and `folderCleared` is the in-memory
   "I unticked everything to start picking" state in which everything still
   plays until the first box is ticked.
   ========================================================================== */

function renderFolderFilters() {
  FOLDER_MODES.forEach(renderFolderFilter);
}

// How many files sit in each folder, cached per catalog.
let folderCountsCache = null;
let folderCountsKey = "";

function folderCounts() {
  if (folderCountsCache && folderCountsKey === state.librarySignature) {
    return folderCountsCache;
  }
  const counts = new Map();
  for (const key of ["images", "videos"]) {
    for (const item of state.library[key] || []) {
      const folder = item.folder || "";
      counts.set(folder, (counts.get(folder) || 0) + 1);
    }
  }
  folderCountsCache = counts;
  folderCountsKey = state.librarySignature;
  return counts;
}

// The folder list as a tree. Real folders (those holding files) are leaves or
// inner nodes; path prefixes that hold nothing themselves become groups.
let folderTreeCache = null;
let folderTreeKey = "";

function folderTree() {
  const folders = state.library.folders || [];
  const key = `${state.librarySignature}:${folders.length}`;
  if (folderTreeCache && folderTreeKey === key) {
    return folderTreeCache;
  }
  const counts = folderCounts();
  const nodes = new Map();
  const root = { path: null, name: "", children: [], own: false, total: 0, leaves: [] };
  const nodeFor = (path) => {
    if (nodes.has(path)) {
      return nodes.get(path);
    }
    const cut = path.lastIndexOf("/");
    const parent = cut === -1 ? root : nodeFor(path.slice(0, cut));
    const node = { path, name: cut === -1 ? path : path.slice(cut + 1), children: [], own: false, total: 0, leaves: [], parent };
    parent.children.push(node);
    nodes.set(path, node);
    return node;
  };
  folders.forEach((folder) => {
    if (folder === "") {
      const node = { path: "", name: "Library root", children: [], own: true, total: 0, leaves: [], parent: root };
      root.children.unshift(node);
      nodes.set("", node);
    } else {
      nodeFor(folder).own = true;
    }
  });
  // Totals and the real folders under each node, bottom-up.
  const settle = (node) => {
    node.children.forEach(settle);
    node.total = (node.own ? counts.get(node.path) || 0 : 0) + node.children.reduce((sum, child) => sum + child.total, 0);
    node.leaves = [...(node.own ? [node.path] : []), ...node.children.flatMap((child) => child.leaves)];
  };
  settle(root);
  folderTreeCache = { root, nodes };
  folderTreeKey = key;
  return folderTreeCache;
}

function folderViewFor(mode) {
  if (!state.folderView[mode]) {
    state.folderView[mode] = { open: new Set(), sort: "name" };
  }
  return state.folderView[mode];
}

// What is ticked right now, as a Set of real folder paths.
function effectiveFolderSelection(mode) {
  const saved = normalizedFolderSelection(`${mode}Folders`);
  if (saved.length) {
    return new Set(saved);
  }
  return state.folderCleared[mode] ? new Set() : new Set(state.library.folders || []);
}

function commitFolderSelection(mode, selected) {
  const folders = state.library.folders || [];
  const next = folders.filter((folder) => selected.has(folder));
  state.settings[`${mode}Folders`] = next.length === 0 || next.length === folders.length ? [] : next;
  state.folderCleared[mode] = next.length === 0;
  invalidateMediaPools();
  renderFolderFilter(mode);
  queueFolderRefresh(mode);
  queueSettingsSave();
}

// Ticking five folders in a row should restart the stage once, not five times.
const folderRefreshTimers = {};
function queueFolderRefresh(mode) {
  window.clearTimeout(folderRefreshTimers[mode]);
  folderRefreshTimers[mode] = window.setTimeout(() => {
    if (isDeckMode(mode) || mode === "feed" || mode === "dangerous" || state.currentMode === mode) {
      refreshMode(mode);
    } else {
      state.feed.dirty ||= mode === "feed";
    }
    syncDrawerSummaries();
  }, 450);
}

function setFolderSelection(mode, all) {
  commitFolderSelection(mode, all ? new Set(state.library.folders || []) : new Set());
}

function setFoldersChecked(mode, paths, checked) {
  const selected = effectiveFolderSelection(mode);
  paths.forEach((path) => (checked ? selected.add(path) : selected.delete(path)));
  commitFolderSelection(mode, selected);
}

function invertFolderSelection(mode) {
  const selected = effectiveFolderSelection(mode);
  commitFolderSelection(mode, new Set((state.library.folders || []).filter((folder) => !selected.has(folder))));
}

function updateFolderSelection(mode, folder, checked) {
  setFoldersChecked(mode, [folder], checked);
}

// Copy this mode's folder choice to every other mode.
function syncFolderSelectionEverywhere(mode) {
  const value = [...(state.settings[`${mode}Folders`] || [])];
  FOLDER_MODES.forEach((other) => {
    if (other !== mode) {
      state.settings[`${other}Folders`] = [...value];
      state.folderCleared[other] = false;
    }
  });
  invalidateMediaPools();
  renderFolderFilters();
  // Only the decks keep a dealt order off screen; everything else re-picks
  // when entered, so re-dealing them all now would be wasted downloads.
  rebuildDeck("swipe");
  renderDeck("swipe");
  rebuildDeck("toktinder");
  renderDeck("toktinder");
  state.feed.dirty = true;
  dangerous.items = [];
  refreshMode(mode);
  queueSettingsSave();
  toast("Folder selection copied to every mode.");
}

/* ---- saved sets ---- */

function sanitizeFolderSets(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((set) => set && typeof set.name === "string" && Array.isArray(set.folders))
    .map((set) => ({ name: set.name.slice(0, 40), folders: set.folders.filter((f) => typeof f === "string") }))
    .slice(0, 24);
}

function saveFolderSet(mode) {
  const selected = [...effectiveFolderSelection(mode)];
  if (!selected.length) {
    toast("Tick some folders first, then save them as a set.");
    return;
  }
  const name = (window.prompt(`Name this set of ${selected.length} folder${selected.length === 1 ? "" : "s"}:`) || "").trim();
  if (!name) {
    return;
  }
  const sets = sanitizeFolderSets(state.settings.folderSets).filter((set) => set.name !== name);
  sets.push({ name, folders: selected });
  state.settings.folderSets = sets;
  queueSettingsSave();
  renderFolderFilters();
  toast(`Saved “${name}”. It is available in every mode.`);
}

function applyFolderSet(mode, set) {
  const available = new Set(state.library.folders || []);
  const folders = set.folders.filter((folder) => available.has(folder));
  if (!folders.length) {
    toast(`None of the folders in “${set.name}” are in this library.`);
    return;
  }
  commitFolderSelection(mode, new Set(folders));
}

function deleteFolderSet(name) {
  if (!window.confirm(`Delete the folder set “${name}”? Folders and files are not touched.`)) {
    return;
  }
  state.settings.folderSets = sanitizeFolderSets(state.settings.folderSets).filter((set) => set.name !== name);
  queueSettingsSave();
  renderFolderFilters();
}

function renderFolderSets(mode, container, selected) {
  container.replaceChildren();
  if (!(state.library.folders || []).length) {
    return;
  }
  const label = document.createElement("span");
  label.className = "fp-sets-label";
  label.textContent = "Sets";
  container.append(label);
  const sets = sanitizeFolderSets(state.settings.folderSets);
  sets.forEach((set) => {
    const matches = set.folders.length === selected.size && set.folders.every((folder) => selected.has(folder));
    const wrap = document.createElement("span");
    wrap.className = `fp-set${matches ? " active" : ""}`;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = set.name;
    apply.title = `${set.folders.length} folders`;
    apply.addEventListener("click", () => applyFolderSet(mode, set));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Delete set ${set.name}`);
    remove.innerHTML = '<svg aria-hidden="true"><use href="#i-x"/></svg>';
    remove.addEventListener("click", () => deleteFolderSet(set.name));
    wrap.append(apply, remove);
    container.append(wrap);
  });
  const save = document.createElement("button");
  save.type = "button";
  save.className = "chip fp-save";
  save.innerHTML = '<svg aria-hidden="true"><use href="#i-plus"/></svg>Save selection';
  save.addEventListener("click", () => saveFolderSet(mode));
  container.append(save);
}

/* ---- rendering ---- */

function nodeCheckState(node, selected) {
  const ticked = node.leaves.filter((leaf) => selected.has(leaf)).length;
  if (!ticked) {
    return "false";
  }
  return ticked === node.leaves.length ? "true" : "mixed";
}

function highlightMatch(target, text, needle) {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at === -1) {
    target.textContent = text;
    return;
  }
  const mark = document.createElement("mark");
  mark.textContent = text.slice(at, at + needle.length);
  target.append(text.slice(0, at), mark, text.slice(at + needle.length));
}

function buildFolderRow(mode, node, depth, selected, { needle = "", flat = false } = {}) {
  const row = document.createElement("div");
  const isGroup = !flat && node.children.length > 0;
  const view = folderViewFor(mode);
  row.className = `fp-row${isGroup ? " is-group" : ""}`;
  row.style.setProperty("--depth", String(depth));
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-checked", nodeCheckState(node, selected));
  if (isGroup) {
    row.setAttribute("aria-expanded", String(view.open.has(node.path)));
    const twisty = document.createElement("button");
    twisty.type = "button";
    twisty.className = "fp-twisty";
    twisty.setAttribute("aria-label", `${view.open.has(node.path) ? "Collapse" : "Expand"} ${node.name}`);
    twisty.innerHTML = '<svg aria-hidden="true"><use href="#i-right"/></svg>';
    twisty.addEventListener("click", () => {
      view.open.has(node.path) ? view.open.delete(node.path) : view.open.add(node.path);
      renderFolderFilter(mode);
    });
    row.append(twisty);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "fp-spacer";
    row.append(spacer);
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fp-toggle";
  const box = document.createElement("span");
  box.className = "fp-box";
  box.innerHTML = '<svg aria-hidden="true"><use href="#i-check"/></svg>';
  const label = document.createElement("span");
  label.className = "fp-label";
  const name = document.createElement("span");
  name.className = "fp-name";
  highlightMatch(name, node.name, needle);
  label.append(name);
  if (flat && node.path && node.path.includes("/")) {
    const parent = document.createElement("span");
    parent.className = "fp-path";
    parent.textContent = node.path.slice(0, node.path.lastIndexOf("/"));
    label.append(parent);
  } else if (isGroup) {
    const sub = document.createElement("span");
    sub.className = "fp-path";
    const inside = node.leaves.length - (node.own ? 1 : 0);
    sub.textContent = `${inside} folder${inside === 1 ? "" : "s"} inside`;
    label.append(sub);
  }
  const count = document.createElement("span");
  count.className = "fp-count";
  count.textContent = node.total.toLocaleString();
  toggle.append(box, label, count);
  toggle.addEventListener("click", () => {
    setFoldersChecked(mode, node.leaves, row.getAttribute("aria-checked") !== "true");
  });
  row.append(toggle);

  const only = document.createElement("button");
  only.type = "button";
  only.className = "fp-only";
  only.textContent = "Only";
  only.setAttribute("aria-label", `Only ${node.name}`);
  only.addEventListener("click", () => commitFolderSelection(mode, new Set(node.leaves)));
  row.append(only);
  return row;
}

function sortedChildren(node, sort) {
  const children = [...node.children];
  if (sort === "count") {
    children.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  } else {
    children.sort((a, b) => (a.path === "" ? -1 : b.path === "" ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true })));
  }
  return children;
}

function renderFolderFilter(mode) {
  const folders = state.library.folders || [];
  const container = controls[`${mode}FolderFilters`];
  const summary = controls[`${mode}FolderSummary`];
  const search = controls[`${mode}FolderSearch`];
  const panel = document.getElementById(`${mode}FolderPanel`);
  const badge = document.getElementById(`${mode}FolderBadge`);
  if (!container || !summary) {
    return;
  }

  const selected = effectiveFolderSelection(mode);
  const cleared = !!state.folderCleared[mode] && !selected.size;
  const all = selected.size === folders.length;
  const counts = folderCounts();
  const totalFiles = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const pickedFiles = [...selected].reduce((sum, folder) => sum + (counts.get(folder) || 0), 0);

  if (badge) {
    badge.textContent = !folders.length || all || cleared ? "All" : `${selected.size}/${folders.length}`;
    badge.classList.toggle("filtered", !!folders.length && !all && !cleared);
  }

  if (!state.libraryReady || !folders.length) {
    summary.textContent = "No folders found yet.";
    container.replaceChildren();
    return;
  }

  summary.innerHTML = "";
  if (cleared) {
    summary.append("Nothing ticked yet — ");
    const dim = document.createElement("span");
    dim.className = "fp-dim";
    dim.textContent = "everything still plays until you pick a folder.";
    summary.append(dim);
  } else {
    const strong = document.createElement("b");
    strong.textContent = all ? `All ${folders.length} folders` : `${selected.size} of ${folders.length} folders`;
    const dim = document.createElement("span");
    dim.className = "fp-dim";
    dim.textContent = ` · ${pickedFiles.toLocaleString()} of ${totalFiles.toLocaleString()} files`;
    summary.append(strong, dim);
  }
  const meter = panel?.querySelector(".fp-meter i");
  if (meter) {
    meter.style.width = `${cleared ? 100 : totalFiles ? Math.round((pickedFiles / totalFiles) * 100) : 0}%`;
  }

  const view = folderViewFor(mode);
  const sortButton = panel?.querySelector('[data-fp="sort"]');
  if (sortButton) {
    sortButton.textContent = view.sort === "count" ? "Most files" : "A–Z";
  }
  const { root } = folderTree();
  const hasGroups = root.children.some((child) => child.children.length);
  const expandButton = panel?.querySelector('[data-fp="expand"]');
  if (expandButton) {
    expandButton.hidden = !hasGroups;
    const anyClosed = [...folderTree().nodes.values()].some((node) => node.children.length && !view.open.has(node.path));
    expandButton.textContent = anyClosed ? "Expand all" : "Collapse all";
  }
  panel?.querySelector('[data-fp-id="FoldersAllButton"]')?.classList.toggle("active", all);
  panel?.querySelector('[data-fp-id="FoldersNoneButton"]')?.classList.toggle("active", cleared);
  const sets = panel?.querySelector('[data-fp="sets"]');
  if (sets) {
    renderFolderSets(mode, sets, selected);
  }

  const scrollHost = container.closest(".drawer-body");
  const scrollTop = scrollHost?.scrollTop || 0;
  const fragment = document.createDocumentFragment();
  const needle = (search?.value || "").trim().toLowerCase();
  if (needle) {
    const matches = [...folderTree().nodes.values()]
      .filter((node) => node.path !== null && node.name.toLowerCase().includes(needle))
      .sort((a, b) => (view.sort === "count" ? b.total - a.total : 0) || a.path.localeCompare(b.path));
    search.placeholder = `Search ${folders.length} folders`;
    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "fp-empty";
      empty.textContent = `No folder matches “${search.value.trim()}”.`;
      fragment.append(empty);
    }
    matches.forEach((node) => fragment.append(buildFolderRow(mode, node, 0, selected, { needle, flat: true })));
  } else {
    const walk = (node, depth) => {
      sortedChildren(node, view.sort).forEach((child) => {
        fragment.append(buildFolderRow(mode, child, depth, selected));
        if (child.children.length && view.open.has(child.path)) {
          walk(child, depth + 1);
        }
      });
    };
    walk(root, 0);
  }
  if (search) {
    search.placeholder = `Search ${folders.length} folders`;
  }
  container.replaceChildren(fragment);
  if (scrollHost) {
    scrollHost.scrollTop = scrollTop;
  }
}

function bindFolderPicker(mode) {
  const panel = document.getElementById(`${mode}FolderPanel`);
  if (!panel) {
    return;
  }
  panel.querySelector('[data-fp="invert"]').addEventListener("click", () => invertFolderSelection(mode));
  panel.querySelector('[data-fp="sort"]').addEventListener("click", () => {
    const view = folderViewFor(mode);
    view.sort = view.sort === "name" ? "count" : "name";
    renderFolderFilter(mode);
  });
  panel.querySelector('[data-fp="expand"]').addEventListener("click", () => {
    const view = folderViewFor(mode);
    const groups = [...folderTree().nodes.values()].filter((node) => node.children.length);
    const anyClosed = groups.some((node) => !view.open.has(node.path));
    view.open = anyClosed ? new Set(groups.map((node) => node.path)) : new Set();
    renderFolderFilter(mode);
  });
}

function normalizedFolderSelection(settingKey) {
  return sanitizeFolderSelection(state.settings[settingKey], state.library.folders || []);
}

function matchesFolderSelection(item, selectedFolders) {
  return !selectedFolders.length || selectedFolders.includes(item.folder || "");
}

let mediaPoolVersion = 0;
const mediaPools = new Map();

function invalidateMediaPools() {
  mediaPoolVersion += 1;
  mediaPools.clear();
}

function mediaPool(key, build) {
  const cached = mediaPools.get(key);
  if (cached && cached.version === mediaPoolVersion) {
    return cached.items;
  }
  const items = build();
  mediaPools.set(key, { version: mediaPoolVersion, items });
  return items;
}

// A mode's own slice of the library: its folders and its Show filter.
function modeSource(mode, key) {
  const selectedFolders = normalizedFolderSelection(`${mode}Folders`);
  const filter = ratingFilterValue(`${mode}RatingFilter`);
  return (state.library[key] || []).filter(
    (item) => matchesFolderSelection(item, selectedFolders) && matchesRatingFilter(item, filter)
  );
}

function getEscalationImages() {
  return modeSource("escalation", "images");
}

function getEscalationVideos() {
  return modeSource("escalation", "videos");
}

function getEscalationMediaItems() {
  return mediaPool("escalation", () => [
    ...getEscalationImages().map((item) => ({ ...item, kind: "photo" })),
    ...getEscalationVideos().map((item) => ({ ...item, kind: "video" })),
  ]);
}

function pickEscalationItem(items) {
  if (!items.length) {
    return null;
  }

  const historyCap = Math.min(Math.max(3, Math.floor(items.length / 3)), 10);
  const recentPaths = state.escalationRecentPaths.slice(-historyCap);
  const chosen = pickBalanced(items, recentPaths, controls.escalationStage?.dataset.path);
  if (!chosen) {
    return null;
  }

  state.escalationRecentPaths.push(chosen.path);
  if (state.escalationRecentPaths.length > historyCap) {
    state.escalationRecentPaths.splice(0, state.escalationRecentPaths.length - historyCap);
  }
  return chosen;
}

function clampNumber(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function lerp(start, end, progress) {
  return start + (end - start) * progress;
}

function sanitizeTheme(value) {
  if (THEMES.has(value)) {
    return value;
  }
  return LEGACY_THEMES[value] || "dark";
}

function sanitizeFolderSelection(value, availableFolders) {
  if (!Array.isArray(value) || !availableFolders.length) {
    return [];
  }

  const allowed = new Set(availableFolders);
  const filtered = value.filter((entry) => typeof entry === "string" && allowed.has(entry));
  if (!filtered.length || filtered.length === availableFolders.length) {
    return [];
  }
  return filtered;
}

function folderLabel(folder) {
  return folder || "Library root";
}

function shuffleArray(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
}

// The deck and the feed are shuffled once and then walked in order, so a flat
// shuffle has the same problem as a flat pick: the first hundred cards mirror
// the library's folder sizes, and the big folders bury the rest. This deals
// the deck folder by folder instead -- one card from each folder per round,
// with the folder order reshuffled every round -- so the first N cards come
// from N different folders and a small folder shows up just as early as a
// large one. Folders run out at different points; those simply drop out.
function shuffleBalanced(items) {
  if (!foldersAreBalanced() || items.length < 2) {
    shuffleArray(items);
    return;
  }

  const groups = groupByFolder(items);
  if (groups.size < 2) {
    shuffleArray(items);
    return;
  }

  const buckets = [...groups.values()];
  buckets.forEach(shuffleArray);

  const dealt = [];
  while (buckets.length) {
    shuffleArray(buckets);
    for (let index = buckets.length - 1; index >= 0; index -= 1) {
      dealt.push(buckets[index].pop());
      if (!buckets[index].length) {
        buckets.splice(index, 1);
      }
    }
  }

  // Written back in place: callers hold a reference to this same array.
  items.length = 0;
  items.push(...dealt);
}

