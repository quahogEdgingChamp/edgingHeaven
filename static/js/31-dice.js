/* ==========================================================================
   Dice — a card every so often changes the rules

   Every 20–45 seconds (your range) a card is drawn: faster, slower, a hold,
   eyes on one picture, clips only, loved only, "edge, then hold", back to
   the start. After the minimum time each draw also rolls the finish odds;
   a "Finish allowed" card ends the run on an open finish.
   ========================================================================== */

const dice = {
  stage: null, clock: null, bound: false,
  running: false, pace: 0.3, rule: null, nextDrawAt: 0, nextSwapAt: 0, draws: 0, edges: 0, ending: "", cardTimer: 0,
};

registerModeUI("dice", {
  card: {
    name: "Dice",
    blurb: "A card every so often changes the rules. Rare cards allow a finish.",
    icon: "M5 5h14v14H5zM9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01",
    stat: () => (Number(state.settings.diceFinishOdds) ? `finish 1 in ${state.settings.diceFinishOdds}` : "no finish"),
  },
  defaults: {
    diceOrder: "random",
    diceRatingFilter: "all",
    diceKind: "all",
    diceDrawMin: 20,
    diceDrawMax: 45,
    diceFinishOdds: 10,
    diceMinMinutes: 10,
    diceHolds: true,
    diceSpeed: true,
    diceEdges: true,
    diceVolume: 0.3,
  },
  presets: {
    gentle: { diceDrawMin: 40, diceDrawMax: 75, diceFinishOdds: 6, diceMinMinutes: 8 },
    standard: { diceDrawMin: 20, diceDrawMax: 45, diceFinishOdds: 10, diceMinMinutes: 10 },
    wild: { diceDrawMin: 10, diceDrawMax: 25, diceFinishOdds: 20, diceMinMinutes: 15 },
  },
  summary: () => {
    const s = state.settings;
    const finish = Number(s.diceFinishOdds) ? `after ${s.diceMinMinutes} min each draw has a 1 in ${s.diceFinishOdds} chance of "Finish allowed"` : "no finish card";
    return `A card every ${s.diceDrawMin}–${s.diceDrawMax}s; ${finish}.`;
  },
});

// Each card: when it can come up, how likely, and what it does.
const DICE_CARDS = [
  { id: "keep", title: "Keep going", sub: "Same pace.", weight: 2.5, when: () => true },
  { id: "faster", title: "Faster", sub: "Quicker swaps, quicker clips.", weight: 2.2, when: () => state.settings.diceSpeed && dice.pace < 1,
    apply: () => { dice.pace = Math.min(1, dice.pace + 0.18); } },
  { id: "slower", title: "Slower", sub: "Ease off.", weight: 1.4, when: () => state.settings.diceSpeed && dice.pace > 0.1,
    apply: () => { dice.pace = Math.max(0, dice.pace - 0.18); } },
  { id: "hold", title: "Hold", sub: "Hands off.", weight: 1.6, when: () => state.settings.diceHolds, seconds: () => 15 + Math.round(Math.random() * 20), freeze: true },
  { id: "eyes", title: "Eyes on this one", sub: "No swaps for a while.", weight: 1, when: () => true, seconds: () => 30, noSwap: true },
  { id: "clips", title: "Clips only", sub: "Just video for a minute.", weight: 1, when: () => dicePool("videos").length > 0 && state.settings.diceKind !== "photos", seconds: () => 60, kind: "videos" },
  { id: "loved", title: "Loved only", sub: "Your top tier for a minute.", weight: 1, when: () => dicePool("all").some((item) => item.rating === "love"), seconds: () => 60, loved: true },
  { id: "edge", title: "Edge, then hold", sub: "Get close and press Edge (E). A hold follows.", weight: 1.2, when: () => state.settings.diceEdges, seconds: () => 90, waitsForEdge: true },
  { id: "restart", title: "Back to the start", sub: "Pace resets.", weight: 0.5, when: () => state.settings.diceSpeed && dice.pace > 0.45,
    apply: () => { dice.pace = 0.3; } },
];

function dicePool(kind) {
  return playPool("dice", kind === "all" ? state.settings.diceKind : kind);
}

