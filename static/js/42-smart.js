/* ==========================================================================
   Smart order

   Each mode's Adjust → Order switches between Shuffled (the balanced shuffle
   in 14-picking.js / 15-folders.js) and Smart. Smart does three things:

   1. Scores every file (smartAssess): Love > Keep > unrated > Pass, plus
      novelty (never seen, or not seen for a while), marked moments, duel
      strength, and what you do with it (clips you watch through count up,
      ones you skip within a couple of seconds count down). A file is then
      picked with odds proportional to exp(score), so good files come up
      more often but nothing is ever certain or impossible.
   2. Chooses the folder first, as the balanced shuffle does, but by Thompson
      sampling instead of evenly: every folder has a Beta(keeps, passes)
      belief about how often you keep from it; each pick draws one guess per
      folder from that belief and the highest guess wins. A folder you keep
      a lot usually wins; a folder you have barely rated has a wide belief
      and still wins now and then, which is how it gets a chance to prove
      itself.
   3. Keeps SMART_EXPLORE (1 in 5) of all picks purely random, so the order
      cannot close in on itself.

   Loving something in a deck, Feed or Rediscover pulls up to three similar
   files (same folder, same day, a near fingerprint) forward. Rediscover in
   smart order also brings back kept files on a spaced-repetition schedule.
   Every smart pick remembers why it was chosen; the decks, Feed and
   Rediscover show that next to the file.
   ========================================================================== */

const SMART_EXPLORE = 0.2;
// Picks dealt one by one with fresh Thompson draws; the rest of a long deck
// is dealt round-robin, each folder still in its scored order.
const SMART_HEAD = 600;
// While dealing a deck, a folder keeps its Thompson draw for this many picks
// (the folder just dealt from draws again at once). A fresh draw per folder
// per card is 600 x folders Beta draws, most of a second on a big library.
const SMART_REDRAW = 20;
const SMART_ORDER_MODES = ["swipe", "toktinder", "feed", "rediscover", "escalation", "session", "mosaic", "beat", "redlight", "dice", "spotlight"];
const SMART_DAY = 86400;
const smart = { why: new Map(), recentFolders: new Map(), stats: null, statsKey: "", prints: null, printsLoading: null, primed: false, priming: null };

function smartOn(mode) {
  return !!mode && signalsAvailable() && state.settings[`${mode}Order`] === "smart";
}

function anySmartOn() {
  return SMART_ORDER_MODES.some(smartOn) || (signalsAvailable() && state.settings.ladderRank === "fair");
}

/* ---- 1. one file's score ---- */

// `withReasons` false skips the wording: a deck scores every file, but only
// the ones you reach are ever explained.
function smartAssess(item, withReasons = true) {
  const reasons = withReasons ? [] : null;
  let score = 0;
  if (item.rating === "love") {
    score += 2;
    reasons?.push([2, "you loved it"]);
  } else if (item.rating === "like") {
    score += 1;
    reasons?.push([1, "you kept it"]);
  } else if (item.rating === "dislike") {
    score -= 2;
  }

  const seen = seenAt(item.path);
  if (!seen) {
    score += 0.8;
    reasons?.push([0.8, "never seen"]);
  } else {
    const days = Math.max(0, Date.now() / 1000 - seen) / SMART_DAY;
    const fresh = 0.8 * (1 - Math.exp(-days / 10));
    score += fresh;
    if (days >= 21) reasons?.push([fresh, `not seen since ${timeAgo(seen)}`]);
  }

  if (marksFor(item.path)?.length) {
    score += 0.6;
    reasons?.push([0.6, "has marked moments"]);
  }

  const strength = duelStrength(item.path);
  if (strength.n) {
    const part = 0.6 * clampNumber(strength.z, -2, 2);
    score += part;
    if (strength.z > 0.4) reasons?.push([part, "wins its duels"]);
  }

  const row = watchRow(item.path);
  if (row?.v) {
    score -= (1.5 * (row.s || 0)) / (row.v + 1);
    const through = (row.c || 0) / (row.v + 1);
    score += through;
    if ((row.c || 0) >= 2) reasons?.push([through, "you watch it to the end"]);
    const linger = (row.t || 0) / row.v;
    if (linger >= 10) {
      score += 0.4;
      reasons?.push([0.4, "you linger on it"]);
    }
  }
  if (!reasons) return { score, reasons: [] };
  reasons.sort((a, b) => b[0] - a[0]);
  return { score, reasons: reasons.map(([, text]) => text) };
}

