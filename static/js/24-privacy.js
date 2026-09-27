/* ==========================================================================
   Privacy — panic cover, a plain tab title, and the PIN lock

   Panic (` or a three-finger tap) silences every mode and covers the page
   with a blank "notes" page; a double tap or ` again brings it back. The
   PIN lock is enforced by the server (see server.py): while locked, every
   API call and every media request answers 401, and this screen is all the
   page can show.
   ========================================================================== */

Object.assign(MODE_DEFAULTS, { useMarks: true, neutralTitle: false, panicOnHide: false, toyAuto: false, toyMax: 0.7 });

const NEUTRAL_TITLE = "Notes";
const NEUTRAL_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23e8e8e8'/%3E%3Cpath d='M9 10h14M9 16h14M9 22h9' stroke='%23999' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E";
let ownIcon = "";

function syncDocumentTitle() {
  const neutral = state.panic || state.settings.neutralTitle || state.locked;
  const mode = state.currentMode;
  document.title = neutral ? NEUTRAL_TITLE : mode === "home" ? "Edging Heaven" : `${workspaceNames[mode]} · Heaven`;
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) {
    ownIcon ||= icon.getAttribute("href");
    icon.setAttribute("href", neutral ? NEUTRAL_ICON : ownIcon);
  }
}

/* ---- panic ---- */

function setPanic(on) {
  if (on === !!state.panic) return;
  state.panic = on;
  el("panicCover").hidden = !on;
  document.body.classList.toggle("panic", on);
  if (on) {
    closeDrawers();
    closeModeLauncher();
    if (!controls.galleryLightbox.hidden) closeLightbox();
    quietAllModes();
    document.querySelectorAll("video").forEach((video) => {
      video.muted = true;
    });
    el("panicCover").focus({ preventScroll: true });
  } else {
    resumeCurrentMode();
  }
  syncDocumentTitle();
  syncWakeLock();
}

function bindPanic() {
  const cover = el("panicCover");
  // Our own double tap: iOS does not reliably send dblclick.
  let lastTap = 0;
  cover.addEventListener("pointerup", () => {
    const now = performance.now();
    if (now - lastTap < 350) {
      lastTap = 0;
      setPanic(false);
    } else {
      lastTap = now;
    }
  });
  window.addEventListener("touchstart", (event) => {
    if (event.touches.length >= 3 && !state.panic && state.libraryReady) {
      setPanic(true);
    }
  }, { passive: true });
  document.addEventListener("visibilitychange", () => {
    // The app switcher shows a snapshot of the page; make it a blank one.
    if (document.hidden && state.settings.panicOnHide && state.libraryReady) {
      setPanic(true);
    }
  });
}

/* ---- PIN lock ---- */

const lockPad = { pin: "", busy: false, waitTimer: 0 };

class LockedError extends Error {
  constructor() {
    super("Locked");
    this.locked = true;
  }
}

function showLockScreen() {
  if (state.locked) return;
  state.locked = true;
  quietAllModes();
  document.querySelectorAll("video").forEach((video) => releaseVideo(video));
  el("lockScreen").hidden = false;
  document.body.classList.add("locked");
  lockPad.pin = "";
  syncLockPad("Enter your PIN");
  syncDocumentTitle();
  fetchJson("/api/lock").then((status) => startLockWait(status.retryAfter)).catch(() => {});
}

function hideLockScreen() {
  state.locked = false;
  el("lockScreen").hidden = true;
  document.body.classList.remove("locked");
  syncDocumentTitle();
}

function syncLockPad(message) {
  el("lockDots").replaceChildren(...Array.from({ length: Math.max(4, lockPad.pin.length) }, (_, index) => {
    const dot = document.createElement("i");
    dot.classList.toggle("filled", index < lockPad.pin.length);
    return dot;
  }));
  if (message !== undefined) el("lockMessage").textContent = message;
}

function startLockWait(seconds) {
  window.clearInterval(lockPad.waitTimer);
  let left = Number(seconds) || 0;
  const pad = el("lockPad");
  const tick = () => {
    pad.classList.toggle("waiting", left > 0);
    pad.querySelectorAll("button").forEach((button) => {
      button.disabled = left > 0;
    });
    if (left > 0) {
      syncLockPad(`Too many wrong PINs. Try again in ${left}s.`);
      left -= 1;
    } else {
      window.clearInterval(lockPad.waitTimer);
      if (el("lockMessage").textContent.startsWith("Too many")) syncLockPad("Enter your PIN");
    }
  };
  tick();
  if (left > 0) lockPad.waitTimer = window.setInterval(tick, 1000);
}

