// The frozen-clip watchdog in 21-ui.js, in Node with no browser: a fake
// video element whose clock we control, and a fake setInterval we step.
//
//   node tests/freeze_watchdog_check.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "21-ui.js"), "utf8");
const start = source.indexOf("const FREEZE_MS");
const end = source.indexOf("function setupPanelAccessibility");
assert(start > 0 && end > start, "watchdog section not found");

let intervals = [];
const posts = [];
const context = vm.createContext({
  URL, Number, Math,
  location: { href: "http://x/" },
  navigator: { userAgent: "test" },
  document: { hidden: false },
  state: { currentMode: "feed" },
  postJson: (url, body) => { posts.push(body); return Promise.resolve(); },
  setInterval: fn => { intervals.push(fn); return intervals.length; },
  clearInterval: id => { if (id) intervals[id - 1] = null; },
});
vm.runInContext(source.slice(start, end), context);

function fakeVideo() {
  const listeners = {};
  return {
    dataset: { path: "a/clip.mp4" },
    paused: false, ended: false, seeking: false, currentTime: 0, duration: 30,
    readyState: 4, networkState: 1, buffered: { length: 1, start: () => 0, end: () => 5 },
    videoWidth: 1920, videoHeight: 1080, playbackRate: 1, muted: false, error: null, src: "x",
    getAttribute: () => "x",
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 60, droppedVideoFrames: 0 }),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { (listeners[type] || []).forEach(fn => fn()); },
  };
}
const tick = () => intervals.forEach(fn => fn && fn());

// 1. A clip that keeps playing is never touched.
intervals = []; posts.length = 0;
let video = fakeVideo(), stalls = [];
vm.runInContext("watchFreeze", context)(video, message => stalls.push(message));
video.fire("playing");
for (let i = 0; i < 10; i += 1) { video.currentTime += 1; tick(); }
assert.deepStrictEqual(posts, []);
assert.deepStrictEqual(stalls, []);

// 2. Frozen for 3 s: reported and nudged by a hair; it recovers.
video.currentTime = 10; tick();
tick(); tick(); tick();
assert.strictEqual(posts.length, 1);
assert.strictEqual(posts[0].kind, "frozen");
assert.strictEqual(posts[0].attempt, 1);
assert.strictEqual(posts[0].frames, 60);
assert.strictEqual(JSON.stringify(posts[0].buffered), "[[0,5]]");
assert(Math.abs(video.currentTime - 10.01) < 1e-9, "first nudge is a tiny seek");
video.currentTime += 0.5; tick();
assert.strictEqual(posts.length, 1, "half a second is not yet recovered");
video.currentTime += 0.6; tick();
assert.strictEqual(posts.at(-1).kind, "recovered");

// 3. Freezes again: a 1 s jump; then again: give up and offer Retry/Skip.
tick(); tick(); tick();
assert.strictEqual(posts.at(-1).attempt, 2);
const jumped = video.currentTime;
// The jump itself reads as movement, so three still seconds come after it.
tick(); tick(); tick(); tick();
assert.strictEqual(posts.at(-1).attempt, 3);
assert.strictEqual(video.currentTime, jumped, "no third seek");
assert.strictEqual(stalls.length, 1);
assert(intervals.every(fn => fn === null), "watchdog stops after giving up");

// 4. Paused, hidden or seeking clips never count as frozen; a new file resets.
intervals = []; posts.length = 0; stalls = [];
video = fakeVideo();
vm.runInContext("watchFreeze", context)(video, message => stalls.push(message));
video.fire("playing");
video.paused = true;
for (let i = 0; i < 6; i += 1) tick();
video.paused = false; context.document.hidden = true;
for (let i = 0; i < 6; i += 1) tick();
context.document.hidden = false; video.seeking = true;
for (let i = 0; i < 6; i += 1) tick();
assert.deepStrictEqual(posts, []);
video.seeking = false;
tick(); tick(); tick();
assert.strictEqual(posts.at(-1).attempt, 1);
video.fire("loadstart");
video.fire("playing");
tick(); tick(); tick();
assert.strictEqual(posts.at(-1).attempt, 1, "loadstart resets the nudge count");

console.log("freeze watchdog: ok");
