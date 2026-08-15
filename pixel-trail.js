(() => {
  'use strict';

  if (window.__dagoldolPixelTrailInstalled) return;
  window.__dagoldolPixelTrailInstalled = true;

  const DEFAULTS = Object.freeze({
    gridSize: 50,
    trailSize: 0.1,
    maxAge: 420,
    interpolate: 5,
    color: '#1A00FE',
    maxDevicePixelRatio: 1.5,
    maxInterpolationSteps: 96
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
    maxInterpolationSteps: Math.round(clampNumber(
      externalConfig.maxInterpolationSteps,
      24,
      160,
      DEFAULTS.maxInterpolationSteps
    ))
  };

  const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  const coarsePointerQuery = window.matchMedia?.('(pointer: coarse)') || null;
  const noHoverQuery = window.matchMedia?.('(hover: none)') || null;

  let canvas = null;
  let context = null;
  let animationFrame = 0;
  let resizeFrame = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let cellSize = 10;
  let gridColumns = 0;
  let gridRows = 0;
  let cellTimes = new Float64Array(0);
  let cellStrengths = new Float32Array(0);
  let activeCells = new Set();
  let lastPointer = null;
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

    context.imageSmoothingEnabled = false;
    document.body.appendChild(canvas);
    resizeCanvas();
  }

  function clearGrid() {
    activeCells.clear();
    cellTimes.fill(0);
    cellStrengths.fill(0);
    lastPointer = null;
  }

  function clearCanvas() {
    if (!context) return;
    context.clearRect(0, 0, width, height);
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
      context.imageSmoothingEnabled = false;
    }

    const targetPhysicalCell = Math.max(
      6,
      Math.floor((Math.min(width, height) * dpr) / config.gridSize)
    );
    cellSize = targetPhysicalCell / dpr;

    gridColumns = Math.max(1, Math.ceil(width / cellSize));
    gridRows = Math.max(1, Math.ceil(height / cellSize));
    cellTimes = new Float64Array(gridColumns * gridRows);
    cellStrengths = new Float32Array(gridColumns * gridRows);
    activeCells = new Set();
    lastPointer = null;

    clearCanvas();
  }

  function scheduleResize() {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      resizeCanvas();
    });
  }

  function getCellIndex(gridX, gridY) {
    return gridY * gridColumns + gridX;
  }

  function getCellOpacity(index, time) {
    const strength = cellStrengths[index];
    if (strength <= 0) return 0;

    const age = Math.max(0, time - cellTimes[index]);
    if (age >= config.maxAge) return 0;

    const life = 1 - age / config.maxAge;
    return strength * Math.pow(life, 1.12);
  }

  function stampCell(gridX, gridY, strength, time) {
    if (gridX < 0 || gridY < 0 || gridX >= gridColumns || gridY >= gridRows) return;

    const index = getCellIndex(gridX, gridY);
    const existingOpacity = getCellOpacity(index, time);
    const nextStrength = Math.max(existingOpacity, strength);

    cellTimes[index] = time;
    cellStrengths[index] = nextStrength;
    activeCells.add(index);
  }

  function stampBrush(x, y, time) {
    const centerX = Math.floor(x / cellSize);
    const centerY = Math.floor(y / cellSize);
    const radiusCells = Math.max(1, Math.ceil(config.gridSize * config.trailSize));
    const radiusLimit = radiusCells + 0.45;

    for (let offsetY = -radiusCells; offsetY <= radiusCells; offsetY += 1) {
      for (let offsetX = -radiusCells; offsetX <= radiusCells; offsetX += 1) {
        const distance = Math.hypot(offsetX, offsetY);
        if (distance > radiusLimit) continue;

        const edgeDepth = Math.max(0, radiusLimit - distance);
        const strength = edgeDepth >= 1
          ? 1
          : 0.76 + 0.24 * edgeDepth;
        stampCell(centerX + offsetX, centerY + offsetY, strength, time);
      }
    }
  }

  function addInterpolatedTrail(x, y, time) {
    if (!lastPointer) {
      stampBrush(x, y, time);
      lastPointer = { x, y, time };
      return;
    }

    const dx = x - lastPointer.x;
    const dy = y - lastPointer.y;
    const distance = Math.hypot(dx, dy);
    const spacing = Math.max(2, cellSize / config.interpolate);
    const steps = Math.min(
      config.maxInterpolationSteps,
      Math.max(1, Math.ceil(distance / spacing))
    );

    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      stampBrush(
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
    addInterpolatedTrail(event.clientX, event.clientY, now);
    ensureAnimation();
  }

  function onPointerLeave(event) {
    if (event && event.relatedTarget) return;
    lastPointer = null;
  }

  function drawFrame(now) {
    animationFrame = 0;
    if (!enabled || !context) return;

    clearCanvas();

    if (!activeCells.size) return;

    context.fillStyle = config.color;

    for (const index of activeCells) {
      const opacity = getCellOpacity(index, now);

      if (opacity <= 0.015) {
        cellTimes[index] = 0;
        cellStrengths[index] = 0;
        activeCells.delete(index);
        continue;
      }

      const gridY = Math.floor(index / gridColumns);
      const gridX = index - gridY * gridColumns;

      context.globalAlpha = Math.min(1, opacity);
      context.fillRect(
        gridX * cellSize,
        gridY * cellSize,
        cellSize,
        cellSize
      );
    }

    context.globalAlpha = 1;

    if (activeCells.size) ensureAnimation();
  }

  function ensureAnimation() {
    if (!enabled || animationFrame || !activeCells.size) return;
    animationFrame = requestAnimationFrame(drawFrame);
  }

  function stopAnimation() {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
    clearGrid();
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
