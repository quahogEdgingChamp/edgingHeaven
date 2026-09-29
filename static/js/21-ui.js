let toastTimer;
// action: { label, run } adds one button (Undo) that closes the toast.
function toast(message, duration = 5000, action = null) {
  const box = el("workspaceToast");
  box.textContent = message;
  box.classList.toggle("has-action", !!action);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      box.hidden = true;
      clearTimeout(toastTimer);
      action.run();
    }, { once: true });
    box.append(" ", button);
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, duration);
}

function setupMediaFeedback() {
  const tracked = new WeakMap();
  function watch(media) {
    if (tracked.has(media) || media.closest(".gallery-grid, .ranked-grid")) return;
    const host = media.closest(".dangerous-card, .swipe-card, .duel-side, .video-slot, .mosaic-tile, .feed-item, .lightbox-media, .stream-stage");
    if (!host) return;
    if (media.tagName === "IMG") media.decoding = "async";
    const overlay = document.createElement("div");
    overlay.className = "media-feedback";
    overlay.hidden = true;
    overlay.innerHTML = '<span class="loading-ring" aria-hidden="true"></span><span role="status">Loading media…</span><div hidden><button class="ghost-button">Retry</button><button class="ghost-button">Skip</button></div>';
    host.append(overlay);
    const record = { timer: null, overlay };
    tracked.set(media, record);
    const done = () => { clearTimeout(record.timer); overlay.hidden = true; };
    const pending = () => {
      done();
      if (!media.getAttribute("src") || media.hidden) return;
      if (media.tagName === "IMG" && media.complete && media.naturalWidth) return;
      overlay.hidden = false;
      overlay.querySelector('[role="status"]').textContent = "Loading media…";
      overlay.querySelector("div").hidden = true;
      record.timer = setTimeout(() => stalled("Taking longer than usual. Retry or skip this file."), 8000);
    };
    const stalled = message => {
      if (!media.getAttribute("src") || media.hidden) return;
      clearTimeout(record.timer);
      overlay.hidden = false;
      overlay.querySelector('[role="status"]').textContent = message;
      overlay.querySelector("div").hidden = false;
    };
    overlay.querySelectorAll("button")[0].addEventListener("click", () => {
      pending();
      if (media.tagName === "VIDEO") {
        media.load();
        media.play().catch(() => {});
      } else { const src = media.src; media.removeAttribute("src"); media.src = src; }
    });
    overlay.querySelectorAll("button")[1].addEventListener("click", () => {
      done();
      if (!controls.galleryLightbox.hidden) stepLightbox(1);
      else if (state.currentMode === "dangerous") actDangerous("skip");
      else if (state.currentMode === "duel") nextDuel();
      else if (state.currentMode === "rediscover") actRediscover("skip");
      else if (isDeckMode(state.currentMode)) skipDeckItem(state.currentMode);
      else if (state.currentMode === "feed") scrollFeedTo(state.feed.activeIndex + 1);
      else if (MODE_HANDLERS[state.currentMode]?.next) MODE_HANDLERS[state.currentMode].next();
      else refreshMode(state.currentMode);
    });
    ["load", "loadeddata", "playing", "canplay"].forEach(event => media.addEventListener(event, done));
    media.addEventListener("waiting", pending);
    media.addEventListener("error", () => stalled("This file could not be played. Retry or skip."));
    new MutationObserver(pending).observe(media, { attributes: true, attributeFilter: ["src"] });
    if (media.getAttribute("src")) pending();
  }
  document.querySelectorAll("img,video").forEach(watch);
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
    if (node.nodeType !== 1) return;
    if (node.matches("img,video")) watch(node);
    node.querySelectorAll("img,video").forEach(watch);
  }))).observe(el("mainContent"), { childList: true, subtree: true });
}

