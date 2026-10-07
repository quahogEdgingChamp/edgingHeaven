/* ==========================================================================
   Dangerous — what a delete looks and sounds like

   - Burn: a ragged burn line eats the picture from one or more sparks, with
     a glowing edge, char behind it, flames licking up, embers and smoke.
   - Shred: the picture tears into strips with torn edges that fall away.
   - Sound: a whoosh and crackle for a burn, a shredder for a shred.

   Everything is drawn on one canvas per deleted file, laid over where it was
   (38-thrill.js decides when). One animation loop runs every canvas on screen.
   ========================================================================== */

/* ---- one loop for every effect on screen ---- */

const fxRunning = new Set();
let fxFrame = 0;

function runFx(effect) {
  fxRunning.add(effect);
  // A hidden tab pauses the loop; the ghost should not outlive that.
  window.setTimeout(() => finishFx(effect), effect.duration + 4000);
  if (!fxFrame) fxFrame = requestAnimationFrame(fxTick);
}

function finishFx(effect) {
  fxRunning.delete(effect);
  effect.node.remove();
}

function fxTick(now) {
  fxFrame = 0;
  fxRunning.forEach((effect) => {
    effect.started ??= now;
    if (!effect.node.isConnected || !effect.draw(now - effect.started)) finishFx(effect);
  });
  if (fxRunning.size) fxFrame = requestAnimationFrame(fxTick);
}

// The ghost: a canvas over the element, with room around it for what flies off.
function fxGhost(kind, rect, scale, pad) {
  const node = document.createElement("div");
  node.className = `burn-ghost is-${kind}`;
  node.setAttribute("aria-hidden", "true");
  Object.assign(node.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const canvas = document.createElement("canvas");
  canvas.className = "fx-canvas";
  const width = rect.width + pad.left + pad.right;
  const height = rect.height + pad.top + pad.bottom;
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  Object.assign(canvas.style, { left: `${-pad.left}px`, top: `${-pad.top}px`, width: `${width}px`, height: `${height}px` });
  node.append(canvas);
  document.body.append(node);
  const context = canvas.getContext("2d");
  // Draw in CSS pixels with the picture's top-left at 0,0.
  context.setTransform(scale, 0, 0, scale, pad.left * scale, pad.top * scale);
  return { node, canvas, context, pad, width, height };
}

/* ---- sprites: soft dots for flame, embers, smoke and paper ---- */

let fxSprites = null;

function radialSprite(size, stops) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([at, color]) => gradient.addColorStop(at, color));
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return canvas;
}

function sprites() {
  fxSprites ??= {
    flame: radialSprite(64, [[0, "rgba(255,246,214,1)"], [0.22, "rgba(255,198,92,0.95)"], [0.5, "rgba(255,104,20,0.55)"], [0.78, "rgba(200,36,0,0.18)"], [1, "rgba(160,20,0,0)"]]),
    ember: radialSprite(24, [[0, "rgba(255,250,220,1)"], [0.25, "rgba(255,190,80,0.95)"], [0.6, "rgba(255,90,10,0.35)"], [1, "rgba(255,60,0,0)"]]),
    smoke: radialSprite(64, [[0, "rgba(58,52,48,0.55)"], [0.5, "rgba(48,44,42,0.28)"], [1, "rgba(40,38,36,0)"]]),
  };
  return fxSprites;
}

/* ---- value noise, for a burn line that is never straight ---- */

function noiseLattice(cols, rows) {
  const values = new Float32Array((cols + 2) * (rows + 2)).map(() => Math.random());
  return (x, y) => {
    const gx = x * cols, gy = y * rows;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (cx, cy) => values[cy * (cols + 2) + cx];
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return top + (bottom - top) * sy;
  };
}

// When each spot of the picture catches, 0 (first) to 1 (last): distance from
// one to three sparks along the bottom and sides, roughened by noise.
function burnField(cols, rows, aspect) {
  const octaves = [[3, 0.5], [7, 0.3], [16, 0.2]].map(([cells, weight]) => [noiseLattice(Math.ceil(cells * aspect), cells), weight]);
  const sparks = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, (_, index) =>
    index === 0
      ? { x: 0.15 + Math.random() * 0.7, y: 1.02 }
      : Math.random() < 0.5
        ? { x: Math.random() < 0.5 ? -0.02 : 1.02, y: 0.4 + Math.random() * 0.6 }
        : { x: Math.random(), y: 1.02 });
  const field = new Float32Array(cols * rows);
  let min = Infinity, max = -Infinity;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = (col + 0.5) / cols, y = (row + 0.5) / rows;
      let near = Infinity;
      sparks.forEach((spark) => (near = Math.min(near, Math.hypot((x - spark.x) * aspect, y - spark.y))));
      let rough = 0;
      octaves.forEach(([noise, weight]) => (rough += noise(x, y) * weight));
      const value = near + rough * 0.55;
      field[row * cols + col] = value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  for (let index = 0; index < field.length; index += 1) field[index] = (field[index] - min) / (max - min || 1);
  return field;
}

