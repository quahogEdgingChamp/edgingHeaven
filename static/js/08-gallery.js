/* ==========================================================================
   Gallery — the only mode that lets you look for something specific
   ========================================================================== */

const GALLERY_PAGE_SIZE = 60;

function galleryItems() {
  const selected = normalizedFolderSelection("galleryFolders");
  const kind = state.settings.galleryKind || "all";
  const filter = ratingFilterValue("galleryRatingFilter");
  const search = state.gallery.search.trim().toLowerCase();

  const pool = [];
  if (kind !== "videos") {
    pool.push(...(state.library.images || []).map((item) => ({ ...item, kind: "photo" })));
  }
  if (kind !== "photos") {
    pool.push(...(state.library.videos || []).map((item) => ({ ...item, kind: "video" })));
  }

  const items = pool.filter((item) => {
    if (!matchesFolderSelection(item, selected)) {
      return false;
    }
    if (!matchesRatingFilter(item, filter)) {
      return false;
    }
    return !search || item.name.toLowerCase().includes(search);
  });

  const sort = state.settings.gallerySort || "name";
  if (sort === "newest") {
    items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  } else if (sort === "oldest") {
    items.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
  } else if (sort === "largest") {
    items.sort((a, b) => (b.size || 0) - (a.size || 0));
  } else if (sort === "random") {
    shuffleArray(items);
  } else {
    items.sort((a, b) => a.path.localeCompare(b.path));
  }
  return items;
}

// The grid's columns and its row height are one number: a square tile. CSS
// alone cannot derive it (see the note on .gallery-grid), so measure the
// scroller and hand both tracks back as custom properties.
const GALLERY_TILE_MIN = 104;
const GALLERY_TILE_MIN_WIDE = 148;

function syncGalleryTileSize() {
  syncGalleryTileSizeFor(controls.galleryGrid);
  if (state.currentMode === "ranked") {
    syncGalleryTileSizeFor(controls.rankedGrid);
  }
}

function syncGalleryTileSizeFor(grid) {
  const style = window.getComputedStyle(grid);
  const inner =
    grid.clientWidth -
    parseFloat(style.paddingLeft || "0") -
    parseFloat(style.paddingRight || "0");
  if (inner <= 0) {
    return;
  }

  const gap = parseFloat(style.columnGap) || 6;
  const minimum = window.matchMedia("(max-width: 767px)").matches
    ? GALLERY_TILE_MIN
    : GALLERY_TILE_MIN_WIDE;
  const columns = Math.max(1, Math.floor((inner + gap) / (minimum + gap)));
  const size = (inner - gap * (columns - 1)) / columns;

  grid.style.setProperty("--gallery-cols", String(columns));
  grid.style.setProperty("--gallery-tile", `${size.toFixed(2)}px`);
}

// Re-measure on rotation, on a window resize, and when the drawer or the tab
// bar changes how much room the grid has.
function observeGalleryTileSize() {
  if (state.gallery.sizeObserver || typeof ResizeObserver === "undefined") {
    return;
  }
  state.gallery.sizeObserver = new ResizeObserver((entries) => {
    entries.forEach((entry) => syncGalleryTileSizeFor(entry.target));
  });
  state.gallery.sizeObserver.observe(controls.galleryGrid);
  state.gallery.sizeObserver.observe(controls.rankedGrid);
}

