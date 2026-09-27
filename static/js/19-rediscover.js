/* ==========================================================================
   Rediscover

   A mixed deck ordered by neglect: files never shown anywhere in the app
   first (folder-balanced), then the ones you have not seen for longest.
   Keep / Pass / Skip rate exactly like the other decks.
   ========================================================================== */

const rediscover = { items: [], index: 0, history: [], bound: false, loadingDeal: false };
const REDISCOVER_DEAL = 400;

function bindRediscover() {
  if (rediscover.bound) return;
  rediscover.bound = true;
  el("rediscoverKeep").addEventListener("click", () => actRediscover("keep"));
  el("rediscoverLove").addEventListener("click", () => actRediscover("love"));
  el("rediscoverPass").addEventListener("click", () => actRediscover("pass"));
  el("rediscoverSkip").addEventListener("click", () => actRediscover("skip"));
  el("rediscoverUndoButton").addEventListener("click", undoRediscover);
  el("rediscoverRefresh").addEventListener("click", () => { startRediscover(true); closeDrawers(); });
  el("rediscoverSound").addEventListener("click", () => {
    toggleVideoAudio();
    const video = el("rediscoverVideo");
    video.muted = !state.audioUnlocked;
    if (!video.hidden) video.play().catch(() => {});
  });
  bindSegmented(el("rediscoverKind"), "rediscoverKind", (value) => {
    state.settings.rediscoverKind = value;
    syncSegmented(el("rediscoverKind"), "rediscoverKind", value);
    invalidateMediaPools();
    queueSettingsSave();
    startRediscover(true);
  });
  const card = el("rediscoverCard");
  card.addEventListener("pointerdown", onSwipePointerDown);
  card.addEventListener("pointermove", onSwipePointerMove);
  card.addEventListener("pointerup", onSwipePointerUp);
  card.addEventListener("pointercancel", resetSwipeCard);
  card.dataset.swipeMode = "rediscover";
  el("rediscoverVideo").addEventListener("loadedmetadata", () => {
    const video = el("rediscoverVideo");
    if (state.currentMode === "rediscover") playWhenReady(video, video.dataset.loadToken, null);
  });
}

async function startRediscover(rebuild = false) {
  bindRediscover();
  syncSegmented(el("rediscoverKind"), "rediscoverKind", state.settings.rediscoverKind || "all");
  if (!seenState.loaded) {
    el("rediscoverStatus").textContent = "Looking up what you have seen…";
    await loadSeen();
    if (state.currentMode !== "rediscover") return;
  }
  if (rebuild || !rediscover.items.length) {
    const kind = state.settings.rediscoverKind || "all";
    const items = [
      ...(kind !== "videos" ? modeSource("rediscover", "images").map((item) => ({ ...item, kind: "photo" })) : []),
      ...(kind !== "photos" ? modeSource("rediscover", "videos").map((item) => ({ ...item, kind: "video" })) : []),
    ];
    const never = items.filter((item) => !seenAt(item.path));
    shuffleBalanced(never);
    const seen = items.filter((item) => seenAt(item.path)).sort((a, b) => seenAt(a.path) - seenAt(b.path));
    rediscover.items = [...never, ...seen].slice(0, REDISCOVER_DEAL);
    // Remember what each card said when dealt; seeing it now changes the map.
    rediscover.items.forEach((item) => { item.lastSeen = seenAt(item.path); });
    rediscover.index = 0;
    rediscover.history = [];
  }
  renderRediscover();
}

function currentRediscoverItem() {
  return rediscover.items[rediscover.index] || null;
}

function renderRediscover() {
  if (state.currentMode !== "rediscover") return;
  const item = currentRediscoverItem();
  const image = el("rediscoverImage");
  const video = el("rediscoverVideo");
  const isVideo = item?.kind === "video";
  el("rediscoverEmpty").hidden = !!item;
  image.hidden = !item || isVideo;
  video.hidden = !item || !isVideo;
  resetSwipeCard("rediscover");
  if (!isVideo) releaseVideo(video);
  if (!item || isVideo) image.removeAttribute("src");
  if (item) {
    if (isVideo) {
      video.muted = !state.audioUnlocked;
      loadVideoSource(video, item);
    } else {
      image.dataset.path = item.path;
      image.alt = item.name;
      image.src = mediaUrl(item.path);
    }
    markSeen(item.path);
  }
  const badge = el("rediscoverBadge");
  badge.hidden = !item;
  if (item) {
    badge.textContent = item.lastSeen ? `Last seen ${timeAgo(item.lastSeen)}` : "Never seen";
    badge.classList.toggle("is-new", !item.lastSeen);
  }
  setLabel(el("rediscoverName"), item?.name || "");
  setLabel(el("rediscoverFolder"), item ? item.folder || "Library root" : "");
  el("rediscoverStatus").textContent = item ? `${(rediscover.index + 1).toLocaleString()} / ${rediscover.items.length.toLocaleString()}` : "";
  el("rediscoverProgress").textContent = item ? `${(rediscover.index + 1).toLocaleString()} / ${rediscover.items.length.toLocaleString()}` : "";
  el("rediscoverUndoButton").disabled = !rediscover.history.length;
  ["rediscoverKeep", "rediscoverLove", "rediscoverPass", "rediscoverSkip"].forEach((id) => { el(id).disabled = !item; });
  syncDrawerSummaries();
}

async function actRediscover(action) {
  flushDeckAnimation("rediscover");
  const item = currentRediscoverItem();
  if (!item) return;
  cancelPendingMark();
  const entry = { action, index: rediscover.index, item, previousRating: item.rating ?? null };
  rediscover.history.push(entry);
  rediscover.history = rediscover.history.slice(-60);
  rediscover.index += 1;
  if (action === "skip") {
    animateDeckAdvance("rediscover", "down");
    return;
  }
  const rating = { keep: "like", love: "love" }[action] || "dislike";
  recordRating(item.path, rating, item);
  haptic();
  animateDeckAdvance("rediscover", { keep: "right", love: "up" }[action] || "left");
  try {
    await postJson("/api/rating", { path: item.path, rating });
  } catch (error) {
    recordRating(item.path, entry.previousRating, item);
    rediscover.history = rediscover.history.filter((logged) => logged !== entry);
    rediscover.index = entry.index;
    flushDeckAnimation("rediscover");
    renderRediscover();
    toast("Could not save that rating. Check the connection and try again.");
  }
}

async function undoRediscover() {
  flushDeckAnimation("rediscover");
  const entry = rediscover.history.pop();
  if (!entry) return;
  if (entry.action !== "skip") {
    try {
      await postJson("/api/rating", { path: entry.item.path, rating: entry.previousRating });
      recordRating(entry.item.path, entry.previousRating, entry.item);
    } catch (error) {
      rediscover.history.push(entry);
      toast("Could not undo the last rating.");
      return;
    }
  }
  rediscover.index = entry.index;
  renderRediscover();
  toast(entry.action === "skip" ? "Back one card." : "Rating undone.");
}