/* ---- burn ---- */

const BURN_EDGE = 0.012;   // how soft the hole's edge is
const BURN_GLOW = 0.03;    // the glowing rim
const BURN_CHAR = 0.05;    // black char behind it
const BURN_SCORCH = 0.13;  // brown scorch further in

function burnEffect(picture, rect, small) {
  const scale = picture.width / rect.width;
  const rise = Math.min(160, rect.height * 0.7);
  const pad = { left: 24, right: 24, top: rise, bottom: 8 };
  const ghost = fxGhost("burn", rect, scale, pad);
  const { context } = ghost;
  const W = rect.width, H = rect.height;

  const cols = Math.round(clampNumber(W / 5, 24, 128));
  const rows = Math.round(clampNumber(cols * (H / W), 16, 160));
  const field = burnField(cols, rows, W / H);
  const flicker = new Float32Array(cols * rows).map(() => Math.random() * Math.PI * 2);
  const layer = () => {
    const canvas = document.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const layerContext = canvas.getContext("2d");
    return { canvas, context: layerContext, image: layerContext.createImageData(cols, rows) };
  };
  const mask = layer(), char = layer(), glow = layer();
  const edge = new Int32Array(cols * rows);
  const particles = [];
  const sprite = sprites();
  const burnMs = small ? 1000 : 1500;
  const duration = burnMs + 900;
  const maxParticles = small ? 70 : 220;
  let last = 0;

  const spawn = (count, make) => {
    for (let index = 0; index < count && particles.length < maxParticles; index += 1) particles.push(make());
  };

  ghost.duration = duration;
  ghost.draw = (elapsed) => {
    const dt = Math.min(0.05, (elapsed - last) / 1000);
    last = elapsed;
    // The fire starts slow and picks up, like paper does.
    const p = Math.min(1, elapsed / burnMs);
    const front = -0.04 + 1.3 * Math.pow(p, 1.35);
    let edges = 0;
    const m = mask.image.data, c = char.image.data, g = glow.image.data;
    for (let index = 0; index < field.length; index += 1) {
      const d = field[index] - front;
      const o = index * 4;
      m[o + 3] = d <= 0 ? 0 : d >= BURN_EDGE ? 255 : (d / BURN_EDGE) * 255;
      // Char: near-black at the line, fading through brown into the picture.
      if (d > 0 && d < BURN_SCORCH) {
        const k = d / BURN_SCORCH;
        const near = d < BURN_CHAR;
        const u = near ? 0 : (d - BURN_CHAR) / (BURN_SCORCH - BURN_CHAR);
        c[o] = 18 + u * 150; c[o + 1] = 8 + u * 78; c[o + 2] = 3 + u * 10;
        c[o + 3] = near ? 250 - k * 50 : 210 * (1 - u) * (1 - u);
      } else {
        c[o + 3] = 0;
      }
      // The glowing rim, flickering cell by cell.
      if (d > -0.02 && d < BURN_GLOW) {
        const heat = (d < 0 ? 1 + d / 0.02 : Math.exp(-d / (BURN_GLOW * 0.45))) * (0.72 + 0.28 * Math.sin(elapsed * 0.025 + flicker[index]));
        g[o] = 255; g[o + 1] = 70 + heat * 170; g[o + 2] = heat * heat * 120; g[o + 3] = Math.min(255, heat * 300);
        if (d >= 0 && d < 0.02) edge[edges++] = index;
      } else {
        g[o + 3] = 0;
      }
    }
    mask.context.putImageData(mask.image, 0, 0);
    char.context.putImageData(char.image, 0, 0);
    glow.context.putImageData(glow.image, 0, 0);

    // New flame, embers and smoke along the burning line.
    if (edges && p < 1) {
      const cellW = W / cols, cellH = H / rows;
      const at = () => {
        const index = edge[Math.floor(Math.random() * edges)];
        return { x: ((index % cols) + Math.random()) * cellW, y: (Math.floor(index / cols) + Math.random()) * cellH };
      };
      // Per second, for the length of line burning now; fractions carry over
      // as odds so a slow frame rate spawns the same amount.
      const line = Math.min(edges, small ? 30 : 90) * dt;
      const howMany = (perCell) => Math.floor(line * perCell + Math.random());
      const flameSize = small ? 9 : 16;
      // Flames live only a moment, so they stay on the line as it moves.
      spawn(howMany(5), () => ({ kind: "flame", ...at(), vx: (Math.random() - 0.5) * 24, vy: -140 - Math.random() * 120, size: flameSize * (0.6 + Math.random() * 0.8), age: 0, life: 0.1 + Math.random() * 0.14 }));
      spawn(howMany(0.6), () => ({ kind: "ember", ...at(), vx: (Math.random() - 0.5) * 70, vy: -160 - Math.random() * 200, size: 0.9 + Math.random() * 1.1, age: 0, life: 0.5 + Math.random() * 0.7, wobble: Math.random() * 6 }));
      spawn(howMany(0.25), () => ({ kind: "smoke", ...at(), vx: (Math.random() - 0.5) * 20, vy: -110 - Math.random() * 80, size: flameSize * (1 + Math.random()), age: 0, life: 0.6 + Math.random() * 0.5 }));
    }

    context.clearRect(-pad.left, -pad.top, ghost.width, ghost.height);
    if (front < 1 + BURN_EDGE) {
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      context.imageSmoothingEnabled = true;
      context.drawImage(picture, 0, 0, W, H);
      // Heat warms the whole picture a little before the line gets there.
      context.globalCompositeOperation = "source-atop";
      context.fillStyle = `rgba(255, 96, 16, ${0.1 * Math.min(1, p * 4)})`;
      context.fillRect(0, 0, W, H);
      context.drawImage(char.canvas, 0, 0, W, H);
      context.globalCompositeOperation = "destination-in";
      context.drawImage(mask.canvas, 0, 0, W, H);
      context.globalCompositeOperation = "lighter";
      context.drawImage(glow.canvas, 0, 0, W, H);
      // A wider, fainter pass of the same rim reads as heat haze.
      context.globalAlpha = 0.35;
      context.drawImage(glow.canvas, -W * 0.02, -H * 0.03, W * 1.04, H * 1.04);
      context.globalAlpha = 1;
    }

    // Particles: smoke under, fire over.
    for (let index = particles.length - 1; index >= 0; index -= 1) {
      const particle = particles[index];
      particle.age += dt;
      if (particle.age >= particle.life) {
        particles.splice(index, 1);
        continue;
      }
      particle.x += particle.vx * dt + (particle.wobble ? Math.sin(elapsed / 70 + particle.wobble) * 0.8 : 0);
      particle.y += particle.vy * dt;
      if (particle.kind === "ember") particle.vy *= 0.985;
    }
    const life = (particle) => particle.age / particle.life;
    context.globalCompositeOperation = "source-over";
    particles.forEach((particle) => {
      if (particle.kind !== "smoke") return;
      const t = life(particle), size = particle.size * (1.5 + t * 3);
      context.globalAlpha = 0.2 * Math.sin(Math.PI * t);
      context.drawImage(sprite.smoke, particle.x - size / 2, particle.y - size / 2, size, size);
    });
    context.globalCompositeOperation = "lighter";
    particles.forEach((particle) => {
      if (particle.kind === "smoke") return;
      const t = life(particle);
      if (particle.kind === "flame") {
        // A tongue, not a ball: narrow, tall, thinning as it rises.
        const size = particle.size * (1 - t * 0.5);
        context.globalAlpha = (1 - t) * (t < 0.2 ? t / 0.2 : 1) * 0.7;
        context.drawImage(sprite.flame, particle.x - size * 0.35, particle.y - size * 1.6, size * 0.7, size * 2.2);
      } else {
        // An ember: a hard bright point in a small halo, cooling to red.
        const fade = t > 0.5 ? (1 - t) / 0.5 : 1;
        context.globalAlpha = fade * 0.55;
        const halo = particle.size * 7;
        context.drawImage(sprite.ember, particle.x - halo / 2, particle.y - halo / 2, halo, halo);
        context.globalAlpha = fade;
        context.fillStyle = t < 0.4 ? "#fff3c4" : "#ffb347";
        context.fillRect(particle.x - particle.size / 2, particle.y - particle.size / 2, particle.size, particle.size);
      }
    });
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    return elapsed < duration && (p < 1 || particles.length > 0);
  };
  return ghost;
}