function renderGallery(resetPage) {
  observeGalleryTileSize();
  syncGalleryTileSize();

  // A 12,000-tile grid is not a grid, it is a stall. Page it, and let the
  // browser fetch each tile only when it scrolls close.
  state.gallery.items = galleryItems();
  const pageCount = Math.max(1, Math.ceil(state.gallery.items.length / GALLERY_PAGE_SIZE));
  if (resetPage) {
    state.gallery.page = 0;
  }
  state.gallery.page = clampNumber(state.gallery.page, 0, pageCount - 1);

  const start = state.gallery.page * GALLERY_PAGE_SIZE;
  const slice = state.gallery.items.slice(start, start + GALLERY_PAGE_SIZE);

  state.gallery.observer?.disconnect();
  state.gallery.observer = videoTileObserver(controls.galleryGrid);
  thumbQueue.length = 0;

  controls.galleryGrid.querySelectorAll("video").forEach(releaseVideo);
  controls.galleryGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  slice.forEach((item, offset) => {
    fragment.appendChild(buildGalleryTile(item, start + offset));
  });
  controls.galleryGrid.appendChild(fragment);
  controls.galleryGrid.querySelectorAll(".gallery-tile.is-video").forEach((tile) => {
    state.gallery.observer.observe(tile);
  });

  const total = state.gallery.items.length;
  controls.galleryPageInfo.textContent = total
    ? `${(start + 1).toLocaleString()}–${Math.min(start + GALLERY_PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()}`
    : "Nothing matches the current filter";
  syncDrawerSummaries();
  controls.galleryPrevPage.disabled = state.gallery.page === 0;
  controls.galleryNextPage.disabled = state.gallery.page >= pageCount - 1;
  controls.galleryGrid.scrollTop = 0;
}

function buildGalleryTile(item, index) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = `gallery-tile${item.kind === "video" ? " is-video" : ""}`;
  tile.dataset.index = String(index);
  tile.title = item.path;

  if (item.kind === "video") {
    // A title tile first; a still frame replaces it once one exists (see
    // the thumbnail queue). Opening the clip itself waits for a tap.
    tile.dataset.path = item.path;
    const preview = document.createElement("span");
    preview.className = "video-placeholder";
    const play = document.createElement("span");
    play.textContent = "▶";
    const label = document.createElement("span");
    label.textContent = item.name;
    preview.append(play, label);
    const thumb = document.createElement("img");
    thumb.className = "gallery-thumb";
    thumb.alt = "";
    thumb.decoding = "async";
    tile.append(preview, thumb);
    const badge = document.createElement("span");
    badge.className = "gallery-badge";
    badge.textContent = "Video";
    tile.appendChild(badge);
  } else {
    const image = document.createElement("img");
    image.loading = "lazy";
    image.decoding = "async";
    image.alt = "";
    image.dataset.path = item.path;
    image.src = mediaUrl(item.path);
    image.addEventListener("error", () => tile.classList.add("is-missing"));
    tile.appendChild(image);
  }

  if (item.rating) {
    const dot = document.createElement("span");
    dot.className = `gallery-rating gallery-rating-${item.rating}`;
    tile.appendChild(dot);
  }

  tile.addEventListener("click", () => openLightbox(index));
  return tile;
}

/* ==========================================================================
   Video thumbnails

   There is no ffmpeg on the server, so the browser makes them: one frame a
   quarter of the way in, drawn to a 360px canvas and saved as a JPEG. The
   server keeps each one (keyed to the file's size and date), so a frame is
   grabbed once per video ever -- after that every device just loads a
   20KB image. Two at a time, only for tiles on screen, never while you are
   elsewhere in the app.
   ========================================================================== */

const thumbCache = new Map();
const thumbQueue = [];
let thumbActive = 0;
const THUMB_CONCURRENCY = 2;

function thumbUrl(path) {
  return `/thumb?path=${encodeURIComponent(path)}`;
}

function videoTileObserver(root) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          requestVideoThumb(entry.target);
        }
      });
    },
    { root: root === controls.rankedScroller ? root : null, rootMargin: "200px" }
  );
  return observer;
}

// A still that arrives after you have left the page is kept in the cache,
// not attached: hidden pages hold no media.
function tileIsOnScreen(tile) {
  return tile.isConnected && !!tile.closest(".mode-panel.active");
}

function showThumb(tile, url) {
  const img = tile.querySelector(".gallery-thumb");
  if (!img || !tileIsOnScreen(tile)) {
    return;
  }
  img.onload = () => tile.classList.add("has-thumb");
  img.src = url;
}