function drawDiceCard() {
  const s = state.settings;
  dice.draws += 1;
  const minutes = dice.clock.elapsed / 60000;
  if (Number(s.diceFinishOdds) && minutes >= s.diceMinMinutes && Math.random() < 1 / s.diceFinishOdds) {
    showDiceCard({ id: "finish", title: "Finish allowed", sub: "Go ahead. Stop when you are done." });
    dice.ending = "finish";
    dice.rule = { card: { id: "finish" }, until: Infinity };
    dice.stage.freeze(false);
    return;
  }
  const deck = DICE_CARDS.filter((card) => card.when());
  let roll = Math.random() * deck.reduce((sum, card) => sum + card.weight, 0);
  const card = deck.find((entry) => (roll -= entry.weight) <= 0) || deck[0];
  card.apply?.();
  const seconds = card.seconds?.() || 0;
  dice.rule = seconds ? { card, until: dice.clock.elapsed + seconds * 1000 } : null;
  if (card.freeze) dice.stage.freeze(true);
  showDiceCard(card, seconds);
  if (card.kind || card.loved) diceSwap();
  scheduleDiceDraw(seconds);
}

function scheduleDiceDraw(afterSeconds = 0) {
  const s = state.settings;
  dice.nextDrawAt = dice.clock.elapsed + (afterSeconds + randomBetween(s.diceDrawMin, s.diceDrawMax)) * 1000;
}

function showDiceCard(card, seconds = 0) {
  const node = el("diceCard");
  el("diceCardTitle").textContent = card.title;
  el("diceCardSub").textContent = seconds && !card.waitsForEdge ? `${card.sub} ${seconds}s.` : card.sub;
  node.dataset.card = card.id;
  node.hidden = false;
  node.classList.remove("show");
  void node.offsetWidth;
  node.classList.add("show");
  window.clearTimeout(dice.cardTimer);
  dice.cardTimer = window.setTimeout(() => {
    node.hidden = true;
  }, 3200);
  if (state.audioUnlocked) {
    playTone(660, 110, 0.18);
    playTone(880, 160, 0.18, (audioContext()?.currentTime || 0) + 0.12);
  }
  haptic();
}

function diceSwap() {
  const rule = dice.rule?.card || {};
  let items = dicePool(rule.kind || "all");
  if (rule.loved) {
    const loved = items.filter((item) => item.rating === "love");
    if (loved.length) items = loved;
  }
  if (!items.length) items = dicePool("all");
  if (!items.length) return;
  dice.stage.fadeMs = Math.round(lerp(420, 150, dice.pace));
  dice.stage.setRate(1 + dice.pace * 0.25);
  dice.stage.show(dice.stage.pick(items), { rate: 1 + dice.pace * 0.25 });
  dice.nextSwapAt = dice.clock.elapsed + lerp(10000, 2500, dice.pace) * (0.8 + Math.random() * 0.4);
}

function diceTick(elapsed) {
  const rule = dice.rule;
  if (rule && elapsed >= rule.until) {
    // An edge card left unanswered still ends in its hold.
    if (rule.card.waitsForEdge) {
      startDiceHold("Time's up — hold", 20);
    } else {
      if (rule.card.freeze) dice.stage.freeze(false);
      dice.rule = null;
      diceSwap();
    }
  }
  const frozen = dice.stage.frozen;
  const finishing = dice.rule?.card.id === "finish";
  if (!frozen && !dice.rule?.card.noSwap && elapsed >= dice.nextSwapAt) diceSwap();
  if (!frozen && !finishing && elapsed >= dice.nextDrawAt) drawDiceCard();
  toySet(frozen ? 0 : finishing ? 1 : lerp(0.25, 1, dice.pace));
  syncDiceHud();
}

function startDiceHold(title, seconds) {
  const card = { id: "hold", title, sub: "Hands off.", freeze: true };
  dice.rule = { card, until: dice.clock.elapsed + seconds * 1000 };
  dice.stage.freeze(true);
  showDiceCard(card, seconds);
  scheduleDiceDraw(seconds);
}