function smartScore(item) {
  return smartAssess(item, false).score;
}

function smartWeight(item) {
  return Math.exp(smartScore(item));
}

/* ---- 2. folders: a Beta belief each, Thompson-sampled ---- */

// Keeps and passes per folder and per model (top-level folder), over the
// whole library. Love counts as two keeps; clips watched through and quick
// skips count a quarter each. Rebuilt when a rating or a watch event lands.
function smartFolderStats() {
  const key = `${mediaPoolVersion}:${watchState.version}`;
  if (smart.stats && smart.statsKey === key) return smart.stats;
  const byFolder = new Map();
  const byModel = new Map();
  const add = (table, name, keeps, passes) => {
    const row = table.get(name) || { keeps: 0, passes: 0 };
    row.keeps += keeps;
    row.passes += passes;
    table.set(name, row);
  };
  for (const list of [state.library.images || [], state.library.videos || []]) {
    for (const item of list) {
      let keeps = item.rating === "love" ? 2 : item.rating === "like" ? 1 : 0;
      let passes = item.rating === "dislike" ? 1 : 0;
      const row = watchRow(item.path);
      if (row) {
        keeps += 0.25 * (row.c || 0);
        passes += 0.25 * (row.s || 0);
      }
      if (!keeps && !passes) continue;
      const folder = item.folder || "";
      add(byFolder, folder, keeps, passes);
      add(byModel, folder.split("/")[0], keeps, passes);
    }
  }
  smart.stats = { byFolder, byModel };
  smart.statsKey = key;
  return smart.stats;
}

function folderBelief(name, table = smartFolderStats().byFolder) {
  const row = table.get(name) || { keeps: 0, passes: 0 };
  return { a: 1 + row.keeps, b: 1 + row.passes };
}