function requestVideoThumb(tile) {
  if (!tileIsOnScreen(tile)) {
    return;
  }
  const path = tile.dataset.path;
  const cached = thumbCache.get(path);
  if (cached === "failed") {
    return;
  }
  if (cached) {
    showThumb(tile, cached);
    return;
  }
  const img = tile.querySelector(".gallery-thumb");
  img.onload = () => {
    tile.classList.add("has-thumb");
    thumbCache.set(path, img.src);
  };
  // Not saved on the server yet: make one.
  img.onerror = () => {
    img.onerror = null;
    img.removeAttribute("src");
    thumbQueue.push(tile);
    pumpThumbs();
  };
  img.src = thumbUrl(path);
}

function pumpThumbs() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const tile = thumbQueue.shift();
    if (!tileIsOnScreen(tile)) {
      continue;
    }
    thumbActive += 1;
    const path = tile.dataset.path;
    generateThumb(path)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        thumbCache.set(path, url);
        showThumb(tile, url);
        fetch(`/api/thumb?path=${encodeURIComponent(path)}`, {
          method: "POST",
          headers: { "Content-Type": "image/jpeg" },
          body: blob,
        }).catch(() => {});
      })
      .catch(() => thumbCache.set(path, "failed"))
      .finally(() => {
        thumbActive -= 1;
        pumpThumbs();
      });
  }
}

function generateThumb(path) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let done = false;
    const finish = (error, blob) => {
      if (done) {
        return;
      }
      done = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      error ? reject(error) : resolve(blob);
    };
    const timer = window.setTimeout(() => finish(new Error("thumbnail timed out")), 20000);
    video.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = duration > 2 ? Math.min(duration * 0.25, 45) : 0.1;
    });
    video.addEventListener(
      "seeked",
      () => {
        const width = 360;
        const height = Math.max(1, Math.round((width * (video.videoHeight || 9)) / (video.videoWidth || 16)));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        try {
          canvas.getContext("2d").drawImage(video, 0, 0, width, height);
          canvas.toBlob((blob) => (blob ? finish(null, blob) : finish(new Error("encode failed"))), "image/jpeg", 0.72);
        } catch (error) {
          finish(error);
        }
      },
      { once: true }
    );
    video.addEventListener("error", () => finish(new Error("decode failed")));
    video.src = mediaUrl(path);
  });
}

function openLightbox(index) {
  const items = state.gallery.items;
  if (!items.length) {
    return;
  }
  state.gallery.lightboxIndex = clampNumber(index, 0, items.length - 1);
  const item = items[state.gallery.lightboxIndex];

  if (controls.galleryLightbox.hidden) {
    state.lightboxOpener = document.activeElement;
    controls.galleryLightbox.hidden = false;
    controls.lightboxClose.focus({ preventScroll: true });
  }
  document.body.classList.add("drawer-open");

  const isVideo = item.kind === "video";
  markSeen(item.path);
  cancelPendingMark();
  controls.lightboxImage.hidden = isVideo;
  controls.lightboxVideo.hidden = !isVideo;
  controls.lightboxMark.hidden = !isVideo || !state.features.has("marks");
  syncMarkButton(controls.lightboxMark, item.path);

  if (isVideo) {
    controls.lightboxImage.removeAttribute("src");
    controls.lightboxVideo.muted = !state.audioUnlocked;
    const poster = thumbCache.get(item.path);
    if (poster && poster !== "failed") {
      controls.lightboxVideo.poster = poster;
    } else {
      controls.lightboxVideo.removeAttribute("poster");
    }
    loadVideoSource(controls.lightboxVideo, item);
    playWhenReady(controls.lightboxVideo, controls.lightboxVideo.dataset.loadToken, null);
  } else {
    releaseVideo(controls.lightboxVideo);
    controls.lightboxImage.src = mediaUrl(item.path);
    controls.lightboxImage.alt = item.name;
  }

  setLabel(controls.lightboxName, item.name);
  setLabel(controls.lightboxFolder, item.folder || "Library root");
  controls.lightboxCount.textContent = `${(state.gallery.lightboxIndex + 1).toLocaleString()} / ${items.length.toLocaleString()}`;
  controls.lightboxPrev.disabled = state.gallery.lightboxIndex === 0;
  controls.lightboxNext.disabled = state.gallery.lightboxIndex >= items.length - 1;
  syncLightboxRating();
}

