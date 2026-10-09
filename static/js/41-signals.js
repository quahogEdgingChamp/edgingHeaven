/* ==========================================================================
   What you do with a file, beyond rating it

   Smart order (42-smart.js) learns from these as well as from ratings:

   - Watch signals, per file, in watch.json on the server: how often it was
     the one on screen in a deck, Feed or Rediscover (v), how often you moved
     on within SKIP_SECONDS without rating it (s), how often a clip played
     through (c), and the seconds it stayed up (t). An "impression" opens when
     a file comes on screen in one of those modes and closes when the next
     one does, when it is rated or skipped, or when you leave.
   - Rediscover's revisit schedule rides along in the same rows (iv, due).
   - Every duel, in duels.json, refitted into a Bradley-Terry ranking.

   Older servers (no "smart" feature) get none of this: nothing is sent and
   every lookup answers "nothing known".
   ========================================================================== */

const SKIP_SECONDS = 2.5;
const watchState = { map: new Map(), loaded: false, loading: null, pending: [], timer: 0, open: new Map(), version: 0 };

function signalsAvailable() {
  return state.features?.has("smart");
}

function watchRow(path) {
  return watchState.map.get(path) || null;
}

async function loadWatch() {
  if (!signalsAvailable() || watchState.loaded) return;
  watchState.loading ||= fetchJson("/api/watch")
    .then((payload) => {
      Object.entries(payload.watch || {}).forEach(([path, row]) => {
        if (!watchState.map.has(path)) watchState.map.set(path, row);
      });
      watchState.version += 1;
    })
    .catch(() => {})
    .finally(() => {
      watchState.loaded = true;
    });
  await watchState.loading;
}

// `channel` is the mode; one open impression per mode. Re-opening the same
// file (a re-render) keeps the original start time.
function watchBegin(channel, path, media = null) {
  if (!signalsAvailable() || !path) return;
  const open = watchState.open.get(channel);
  if (open?.path === path) {
    open.media = media || open.media;
    return;
  }
  watchEnd(channel, "next");
  watchState.open.set(channel, { path, media, started: performance.now(), rated: false });
}

// A rating made while the file is up: it is a verdict, not a skip.
function watchNoteRated(channel) {
  const open = watchState.open.get(channel);
  if (open) open.rated = true;
}

// outcome: "next" (moved on), "skip", "rated", "left" (mode or tab left).
// review: Rediscover's keep / love / pass / skip, for the revisit schedule.
function watchEnd(channel, outcome, review = null) {
  const open = watchState.open.get(channel);
  if (!open) return;
  watchState.open.delete(channel);
  const seconds = Math.round(((performance.now() - open.started) / 1000) * 10) / 10;
  const rated = open.rated || outcome === "rated";
  const event = {
    path: open.path,
    seconds,
    coverage: playedCoverage(open.media, open.path),
    // Leaving the mode is not a judgement on the file that was up.
    skipped: !rated && outcome !== "left" && seconds < SKIP_SECONDS,
    review,
  };
  applyWatchEvent(event);
  watchState.pending.push(event);
  if (!watchState.timer) watchState.timer = window.setTimeout(flushWatch, 15000);
}

function watchEndAll(outcome = "left") {
  [...watchState.open.keys()].forEach((channel) => watchEnd(channel, outcome));
}

// Share of a clip that has actually played, from the element's own record of
// played ranges, so seeking past the middle does not count as watching it.
// Null for photos, or when the element has moved on to another file.
function playedCoverage(media, path) {
  if (!(media instanceof HTMLVideoElement) || media.dataset.path !== path) return null;
  const duration = media.duration;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  let played = 0;
  for (let index = 0; index < media.played.length; index += 1) {
    played += media.played.end(index) - media.played.start(index);
  }
  return Math.round(clampNumber(played / duration, 0, 1) * 100) / 100;
}

// The same bookkeeping as MediaLibrary.record_watch, so this visit counts
// at once instead of after the next page load.
function applyWatchEvent(event) {
  const row = { v: 0, s: 0, c: 0, t: 0, ...(watchState.map.get(event.path) || {}) };
  row.v += 1;
  row.t = Math.round((row.t + Math.min(event.seconds, 600)) * 10) / 10;
  if (event.skipped) row.s += 1;
  if (event.coverage !== null && event.coverage >= 0.85) row.c += 1;
  const now = Math.floor(Date.now() / 1000);
  row.at = now;
  if (event.review === "keep" || event.review === "love") {
    row.iv = Math.min(3650, typeof row.iv === "number" ? Math.max(3, row.iv * 2.5) : 7);
    row.due = now + Math.round(row.iv * 86400);
  } else if (event.review === "skip" && typeof row.iv === "number") {
    row.due = now + 86400;
  } else if (event.review === "pass") {
    delete row.iv;
    delete row.due;
  }
  watchState.map.set(event.path, row);
  watchState.version += 1;
}