/* ---- shred ---- */

function shredEffect(picture, rect, small) {
  const scale = picture.width / rect.width;
  const W = rect.width, H = rect.height;
  const fall = Math.max(120, Math.min(window.innerHeight - rect.top, H * 1.4));
  const pad = { left: 40, right: 40, top: 10, bottom: fall };
  const ghost = fxGhost("shred", rect, scale, pad);
  const { context } = ghost;
  const count = small ? 5 : 9;
  const stripW = W / count;

  // Each cut is one torn line, shared by the strips on both sides of it.
  const steps = small ? 10 : 18;
  const cuts = Array.from({ length: count + 1 }, (_, cut) => Array.from({ length: steps + 1 }, (_, step) => ({
    x: cut * stripW + (cut === 0 || cut === count ? 0 : (Math.random() - 0.5) * stripW * (step % 2 ? 0.22 : 0.1)),
    y: (step / steps) * H,
  })));
  const strips = Array.from({ length: count }, (_, index) => {
    const outward = index - (count - 1) / 2;
    return {
      left: cuts[index], right: cuts[index + 1], cx: (index + 0.5) * stripW,
      delay: 0.12 + Math.abs(outward) * 0.03 + Math.random() * 0.12,
      vx: outward * (small ? 14 : 22) + (Math.random() - 0.5) * 30, vy: -40 - Math.random() * 60,
      spin: (outward >= 0 ? 1 : -1) * (0.15 + Math.random() * 0.45), flutter: 5 + Math.random() * 5, phase: Math.random() * 6,
      x: 0, y: 0, angle: 0,
    };
  });
  const flecks = [];
  cuts.slice(1, -1).forEach((cut) => cut.forEach((point) => {
    if (Math.random() < 0.5) flecks.push({ x: point.x, y: point.y, vx: (Math.random() - 0.5) * 120, vy: -30 - Math.random() * 90, size: 1 + Math.random() * 2.2, light: Math.random() < 0.6 });
  }));
  const duration = 1250;

  const outline = (strip) => {
    context.beginPath();
    strip.left.forEach((point, index) => (index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)));
    for (let index = strip.right.length - 1; index >= 0; index -= 1) context.lineTo(strip.right[index].x, strip.right[index].y);
    context.closePath();
  };

  ghost.duration = duration;
  ghost.draw = (elapsed) => {
    const t = elapsed / 1000;
    context.clearRect(-pad.left, -pad.top, ghost.width, ghost.height);
    strips.forEach((strip, index) => {
      // First a shudder as the teeth bite, then the strips part and fall.
      const local = Math.max(0, t - strip.delay);
      const bite = Math.min(1, t / 0.12);
      const shake = t < strip.delay ? Math.sin(t * 90 + index) * 1.2 * bite : 0;
      strip.x = (index - (count - 1) / 2) * 2.5 * bite + strip.vx * local + shake;
      strip.y = strip.vy * local + 0.5 * 1500 * local * local;
      strip.angle = strip.spin * local * local * 1.4;
      const turning = Math.min(1, local * 3);
      const twist = Math.cos(local * strip.flutter + strip.phase) * turning;
      const narrow = 1 - (1 - Math.abs(twist)) * 0.5 * turning;
      const fade = Math.max(0, 1 - Math.max(0, (strip.y - fall * 0.45) / (fall * 0.55)));
      if (fade <= 0) return;
      context.save();
      context.globalAlpha = fade;
      context.translate(strip.cx + strip.x, strip.y);
      context.rotate(strip.angle);
      context.scale(narrow, 1);
      context.translate(-strip.cx, 0);
      outline(strip);
      context.save();
      context.clip();
      context.drawImage(picture, 0, 0, W, H);
      // Light catches a strip as it turns; the back of the curl goes dark.
      context.fillStyle = twist < 0 ? `rgba(0, 0, 0, ${0.45 * -twist})` : `rgba(255, 255, 255, ${0.12 * twist * Math.min(1, local * 4)})`;
      context.fillRect(0, 0, W, H);
      context.restore();
      // The torn white paper along each cut.
      context.lineWidth = 1.4;
      context.strokeStyle = "rgba(255, 252, 244, 0.55)";
      context.stroke();
      context.restore();
    });
    flecks.forEach((fleck) => {
      const local = Math.max(0, t - 0.08);
      const x = fleck.x + fleck.vx * local, y = fleck.y + fleck.vy * local + 0.5 * 900 * local * local;
      context.globalAlpha = Math.max(0, 1 - local / 1.0);
      context.fillStyle = fleck.light ? "#f4efe4" : "#8e877b";
      context.fillRect(x, y, fleck.size, fleck.size);
    });
    context.globalAlpha = 1;
    return elapsed < duration;
  };
  return ghost;
}

