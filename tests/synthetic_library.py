"""A synthetic media library for the browser checks.

The checks used to read a hand-made test library on the Lexar stick
(/mnt/edging-heaven/testing), which died on 2026-09-29. This builds an
equivalent one: four model folders of distinct JPEG and PNG pictures in
several shapes, a subfolder, and short VP8 WebM clips. Pictures are drawn by
headless Chromium; clips are encoded by the ffmpeg that Playwright installs
(no system packages needed).

The library carries a marker file, and the checks refuse any --media-dir
without it, so they can never be pointed at the real library.

    python3 tests/synthetic_library.py [dir]   # build it (default: see DEFAULT_DIR)
"""
import base64
import glob
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MARKER = ".edging-heaven-test-library"
VERSION = "2"
DEFAULT_DIR = Path(tempfile.gettempdir()) / "edging-heaven-test-library"

# Folder names are model slugs, as simp downloads them ("alice_example").
MODELS = ["alice_example", "bella", "cara_mia", "dana"]
SHAPES = [(600, 900), (900, 600), (700, 700), (640, 960), (1000, 620)]
PICTURES_PER_MODEL = 9
CLIPS_PER_MODEL = 3
CLIP_SECONDS = 6
CLIP_FPS = 10

# Seeded drawing so every picture is different, but the same on every build.
DRAW = """
(spec) => {
  let seed = spec.seed;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const hue = () => Math.floor(rand() * 360);
  const canvas = document.createElement('canvas');
  canvas.width = spec.w; canvas.height = spec.h;
  const g = canvas.getContext('2d');
  const out = [];
  const frames = spec.frames || 1;
  const a = hue(), b = hue(), shapes = Array.from({length: 7}, () => [rand(), rand(), 0.05 + rand() * 0.25, hue(), rand() > 0.5]);
  for (let f = 0; f < frames; f += 1) {
    const grad = g.createLinearGradient(0, 0, spec.w, spec.h);
    grad.addColorStop(0, `hsl(${a} 60% 45%)`); grad.addColorStop(1, `hsl(${b} 65% 30%)`);
    g.fillStyle = grad; g.fillRect(0, 0, spec.w, spec.h);
    for (const [x, y, r, h, round] of shapes) {
      g.fillStyle = `hsl(${h} 70% 60% / 0.8)`;
      const cx = (x + f / Math.max(frames, 1) * 0.3) % 1 * spec.w, cy = y * spec.h, size = r * Math.min(spec.w, spec.h);
      g.beginPath(); round ? g.arc(cx, cy, size, 0, Math.PI * 2) : g.rect(cx - size, cy - size, size * 2, size * 1.4); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = `${Math.round(spec.h / 14)}px sans-serif`;
    g.fillText(spec.label + (frames > 1 ? ` ${f}` : ''), spec.w * 0.06, spec.h * 0.94);
    out.push(canvas.toDataURL(spec.type, 0.88).split(',')[1]);
  }
  return out;
}
"""


def _ffmpeg():
    roots = [os.environ.get("PLAYWRIGHT_BROWSERS_PATH"), str(Path.home() / ".cache" / "ms-playwright")]
    for root in filter(None, roots):
        found = sorted(glob.glob(os.path.join(root, "ffmpeg-*", "ffmpeg-linux")))
        if found:
            return found[-1]
    raise SystemExit("Playwright's ffmpeg was not found; run: playwright install ffmpeg")


def is_test_library(path):
    return (Path(path) / MARKER).is_file()


def build(target):
    from playwright.sync_api import sync_playwright

    target = Path(target)
    if target.exists():
        # Rebuild from scratch, but only ever delete a library this made.
        if not is_test_library(target) and any(target.iterdir()):
            raise SystemExit(f"{target} exists and is not a test library; refusing to overwrite it.")
        shutil.rmtree(target)
    target.mkdir(parents=True)
    ffmpeg = _ffmpeg()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("BROWSER_EXECUTABLE"), args=["--no-sandbox"])
        page = browser.new_page()
        seed = 1
        for m, model in enumerate(MODELS):
            folder = target / model
            folder.mkdir(exist_ok=True)
            for n in range(PICTURES_PER_MODEL):
                w, h = SHAPES[(m + n) % len(SHAPES)]
                kind = "png" if n == PICTURES_PER_MODEL - 1 else "jpg"
                [data] = page.evaluate(DRAW, {"seed": seed, "w": w, "h": h, "type": f"image/{'png' if kind == 'png' else 'jpeg'}", "label": f"{model} {n}"})
                (folder / f"photo_{n:02d}.{kind}").write_bytes(base64.b64decode(data))
                seed += 1
            if m == 0:
                (folder / "set_1").mkdir(exist_ok=True)
                for n in range(3):
                    [data] = page.evaluate(DRAW, {"seed": seed, "w": 800, "h": 600, "type": "image/jpeg", "label": f"set {n}"})
                    (folder / "set_1" / f"set_{n:02d}.jpg").write_bytes(base64.b64decode(data))
                    seed += 1
            for n in range(CLIPS_PER_MODEL):
                frames = page.evaluate(DRAW, {"seed": seed, "w": 320, "h": 240, "type": "image/jpeg", "label": f"{model} clip {n}", "frames": CLIP_SECONDS * CLIP_FPS})
                seed += 1
                subprocess.run(
                    [ffmpeg, "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", str(CLIP_FPS), "-i", "pipe:0",
                     "-c:v", "libvpx", "-b:v", "400k", "-pix_fmt", "yuv420p", str(folder / f"clip_{n:02d}.webm")],
                    input=b"".join(base64.b64decode(f) for f in frames), check=True,
                )
        browser.close()
    (target / MARKER).write_text(VERSION + "\n")
    return target


def ensure(media_dir=None):
    """The library to test against: a given one (only if it is a test
    library), or the default one, built on first use."""
    if media_dir is not None:
        if not is_test_library(media_dir):
            raise SystemExit(f"{media_dir} is not a test library (no {MARKER}); refusing to use it.")
        return Path(media_dir)
    marker = DEFAULT_DIR / MARKER
    if not (marker.is_file() and marker.read_text().strip() == VERSION):
        print(f"Building the test library in {DEFAULT_DIR} …")
        build(DEFAULT_DIR)
    return DEFAULT_DIR


if __name__ == "__main__":
    print(build(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DIR))
