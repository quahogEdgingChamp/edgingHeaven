// Smart order's maths, in Node with no browser: the page's own scripts
// (14-picking, 15-folders, 17-seen, 41-signals, 42-smart) loaded into one
// context over a fake catalog, with stubs for the rest of the app.
//
//   node tests/smart_order_check.js
//
// Statistical checks use many runs and loose bounds, so they do not flake.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const js = path.join(__dirname, "..", "static", "js");
const context = vm.createContext({
  console,
  Math,
  Date,
  Map,
  Set,
  JSON,
  performance: { now: () => Date.now() },
  window: { setTimeout: () => 1, clearTimeout() {} },
  document: { querySelectorAll: () => [] },
  HTMLVideoElement: class {},
});
const stubs = `
  var state = { settings: { balancedFolders: true }, features: new Set(["smart"]), library: { images: [], videos: [] }, history: {}, feed: {} };
  var controls = {};
  var duel = { ratings: {} };
  var marks = {};
  function marksFor(p) { return marks[p] || null; }
  function isKept(item) { return item.rating === "like" || item.rating === "love"; }
  function popcount(value) {
    let v = value - ((value >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  function fetchJson() { return Promise.resolve({}); }
`;
vm.runInContext(stubs, context);
for (const file of ["14-picking.js", "15-folders.js", "17-seen.js", "41-signals.js", "42-smart.js"]) {
  vm.runInContext(fs.readFileSync(path.join(js, file), "utf8"), context, { filename: file });
}
// Results are copied out through JSON: arrays made inside the context have
// that context's prototypes, which deepStrictEqual treats as different.
const run = (code) => {
  const value = vm.runInContext(code, context);
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
};

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok  ${name}`);
}

// A library: folder "kept" where you keep everything, "passed" where you
// pass on everything, and "fresh" you have never rated. 30 photos each.
function library() {
  const items = [];
  for (const folder of ["kept", "passed", "fresh"]) {
    for (let index = 0; index < 30; index += 1) {
      const item = { path: `${folder}/${index}.jpg`, folder, mtime: 1_700_000_000 + index * 3600 };
      if (folder === "kept" && index < 20) item.rating = "like";
      if (folder === "passed" && index < 20) item.rating = "dislike";
      items.push(item);
    }
  }
  return items;
}
context.testItems = library();
run(`state.library.images = testItems; state.settings.swipeOrder = "smart"; invalidateMediaPools();`);

check("smartOn needs the server feature and the setting", () => {
  assert.strictEqual(run(`smartOn("swipe")`), true);
  assert.strictEqual(run(`smartOn("toktinder")`), false);
  assert.strictEqual(run(`smartOn(null)`), false);
  run(`state.features = new Set()`);
  assert.strictEqual(run(`smartOn("swipe")`), false);
  run(`state.features = new Set(["smart"])`);
});

check("scores: love > keep > unrated > pass; never seen beats just seen", () => {
  const score = (item) => run(`smartAssess(${JSON.stringify(item)}).score`);
  const base = { path: "x/1.jpg", folder: "x" };
  assert(score({ ...base, rating: "love" }) > score({ ...base, rating: "like" }));
  assert(score({ ...base, rating: "like" }) > score(base));
  assert(score(base) > score({ ...base, rating: "dislike" }));
  run(`seenState.map.set("x/2.jpg", Math.floor(Date.now() / 1000))`);
  run(`seenState.map.set("x/3.jpg", Math.floor(Date.now() / 1000) - 60 * 86400)`);
  assert(score({ path: "x/1.jpg" }) > score({ path: "x/2.jpg" }));
  assert(score({ path: "x/3.jpg" }) > score({ path: "x/2.jpg" }));
  assert.match(run(`smartAssess({ path: "x/3.jpg" }).reasons.join()`), /not seen since/);
});

check("watch signals: watched-through clips up, quick skips down", () => {
  run(`watchState.map.set("w/good.mp4", { v: 4, s: 0, c: 4, t: 80 }); watchState.map.set("w/bad.mp4", { v: 4, s: 4, c: 0, t: 4 })`);
  const good = run(`smartAssess({ path: "w/good.mp4" })`);
  const bad = run(`smartAssess({ path: "w/bad.mp4" })`);
  const plain = run(`smartAssess({ path: "w/none.mp4" })`);
  assert(good.score > plain.score && plain.score > bad.score);
  assert(good.reasons.includes("you watch it to the end"));
});

check("Beta sampler has the right mean", () => {
  const mean = run(`(() => { let sum = 0; for (let i = 0; i < 20000; i += 1) sum += sampleBeta(8, 2); return sum / 20000; })()`);
  assert(Math.abs(mean - 0.8) < 0.01, mean);
});

check("Thompson picks the kept folder most, still tries the unrated one", () => {
  const counts = run(`(() => {
    const table = smartFolderStats().byFolder;
    const counts = { kept: 0, passed: 0, fresh: 0 };
    for (let i = 0; i < 5000; i += 1) counts[thompsonChoose(["kept", "passed", "fresh"], table)] += 1;
    return counts;
  })()`);
  assert(counts.kept > counts.fresh && counts.fresh > counts.passed, JSON.stringify(counts));
  assert(counts.fresh > 50, JSON.stringify(counts));
});

check("a smart deck keeps every file once and front-loads the kept folder", () => {
  const firsts = { kept: 0, passed: 0, fresh: 0 };
  for (let round = 0; round < 200; round += 1) {
    const deck = run(`(() => { const deck = state.library.images.slice(); shuffleBalanced(deck, "swipe"); return deck.map((i) => i.path); })()`);
    assert.strictEqual(new Set(deck).size, 90);
    deck.slice(0, 15).forEach((p) => (firsts[p.split("/")[0]] += 1));
  }
  assert(firsts.kept > firsts.fresh && firsts.fresh > firsts.passed, JSON.stringify(firsts));
  // The exploration floor: the passed folder is never shut out.
  assert(firsts.passed > 0, JSON.stringify(firsts));
  assert(run(`smartWhy("swipe", state.library.images[0].path)`) !== undefined);
});

check("shuffled order is untouched when smart is off", () => {
  run(`state.settings.swipeOrder = "random"`);
  const deck = run(`(() => { const deck = state.library.images.slice(); shuffleBalanced(deck, "swipe"); return deck.slice(0, 3).map((i) => i.folder); })()`);
  // Balanced round-robin: the first three cards come from three folders.
  assert.strictEqual(new Set(deck).size, 3);
  assert.strictEqual(run(`smartWhy("swipe", state.library.images[0].path)`), "");
  run(`state.settings.swipeOrder = "smart"`);
});

check("smart pick skips recent files and the one on screen", () => {
  run(`state.settings.sessionOrder = "smart"`);
  for (let round = 0; round < 300; round += 1) {
    const picked = run(`pickWithoutRepeats(state.library.images, ["kept/0.jpg", "kept/1.jpg"], "kept/2.jpg", "session").path`);
    assert(!["kept/0.jpg", "kept/1.jpg", "kept/2.jpg"].includes(picked), picked);
  }
});

check("Bradley-Terry: consistent winner on top, few duels shrink to average", () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push(["a", "b", 0], ["b", "c", 0], ["a", "c", 0]);
  rows.push(["lucky", "c", 0]);
  context.testRows = rows;
  const fit = run(`(() => { const fit = fitBradleyTerry(testRows); return Object.fromEntries([...fit].map(([k, v]) => [k, v.z])); })()`);
  assert(fit.a > fit.b && fit.b > fit.c, JSON.stringify(fit));
  // One win over the weakest file does not beat ten wins over everyone.
  assert(fit.lucky < fit.a, JSON.stringify(fit));
  assert(Math.abs(fit.lucky) < 1.5, JSON.stringify(fit));
});

check("duel strength uses the refit when there is a log, shrunk Elo otherwise", () => {
  run(`duel.ratings = { solo: { r: 1700, n: 1 }, veteran: { r: 1700, n: 40 } }; duelLog.rows = null;`);
  const solo = run(`duelStrength("solo").z`);
  const veteran = run(`duelStrength("veteran").z`);
  assert(veteran > solo && solo > 0);
  run(`duelLog.rows = [["solo", "veteran", 0]]; duelLog.fit = null;`);
  assert(run(`duelStrength("solo").z`) > run(`duelStrength("veteran").z`));
  run(`noteDuelUndone("solo", "veteran")`);
  assert.strictEqual(run(`duelLog.rows.length`), 0);
  run(`duelLog.rows = null; duel.ratings = {};`);
});

check("watch events: skips, completion and the revisit schedule", () => {
  run(`applyWatchEvent({ path: "r/1.jpg", seconds: 1, coverage: null, skipped: true, review: "keep" })`);
  let row = run(`watchRow("r/1.jpg")`);
  assert.strictEqual(row.s, 1);
  assert.strictEqual(row.iv, 7);
  run(`applyWatchEvent({ path: "r/1.jpg", seconds: 9, coverage: 0.9, skipped: false, review: "love" })`);
  row = run(`watchRow("r/1.jpg")`);
  assert.strictEqual(row.c, 1);
  assert.strictEqual(row.iv, 17.5);
  run(`applyWatchEvent({ path: "r/1.jpg", seconds: 2, coverage: null, skipped: false, review: "pass" })`);
  assert.strictEqual(run(`watchRow("r/1.jpg").iv`), undefined);
});

check("more like this: nearest first, never a near-copy", () => {
  const now = 1_700_000_000;
  context.simList = [
    { path: "m/next.jpg", folder: "m", mtime: now + 5 * 86400 },
    { path: "other/far.jpg", folder: "other", mtime: now + 9 * 86400 },
    { path: "m/sameday.jpg", folder: "m", mtime: now + 600 },
    { path: "m/copy.jpg", folder: "m", mtime: now + 60 },
    { path: "other/lookalike.jpg", folder: "other", mtime: now + 300 },
  ];
  context.simAnchor = { path: "m/loved.jpg", folder: "m", mtime: now };
  run(`smart.prints = new Map([
    ["m/loved.jpg", [0x0f0f0f0f, 0x0f0f0f0f]],
    ["m/copy.jpg", [0x0f0f0f0f, 0x0f0f0f0e]],
    ["other/lookalike.jpg", [0x0f0f0000, 0x0f0f0f0f]],
  ])`);
  const moved = run(`pullSimilarForward("swipe", simList, 1, simAnchor)`);
  const order = run(`simList.map((i) => i.path)`);
  assert.strictEqual(moved, 2, order.join());
  assert.deepStrictEqual(order.slice(0, 3), ["m/next.jpg", "other/lookalike.jpg", "m/sameday.jpg"]);
  // Before the insertion point stays put; the near-copy was left where it was.
  assert(order.indexOf("m/copy.jpg") > 2);
  assert.strictEqual(run(`smartWhy("swipe", "m/sameday.jpg")`), "like one you just loved");
});

check("Rediscover deals due revisits, never-seen and long-unseen in turn", () => {
  const now = Math.floor(Date.now() / 1000);
  run(`state.settings.rediscoverOrder = "smart"; seenState.map.clear(); watchState.map.clear();`);
  context.rdItems = [
    { path: "d/due.jpg", folder: "d", rating: "like" },
    { path: "d/notyet.jpg", folder: "d", rating: "like" },
    { path: "d/new.jpg", folder: "d" },
    { path: "d/old.jpg", folder: "d" },
  ];
  run(`
    watchState.map.set("d/due.jpg", { v: 1, s: 0, c: 0, t: 1, iv: 7, due: ${now - 86400} });
    watchState.map.set("d/notyet.jpg", { v: 1, s: 0, c: 0, t: 1, iv: 17.5, due: ${now + 9 * 86400} });
    seenState.map.set("d/due.jpg", ${now - 8 * 86400});
    seenState.map.set("d/notyet.jpg", ${now - 86400});
    seenState.map.set("d/old.jpg", ${now - 90 * 86400});
  `);
  const dealt = run(`smartRediscoverDeal(rdItems, 10).map((i) => i.path)`);
  assert.deepStrictEqual(dealt.slice(0, 3), ["d/due.jpg", "d/new.jpg", "d/old.jpg"]);
  assert.strictEqual(dealt.length, 4);
  assert.match(run(`smartWhy("rediscover", "d/due.jpg")`), /due a revisit · every 7 days/);
});

console.log(`\n${checks} checks passed`);