/* ---- sound ---- */

let fxBus = null;
let fxNoise = null;

// Everything goes through a compressor (so a pile of deletes does not clip)
// and a send to a short room reverb (so it sounds like a room, not a chip).
function soundBus(context) {
  if (fxBus?.context === context) return fxBus;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  const master = context.createGain();
  master.gain.value = 0.9;
  compressor.connect(master).connect(context.destination);
  const reverb = context.createConvolver();
  const seconds = 1.8;
  const impulse = context.createBuffer(2, Math.round(context.sampleRate * seconds), context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / data.length, 3.2);
  }
  reverb.buffer = impulse;
  const wet = context.createGain();
  wet.gain.value = 0.5;
  reverb.connect(wet).connect(compressor);
  fxBus = { context, dry: compressor, wet: reverb };
  return fxBus;
}

function noise(context) {
  if (fxNoise?.sampleRate !== context.sampleRate) {
    fxNoise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = fxNoise.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  }
  return fxNoise;
}

// An output gain wired to the bus: dry, plus `room` of it into the reverb.
function voiceOut(context, room = 0.2) {
  const bus = soundBus(context);
  const out = context.createGain();
  out.connect(bus.dry);
  if (room) {
    const send = context.createGain();
    send.gain.value = room;
    out.connect(send).connect(bus.wet);
  }
  return out;
}

