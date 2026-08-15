import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve('/mnt/data/DAGOLDOL-PIXEL-TRAIL-SCRATCH-WORK');
const js = fs.readFileSync(path.join(root, 'pixel-trail.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pixel-trail.css'), 'utf8');

function makeHarness() {
  const listeners = new Map();
  const mediaListeners = [];
  const fillRects = [];
  const rafQueue = new Map();
  let rafId = 0;
  let now = 1000;

  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    imageSmoothingEnabled: true,
    setTransform() {},
    clearRect() {},
    fillRect(x, y, w, h) {
      fillRects.push({ x, y, w, h, alpha: this.globalAlpha });
    }
  };

  const canvas = {
    className: '',
    hidden: false,
    width: 0,
    height: 0,
    style: {},
    setAttribute() {},
    remove() {},
    getContext() { return ctx; }
  };

  const documentElement = { clientWidth: 900, clientHeight: 600, dataset: {} };
  const body = { appendChild() {} };
  const document = {
    readyState: 'complete',
    body,
    documentElement,
    hidden: false,
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return canvas;
    },
    addEventListener(type, handler) { listeners.set(`document:${type}`, handler); },
    removeEventListener(type) { listeners.delete(`document:${type}`); }
  };

  const matchMedia = query => ({
    media: query,
    matches: false,
    addEventListener(type, handler) { mediaListeners.push({ query, type, handler }); },
    removeEventListener() {}
  });

  const window = {
    innerWidth: 900,
    innerHeight: 600,
    devicePixelRatio: 1,
    matchMedia,
    addEventListener(type, handler) { listeners.set(`window:${type}`, handler); },
    removeEventListener(type) { listeners.delete(`window:${type}`); },
    DAGOLDOL_PIXEL_TRAIL_CONFIG: {
      gridSize: 96,
      maxAge: 220,
      scratchCount: 3,
      scratchGap: 1.25,
      breakEvery: 8,
      jitter: 0.32
    }
  };

  const sandbox = {
    window,
    document,
    performance: { now: () => now },
    requestAnimationFrame(callback) {
      const id = ++rafId;
      rafQueue.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { rafQueue.delete(id); },
    Float64Array,
    Float32Array,
    Set,
    Math,
    Number,
    Object,
    console
  };

  vm.runInNewContext(js, sandbox, { filename: 'pixel-trail.js' });

  return {
    window,
    fillRects,
    listeners,
    setNow(value) { now = value; },
    pointerMove(x, y, pointerType = 'mouse') {
      const handler = listeners.get('window:pointermove');
      assert.equal(typeof handler, 'function');
      handler({ clientX: x, clientY: y, pointerType });
    },
    flushRaf(timestamp = now) {
      const callbacks = [...rafQueue.values()];
      rafQueue.clear();
      for (const callback of callbacks) callback(timestamp);
    }
  };
}

test('defaults describe a compact three-scratch cursor trail', () => {
  assert.match(js, /scratchCount:\s*3/);
  assert.match(js, /maxAge:\s*220/);
  assert.match(js, /gridSize:\s*96/);
  assert.match(js, /scratchGap:/);
  assert.match(js, /breakEvery:/);
});

test('movement renders a narrow scratch ribbon instead of a round brush', () => {
  const h = makeHarness();
  h.pointerMove(120, 220);
  h.setNow(1016);
  h.pointerMove(300, 220);
  h.flushRaf(1016);

  assert.ok(h.fillRects.length > 8, 'expected visible scratch cells');
  const xs = h.fillRects.map(r => r.x);
  const ys = h.fillRects.map(r => r.y);
  const width = Math.max(...xs) - Math.min(...xs) + h.fillRects[0].w;
  const height = Math.max(...ys) - Math.min(...ys) + h.fillRects[0].h;

  assert.ok(width > 120, `scratch should stretch with cursor movement, got width ${width}`);
  assert.ok(height < 52, `scratch should stay thin, got height ${height}`);
  assert.ok(width / height > 3, `scratch should be ribbon-like, got aspect ${width / height}`);
});

test('scratch trail expires quickly', () => {
  const h = makeHarness();
  h.pointerMove(120, 220);
  h.setNow(1016);
  h.pointerMove(260, 220);
  h.flushRaf(1016);
  assert.ok(h.fillRects.length > 0);

  const before = h.fillRects.length;
  h.setNow(1300);
  h.flushRaf(1300);
  assert.equal(h.fillRects.length, before, 'expired cells should not draw new rectangles');
});

test('touch input does not generate the cursor trail', () => {
  const h = makeHarness();
  h.pointerMove(100, 100, 'touch');
  h.setNow(1016);
  h.pointerMove(200, 100, 'touch');
  h.flushRaf(1016);
  assert.equal(h.fillRects.length, 0);
});

test('overlay remains visual-only and cannot block UI clicks', () => {
  assert.match(css, /pointer-events:\s*none\s*!important/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /pointer:\s*coarse/);
});
