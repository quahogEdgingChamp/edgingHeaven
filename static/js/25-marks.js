/* ==========================================================================
   Marked moments

   Press Mark (or B) where a moment starts and again where it ends; two quick
   presses mark the next fifteen seconds. Marks live on the server
   (state.json → "marks"), show as ticks on the Video deck's seek bar, are
   what Highlights plays, and — unless turned off in Settings — are where
   Escalation, Session, Mosaic and the timed modes start a clip.
   ========================================================================== */

const marksState = { map: {}, loaded: false, loading: null, pending: null };
const QUICK_MARK_SECONDS = 15;

async function loadMarks(force = false) {
  if (!state.features.has("marks")) return;
  if (marksState.loaded && !force) return;
  if (force) marksState.loading = null;
  marksState.loading ||= fetchJson("/api/marks")
    .then((payload) => {
      marksState.map = payload.marks || {};
      marksState.loaded = true;
      renderSeekMarks();
    })
    .catch(() => {});
  await marksState.loading;
}

function marksFor(path) {
  return path ? marksState.map[path] || null : null;
}

function markedCount() {
  return Object.values(marksState.map).reduce((sum, spans) => sum + spans.length, 0);
}

async function saveMarks(path, spans) {
  const result = await postJson("/api/marks", { path, marks: spans });
  if (result.marks.length) {
    marksState.map[path] = result.marks;
  } else {
    delete marksState.map[path];
  }
  invalidateMediaPools();
  renderSeekMarks();
  return result.marks;
}

function markToggle(video, item) {
  if (!state.features.has("marks")) {
    toast("Marking needs the updated server. Restart edging-heaven.service.");
    return;
  }
  if (!item || !video || video.hidden || !video.getAttribute("src")) {
    toast("Marks are for clips. Open a video first.");
    return;
  }
  const now = video.currentTime || 0;
  const duration = Number.isFinite(video.duration) ? video.duration : now + QUICK_MARK_SECONDS;
  const pending = marksState.pending;
  if (!pending || pending.path !== item.path) {
    marksState.pending = { path: item.path, start: now };
    toast(`Moment starts at ${formatClock(now)}. Press Mark (or B) again where it ends.`);
    syncMarkButtons();
    return;
  }
  marksState.pending = null;
  let start = Math.min(pending.start, now);
  let end = Math.max(pending.start, now);
  if (end - start < 1) {
    end = Math.min(duration, start + QUICK_MARK_SECONDS);
  }
  syncMarkButtons();
  saveMarks(item.path, [...(marksFor(item.path) || []), [start, end]])
    .then((spans) => {
      haptic();
      toast(`Moment saved: ${formatClock(start)}–${formatClock(end)}. ${plural(spans.length, "moment", "moments")} on this clip.`);
    })
    .catch((error) => toast(error.message));
}

function cancelPendingMark() {
  if (marksState.pending) {
    marksState.pending = null;
    syncMarkButtons();
  }
}

function syncMarkButton(button, path) {
  if (!button) return;
  const pending = marksState.pending && marksState.pending.path === path;
  button.textContent = pending ? "End mark" : "Mark";
  button.classList.toggle("active", !!pending);
  button.title = pending ? "Mark where this moment ends (B)" : "Mark where a moment starts (B)";
}

function syncMarkButtons() {
  syncMarkButton(controls.toktinderMarkButton, currentDeckItem("toktinder")?.path);
  const lightboxItem = state.gallery.items[state.gallery.lightboxIndex];
  syncMarkButton(controls.lightboxMark, lightboxItem?.path);
}

function markFromToktinder() {
  markToggle(controls.toktinderVideo, currentDeckItem("toktinder"));
}

function markFromFeed() {
  const article = controls.feedScroller.querySelector(`.feed-item[data-index="${state.feed.activeIndex}"]`);
  markToggle(article?.querySelector("video"), state.feed.items[state.feed.activeIndex]);
}

function markFromLightbox() {
  const item = state.gallery.items[state.gallery.lightboxIndex];
  if (item?.kind !== "video") return;
  markToggle(controls.lightboxVideo, item);
}

function markFromRediscover() {
  const item = currentRediscoverItem();
  if (item?.kind !== "video") return;
  markToggle(el("rediscoverVideo"), item);
}

// Ticks under the Video deck's seek bar, one per marked moment.
function renderSeekMarks() {
  const holder = controls.toktinderSeekMarks;
  if (!holder) return;
  const video = controls.toktinderVideo;
  const item = currentDeckItem("toktinder");
  controls.toktinderMarkButton.hidden = !state.features.has("marks");
  syncMarkButtons();
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const spans = item && duration ? marksFor(item.path) || [] : [];
  holder.replaceChildren(...spans.map(([start, end]) => {
    const tick = document.createElement("i");
    tick.style.left = `${(start / duration) * 100}%`;
    tick.style.width = `${Math.max(0.8, ((end - start) / duration) * 100)}%`;
    return tick;
  }));
}

function bindMarking() {
  controls.toktinderMarkButton.addEventListener("click", markFromToktinder);
  controls.toktinderVideo.addEventListener("loadedmetadata", renderSeekMarks);
}