function envelope(param, start, points) {
  param.setValueAtTime(0.0001, start);
  points.forEach(([at, value]) => param.exponentialRampToValueAtTime(Math.max(0.0001, value), start + at));
}

function noiseSource(context, start, length, offset = Math.random()) {
  const source = context.createBufferSource();
  source.buffer = noise(context);
  source.loop = true;
  source.start(start, offset * 1.5);
  source.stop(start + length);
  return source;
}

// A low thud you feel more than hear.
function thud(context, start, volume, from = 120, to = 42) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.setValueAtTime(from, start);
  oscillator.frequency.exponentialRampToValueAtTime(to, start + 0.22);
  envelope(gain.gain, start, [[0.008, volume], [0.32, 0.0001]]);
  oscillator.connect(gain).connect(voiceOut(context, 0.1));
  oscillator.start(start);
  oscillator.stop(start + 0.36);
}

// Paper catching: a filtered whoosh that swells and settles, a thud, and
// crackle that thins out as it burns down.
function burnSound(context, start, weight, lift) {
  const length = 0.9 + weight * 0.5;
  const whoosh = noiseSource(context, start, length);
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 2;
  filter.frequency.setValueAtTime(260, start);
  filter.frequency.exponentialRampToValueAtTime(1800 + lift, start + 0.16);
  filter.frequency.exponentialRampToValueAtTime(500, start + length);
  const gain = context.createGain();
  envelope(gain.gain, start, [[0.07, 0.5 + weight * 0.25], [0.3, 0.22], [length, 0.0001]]);
  whoosh.connect(filter).connect(gain).connect(voiceOut(context, 0.25));
  thud(context, start, 0.55 + weight * 0.3);

  // Crackle: a buffer of short pops, denser at the start.
  const rate = context.sampleRate;
  const crackle = context.createBuffer(1, Math.round(rate * length), rate);
  const data = crackle.getChannelData(0);
  const pops = Math.round(26 + weight * 30);
  for (let pop = 0; pop < pops; pop += 1) {
    const at = Math.floor(Math.pow(Math.random(), 1.8) * (data.length - rate * 0.02));
    const size = Math.floor(rate * (0.001 + Math.random() * 0.006));
    const loud = 0.2 + Math.random() * 0.8;
    for (let index = 0; index < size; index += 1) data[at + index] += (Math.random() * 2 - 1) * loud * Math.pow(1 - index / size, 2);
  }
  const crackleSource = context.createBufferSource();
  crackleSource.buffer = crackle;
  const high = context.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 1100;
  const crackleGain = context.createGain();
  crackleGain.gain.value = 0.32;
  crackleSource.connect(high).connect(crackleGain).connect(voiceOut(context, 0.15));
  crackleSource.start(start + 0.05);
}

