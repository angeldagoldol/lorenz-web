// liquid-chrome.js
// Vanilla LiquidChrome integration for Dagoldol.
//
// Mobile stability rule:
// - phone/tablet-class touch devices use the same dark visual treatment but do
//   not download OGL or create a WebGL context. This avoids allocating a
//   continuously rendered full-screen GPU surface on the devices that were
//   reported to crash.
// - desktop/pointer devices keep the original LiquidChrome effect and controls.
//
// The public createLiquidChrome(container, options) contract remains synchronous
// and still returns a destroy() function. OGL is loaded lazily only when the
// current device is eligible for the animated background.
import { shouldAnimateLiquidChrome } from './phase2-core.js';

const vertexShader = `
  attribute vec2 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const fragmentShader = `
  precision highp float;
  uniform float uTime;
  uniform vec3 uResolution;
  uniform vec3 uBaseColor;
  uniform float uAmplitude;
  uniform float uFrequencyX;
  uniform float uFrequencyY;
  uniform vec2 uMouse;
  varying vec2 vUv;

  vec4 renderImage(vec2 uvCoord) {
      vec2 fragCoord = uvCoord * uResolution.xy;
      vec2 uv = (2.0 * fragCoord - uResolution.xy) / min(uResolution.x, uResolution.y);

      for (float i = 1.0; i < 10.0; i++){
          uv.x += uAmplitude / i * cos(i * uFrequencyX * uv.y + uTime + uMouse.x * 3.14159);
          uv.y += uAmplitude / i * cos(i * uFrequencyY * uv.x + uTime + uMouse.y * 3.14159);
      }

      vec2 diff = (uvCoord - uMouse);
      float dist = length(diff);
      float falloff = exp(-dist * 20.0);
      float ripple = sin(10.0 * dist - uTime * 2.0) * 0.03;
      uv += (diff / (dist + 0.0001)) * ripple * falloff;

      vec3 color = uBaseColor / abs(sin(uTime - uv.y - uv.x));
      return vec4(color, 1.0);
  }

  void main() {
      vec4 col = vec4(0.0);
      int samples = 0;
      for (int i = -1; i <= 1; i++){
          for (int j = -1; j <= 1; j++){
              vec2 offset = vec2(float(i), float(j)) * (1.0 / min(uResolution.x, uResolution.y));
              col += renderImage(vUv + offset);
              samples++;
          }
      }
      gl_FragColor = col / float(samples);
  }