function setupPanelAccessibility() {
  document.querySelectorAll(".drawer").forEach(drawer => {
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-label", drawer.querySelector("h2").textContent);
    drawer.inert = true;
    let previousFocus;
    let wasOpen = false;
    new MutationObserver(() => {
      const open = drawer.getAttribute("aria-hidden") === "false";
      drawer.inert = !open;
      if (open === wasOpen) return;
      wasOpen = open;
      if (open) { previousFocus = document.activeElement; drawer.querySelector(".drawer-header button")?.focus({ preventScroll: true }); }
      else if (previousFocus?.getClientRects().length) previousFocus.focus({ preventScroll: true });
    }).observe(drawer, { attributes: true, attributeFilter: ["aria-hidden"] });
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const dialog = (drawerIsDocked() ? null : document.querySelector('.drawer.open')) || (state.launcherOpen ? controls.modeLauncher : null) || (!controls.galleryLightbox.hidden ? controls.galleryLightbox : null);
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll('button, input, select, summary, [tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (!dialog.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
}

// Overview uses metadata only, so opening the app never downloads a wall of media.
function modeIcon(card) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${card.icon}"/></svg>`;
}

function renderOverview() {
  const groups = el("homeModes");
  groups.replaceChildren();
  MODE_GROUPS.forEach(({ label, modes }) => {
    const group = document.createElement("section");
    group.className = "home-group";
    const heading = document.createElement("h3");
    heading.textContent = label;
    const grid = document.createElement("div");
    grid.className = "home-modes";
    modes.forEach(mode => {
      const card = MODE_CARDS.find(c => c.mode === mode);
      const button = document.createElement("button");
      button.className = "home-mode";
      button.dataset.mode = mode;
      if (MODE_TONES[mode]) button.dataset.tone = MODE_TONES[mode];
      button.innerHTML = `<span class="mode-icon">${modeIcon(card)}</span><strong></strong><p></p><span class="mode-stat"></span><kbd>${modeKey(mode)}</kbd>`;
      button.querySelector("strong").textContent = card.name;
      button.querySelector("p").textContent = card.blurb;
      button.addEventListener("click", () => setMode(mode));
      grid.append(button);
    });
    group.append(heading, grid);
    groups.append(group);
  });
  [["images", "Photos", "gallery"], ["videos", "Videos", "toktinder"], ["liked", "Kept", "ranked"], ["unrated", "Unrated", "swipe"]].forEach(([key, label, mode]) => {
    const button = document.createElement("button");
    button.className = "overview-stat";
    button.dataset.count = key;
    button.innerHTML = `${modeIcon(MODE_CARDS.find(c => c.mode === mode))}<div><strong>0</strong><span>${label}</span></div>`;
    button.addEventListener("click", () => {
      if (key === "unrated") {
        setRatingFilter("swipe", "unrated");
      }
      setMode(mode);
    });
    el("overviewStats").append(button);
  });
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Late night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

// Chips that open a lean-back mode with Show set to Liked.
function renderFavoriteLaunchers(container, title) {
  container.replaceChildren();
  const liked = countOf("liked");
  container.hidden = !liked;
  if (!liked) return;
  const head = document.createElement("span");
  head.className = "fav-title ranked-play-label";
  head.innerHTML = '<svg aria-hidden="true"><use href="#i-heart"/></svg>';
  head.append(title);
  container.append(head);
  ["escalation", "session", "beat", "ladder", "highlights", "mosaic", "feed"].forEach(mode => {
    const card = MODE_CARDS.find(c => c.mode === mode);
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.innerHTML = modeIcon(card);
    chip.append(card.name);
    chip.addEventListener("click", () => playFavorites(mode));
    container.append(chip);
  });
}

function playFavorites(mode) {
  state.settings[`${mode}RatingFilter`] = "liked";
  syncRatingFilter(mode);
  invalidateMediaPools();
  if (mode === "feed") state.feed.dirty = true;
  queueSettingsSave();
  setMode(mode);
  toast(`${workspaceNames[mode]} is showing only what you kept. Change it under Adjust → Show.`);
}

function syncOverview() {
  const counts = state.library.counts || {};
  const total = countOf("images") + countOf("videos");
  const rated = countOf("liked") + Number(counts.disliked || 0);
  document.querySelectorAll(".overview-stat").forEach(button => {
    const key = button.dataset.count;
    const value = key === "unrated" ? Math.max(0, total - rated) : countOf(key);
    button.querySelector("strong").textContent = value.toLocaleString();
  });
  document.querySelectorAll(".home-mode").forEach(button => {
    const card = MODE_CARDS.find(c => c.mode === button.dataset.mode);
    button.querySelector(".mode-stat").textContent = card.stat();
    button.classList.toggle("is-last", button.dataset.mode === state.settings.lastMode);
  });
  const last = MODE_CARDS.find(c => c.mode === state.settings.lastMode) || MODE_CARDS[0];
  el("continueButton").replaceChildren(document.createTextNode(`Continue in ${last.name}`));
  el("continueButton").insertAdjacentHTML("beforeend", '<svg aria-hidden="true"><use href="#i-right"/></svg>');
  el("homeGreeting").textContent = greeting();
  const percent = total ? Math.round((rated / total) * 100) : 0;
  el("homeHeadline").textContent = !total ? "Your library is empty." : rated === 0 ? "Fresh library. Start sorting." : percent >= 100 ? "Everything is sorted." : "Pick up where you left off.";
  el("homeSubline").textContent = total
    ? `${total.toLocaleString()} files · ${countOf("liked").toLocaleString()} kept · ${Math.max(0, total - rated).toLocaleString()} still to rate`
    : "Choose a folder in Settings to begin.";
  el("homeMeterValue").textContent = `${percent}%`;
  el("homeMeterFill").style.strokeDashoffset = String(326.7 * (1 - percent / 100));
  renderFavoriteLaunchers(el("homeFavorites"), "Play your favorites");
}
