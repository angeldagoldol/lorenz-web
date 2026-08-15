(() => {
  'use strict';

  if (window.__dagoldolPixelTrailInstalled) return;
  window.__dagoldolPixelTrailInstalled = true;

  const DEFAULTS = Object.freeze({
    gridSize: 96,
    trailSize: 0.1,
    maxAge: 220,
    interpolate: 7,
    color: '#1A00FE',
    scratchCount: 3,
    scratchGap: 1.25,
    breakEvery: 8,
    jitter: 0.32,
    maxDevicePixelRatio: 1.5,
    maxInterpolationSteps: 120
  });

  const externalConfig = (
    window.DAGOLDOL_PIXEL_TRAIL_CONFIG &&
    typeof window.DAGOLDOL_PIXEL_TRAIL_CONFIG === 'object'
  ) ? window.DAGOLDOL_PIXEL_TRAIL_CONFIG : {};

  const config = {
    gridSize: clampNumber(externalConfig.gridSize, 48, 160, DEFAULTS.gridSize),
    trailSize: clampNumber(externalConfig.trailSize, 0.02, 0.3, DEFAULTS.trailSize),
    maxAge: clampNumber(externalConfig.maxAge, 100, 600, DEFAULTS.maxAge),
    interpolate: clampNumber(externalConfig.interpolate, 2, 12, DEFAULTS.interpolate),
    color: typeof externalConfig.color === 'string' && externalConfig.color.trim()
      ? externalConfig.color.trim()
      : DEFAULTS.color,
    scratchCount: Math.round(clampNumber(
      externalConfig.scratchCount,
      3,
      3,
      DEFAULTS.scratchCount
    )),
    scratchGap: clampNumber(
      externalConfig.scratchGap,
      0.8,
      2,
      DEFAULTS.scratchGap
    ),
    breakEvery: Math.round(clampNumber(
      externalConfig.breakEvery,
      6,
      14,
      DEFAULTS.breakEvery
    )),
    jitter: clampNumber(externalConfig.jitter, 0, 0.7, DEFAULTS.jitter),
    maxDevicePixelRatio: clampNumber(
      externalConfig.maxDevicePixelRatio,
      1,
      2,
      DEFAULTS.maxDevicePixelRatio
    ),
    maxInterpolationSteps: Math.round(clampNumber(
      externalConfig.maxInterpolationSteps,
      32,
      180,
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
  let cellSize = 7;
  let gridColumns = 0;
  let gridRows = 0;
  let cellTimes = new Float64Array(0);
  let cellStrengths = new Float32Array(0);
  let activeCells = new Set();
  let lastPointer = null;
  let segmentSequence = 0;
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
    segmentSequence = 0;
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
      4,
      Math.floor((Math.min(width, height) * dpr) / config.gridSize)
    );
    cellSize = targetPhysicalCell / dpr;

    gridColumns = Math.max(1, Math.ceil(width / cellSize));
    gridRows = Math.max(1, Math.ceil(height / cellSize));
    cellTimes = new Float64Array(gridColumns * gridRows);
    cellStrengths = new Float32Array(gridColumns * gridRows);
    activeCells = new Set();
    lastPointer = null;
    segmentSequence = 0;

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
    return strength * Math.pow(life, 1.35);
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

  function signedNoise(seed) {
    const raw = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return (raw - Math.floor(raw)) * 2 - 1;
  }

  function shouldBreakLane(sampleIndex, laneIndex) {
    const phase = (sampleIndex + laneIndex * 3 + segmentSequence) % config.breakEvery;
    return phase >= config.breakEvery - 2;
  }

  function stampScratchPoint(x, y, laneIndex, sampleIndex, time, tangentX, tangentY, normalX, normalY) {
    if (shouldBreakLane(sampleIndex, laneIndex)) return;

    const middle = (config.scratchCount - 1) / 2;
    const laneOffset = (laneIndex - middle) * cellSize * config.scratchGap;
    const seed = segmentSequence * 97 + sampleIndex * 17 + laneIndex * 31;
    const sideJitter = signedNoise(seed) * cellSize * config.jitter;
    const forwardJitter = signedNoise(seed + 0.47) * cellSize * config.jitter * 0.34;

    const scratchX = x
      + normalX * (laneOffset + sideJitter)
      + tangentX * forwardJitter;
    const scratchY = y
      + normalY * (laneOffset + sideJitter)
      + tangentY * forwardJitter;

    const gridX = Math.floor(scratchX / cellSize);
    const gridY = Math.floor(scratchY / cellSize);
    const laneDistance = Math.abs(laneIndex - middle);
    const laneStrength = Math.max(0.72, 1 - laneDistance * 0.1);
    const textureStrength = 0.86 + Math.abs(signedNoise(seed + 1.9)) * 0.14;
    const ageBias = laneDistance * 12;

    stampCell(gridX, gridY, laneStrength * textureStrength, time - ageBias);

    // Sparse single-cell notches make each line look torn rather than perfectly plotted.
    if ((sampleIndex + laneIndex + segmentSequence) % 13 === 5) {
      const notchDirection = signedNoise(seed + 4.2) >= 0 ? 1 : -1;
      stampCell(
        gridX + Math.round(normalX * notchDirection),
        gridY + Math.round(normalY * notchDirection),
        laneStrength * 0.42,
        time - 18
      );
    }
  }

  function addScratchSegment(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);

    if (distance < 0.75) return;

    const tangentX = dx / distance;
    const tangentY = dy / distance;
    const normalX = -tangentY;
    const normalY = tangentX;
    const spacing = Math.max(1.5, cellSize * 0.48);
    const steps = Math.min(
      config.maxInterpolationSteps,
      Math.max(1, Math.ceil(distance / spacing))
    );

    segmentSequence += 1;

    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps;
      const x = from.x + dx * ratio;
      const y = from.y + dy * ratio;
      const sampleTime = from.time + (to.time - from.time) * ratio;

      for (let lane = 0; lane < config.scratchCount; lane += 1) {
        stampScratchPoint(
          x,
          y,
          lane,
          step,
          sampleTime,
          tangentX,
          tangentY,
          normalX,
          normalY
        );
      }
    }
  }

  function addInterpolatedTrail(x, y, time) {
    if (!lastPointer) {
      // Record the starting point without painting a circular cursor blob.
      lastPointer = { x, y, time };
      return;
    }

    const nextPointer = { x, y, time };
    addScratchSegment(lastPointer, nextPointer);
    lastPointer = nextPointer;
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

      context.globalAlpha = Math.min(0.94, opacity);
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
