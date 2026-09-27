/* ==========================================================================
   Duel

   Two files side by side; tap (or ←/→) the better one. Each pick is an Elo
   match on the server, so after a few dozen picks the order says which
   favorites are actually the favorites -- something a like can never do.
   Pairs are chosen to be informative: one side is a file with few duels,
   the other is close to it in rating.
   ========================================================================== */

const duel = { ratings: null, loading: null, pair: [], recent: [], history: [], busy: false, count: 0, bound: false };

async function loadDuelRatings(force = false) {
  if (duel.ratings && !force) {
    return;
  }
  if (force) duel.loading = null;
  duel.loading ||= fetchJson("/api/duel")
    .then((payload) => {
      duel.ratings = payload.ratings || {};
    })
    .catch(() => {
      duel.ratings = duel.ratings || {};
    });
  await duel.loading;
}

function duelRating(path) {
  return duel.ratings?.[path] || { r: 1500, n: 0 };
}

function duelPool() {
  const kind = state.settings.duelKind || "photos";
  return mediaPool(`duel:${kind}`, () => [
    ...(kind !== "videos" ? modeSource("duel", "images").map((item) => ({ ...item, kind: "photo" })) : []),
    ...(kind !== "photos" ? modeSource("duel", "videos").map((item) => ({ ...item, kind: "video" })) : []),
  ]);
}

function pickDuelPair() {
  const pool = duelPool();
  if (pool.length < 2) {
    return null;
  }
  const recent = new Set(duel.recent);
  const sample = (count) => Array.from({ length: Math.min(count, pool.length * 2) }, () => pool[Math.floor(Math.random() * pool.length)]);
  const fresh = (list) => list.filter((item) => !recent.has(item.path));
  let firstPool = fresh(sample(14));
  if (!firstPool.length) firstPool = sample(14);
  const first = firstPool.sort((a, b) => duelRating(a.path).n - duelRating(b.path).n)[0];
  const target = duelRating(first.path).r;
  let secondPool = fresh(sample(20)).filter((item) => item.path !== first.path);
  if (!secondPool.length) secondPool = pool.filter((item) => item.path !== first.path);
  secondPool.sort((a, b) => Math.abs(duelRating(a.path).r - target) - Math.abs(duelRating(b.path).r - target));
  const second = secondPool[Math.floor(Math.random() * Math.min(3, secondPool.length))];
  return Math.random() < 0.5 ? [first, second] : [second, first];
}

function duelSides() {
  return [document.getElementById("duelLeft"), document.getElementById("duelRight")];
}

function bindDuel() {
  if (duel.bound) return;
  duel.bound = true;
  duelSides().forEach((side, index) => side.addEventListener("click", () => pickDuelWinner(index)));
  el("duelSkipButton").addEventListener("click", nextDuel);
  el("duelShuffleButton").addEventListener("click", () => { nextDuel(); closeDrawers(); });
  el("duelUndoButton").addEventListener("click", undoDuel);
  bindSegmented(el("duelKind"), "duelKind", (value) => {
    state.settings.duelKind = value;
    syncSegmented(el("duelKind"), "duelKind", value);
    invalidateMediaPools();
    queueSettingsSave();
    nextDuel();
    syncDrawerSummaries();
  });
  el("duelLeadersOpen").addEventListener("click", () => {
    state.settings.rankedSort = "duel";
    queueSettingsSave();
    setMode("ranked");
  });
  el("duelResetButton").addEventListener("click", async () => {
    if (!window.confirm("Forget every duel result? Likes and dislikes stay.")) return;
    const cleared = Object.fromEntries(Object.keys(duel.ratings || {}).map((path) => [path, null]));
    try {
      await postJson("/api/duel-restore", { ratings: cleared });
      duel.ratings = {};
      duel.history = [];
      renderDuelLeaders();
      nextDuel();
      toast("Duel ranking reset.");
    } catch (error) {
      toast(error.message);
    }
  });
}

async function startDuel() {
  bindDuel();
  syncSegmented(el("duelKind"), "duelKind", state.settings.duelKind || "photos");
  await loadDuelRatings();
  if (state.currentMode !== "duel") return;
  if (duel.pair.length === 2 && duel.pair.every((item) => duelPool().some((entry) => entry.path === item.path))) {
    renderDuel();
  } else {
    nextDuel();
  }
}

function nextDuel() {
  if (state.currentMode !== "duel") return;
  duel.pair = pickDuelPair() || [];
  duel.pair.forEach((item) => {
    duel.recent.push(item.path);
    markSeen(item.path);
  });
  duel.recent = duel.recent.slice(-12);
  renderDuel();
}