function gaussian() {
  let u = 0;
  while (!u) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// Marsaglia-Tsang; every shape here is at least 1 (the Beta(1, 1) prior).
function sampleGamma(shape) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = gaussian();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(a, b) {
  const x = sampleGamma(a);
  return x / (x + sampleGamma(b));
}

// The folder with the highest draw. `avoid` (the last two picked) sits out
// while there are other folders, so one strong folder cannot take every
// turn in a row. `draws` reuses draws already made (a deck being dealt).
function thompsonChoose(names, table, avoid = [], draws = null) {
  const skip = names.length > avoid.length + 1 ? new Set(avoid) : new Set();
  let best = null;
  let bestDraw = -1;
  for (const name of names) {
    if (skip.has(name)) continue;
    let draw = draws?.get(name);
    if (draw === undefined) {
      const belief = folderBelief(name, table);
      draw = sampleBeta(belief.a, belief.b);
    }
    if (draw > bestDraw) {
      bestDraw = draw;
      best = name;
    }
  }
  return best ?? names[0];
}

function folderReason(name, table = smartFolderStats().byFolder) {
  const { a, b } = folderBelief(name, table);
  return a + b >= 8 && a / (a + b) >= 0.65 ? "from a folder you keep" : "";
}

/* ---- why each file was picked ---- */

// `text` may be a function, worded the first time it is shown. Read it before
// the file is marked seen, or "never seen" is already untrue.
function setSmartWhy(mode, path, text) {
  if (!smart.why.has(mode)) smart.why.set(mode, new Map());
  smart.why.get(mode).set(path, text);
}

function smartWhy(mode, path) {
  if (!smartOn(mode)) return "";
  const table = smart.why.get(mode);
  let text = table?.get(path) || "";
  if (typeof text === "function") {
    text = text();
    table.set(path, text);
  }
  return text;
}

function whyText(...parts) {
  return parts.filter(Boolean).slice(0, 2).join(" · ");
}

/* ---- a whole deck ---- */

// Efraimidis-Spirakis: one weighted shuffle in a sort. log(u)/w keeps it
// stable for very small and very large weights.
function weightedOrder(list) {
  return list
    .map((item) => ({ item, key: Math.log(Math.random() || 1e-12) / smartWeight(item) }))
    .sort((a, b) => b.key - a.key);
}

function takeFrom(bucket, random) {
  if (random) {
    const index = bucket.next + Math.floor(Math.random() * (bucket.list.length - bucket.next));
    [bucket.list[index], bucket.list[bucket.next]] = [bucket.list[bucket.next], bucket.list[index]];
  }
  return bucket.list[bucket.next++];
}

function smartShuffle(items, mode) {
  if (items.length < 2) return;
  const balanced = foldersAreBalanced();
  const table = smartFolderStats().byFolder;
  const groups = balanced ? groupByFolder(items) : new Map([["", items.slice()]]);
  const buckets = new Map([...groups].map(([folder, list]) => [folder, { list: weightedOrder(list), next: 0 }]));
  const dealt = [];
  const recent = [];

  const deal = (folder, explore) => {
    const bucket = buckets.get(folder);
    const entry = takeFrom(bucket, explore);
    if (bucket.next >= bucket.list.length) buckets.delete(folder);
    const fromFolder = balanced && !explore ? folderReason(folder, table) : "";
    setSmartWhy(mode, entry.item.path, explore ? "wildcard" : () => {
      const reasons = smartAssess(entry.item).reasons;
      return whyText(reasons[0], fromFolder, reasons[1]);
    });
    dealt.push(entry.item);
  };

  const draws = new Map();
  const redraw = (folder) => {
    const belief = folderBelief(folder, table);
    draws.set(folder, sampleBeta(belief.a, belief.b));
  };
  while (buckets.size && dealt.length < SMART_HEAD) {
    const names = [...buckets.keys()];
    if (dealt.length % SMART_REDRAW === 0) names.forEach(redraw);
    const explore = Math.random() < SMART_EXPLORE;
    const folder = names.length === 1 ? names[0] : explore ? randomOf(names) : thompsonChoose(names, table, recent, draws);
    deal(folder, explore);
    if (buckets.has(folder)) redraw(folder);
    recent.push(folder);
    if (recent.length > 2) recent.shift();
  }
  // The long tail: round-robin, as the balanced shuffle deals it.
  while (buckets.size) {
    const names = [...buckets.keys()];
    shuffleArray(names);
    names.forEach((folder) => deal(folder, Math.random() < SMART_EXPLORE));
  }

  items.length = 0;
  items.push(...dealt);
}

/* ---- one pick (Escalation, Session, Mosaic, the timed modes) ---- */

function smartPick(items, recentPaths, avoidPath, mode) {
  if (!items.length) return null;
  const recent = new Set(recentPaths || []);
  let candidates = items.filter((item) => !recent.has(item.path) && item.path !== avoidPath);
  if (!candidates.length) candidates = items.filter((item) => item.path !== avoidPath);
  if (!candidates.length) candidates = items;

  const explore = Math.random() < SMART_EXPLORE;
  let bucket = candidates;
  let folder = null;
  if (foldersAreBalanced()) {
    const groups = groupByFolder(candidates);
    const names = [...groups.keys()];
    const lastFolders = smart.recentFolders.get(mode) || [];
    folder = names.length === 1 ? names[0] : explore ? randomOf(names) : thompsonChoose(names, smartFolderStats().byFolder, lastFolders);
    bucket = groups.get(folder);
    smart.recentFolders.set(mode, [...lastFolders, folder].slice(-2));
  }
  if (explore) {
    const chosen = randomOf(bucket);
    setSmartWhy(mode, chosen.path, "wildcard");
    return chosen;
  }
  const weights = bucket.map(smartWeight);
  let roll = Math.random() * weights.reduce((sum, value) => sum + value, 0);
  let chosen = bucket.at(-1);
  for (let index = 0; index < bucket.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) {
      chosen = bucket[index];
      break;
    }
  }
  setSmartWhy(mode, chosen.path, whyText(smartAssess(chosen).reasons[0], folder !== null ? folderReason(folder) : ""));
  return chosen;
}

