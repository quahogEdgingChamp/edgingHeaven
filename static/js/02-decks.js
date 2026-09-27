function isDeckMode(mode) {
  return mode === "swipe" || mode === "toktinder";
}

function deckConfig(mode) {
  if (mode === "swipe") {
    return {
      itemsKey: "swipeItems",
      indexKey: "swipeIndex",
      sourceKey: "images",
      foldersKey: "swipeFolders",
      filterKey: "swipeRatingFilter",
      mediaType: "image",
      emptyTitle: "No photos match the current filter",
      emptyStatus: "Nothing matches. Widen the folder filter, switch Show to All, or rescan.",
      nameControl: "swipeName",
      folderControl: "swipeFolder",
      statusControl: "swipeStatus",
      mediaControl: "swipeImage",
    };
  }

  if (mode === "toktinder") {
    return {
      itemsKey: "toktinderItems",
      indexKey: "toktinderIndex",
      sourceKey: "videos",
      foldersKey: "toktinderFolders",
      filterKey: "toktinderRatingFilter",
      mediaType: "video",
      emptyTitle: "No videos match the current filter",
      emptyStatus: "Nothing matches. Widen the folder filter, switch Show to All, or rescan.",
      nameControl: "toktinderName",
      folderControl: "toktinderFolder",
      statusControl: "toktinderStatus",
      mediaControl: "toktinderVideo",
    };
  }

  return null;
}

function rebuildDeck(mode) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  state.history[mode] = [];
  syncUndoButtons();

  const selectedFolders = normalizedFolderSelection(config.foldersKey);
  const allItems = state.library[config.sourceKey] || [];
  state[config.itemsKey] = allItems.filter((item) => {
    if (!matchesFolderSelection(item, selectedFolders)) {
      return false;
    }
    return matchesRatingFilter(item, ratingFilterValue(config.filterKey));
  });
  shuffleBalanced(state[config.itemsKey]);
  state[config.indexKey] = 0;
}

function currentDeckItem(mode) {
  const config = deckConfig(mode);
  if (!config || !state[config.itemsKey].length) {
    return null;
  }
  return state[config.itemsKey][state[config.indexKey]];
}

function renderDeck(mode) {
  if (state.currentMode !== mode) return;
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  const item = currentDeckItem(mode);
  resetSwipeCard(mode);

  if (!item) {
    clearDeckMedia(mode);
    setLabel(controls[config.nameControl], config.emptyTitle);
    setLabel(controls[config.folderControl], "");
    controls[config.statusControl].textContent = config.emptyStatus;
    return;
  }

  setDeckMedia(mode, item);
  markSeen(item.path);
  syncDrawerSummaries();
  setLabel(controls[config.nameControl], item.name);
  setLabel(controls[config.folderControl], item.folder || "Library root");
  controls[config.statusControl].textContent =
    `${state[config.indexKey] + 1} / ${state[config.itemsKey].length} in current deck`;
}

// Optimistic: the card leaves at once and the save happens behind it. Over
// Tailscale the round trip is long enough to feel, and a failure is rare --
// when it happens the card comes back and says so.
async function rateDeckItem(mode, rating) {
  flushDeckAnimation(mode);
  const config = deckConfig(mode);
  const item = currentDeckItem(mode);
  if (!config || !item) {
    return;
  }

  const previousRating = item.rating ?? null;
  const index = state[config.indexKey];
  recordRating(item.path, rating, item);
  haptic();

  // A rating can push the item out of the current filter (rate something
  // while on "Unrated", dislike something while on "Liked").
  const stillVisible = matchesRatingFilter(item, ratingFilterValue(config.filterKey));
  const entry = { kind: "rate", path: item.path, previousRating, index, removed: !stillVisible, item };
  pushHistory(mode, entry);

  if (!stillVisible) {
    state[config.itemsKey].splice(index, 1);
    if (state[config.indexKey] >= state[config.itemsKey].length) {
      state[config.indexKey] = 0;
    }
  } else if (state[config.itemsKey].length > 1) {
    state[config.indexKey] = (index + 1) % state[config.itemsKey].length;
  }
  animateDeckAdvance(mode, rating === "love" ? "up" : rating === "like" ? "right" : "left");

  try {
    await postJson("/api/rating", { path: item.path, rating });
  } catch (error) {
    console.error(error);
    recordRating(item.path, previousRating, item);
    state.history[mode] = state.history[mode].filter((logged) => logged !== entry);
    syncUndoButtons();
    const items = state[config.itemsKey];
    if (!items.includes(item)) {
      items.splice(clampNumber(index, 0, items.length), 0, item);
    }
    state[config.indexKey] = clampNumber(items.indexOf(item), 0, Math.max(0, items.length - 1));
    flushDeckAnimation(mode);
    renderDeck(mode);
    toast("Could not save that rating. Check the connection and try again.");
  }
}

function skipDeckItem(mode) {
  flushDeckAnimation(mode);
  const config = deckConfig(mode);
  if (!config || !state[config.itemsKey].length) {
    return;
  }
  pushHistory(mode, { kind: "skip", index: state[config.indexKey] });
  state[config.indexKey] = (state[config.indexKey] + 1) % state[config.itemsKey].length;
  animateDeckAdvance(mode, "down");
}