function renderDuel() {
  const empty = duel.pair.length < 2;
  el("duelEmpty").hidden = !empty;
  if (empty) {
    const filter = ratingFilterValue("duelRatingFilter");
    el("duelEmptyText").textContent = filter === "liked"
      ? "Duel compares what you have kept, and there are fewer than two. Keep a few more in the decks, or set Show to All under Adjust."
      : "Duel needs at least two files in the chosen folders.";
  }
  duelSides().forEach((side, index) => {
    const item = duel.pair[index];
    const image = side.querySelector("img");
    const video = side.querySelector("video");
    side.hidden = empty;
    side.classList.remove("won", "lost");
    if (!item) {
      releaseVideo(video);
      image.removeAttribute("src");
      return;
    }
    const isVideo = item.kind === "video";
    image.hidden = isVideo;
    video.hidden = !isVideo;
    if (isVideo) {
      image.removeAttribute("src");
      video.muted = true;
      const token = loadVideoSource(video, item);
      video.addEventListener("loadedmetadata", () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        playWhenReady(video, token, duration > 6 ? duration * (0.2 + Math.random() * 0.5) : 0);
      }, { once: true });
    } else {
      releaseVideo(video);
      image.dataset.path = item.path;
      image.src = mediaUrl(item.path);
    }
    const rating = duelRating(item.path);
    side.querySelector(".duel-caption strong").textContent = item.name;
    side.querySelector(".duel-caption small").textContent = rating.n
      ? `${Math.round(rating.r)} · ${plural(rating.n, "duel", "duels")}`
      : "first duel";
    side.title = item.path;
  });
  el("duelProgress").textContent = duel.count ? `${duel.count} picked` : "";
  el("duelUndoButton").disabled = !duel.history.length || duel.busy;
  renderDuelLeaders();
  syncDrawerSummaries();
}

async function pickDuelWinner(index) {
  if (duel.busy || duel.pair.length < 2 || state.currentMode !== "duel") return;
  const winner = duel.pair[index];
  const loser = duel.pair[1 - index];
  duel.busy = true;
  const sides = duelSides();
  sides[index].classList.add("won");
  sides[1 - index].classList.add("lost");
  haptic();
  let saved = false;
  try {
    const result = await postJson("/api/duel", { winner: winner.path, loser: loser.path });
    Object.assign(duel.ratings, result.ratings);
    duel.history.push({ before: result.before, pair: [...duel.pair] });
    duel.history = duel.history.slice(-40);
    duel.count += 1;
    saved = true;
  } catch (error) {
    toast("Could not save that pick. If the server was just updated, it needs a restart.");
  }
  window.setTimeout(() => {
    duel.busy = false;
    if (saved) nextDuel();
    else renderDuel();
  }, REDUCED_MOTION.matches ? 0 : 420);
}

async function undoDuel() {
  const entry = duel.history.at(-1);
  if (!entry || duel.busy) return;
  duel.busy = true;
  try {
    await postJson("/api/duel-restore", { ratings: entry.before });
    Object.entries(entry.before).forEach(([path, value]) => {
      if (value) duel.ratings[path] = value;
      else delete duel.ratings[path];
    });
    duel.history.pop();
    duel.count = Math.max(0, duel.count - 1);
    duel.pair = entry.pair;
    toast("Last pick undone.");
  } catch (error) {
    toast(error.message);
  } finally {
    duel.busy = false;
    renderDuel();
  }
}

function duelLeaders(limit) {
  const available = new Map(duelPool().map((item) => [item.path, item]));
  return Object.entries(duel.ratings || {})
    .filter(([path, rating]) => available.has(path) && rating.n >= 2)
    .sort((a, b) => b[1].r - a[1].r)
    .slice(0, limit)
    .map(([path, rating]) => ({ item: available.get(path), rating }));
}

function renderDuelLeaders() {
  const list = el("duelLeaders");
  if (!list) return;
  list.replaceChildren();
  const leaders = duelLeaders(8);
  if (!leaders.length) {
    const empty = document.createElement("li");
    empty.className = "subtle";
    empty.textContent = "Pick a few winners and the top of your ranking appears here.";
    list.append(empty);
    return;
  }
  leaders.forEach(({ item, rating }) => {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = item.name;
    name.title = item.path;
    const score = document.createElement("b");
    score.textContent = Math.round(rating.r);
    row.append(name, score);
    list.append(row);
  });
}