/* ---- Spotlight: which model ---- */

function smartSurpriseModel(rows) {
  const names = rows.map((row) => row.model);
  if (Math.random() < SMART_EXPLORE) return randomOf(names);
  return thompsonChoose(names, smartFolderStats().byModel);
}

/* ---- Rediscover: spaced revisits ----

   A kept file is due again a week after you last saw or rated it. Keeping
   it again in Rediscover pushes the next visit out (7 days, then x2.5 each
   time: 17, 44, 109...); a skip asks again tomorrow; a pass takes it off the
   schedule. The schedule lives in watch.json (iv, due). */

function revisitDue(item) {
  const row = watchRow(item.path);
  if (typeof row?.due === "number") return { due: row.due, every: row.iv };
  if (!isKept(item)) return null;
  const rated = item.ratedAt ? Date.parse(item.ratedAt) / 1000 : 0;
  const last = Math.max(seenAt(item.path), Number.isFinite(rated) ? rated : 0);
  return { due: last ? last + 7 * SMART_DAY : 0, every: 7 };
}

// Three lanes dealt in turn: kept files due a revisit (most overdue first),
// never-seen files in smart order, and the rest by how long since you saw
// them, weighted by score.
function smartRediscoverDeal(items, limit) {
  const now = Date.now() / 1000;
  const due = [];
  const never = [];
  const stale = [];
  for (const item of items) {
    const revisit = isKept(item) ? revisitDue(item) : null;
    if (revisit && revisit.due <= now) {
      const overdue = (now - revisit.due) / ((revisit.every || 7) * SMART_DAY);
      due.push({ item, overdue, every: revisit.every });
    } else if (!seenAt(item.path)) {
      never.push(item);
    } else {
      stale.push(item);
    }
  }
  due.sort((a, b) => b.overdue - a.overdue);
  due.forEach(({ item, every }) => setSmartWhy("rediscover", item.path, `due a revisit · every ${Math.round(every || 7)} days`));
  smartShuffle(never, "rediscover");
  const staleOrder = stale
    .map((item) => ({ item, key: (now - seenAt(item.path)) * Math.sqrt(smartWeight(item)) * (0.8 + Math.random() * 0.4) }))
    .sort((a, b) => b.key - a.key)
    .map(({ item }) => {
      setSmartWhy("rediscover", item.path, `not seen since ${timeAgo(seenAt(item.path))}`);
      return item;
    });
  const lanes = [due.map(({ item }) => item), never, staleOrder];
  const dealt = [];
  while (dealt.length < limit && lanes.some((lane) => lane.length)) {
    lanes.forEach((lane) => {
      if (lane.length && dealt.length < limit) dealt.push(lane.shift());
    });
  }
  return dealt;
}

/* ---- more like this ---- */

async function loadSmartPrints() {
  if (smart.prints) return;
  smart.printsLoading ||= fetchJson("/api/fingerprints")
    .then(({ fingerprints }) => {
      smart.prints = new Map();
      Object.entries(fingerprints || {}).forEach(([path, [hash]]) => {
        smart.prints.set(path, [parseInt(hash.slice(0, 8), 16), parseInt(hash.slice(8), 16)]);
      });
    })
    .catch(() => {
      smart.prints = new Map();
    });
  await smart.printsLoading;
}

// Same folder, shot the same day, and a fingerprint that is close but not a
// near-copy (those are Look-alikes' business, and nobody wants the same
// picture twice in a row).
function smartSimilarity(a, b) {
  let score = 0;
  if ((a.folder || "") === (b.folder || "")) score += 1;
  if (a.mtime && b.mtime && Math.abs(a.mtime - b.mtime) < SMART_DAY) score += 0.6;
  const pa = smart.prints?.get(a.path);
  const pb = smart.prints?.get(b.path);
  if (pa && pb) {
    const distance = popcount(pa[0] ^ pb[0]) + popcount(pa[1] ^ pb[1]);
    if (distance <= 6) return 0;
    if (distance <= 22) score += (2 * (22 - distance)) / 16;
  }
  return score;
}