// A shredder: a motor that bites, teeth chattering through paper, a thud.
function shredSound(context, start, weight, lift) {
  const length = 0.55 + weight * 0.35;
  const motor = context.createOscillator();
  motor.type = "sawtooth";
  motor.frequency.setValueAtTime(55, start);
  motor.frequency.linearRampToValueAtTime(48, start + length);
  const motorFilter = context.createBiquadFilter();
  motorFilter.type = "lowpass";
  motorFilter.frequency.value = 520;
  const motorGain = context.createGain();
  envelope(motorGain.gain, start, [[0.03, 0.22], [length * 0.8, 0.16], [length, 0.0001]]);
  motor.connect(motorFilter).connect(motorGain).connect(voiceOut(context, 0.08));
  motor.start(start);
  motor.stop(start + length + 0.02);

  const paper = noiseSource(context, start, length);
  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.9;
  band.frequency.setValueAtTime(3200 + lift, start);
  band.frequency.exponentialRampToValueAtTime(1300, start + length);
  // The chatter: the paper's level pulsed by a fast square wave.
  const teeth = context.createOscillator();
  teeth.type = "square";
  teeth.frequency.value = 38 + Math.random() * 8;
  const depth = context.createGain();
  depth.gain.value = 0.5;
  const paperGain = context.createGain();
  paperGain.gain.value = 0.5;
  teeth.connect(depth).connect(paperGain.gain);
  const shape = context.createGain();
  envelope(shape.gain, start, [[0.02, 0.6 + weight * 0.2], [length * 0.7, 0.4], [length, 0.0001]]);
  paper.connect(band).connect(paperGain).connect(shape).connect(voiceOut(context, 0.15));
  teeth.start(start);
  teeth.stop(start + length);
  thud(context, start + length * 0.85, 0.35 + weight * 0.2, 90, 40);
}

// Plain: a soft whoomp and a thud, no fuss.
function plainSound(context, start, weight) {
  const air = noiseSource(context, start, 0.3);
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(1600, start);
  filter.frequency.exponentialRampToValueAtTime(240, start + 0.28);
  const gain = context.createGain();
  envelope(gain.gain, start, [[0.02, 0.3 + weight * 0.15], [0.28, 0.0001]]);
  air.connect(filter).connect(gain).connect(voiceOut(context, 0.2));
  thud(context, start, 0.5 + weight * 0.3);
}

// What 38-thrill.js calls on every delete. weight 0..1 is how much went at
// once; streak drives the pitch of the effect.
function playDeleteSound(context, { effect, weight, streak, milestone }) {
  const start = context.currentTime + 0.01;
  const lift = Math.min(streak, 30) * 60;
  if (effect === "shred") shredSound(context, start, weight, lift);
  else if (effect === "burn") burnSound(context, start, weight, lift);
  else plainSound(context, start, weight);
  if (milestone) chime(context, [523.25, 659.25, 783.99, 1046.5, 1318.5], start + 0.12, 0.075, 0.16);
}

// A bell: each note a few sine partials that ring into the reverb.
function chime(context, notes, start, gap, volume) {
  notes.forEach((frequency, index) => {
    const when = start + index * gap;
    const out = voiceOut(context, 0.45);
    [[1, 1], [2.01, 0.35], [3.02, 0.12]].forEach(([ratio, level]) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency * ratio;
      envelope(gain.gain, when, [[0.006, volume * level], [0.5 / ratio + 0.15, 0.0001]]);
      oscillator.connect(gain).connect(out);
      oscillator.start(when);
      oscillator.stop(when + 0.7);
    });
  });
}

// A keep: a soft rising "bloop".
function keepChime(context) {
  const start = context.currentTime + 0.01;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.setValueAtTime(620, start);
  oscillator.frequency.exponentialRampToValueAtTime(1240, start + 0.09);
  envelope(gain.gain, start, [[0.01, 0.12], [0.2, 0.0001]]);
  oscillator.connect(gain).connect(voiceOut(context, 0.3));
  oscillator.start(start);
  oscillator.stop(start + 0.22);
}