async function submitPin() {
  if (lockPad.busy || lockPad.pin.length < 4) return;
  lockPad.busy = true;
  try {
    const response = await fetch("/api/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: lockPad.pin }),
    });
    const payload = await parseJsonResponse(response);
    lockPad.pin = "";
    if (!response.ok) {
      syncLockPad(payload.error || "Wrong PIN.");
      el("lockPad").classList.remove("shake");
      void el("lockPad").offsetWidth;
      el("lockPad").classList.add("shake");
      if (payload.retryAfter) startLockWait(payload.retryAfter);
      return;
    }
    hideLockScreen();
    await loadState({ rebuild: true });
    loadSeen();
    if (!state.panic) resumeCurrentMode();
  } catch (error) {
    syncLockPad("Could not reach the server.");
  } finally {
    lockPad.busy = false;
  }
}

function pressLockKey(key) {
  if (lockPad.busy) return;
  if (key === "del") {
    lockPad.pin = lockPad.pin.slice(0, -1);
  } else if (key === "ok") {
    submitPin();
    return;
  } else if (/^\d$/.test(key) && lockPad.pin.length < 12) {
    lockPad.pin += key;
  }
  syncLockPad("Enter your PIN");
}

function bindLockScreen() {
  el("lockPad").addEventListener("click", (event) => {
    const button = event.target.closest("[data-key]");
    if (button) pressLockKey(button.dataset.key);
  });
  window.addEventListener("keydown", (event) => {
    if (!state.locked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (/^\d$/.test(event.key)) pressLockKey(event.key);
    else if (event.key === "Backspace") pressLockKey("del");
    else if (event.key === "Enter") pressLockKey("ok");
  }, true);
}

/* ---- Settings: the Privacy card ---- */

async function syncPinCard() {
  const card = el("privacyCard");
  const supported = state.features.has("lock");
  el("pinForm").hidden = !supported;
  if (!supported) {
    el("pinStatus").textContent = "The PIN lock needs the updated server. Restart edging-heaven.service to turn it on.";
    return;
  }
  let status = { enabled: false };
  try {
    status = await fetchJson("/api/lock");
  } catch (error) {
    /* shown as off */
  }
  card.dataset.pin = status.enabled ? "on" : "off";
  el("pinStatus").textContent = status.enabled
    ? "PIN is on. Every device needs it once; each one then stays unlocked for 30 days or until you lock it."
    : "No PIN. Anyone who can open this page can use it.";
  el("pinCurrent").hidden = !status.enabled;
  el("pinSave").textContent = status.enabled ? "Change PIN" : "Set PIN";
  el("pinRemove").hidden = !status.enabled;
  el("pinLockNow").hidden = !status.enabled;
}

async function savePin(remove = false) {
  const current = el("pinCurrent").value.trim();
  const next = el("pinNew").value.trim();
  if (!remove && !/^\d{4,12}$/.test(next)) {
    toast("A PIN is 4 to 12 digits.");
    return;
  }
  try {
    await postJson(remove ? "/api/lock/clear" : "/api/lock/set", remove ? { current } : { pin: next, current });
    el("pinCurrent").value = "";
    el("pinNew").value = "";
    toast(remove ? "PIN removed." : "PIN saved. Other devices will ask for it.");
  } catch (error) {
    toast(error.message);
  }
  syncPinCard();
}

async function lockNow() {
  try {
    await postJson("/api/lock/logout", {});
  } catch (error) {
    /* the lock screen is what matters */
  }
  showLockScreen();
}

function bindPrivacyCards() {
  el("pinSave").addEventListener("click", () => savePin(false));
  el("pinRemove").addEventListener("click", () => {
    if (window.confirm("Remove the PIN? Anyone who can open this page can then use it.")) savePin(true);
  });
  el("pinLockNow").addEventListener("click", lockNow);
  ["pinCurrent", "pinNew"].forEach((id) => {
    el(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") savePin(false);
    });
  });
  const cards = [el("privacyCard"), el("playbackCard"), el("toyCard")];
  cards.forEach((card) => bindSettingControls(card, (key) => {
    if (key === "neutralTitle") syncDocumentTitle();
  }));
  bindToyPanel();
  bindPanic();
  bindLockScreen();
}

function syncPrivacyCards() {
  [el("privacyCard"), el("playbackCard"), el("toyCard")].forEach(syncSettingControls);
  syncPinCard();
  syncToyPanel();
}

// What coming back to a mode means, for visibility, panic and unlocking alike.
function resumeCurrentMode() {
  const mode = state.currentMode;
  if (mode === "escalation") {
    startEscalation();
  } else if (mode === "toktinder") {
    playToktinderVideo();
  } else if (mode === "session") {
    enterSession();
  } else if (mode === "mosaic") {
    startMosaic();
  } else if (mode === "feed") {
    startFeed();
  } else if (MODE_HANDLERS[mode]) {
    MODE_HANDLERS[mode].enter();
  }
}
