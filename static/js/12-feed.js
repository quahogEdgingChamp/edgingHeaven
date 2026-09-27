/* ==========================================================================
   Feed — vertical snap scrolling, one clip at a time

   Only the clip in view and its immediate neighbours hold a src; everything
   else is released, so scrolling a long feed does not accumulate decoders.
   ========================================================================== */

const FEED_BATCH = 12;

function getFeedItems() {
  const selected = normalizedFolderSelection("feedFolders");
  const filter = ratingFilterValue("feedRatingFilter");
  return (state.library.videos || []).filter(
    (item) => matchesFolderSelection(item, selected) && matchesRatingFilter(item, filter)
  );
}

function startFeed() {
  observeFeedItems();
  if (!state.feed.items.length || state.feed.dirty) {
    rebuildFeed();
    return;
  }
  activateFeedItem(Math.max(0, state.feed.activeIndex), true);
}

function rebuildFeed() {
  state.feed.items = getFeedItems();
  shuffleBalanced(state.feed.items);
  state.feed.rendered = 0;
  state.feed.activeIndex = -1;
  state.feed.dirty = false;
  controls.feedScroller.querySelectorAll("video").forEach(releaseVideo);
  controls.feedScroller.innerHTML = "";

  if (!state.feed.items.length) {
    const empty = document.createElement("p");
    empty.className = "feed-empty subtle";
    empty.textContent = "No videos match the feed filter.";
    controls.feedScroller.appendChild(empty);
    return;
  }

  appendFeedBatch();
  controls.feedScroller.scrollTop = 0;
  observeFeedItems();
  // The panel may only just have become visible, so the scroller can still
  // be zero-height this frame. Start the first clip once layout settles.
  window.requestAnimationFrame(() => activateFeedItem(0, true));
}

function pauseFeed() {
  controls.feedScroller.querySelectorAll("video").forEach((video) => video.pause());
  window.cancelAnimationFrame(state.feed.scrollFrame);
  state.feed.scrollFrame = 0;
}

function appendFeedBatch() {
  const template = document.getElementById("feedItemTemplate");
  const fragment = document.createDocumentFragment();
  const end = Math.min(state.feed.rendered + FEED_BATCH, state.feed.items.length);

  for (let index = state.feed.rendered; index < end; index += 1) {
    const item = state.feed.items[index];
    const node = template.content.cloneNode(true);
    const article = node.querySelector(".feed-item");
    article.dataset.index = String(index);
    article.querySelector(".feed-item-name").textContent = item.name;
    article.querySelector(".feed-item-folder").textContent = item.folder || "Library root";

    const video = article.querySelector("video");
    video.dataset.path = item.path;
    video.playsInline = true;
    // A looping clip never fires `ended`, so the two settings are the same
    // switch seen from either side.
    video.loop = !state.settings.feedAutoAdvance;
    video.addEventListener("ended", () => {
      if (state.settings.feedAutoAdvance && Number(article.dataset.index) === state.feed.activeIndex) {
        scrollFeedTo(index + 1);
      }
    });
    video.addEventListener("error", () => {
      if (mediaErrorIsFatal(video)) {
        reportBrokenMedia(video.dataset.path);
        state.feed.dirty = true;
      }
    });

    article.querySelector(".feed-keep").addEventListener("click", () => rateFeedItem(index, "like"));
    article.querySelector(".feed-love").addEventListener("click", () => rateFeedItem(index, "love", false));
    article.querySelector(".feed-pass").addEventListener("click", () => rateFeedItem(index, "dislike"));

    // One tap toggles playback, two keeps the clip -- the gesture the Feed
    // drawer has always advertised but nothing implemented. The single-tap
    // action is deferred so a double tap does not also pause the video on
    // its way past; 280ms is the usual double-tap window.
    let tapTimer = 0;
    video.addEventListener("click", () => {
      if (tapTimer) {
        window.clearTimeout(tapTimer);
        tapTimer = 0;
        flashFeedKeep(article);
        rateFeedItem(index, "like", false);
        return;
      }
      tapTimer = window.setTimeout(() => {
        tapTimer = 0;
        if (video.paused) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      }, 280);
    });

    fragment.appendChild(node);
  }

  state.feed.rendered = end;
  controls.feedScroller.appendChild(fragment);
}