function syncDiceHud() {
  if (!dice.running) {
    setHud("dice", { phase: "idle", cue: "Dice", big: "", sub: "Start, and let the cards decide.", fill: 0 });
    syncRunButtons("dice", false);
    return;
  }
  const rule = dice.rule;
  const left = rule && Number.isFinite(rule.until) ? Math.max(0, (rule.until - dice.clock.elapsed) / 1000) : 0;
  const pace = `Pace ${Math.round(lerp(1, 10, dice.pace))}/10`;
  if (rule?.card.id === "finish") {
    setHud("dice", { phase: "finish", cue: "Finish allowed", sub: `${formatClock(dice.clock.elapsed / 1000)} in`, fill: 1, compact: true });
  } else if (dice.stage.frozen) {
    setHud("dice", { phase: "hold", cue: rule?.card.title || "Hold", big: formatClock(Math.ceil(left)), sub: "Hands off.", fill: dice.pace });
  } else {
    const ruleText = rule ? `${rule.card.title}${rule.card.waitsForEdge ? " · press Edge" : ""} · ${formatClock(Math.ceil(left))}` : pace;
    setHud("dice", { phase: rule?.card.waitsForEdge ? "warn" : "go", cue: ruleText, sub: `${rule ? `${pace} · ` : ""}${plural(dice.draws, "card", "cards")}${dice.edges ? ` · ${plural(dice.edges, "edge", "edges")}` : ""}`, fill: dice.pace, compact: true });
  }
  el("diceStatus").textContent = formatClock(dice.clock.elapsed / 1000);
  syncRunButtons("dice", true);
}

function startDice() {
  if (!dicePool("all").length) {
    toast("Nothing to show. Widen the folders or Show under Adjust.");
    return;
  }
  audioContext();
  Object.assign(dice, { running: true, pace: 0.3, rule: null, draws: 0, edges: 0, ending: "" });
  dice.stage.freeze(false);
  dice.clock.start();
  scheduleDiceDraw(0);
  diceSwap();
  syncDiceHud();
}

function stopDice() {
  if (dice.running) {
    const seconds = dice.clock.elapsed / 1000;
    logSession("dice", seconds, dice.edges, dice.ending || undefined);
    toast(`Dice over · ${formatClock(seconds)} · ${plural(dice.draws, "card", "cards")}`);
  }
  dice.running = false;
  dice.clock.stop();
  dice.stage.freeze(false);
  dice.stage.clear();
  el("diceCard").hidden = true;
  toyStop();
  syncDiceHud();
}

function edgeDice() {
  if (!dice.running) {
    toast("Start first. Edge then gives you an instant hold.");
    return;
  }
  if (dice.rule?.card.id === "finish") return;
  dice.edges += 1;
  flashStage("dice");
  if (dice.stage.frozen && dice.rule) {
    dice.rule.until += 10000;
    toast("Hold extended by 10 seconds.");
    return;
  }
  startDiceHold(dice.rule?.card.waitsForEdge ? "Edged — hold" : "Edge — hold", 20);
}

function bindDice() {
  if (dice.bound) return;
  dice.bound = true;
  dice.stage = new PlayStage("dice", { volumeKey: "diceVolume" });
  dice.clock = new PlayClock(diceTick, 200);
  dice.stage.onBroken = diceSwap;
  el("diceToggleButton").addEventListener("click", () => (dice.running ? stopDice() : startDice()));
  el("diceHudStart").addEventListener("click", startDice);
  el("diceEdgeButton").addEventListener("click", edgeDice);
  el("diceDrawButton").addEventListener("click", () => dice.running && !dice.stage.frozen && drawDiceCard());
  el("diceRestart").addEventListener("click", () => {
    stopDice();
    startDice();
    closeDrawers();
  });
  bindSettingControls(el("diceDrawer"), (key) => {
    if (key === "diceVolume") dice.stage.applyAudio();
    if (key === "diceKind") invalidateMediaPools();
    syncDrawerSummaries();
  });
}

registerMode("dice", {
  enter() {
    bindDice();
    syncSettingControls(el("diceDrawer"));
    if (dice.running) {
      dice.clock.resume();
      dice.stage.resume();
    }
    syncDiceHud();
  },
  quiet() {
    dice.clock?.pause();
    dice.stage?.pause();
  },
  refresh() {
    if (dice.running && !dice.stage.frozen && state.currentMode === "dice") diceSwap();
    syncDrawerSummaries();
  },
  next() {
    if (dice.running && !dice.stage.frozen) diceSwap();
  },
  key(key, lower) {
    const actions = { " ": () => (dice.running ? stopDice() : startDice()), ArrowRight: () => dice.running && !dice.stage.frozen && diceSwap() };
    const action = actions[key] || { e: edgeDice, d: () => dice.running && !dice.stage.frozen && drawDiceCard(), l: () => loveCurrentPlayItem("dice") }[lower];
    if (!action) return false;
    action();
    return true;
  },
});