/* The card flies out the way it was rated, and the next one settles in.
   A second action during the flight finishes the first one immediately, so
   nothing is ever rated that has not been on screen. */
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const deckAnimations = {};

function animateDeckAdvance(mode, direction) {
  const card = swipeCardControl(mode);
  if (!card || state.currentMode !== mode || REDUCED_MOTION.matches) {
    renderAnyDeck(mode);
    return;
  }
  card.querySelector("video")?.pause();
  card.classList.remove("enter", "dragging");
  card.style.transform = "";
  card.classList.add(`fly-${direction}`);
  deckAnimations[mode] = window.setTimeout(() => finishDeckAnimation(mode), 190);
}

function finishDeckAnimation(mode) {
  window.clearTimeout(deckAnimations[mode]);
  deckAnimations[mode] = 0;
  const card = swipeCardControl(mode);
  card.classList.remove("fly-left", "fly-right", "fly-down", "fly-up");
  renderAnyDeck(mode);
  void card.offsetWidth;
  card.classList.add("enter");
}

function flushDeckAnimation(mode) {
  if (deckAnimations[mode]) {
    finishDeckAnimation(mode);
  }
}

function setDeckMedia(mode, item) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  if (config.mediaType === "image") {
    controls[config.mediaControl].dataset.path = item.path;
    controls[config.mediaControl].src = mediaUrl(item.path);
    controls[config.mediaControl].alt = item.name;
    return;
  }

  clearToktinderVideoShape();
  cancelPendingMark();
  controls.toktinderVideo.loop = true;
  controls.toktinderVideo.playsInline = true;
  applyToktinderAudio();
  loadVideoSource(controls.toktinderVideo, item);
  syncToktinderTransport();
  renderSeekMarks();
}

function clearDeckMedia(mode) {
  const config = deckConfig(mode);
  if (!config) {
    return;
  }

  if (config.mediaType === "image") {
    controls[config.mediaControl].removeAttribute("src");
    controls[config.mediaControl].removeAttribute("data-path");
    controls[config.mediaControl].alt = "";
    return;
  }

  clearToktinderVideoShape();
  releaseVideo(controls.toktinderVideo);
  syncToktinderTransport();
}

function swipeCardControl(mode) {
  if (mode === "swipe") {
    return controls.swipeCard;
  }
  if (mode === "toktinder") {
    return controls.toktinderCard;
  }
  if (mode === "rediscover") {
    return document.getElementById("rediscoverCard");
  }
  return null;
}

// The drag gesture and the fly-out are shared by the two decks and Rediscover.
function deckHasItem(mode) {
  return mode === "rediscover" ? !!currentRediscoverItem() : !!currentDeckItem(mode);
}

function deckAction(mode, action) {
  if (mode === "rediscover") {
    actRediscover({ like: "keep", love: "love", dislike: "pass" }[action] || "skip");
  } else if (action === "skip") {
    skipDeckItem(mode);
  } else {
    rateDeckItem(mode, action);
  }
}

function renderAnyDeck(mode) {
  if (mode === "rediscover") {
    renderRediscover();
  } else {
    renderDeck(mode);
  }
}

function rebuildSwipeDeck() {
  rebuildDeck("swipe");
}

function rebuildToktinderDeck() {
  rebuildDeck("toktinder");
}

function currentSwipeItem() {
  return currentDeckItem("swipe");
}

function currentToktinderItem() {
  return currentDeckItem("toktinder");
}

function renderSwipe() {
  renderDeck("swipe");
}

function renderToktinder() {
  renderDeck("toktinder");
}

async function rateCurrent(rating) {
  await rateDeckItem("swipe", rating);
}

async function rateToktinderCurrent(rating) {
  await rateDeckItem("toktinder", rating);
}

function skipCurrent() {
  skipDeckItem("swipe");
}

function skipToktinderCurrent() {
  skipDeckItem("toktinder");
}

// The one place a saved rating lands in memory: the catalog entry, its
// timestamp (Collection sorts on it), the counts, and every pool filtered by
// rating. `extra` are copies (deck/gallery items) that should follow along.
function recordRating(path, rating, ...extra) {
  const stamp = rating ? new Date().toISOString() : undefined;
  for (const key of ["images", "videos"]) {
    const found = (state.library[key] || []).find((entry) => entry.path === path);
    if (found) {
      found.rating = rating;
      found.ratedAt = stamp;
    }
  }
  extra.forEach((item) => {
    if (item) {
      item.rating = rating;
      item.ratedAt = stamp;
    }
  });
  invalidateMediaPools();
  syncCountsFromLibrary();
}

function syncCountsFromLibrary() {
  const allItems = [...(state.library.images || []), ...(state.library.videos || [])];
  state.library.counts = {
    ...(state.library.counts || {}),
    liked: allItems.filter(isKept).length,
    loved: allItems.filter((item) => item.rating === "love").length,
    disliked: allItems.filter((item) => item.rating === "dislike").length,
    unrated: allItems.filter((item) => !item.rating).length,
  };
  syncCounts();
}