function flushWatch(useBeacon = false) {
  window.clearTimeout(watchState.timer);
  watchState.timer = 0;
  if (!watchState.pending.length || !signalsAvailable()) return;
  const events = watchState.pending.splice(0, 200);
  const body = JSON.stringify({ events });
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/watch", new Blob([body], { type: "application/json" }));
  } else {
    fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  }
  if (watchState.pending.length) watchState.timer = window.setTimeout(flushWatch, 2000);
}

/* ---- every duel, refitted (Bradley-Terry) ----

   Elo only remembers a running score, so the order of your picks matters
   and an early lucky win sticks. Bradley-Terry fits one strength per file
   that explains all the duels at once. Each file also gets one virtual win
   and one virtual loss against an average file, so two duels cannot crown
   a file: strength grows with evidence. Fitted with the MM algorithm
   (Hunter, 2004), a few dozen passes over the log. */

const duelLog = { rows: null, loading: null, fit: null };

async function loadDuelLog(force = false) {
  if (!signalsAvailable()) return;
  if (duelLog.rows && !force) return;
  if (force) duelLog.loading = null;
  duelLog.loading ||= fetchJson("/api/duel-log")
    .then((payload) => {
      duelLog.rows = Array.isArray(payload.log) ? payload.log : [];
      duelLog.fit = null;
    })
    .catch(() => {
      duelLog.rows ||= [];
    });
  await duelLog.loading;
}

function noteDuelLogged(winner, loser) {
  if (!duelLog.rows) return;
  duelLog.rows.push([winner, loser, Math.floor(Date.now() / 1000)]);
  duelLog.fit = null;
}

function noteDuelUndone(winner, loser) {
  if (!duelLog.rows) return;
  for (let index = duelLog.rows.length - 1; index >= 0; index -= 1) {
    if (duelLog.rows[index][0] === winner && duelLog.rows[index][1] === loser) {
      duelLog.rows.splice(index, 1);
      break;
    }
  }
  duelLog.fit = null;
}

function fitBradleyTerry(rows, passes = 60) {
  // Files as numbers, so each pass is plain array arithmetic.
  const index = new Map();
  const id = (path) => {
    let value = index.get(path);
    if (value === undefined) {
      value = index.size;
      index.set(path, value);
    }
    return value;
  };
  const winners = new Int32Array(rows.length);
  const losers = new Int32Array(rows.length);
  rows.forEach(([winner, loser], row) => {
    winners[row] = id(winner);
    losers[row] = id(loser);
  });
  const count = index.size;
  const wins = new Float64Array(count);
  const games = new Float64Array(count);
  for (let row = 0; row < rows.length; row += 1) {
    wins[winners[row]] += 1;
    games[winners[row]] += 1;
    games[losers[row]] += 1;
  }
  const gamma = new Float64Array(count).fill(1);
  const denominator = new Float64Array(count);
  for (let pass = 0; pass < passes; pass += 1) {
    // The virtual win and loss against a fixed average file (strength 1).
    for (let file = 0; file < count; file += 1) denominator[file] = 2 / (gamma[file] + 1);
    for (let row = 0; row < rows.length; row += 1) {
      const share = 1 / (gamma[winners[row]] + gamma[losers[row]]);
      denominator[winners[row]] += share;
      denominator[losers[row]] += share;
    }
    for (let file = 0; file < count; file += 1) gamma[file] = (wins[file] + 1) / denominator[file];
  }
  const fit = new Map();
  for (const [path, file] of index) {
    fit.set(path, { z: Math.log(gamma[file]), n: games[file], w: wins[file] });
  }
  return fit;
}

// Strength in natural-log units (0 = average, +1 = beats an average file
// about 73% of the time). The refit when the log is loaded, else the Elo
// score shrunk toward average while it rests on few duels.
function duelStrength(path) {
  if (duelLog.rows?.length) {
    duelLog.fit ||= fitBradleyTerry(duelLog.rows);
    const row = duelLog.fit.get(path);
    if (row) return row;
  }
  const elo = duel.ratings?.[path];
  if (!elo?.n) return { z: 0, n: 0, w: 0 };
  return { z: (((elo.r - 1500) / 400) * Math.LN10 * elo.n) / (elo.n + 4), n: elo.n, w: null };
}

// Elo-like number for showing the refit next to the running score.
function duelFairScore(path) {
  return Math.round(1500 + (400 * duelStrength(path).z) / Math.LN10);
}