// Touch: swipe sideways for the next file, down to close. The bottom of a
// video is left alone so its own scrubber still works.
function bindLightboxGestures() {
  const stage = controls.galleryLightbox.querySelector(".lightbox-media");
  let drag = null;
  const media = () => (controls.lightboxImage.hidden ? controls.lightboxVideo : controls.lightboxImage);
  stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || event.target.closest("button")) {
      return;
    }
    if (event.target.tagName === "VIDEO" && event.offsetY > event.target.clientHeight - 70) {
      return;
    }
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0 };
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) {
      return;
    }
    drag.dx = event.clientX - drag.x;
    drag.dy = event.clientY - drag.y;
    const vertical = Math.abs(drag.dy) > Math.abs(drag.dx);
    media().style.transform = vertical ? `translateY(${Math.max(0, drag.dy)}px)` : `translateX(${drag.dx}px)`;
    media().style.opacity = vertical ? String(1 - Math.min(0.6, Math.max(0, drag.dy) / 400)) : "1";
  });
  const end = () => {
    if (!drag) {
      return;
    }
    const { dx, dy } = drag;
    drag = null;
    media().style.transform = "";
    media().style.opacity = "";
    if (dy > 110 && dy > Math.abs(dx)) {
      closeLightbox();
    } else if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) {
      stepLightbox(dx < 0 ? 1 : -1);
    }
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
}

function closeLightbox() {
  cancelPendingMark();
  controls.galleryLightbox.hidden = true;
  document.body.classList.toggle("drawer-open", !!state.activeDrawer);
  releaseVideo(controls.lightboxVideo);
  controls.lightboxImage.removeAttribute("src");
  state.gallery.lightboxIndex = -1;
  if (state.lightboxOpener?.getClientRects().length) state.lightboxOpener.focus({ preventScroll: true });
}

function stepLightbox(delta) {
  if (state.gallery.lightboxIndex < 0) {
    return;
  }
  const next = state.gallery.lightboxIndex + delta;
  if (next < 0 || next >= state.gallery.items.length) {
    return;
  }
  openLightbox(next);
}

function syncLightboxRating() {
  const item = state.gallery.items[state.gallery.lightboxIndex];
  const rating = item ? item.rating : null;
  controls.lightboxLike.classList.toggle("active", rating === "like");
  controls.lightboxLove.classList.toggle("active", rating === "love");
  controls.lightboxDislike.classList.toggle("active", rating === "dislike");
}

async function rateLightboxItem(rating) {
  const item = state.gallery.items[state.gallery.lightboxIndex];
  if (!item) {
    return;
  }
  // Tapping the active rating again clears it; un-loving steps back to a keep.
  const next = item.rating === rating ? (rating === "love" ? "like" : null) : rating;
  try {
    await postJson("/api/rating", { path: item.path, rating: next });
  } catch (error) {
    console.error(error);
    return;
  }

  recordRating(item.path, next, item);
  haptic();
  syncLightboxRating();

  const grid = state.currentMode === "downloads" ? el("dlArrivalsGrid")
    : state.currentMode !== "ranked" ? controls.galleryGrid : state.ranked.model != null ? el("modelGrid") : controls.rankedGrid;
  const tile = grid.querySelector(`.gallery-tile[data-index="${state.gallery.lightboxIndex}"]`);
  if (tile) {
    tile.querySelector(".gallery-rating")?.remove();
    if (next) {
      const dot = document.createElement("span");
      dot.className = `gallery-rating gallery-rating-${next}`;
      tile.appendChild(dot);
    }
  }
}