// Moves up to `limit` files like `anchor` from list[from…] to list[from],
// nearest first. Returns how many moved.
function pullSimilarForward(mode, list, from, anchor, limit = 3) {
  if (!smartOn(mode) || from < 0 || from >= list.length) return 0;
  const recentCutoff = Date.now() / 1000 - 3600;
  const picks = [];
  for (let index = from; index < list.length; index += 1) {
    const item = list[index];
    if (item.path === anchor.path || item.rating === "dislike" || seenAt(item.path) > recentCutoff) continue;
    const similarity = smartSimilarity(anchor, item);
    if (similarity >= 1.5) picks.push({ index, similarity });
  }
  picks.sort((a, b) => b.similarity - a.similarity);
  const chosen = picks.slice(0, limit);
  const moving = chosen.map(({ index }) => list[index]);
  chosen.map(({ index }) => index).sort((a, b) => b - a).forEach((index) => list.splice(index, 1));
  list.splice(from, 0, ...moving);
  moving.forEach((item) => setSmartWhy(mode, item.path, "like one you just loved"));
  return moving.length;
}

/* ---- loading what it needs ---- */

// Seen times, watch rows, duel scores and their log, marks and fingerprints.
// Started once a mode is in smart order; decks dealt before it finished are
// dealt again if you have not started on them.
async function primeSmart() {
  if (!signalsAvailable() || !anySmartOn()) return;
  if (smart.primed) return;
  smart.priming ||= Promise.all([
    loadSeen(),
    loadWatch(),
    loadDuelRatings(),
    loadDuelLog(),
    loadMarks(),
    loadSmartPrints(),
  ]).then(() => {
    smart.primed = true;
    redealUntouched();
  });
  await smart.priming;
}

function redealUntouched() {
  ["swipe", "toktinder"].forEach((mode) => {
    const config = deckConfig(mode);
    if (smartOn(mode) && state[config.indexKey] === 0 && !state.history[mode]?.length) {
      rebuildDeck(mode);
      if (state.currentMode === mode) renderDeck(mode);
    }
  });
  if (smartOn("feed") && state.currentMode !== "feed") state.feed.dirty = true;
  if (smartOn("rediscover") && state.currentMode !== "rediscover") rediscover.items = [];
}

/* ---- the Order switch in each drawer ---- */

// The timed modes' drawers already bind every data-setting control; the
// older drawers get their Order section bound here.
const SMART_LEGACY_DRAWERS = ["swipe", "toktinder", "feed", "rediscover", "escalation", "session", "mosaic"];

function bindSmartOrderControls() {
  SMART_LEGACY_DRAWERS.forEach((mode) => {
    const section = document.querySelector(`[data-smart-order="${mode}"]`);
    if (section) bindSettingControls(section, () => smartOrderChanged(mode));
  });
  syncSmartOrderControls();
}

function syncSmartOrderControls() {
  document.querySelectorAll("[data-smart-order]").forEach((section) => {
    section.hidden = !signalsAvailable();
    syncSettingControls(section);
  });
}

async function smartOrderChanged(mode) {
  syncDrawerSummaries();
  if (smartOn(mode)) await primeSmart();
  if (mode === "swipe" || mode === "toktinder") {
    rebuildDeck(mode);
    if (state.currentMode === mode) renderDeck(mode);
  } else if (mode === "feed") {
    state.feed.dirty = true;
    if (state.currentMode === "feed") startFeed();
  } else if (mode === "rediscover") {
    rediscover.items = [];
    if (state.currentMode === "rediscover") startRediscover(true);
  } else if (mode === "spotlight" || mode === "ladder") {
    MODE_HANDLERS[mode]?.refresh();
  }
}

function smartOrderNote(mode) {
  if (mode === "ladder") return signalsAvailable() && state.settings.ladderRank === "fair" ? " Ranked from every duel." : "";
  return smartOn(mode) ? " Smart order." : "";
}
