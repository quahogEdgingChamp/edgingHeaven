/* ==========================================================================
   Seen times

   Every file that is put on screen anywhere is noted, in batches, so
   Rediscover can order the library by how long it has been since you last
   looked. Held locally too, so the current visit counts straight away.
   ========================================================================== */

const seenState = { map: new Map(), loaded: false, loading: null, pending: new Set(), timer: 0 };

function markSeen(path) {
  if (!path) {
    return;
  }
  seenState.map.set(path, Math.floor(Date.now() / 1000));
  seenState.pending.add(path);
  if (!seenState.timer) {
    seenState.timer = window.setTimeout(flushSeen, 15000);
  }
}

function flushSeen(useBeacon = false) {
  window.clearTimeout(seenState.timer);
  seenState.timer = 0;
  if (!seenState.pending.size) {
    return;
  }
  const paths = [...seenState.pending].slice(0, 500);
  paths.forEach((path) => seenState.pending.delete(path));
  const body = JSON.stringify({ paths });
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/seen", new Blob([body], { type: "application/json" }));
  } else {
    fetch("/api/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  }
  if (seenState.pending.size) {
    seenState.timer = window.setTimeout(flushSeen, 2000);
  }
}

async function loadSeen() {
  if (seenState.loaded) {
    return;
  }
  seenState.loading ||= fetchJson("/api/seen")
    .then((payload) => {
      Object.entries(payload.seen || {}).forEach(([path, stamp]) => {
        if (!seenState.map.has(path)) seenState.map.set(path, stamp);
      });
    })
    .catch(() => {})
    .finally(() => {
      seenState.loaded = true;
    });
  await seenState.loading;
}

function seenAt(path) {
  return seenState.map.get(path) || 0;
}

function timeAgo(epochSeconds) {
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [name, size] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${name}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