`;

const mountedControllers = new Set();
let globalUserPaused = false;
let motionToggle = null;
let oglModulePromise = null;

function mediaMatches(query) {
  try {
    return window.matchMedia?.(query).matches === true;
  } catch (_) {
    return false;
  }
}

export function shouldUseStaticBackground() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;

  const viewportWidth = Number(window.innerWidth)
    || Number(document.documentElement?.clientWidth)
    || Infinity;
  const screenWidth = Number(window.screen?.width) || viewportWidth;
  const shortWidth = Math.min(viewportWidth, screenWidth);

  const touchCapable = (Number(navigator.maxTouchPoints) || 0) > 0;
  const coarsePointer = mediaMatches('(pointer: coarse)');
  const noHover = mediaMatches('(hover: none)');

  // This deliberately targets touch-oriented phone/tablet layouts only. A
  // narrow desktop window keeps the original animated UI because its input
  // characteristics are not mobile-class.
  return shortWidth <= 1024 && (touchCapable || coarsePointer || noHover);
}

function applyStaticBackground(container, reason = 'mobile-safe') {
  if (!(container instanceof HTMLElement)) return;
  container.classList.add('liquid-chrome-static');
  container.classList.remove('liquid-chrome-loading');
  container.dataset.liquidChromeMode = 'static';
  container.dataset.liquidChromeReason = reason;
  // Inline color prevents a white flash if the additive Phase 3 stylesheet is
  // still loading; phase3-fixes.css supplies the final static gradient.
  container.style.backgroundColor = '#0e1016';
}

function clearStaticBackground(container) {
  if (!(container instanceof HTMLElement)) return;
  container.classList.remove('liquid-chrome-static');
  container.dataset.liquidChromeMode = 'animated';
  delete container.dataset.liquidChromeReason;
  container.style.backgroundColor = '';
}

function loadOglModule() {
  if (!oglModulePromise) {
    oglModulePromise = import('https://cdn.jsdelivr.net/npm/ogl@1.0.11/+esm');
  }
  return oglModulePromise;
}

function updateMotionToggle() {
  if (!(motionToggle instanceof HTMLButtonElement)) return;
  motionToggle.setAttribute('aria-pressed', globalUserPaused ? 'true' : 'false');
  motionToggle.textContent = globalUserPaused ? 'Resume background motion' : 'Pause background motion';
}

function setGlobalUserPaused(paused) {
  globalUserPaused = Boolean(paused);
  mountedControllers.forEach((controller) => controller.setUserPaused(globalUserPaused));
  updateMotionToggle();
}

function ensureBackgroundMotionToggle() {
  if (document.querySelector('.background-motion-toggle')) return;
  if (!document.querySelector('.liquid-chrome-bg canvas')) return;

  const reducedMotion = mediaMatches('(prefers-reduced-motion: reduce)');
  if (reducedMotion) return;

  motionToggle = document.createElement('button');
  motionToggle.type = 'button';
  motionToggle.className = 'background-motion-toggle';
  motionToggle.setAttribute('aria-label', 'Pause or resume decorative background motion');
  motionToggle.addEventListener('click', () => setGlobalUserPaused(!globalUserPaused));
  document.body.appendChild(motionToggle);
  updateMotionToggle();
}

function mountAnimatedLiquidChrome(container, options, ogl) {
  const {
    baseColor = [0.1, 0.1, 0.1],
    speed = 0.2,
    amplitude = 0.3,
    frequencyX = 3,
    frequencyY = 3,
    interactive = true,
  } = options;

  const { Renderer, Program, Mesh, Triangle } = ogl;
  const renderer = new Renderer({ antialias: true });
  const gl = renderer.gl;

  if (!gl || gl.isContextLost?.()) {
    throw new Error('WebGL context is unavailable.');
  }

  gl.clearColor(1, 1, 1, 1);
  gl.canvas.style.display = 'block';
  gl.canvas.style.width = '100%';
  gl.canvas.style.height = '100%';

  const geometry = new Triangle(gl);
  const program = new Program(gl, {
    vertex: vertexShader,
    fragment: fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uResolution: {
        value: new Float32Array([
          gl.canvas.width,
          gl.canvas.height,
          gl.canvas.width / Math.max(gl.canvas.height, 1)
        ])
      },
      uBaseColor: { value: new Float32Array(baseColor) },
      uAmplitude: { value: amplitude },
      uFrequencyX: { value: frequencyX },
      uFrequencyY: { value: frequencyY },
      uMouse: { value: new Float32Array([0, 0]) }
    }
  });
  const mesh = new Mesh(gl, { geometry, program });

  let destroyed = false;
  let resizeObserver = null;
  let animationId = null;
  let userPaused = globalUserPaused;
  let lastFrameTime = performance.now();

  function resize() {
    if (destroyed) return;
    const w = Math.max(1, Math.floor(container.clientWidth || container.offsetWidth || 1));
    const h = Math.max(1, Math.floor(container.clientHeight || container.offsetHeight || 1));
    renderer.setSize(w, h);
    const resolution = program.uniforms.uResolution.value;
    resolution[0] = gl.canvas.width;
    resolution[1] = gl.canvas.height;
    resolution[2] = gl.canvas.width / Math.max(gl.canvas.height, 1);
  }

  function handleMouseMove(event) {
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const mouse = program.uniforms.uMouse.value;
    mouse[0] = (event.clientX - rect.left) / rect.width;
    mouse[1] = 1 - ((event.clientY - rect.top) / rect.height);
  }

  function handleTouchMove(event) {
    const touch = event.touches?.[0];
    if (!touch) return;
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const mouse = program.uniforms.uMouse.value;
    mouse[0] = (touch.clientX - rect.left) / rect.width;
    mouse[1] = 1 - ((touch.clientY - rect.top) / rect.height);
  }

  const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;

  function canAnimate() {
    return !destroyed && shouldAnimateLiquidChrome({
      documentHidden: document.hidden,
      reducedMotion: Boolean(reducedMotionQuery?.matches),
      userPaused
    });
  }

  function renderFrame(time) {
    if (destroyed || gl.isContextLost?.()) return;
    const safeTime = Number.isFinite(time) ? time : lastFrameTime;
    lastFrameTime = safeTime;
    program.uniforms.uTime.value = safeTime * 0.001 * speed;
    renderer.render({ scene: mesh });
  }

  function stopAnimation() {
    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }

  function scheduleAnimation() {
    if (!canAnimate() || animationId !== null) return;
    animationId = requestAnimationFrame(update);
  }

  function update(time) {
    animationId = null;
    if (!canAnimate()) return;
    try {
      renderFrame(time);
      scheduleAnimation();
    } catch (error) {
      console.warn('[Dagoldol] LiquidChrome render stopped; using static background.', error);
      stopAnimation();
      applyStaticBackground(container, 'render-failed');
      if (gl.canvas.parentElement === container) gl.canvas.remove();
    }
  }

  function syncAnimationState({ renderStaticFrame = false } = {}) {
    if (destroyed) return;
    if (canAnimate()) {
      scheduleAnimation();
      return;
    }
    stopAnimation();
    if (renderStaticFrame && !document.hidden && !gl.isContextLost?.()) {
      try {
        renderFrame(lastFrameTime);
      } catch (_) {
        applyStaticBackground(container, 'static-render-failed');
      }
    }
  }

  function handleVisibilityChange() {
    syncAnimationState({ renderStaticFrame: false });
  }

  function handleReducedMotionChange() {
    syncAnimationState({ renderStaticFrame: true });
    if (reducedMotionQuery?.matches && motionToggle instanceof HTMLElement) {
      motionToggle.remove();
      motionToggle = null;
    } else {
      ensureBackgroundMotionToggle();
    }
  }

  function handleContextLost(event) {
    event.preventDefault();
    stopAnimation();
    applyStaticBackground(container, 'context-lost');
  }

  const controller = {
    setUserPaused(paused) {
      userPaused = Boolean(paused);
      syncAnimationState({ renderStaticFrame: true });
    }
  };

  mountedControllers.add(controller);
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  reducedMotionQuery?.addEventListener?.('change', handleReducedMotionChange);
  gl.canvas.addEventListener('webglcontextlost', handleContextLost, false);

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
  }

  if (interactive) {
    container.addEventListener('mousemove', handleMouseMove, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
  }

  clearStaticBackground(container);
  container.classList.remove('liquid-chrome-loading');
  container.appendChild(gl.canvas);
  resize();
  renderFrame(lastFrameTime);
  syncAnimationState();
  ensureBackgroundMotionToggle();

  return function destroyAnimatedLiquidChrome() {
    if (destroyed) return;
    destroyed = true;
    mountedControllers.delete(controller);
    stopAnimation();
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    reducedMotionQuery?.removeEventListener?.('change', handleReducedMotionChange);
    gl.canvas.removeEventListener('webglcontextlost', handleContextLost, false);
    resizeObserver?.disconnect();

    if (interactive) {
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('touchmove', handleTouchMove);
    }

    if (gl.canvas.parentElement === container) gl.canvas.remove();
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch (_) {
      // Context may already be unavailable. Cleanup is best-effort here.
    }
  };
}

/**
 * Mounts LiquidChrome inside `container` on capable pointer devices.
 * Phone/tablet-class touch devices receive a static background instead.
 * The function always returns a synchronous destroy() callback.
 */
export function createLiquidChrome(container, options = {}) {
  if (!(container instanceof HTMLElement)) return () => {};

  let destroyed = false;
  let destroyAnimated = null;

  if (shouldUseStaticBackground()) {
    applyStaticBackground(container, 'mobile-safe');
    return () => {
      destroyed = true;
      container.classList.remove('liquid-chrome-loading');
    };
  }

  container.classList.add('liquid-chrome-loading');

  loadOglModule()
    .then((ogl) => {
      if (destroyed) return;
      try {
        destroyAnimated = mountAnimatedLiquidChrome(container, options, ogl);
      } catch (error) {
        console.warn('[Dagoldol] LiquidChrome could not start; using static background.', error);
        applyStaticBackground(container, 'init-failed');
      }
    })
    .catch((error) => {
      if (destroyed) return;
      console.warn('[Dagoldol] LiquidChrome module could not load; using static background.', error);
      applyStaticBackground(container, 'module-load-failed');
    });

  return function destroy() {
    if (destroyed) return;
    destroyed = true;
    destroyAnimated?.();
    container.classList.remove('liquid-chrome-loading');
  };
}

function autoInit() {
  document.querySelectorAll('.liquid-chrome-bg').forEach((element) => {
    if (!(element instanceof HTMLElement) || element.dataset.liquidChromeMounted) return;
    element.dataset.liquidChromeMounted = 'true';

    const options = {};
    if (element.dataset.speed) options.speed = Number.parseFloat(element.dataset.speed);
    if (element.dataset.amplitude) options.amplitude = Number.parseFloat(element.dataset.amplitude);
    if (element.dataset.frequencyX) options.frequencyX = Number.parseFloat(element.dataset.frequencyX);
    if (element.dataset.frequencyY) options.frequencyY = Number.parseFloat(element.dataset.frequencyY);
    if (element.dataset.interactive === 'false') options.interactive = false;
    if (element.dataset.baseColor) {
      options.baseColor = element.dataset.baseColor
        .split(',')
        .map((value) => Number.parseFloat(value))
        .filter(Number.isFinite);
    }

    createLiquidChrome(element, options);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoInit, { once: true });
} else {
  autoInit();
}