function observeFeedItems() {
  if (state.feed.scrollBound) {
    return;
  }
  state.feed.scrollBound = true;
  controls.feedScroller.addEventListener("scroll", () => {
    if (state.feed.scrollFrame) {
      return;
    }
    state.feed.scrollFrame = window.requestAnimationFrame(() => {
      state.feed.scrollFrame = 0;
      syncFeedActiveItem();
    });
  });
}

function syncFeedActiveItem() {
  const scroller = controls.feedScroller;
  const height = scroller.clientHeight;
  if (!height) {
    return;
  }
  activateFeedItem(Math.round(scroller.scrollTop / height), false);
}

function activateFeedItem(index, force) {
  if (!Number.isFinite(index) || index < 0) {
    index = 0;
  }
  if (index === state.feed.activeIndex && !force) {
    return;
  }
  state.feed.activeIndex = index;

  controls.feedScroller.querySelectorAll(".feed-item").forEach((article) => {
    const position = Number(article.dataset.index);
    const video = article.querySelector("video");
    const distance = Math.abs(position - index);

    if (distance > 1) {
      video.preload = "none";
      releaseVideo(video);
      return;
    }
    if (!video.getAttribute("src")) {
      const item = state.feed.items[position];
      if (item) {
        video.loop = !state.settings.feedAutoAdvance;
        video.preload = position === index ? "auto" : "metadata";
        loadVideoSource(video, item);
        video.preload = position === index ? "auto" : "metadata";
      }
    }
    if (position === index) {
      video.preload = "auto";
    }
    if (position === index) {
      applyFeedAudio();
      markSeen(state.feed.items[position]?.path);
      playWhenReady(video, video.dataset.loadToken, null);
    } else {
      video.pause();
    }
  });

  if (index >= state.feed.rendered - 4 && state.feed.rendered < state.feed.items.length) {
    appendFeedBatch();
  }
}

// A double tap has no button to light up, so the card itself acknowledges it.
function flashFeedKeep(article) {
  article.classList.remove("is-kept");
  // Reading offsetWidth restarts the animation when two taps land in a row.
  void article.offsetWidth;
  article.classList.add("is-kept");
  window.setTimeout(() => article.classList.remove("is-kept"), 650);
}

function applyFeedAudio() {
  const volume = clampNumber(Number(state.settings.feedVolume ?? 1), 0, 1);
  controls.feedScroller.querySelectorAll("video").forEach((video) => {
    const active = Number(video.closest(".feed-item")?.dataset.index) === state.feed.activeIndex;
    video.volume = volume;
    video.muted = !active || !state.audioUnlocked || volume === 0;
  });
}

// `advance` is what separates the two ways of keeping a clip. The Pass/Keep
// buttons are a verdict, so they move on. A double tap on the clip itself is
// not -- you are still watching it -- so it rates in place and leaves you
// there, which is also the only way the keep flash is on screen long enough
// to read.
async function rateFeedItem(index, rating, advance = true) {
  const item = state.feed.items[index];
  if (!item) {
    return;
  }
  try {
    await postJson("/api/rating", { path: item.path, rating });
  } catch (error) {
    console.error(error);
    return;
  }
  recordRating(item.path, rating, item);
  haptic();

  const article = controls.feedScroller.querySelector(`.feed-item[data-index="${index}"]`);
  if (article) {
    article.dataset.rating = rating;
  }
  if (advance) {
    scrollFeedTo(index + 1);
  }
}

function toggleFeedPlayback() {
  const article = controls.feedScroller.querySelector(`.feed-item[data-index="${state.feed.activeIndex}"]`);
  const video = article?.querySelector("video");
  if (!video) {
    return;
  }
  if (video.paused) {
    applyFeedAudio();
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function scrollFeedTo(index) {
  const article = controls.feedScroller.querySelector(`.feed-item[data-index="${index}"]`);
  if (article) {
    article.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

