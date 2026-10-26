/* ==========================================================================
   Privacy — a plain tab title, and the PIN lock

   The PIN lock is enforced by the server (see server.py): while locked, every
   API call and every media request answers 401, and this screen is all the
   page can show. With a PIN set it is asked every time: when the page opens,
   and whenever it was hidden (another app or tab, the screen off), for
   however short a time.
   ========================================================================== */

Object.assign(MODE_DEFAULTS, { useMarks: true, neutralTitle: false, toyAuto: false, toyMax: 0.7 });

const NEUTRAL_TITLE = "Notes";
const NEUTRAL_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23e8e8e8'/%3E%3Cpath d='M9 10h14M9 16h14M9 22h9' stroke='%23999' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E";
let ownIcon = "";

function syncDocumentTitle() {
  const neutral = state.settings.neutralTitle || state.locked;
  const mode = state.currentMode;
  document.title = neutral ? NEUTRAL_TITLE : mode === "home" ? "Edging Heaven" : `${workspaceNames[mode]} · Heaven`;
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) {
    ownIcon ||= icon.getAttribute("href");
    icon.setAttribute("href", neutral ? NEUTRAL_ICON : ownIcon);
  }
}

/* ---- PIN lock ---- */

const lockPad = { pin: "", busy: false, waitTimer: 0, enabled: false };

class LockedError extends Error {
  constructor() {
    super("Locked");
    this.locked = true;
  }
}

function showLockScreen() {
  if (state.locked) return;
  state.locked = true;
  lockPad.enabled = true;
  quietAllModes();
  document.querySelectorAll("video").forEach((video) => releaseVideo(video));
  el("lockScreen").hidden = false;
  document.body.classList.add("locked");
  lockPad.pin = "";
  syncLockPad("Enter your PIN");
  syncDocumentTitle();
  fetchJson("/api/lock").then((status) => startLockWait(status.retryAfter)).catch(() => {});
}

// The server forgets this device's unlock first, so a reload or another tab
// cannot skip the PIN either. sendBeacon still goes out while a phone puts
// the browser in the background, which a plain fetch may not.
function lockOnLeave() {
  if (!lockPad.enabled || state.locked) return;
  const body = new Blob(["{}"], { type: "application/json" });
  if (!navigator.sendBeacon("/api/lock/logout", body)) {
    fetch("/api/lock/logout", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  }
  showLockScreen();
}

// Opening the page asks too, however recently this device unlocked. Runs
// before the library loads, which then meets the lock and shows the pad.
async function requirePinOnOpen() {
  try {
    const status = await fetchJson("/api/lock");
    lockPad.enabled = !!status.enabled;
    if (status.enabled && status.unlocked) await postJson("/api/lock/logout", {});
  } catch (error) {
    /* an older server or no connection: loading the library finds out */
  }
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
    resumeCurrentMode();
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
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) lockOnLeave();
  });
  window.addEventListener("pagehide", lockOnLeave);
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
  lockPad.enabled = !!status.enabled;
  el("pinStatus").textContent = status.enabled
    ? "PIN is on. It is asked every time you open this page or come back to it from another app or tab."
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
  const cards = [el("privacyCard"), el("playbackCard"), el("streaksCard"), el("toyCard")];
  cards.forEach((card) => bindSettingControls(card, (key) => {
    if (key === "neutralTitle") syncDocumentTitle();
    if (key === "showStreaks") thrillSettingChanged(key);
  }));
  bindToyPanel();
  bindLockScreen();
}

function syncPrivacyCards() {
  [el("privacyCard"), el("playbackCard"), el("streaksCard"), el("toyCard")].forEach(syncSettingControls);
  syncPinCard();
  syncToyPanel();
}

// What coming back to a mode means, for visibility and unlocking alike.
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
