(() => {
  'use strict';

  if (window.__dagoldolPixelTrailInstalled) return;
  window.__dagoldolPixelTrailInstalled = true;

  const DEFAULTS = Object.freeze({
    gridSize: 50,
    trailSize: 0.1,
    maxAge: 250,
    interpolate: 5,
    color: '#4FE3C1',
    maxDevicePixelRatio: 1.5,
    maxSamples: 240
  });

  const externalConfig = (
    window.DAGOLDOL_PIXEL_TRAIL_CONFIG &&
    typeof window.DAGOLDOL_PIXEL_TRAIL_CONFIG === 'object'
  ) ? window.DAGOLDOL_PIXEL_TRAIL_CONFIG : {};

  const config = {
    gridSize: clampNumber(externalConfig.gridSize, 12, 120, DEFAULTS.gridSize),
    trailSize: clampNumber(externalConfig.trailSize, 0.02, 0.3, DEFAULTS.trailSize),
    maxAge: clampNumber(externalConfig.maxAge, 80, 1500, DEFAULTS.maxAge),
    interpolate: clampNumber(externalConfig.interpolate, 1, 12, DEFAULTS.interpolate),
    color: typeof externalConfig.color === 'string' && externalConfig.color.trim()
      ? externalConfig.color.trim()
      : DEFAULTS.color,
    maxDevicePixelRatio: clampNumber(
      externalConfig.maxDevicePixelRatio,
      1,
      2,
      DEFAULTS.maxDevicePixelRatio
    ),
    maxSamples: clampNumber(externalConfig.maxSamples, 60, 600, DEFAULTS.maxSamples)
  };

  const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  const coarsePointerQuery = window.matchMedia?.('(pointer: coarse)') || null;
  const noHoverQuery = window.matchMedia?.('(hover: none)') || null;

  let canvas = null;
  let context = null;
  let samples = [];
  let lastPointer = null;
  let animationFrame = 0;
  let resizeFrame = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let cellSize = 16;
  let enabled = false;
  let destroyed = false;

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function shouldEnable() {
    if (destroyed) return false;
    if (reducedMotionQuery?.matches) return false;
    if (coarsePointerQuery?.matches) return false;
    if (noHoverQuery?.matches) return false;
    return true;
  }

  function setStatus(status) {
    document.documentElement.dataset.pixelTrail = status;
  }

  function createCanvas() {
    if (canvas || !document.body) return;

    canvas = document.createElement('canvas');
    canvas.className = 'pixel-trail-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.setAttribute('role', 'presentation');
    canvas.style.pointerEvents = 'none';
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';

    context = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true
    });

    if (!context) {
      canvas.remove();
      canvas = null;
      setStatus('unsupported');
      return;
    }

    document.body.appendChild(canvas);
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvas || !context) return;

    width = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    height = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    dpr = Math.min(config.maxDevicePixelRatio, Math.max(1, window.devicePixelRatio || 1));

    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));

    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    cellSize = Math.max(8, Math.min(width, height) / config.gridSize);
    clearCanvas();
  }

  function scheduleResize() {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      resizeCanvas();
    });
  }

  function clearCanvas() {
    if (!context) return;
    context.clearRect(0, 0, width, height);
  }

  function addSample(x, y, time) {
    samples.push({ x, y, time });
    if (samples.length > config.maxSamples) {
      samples.splice(0, samples.length - config.maxSamples);
    }
  }

  function addInterpolatedSamples(x, y, time) {
    if (!lastPointer) {
      addSample(x, y, time);
      lastPointer = { x, y, time };
      return;
    }

    const dx = x - lastPointer.x;
    const dy = y - lastPointer.y;
    const distance = Math.hypot(dx, dy);
    const spacing = Math.max(3, cellSize / config.interpolate);
    const steps = Math.min(16, Math.max(1, Math.ceil(distance / spacing)));

    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      addSample(
        lastPointer.x + dx * ratio,
        lastPointer.y + dy * ratio,
        lastPointer.time + (time - lastPointer.time) * ratio
      );
    }

    lastPointer = { x, y, time };
  }

  function onPointerMove(event) {
    if (!enabled || event.pointerType === 'touch') return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;

    const now = performance.now();
    addInterpolatedSamples(event.clientX, event.clientY, now);
    ensureAnimation();
  }

  function onPointerLeave(event) {
    if (event && event.relatedTarget) return;
    lastPointer = null;
  }

  function drawFrame(now) {
    animationFrame = 0;
    if (!enabled || !context) return;

    const oldestAllowed = now - config.maxAge;
    samples = samples.filter((sample) => sample.time >= oldestAllowed);

    clearCanvas();

    if (!samples.length) return;

    const radiusCells = Math.max(1, Math.ceil(config.gridSize * config.trailSize * 0.5));
    const pixels = new Map();

    for (const sample of samples) {
      const age = Math.max(0, now - sample.time);
      const life = Math.max(0, 1 - age / config.maxAge);
      if (life <= 0) continue;

      const centerX = Math.floor(sample.x / cellSize);
      const centerY = Math.floor(sample.y / cellSize);

      for (let offsetY = -radiusCells; offsetY <= radiusCells; offsetY += 1) {
        for (let offsetX = -radiusCells; offsetX <= radiusCells; offsetX += 1) {
          const distance = Math.hypot(offsetX, offsetY);
          if (distance > radiusCells + 0.35) continue;

          const gridX = centerX + offsetX;
          const gridY = centerY + offsetY;
          if (gridX < 0 || gridY < 0) continue;

          const radial = Math.max(0, 1 - distance / (radiusCells + 0.5));
          const opacity = Math.pow(life, 1.6) * Math.pow(radial, 1.15);
          if (opacity < 0.035) continue;

          const key = `${gridX}:${gridY}`;
          const existing = pixels.get(key) || 0;
          if (opacity > existing) pixels.set(key, opacity);
        }
      }
    }

    context.fillStyle = config.color;
    const gap = Math.max(1, Math.round(cellSize * 0.18));
    const pixelSize = Math.max(2, cellSize - gap);
    const inset = (cellSize - pixelSize) / 2;

    for (const [key, opacity] of pixels) {
      const [gridX, gridY] = key.split(':').map(Number);
      context.globalAlpha = Math.min(0.92, opacity);
      context.fillRect(
        gridX * cellSize + inset,
        gridY * cellSize + inset,
        pixelSize,
        pixelSize
      );
    }

    context.globalAlpha = 1;
    ensureAnimation();
  }

  function ensureAnimation() {
    if (!enabled || animationFrame || !samples.length) return;
    animationFrame = requestAnimationFrame(drawFrame);
  }

  function stopAnimation() {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
    samples = [];
    lastPointer = null;
    clearCanvas();
  }

  function enable() {
    if (enabled || !shouldEnable()) return;
    createCanvas();
    if (!canvas || !context) return;

    enabled = true;
    canvas.hidden = false;
    setStatus('enabled');

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerout', onPointerLeave, { passive: true });
    window.addEventListener('blur', onPointerLeave, { passive: true });
  }

  function disable(reason = 'disabled') {
    if (enabled) {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerout', onPointerLeave);
      window.removeEventListener('blur', onPointerLeave);
    }

    enabled = false;
    stopAnimation();
    if (canvas) canvas.hidden = true;
    setStatus(reason);
  }

  function syncCapability() {
    if (shouldEnable()) enable();
    else disable(reducedMotionQuery?.matches ? 'reduced-motion' : 'touch-device');
  }

  function onVisibilityChange() {
    if (document.hidden) {
      stopAnimation();
      return;
    }
    syncCapability();
  }

  function destroy() {
    destroyed = true;
    disable('destroyed');
    window.removeEventListener('resize', scheduleResize);
    window.removeEventListener('orientationchange', scheduleResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    reducedMotionQuery?.removeEventListener?.('change', syncCapability);
    coarsePointerQuery?.removeEventListener?.('change', syncCapability);
    noHoverQuery?.removeEventListener?.('change', syncCapability);
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    canvas?.remove();
    canvas = null;
    context = null;
  }

  function install() {
    if (!document.body) return;

    window.addEventListener('resize', scheduleResize, { passive: true });
    window.addEventListener('orientationchange', scheduleResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    reducedMotionQuery?.addEventListener?.('change', syncCapability);
    coarsePointerQuery?.addEventListener?.('change', syncCapability);
    noHoverQuery?.addEventListener?.('change', syncCapability);

    syncCapability();
  }

  window.DagoldolPixelTrail = Object.freeze({
    destroy,
    get enabled() {
      return enabled;
    },
    get config() {
      return { ...config };
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
