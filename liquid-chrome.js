// liquid-chrome.js
// Vanilla JS port of the LiquidChrome effect (no React, no build step required).
// Loads OGL straight from a CDN as an ES module.
// Phase 2 adds visibility/reduced-motion/user-pause lifecycle control while
// preserving createLiquidChrome(container, options) and the existing data-* API.
import { Renderer, Program, Mesh, Triangle } from 'https://cdn.jsdelivr.net/npm/ogl@1.0.11/+esm';
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
  if (!document.querySelector('.liquid-chrome-bg')) return;

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (reducedMotion) return;

  motionToggle = document.createElement('button');
  motionToggle.type = 'button';
  motionToggle.className = 'background-motion-toggle';
  motionToggle.setAttribute('aria-label', 'Pause or resume decorative background motion');
  motionToggle.addEventListener('click', () => setGlobalUserPaused(!globalUserPaused));
  document.body.appendChild(motionToggle);
  updateMotionToggle();
}

/**
 * Mounts the LiquidChrome effect inside `container`.
 * Returns a destroy() function to tear it down.
 */
export function createLiquidChrome(container, options = {}) {
  const {
    baseColor = [0.1, 0.1, 0.1],
    speed = 0.2,
    amplitude = 0.3,
    frequencyX = 3,
    frequencyY = 3,
    interactive = true,
  } = options;

  const renderer = new Renderer({ antialias: true });
  const gl = renderer.gl;
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
        value: new Float32Array([gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height])
      },
      uBaseColor: { value: new Float32Array(baseColor) },
      uAmplitude: { value: amplitude },
      uFrequencyX: { value: frequencyX },
      uFrequencyY: { value: frequencyY },
      uMouse: { value: new Float32Array([0, 0]) }
    }
  });
  const mesh = new Mesh(gl, { geometry, program });

  function resize() {
    const w = container.offsetWidth;
    const h = container.offsetHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    const resUniform = program.uniforms.uResolution.value;
    resUniform[0] = gl.canvas.width;
    resUniform[1] = gl.canvas.height;
    resUniform[2] = gl.canvas.width / gl.canvas.height;
  }
  window.addEventListener('resize', resize);

  let resizeObserver;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(container);
  }
  resize();

  function handleMouseMove(event) {
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = 1 - (event.clientY - rect.top) / rect.height;
    const mouseUniform = program.uniforms.uMouse.value;
    mouseUniform[0] = x;
    mouseUniform[1] = y;
  }

  function handleTouchMove(event) {
    if (event.touches.length > 0) {
      const touch = event.touches[0];
      const rect = container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (touch.clientX - rect.left) / rect.width;
      const y = 1 - (touch.clientY - rect.top) / rect.height;
      const mouseUniform = program.uniforms.uMouse.value;
      mouseUniform[0] = x;
      mouseUniform[1] = y;
    }
  }

  if (interactive) {
    container.addEventListener('mousemove', handleMouseMove, { passive:true });
    container.addEventListener('touchmove', handleTouchMove, { passive:true });
  }

  const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  let userPaused = globalUserPaused;
  let animationId = null;
  let destroyed = false;
  let lastFrameTime = performance.now();

  function canAnimate() {
    return shouldAnimateLiquidChrome({
      documentHidden: document.hidden,
      reducedMotion: Boolean(reducedMotionQuery?.matches),
      userPaused
    });
  }

  function renderFrame(time) {
    const safeTime = Number.isFinite(time) ? time : lastFrameTime;
    lastFrameTime = safeTime;
    program.uniforms.uTime.value = safeTime * 0.001 * speed;
    renderer.render({ scene: mesh });
  }

  function update(time) {
    animationId = null;
    if (destroyed || !canAnimate()) return;
    renderFrame(time);
    scheduleAnimation();
  }

  function scheduleAnimation() {
    if (destroyed || animationId !== null || !canAnimate()) return;
    animationId = requestAnimationFrame(update);
  }

  function stopAnimation() {
    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }

  function syncAnimationState({ renderStaticFrame = false } = {}) {
    if (destroyed) return;
    if (canAnimate()) {
      scheduleAnimation();
      return;
    }

    stopAnimation();
    if (renderStaticFrame && !document.hidden) renderFrame(lastFrameTime);
  }

  function handleVisibilityChange() {
    syncAnimationState({ renderStaticFrame:false });
  }

  function handleReducedMotionChange() {
    syncAnimationState({ renderStaticFrame:true });
    if (reducedMotionQuery?.matches && motionToggle instanceof HTMLElement) {
      motionToggle.remove();
      motionToggle = null;
    } else {
      ensureBackgroundMotionToggle();
    }
  }

  const controller = {
    setUserPaused(paused) {
      userPaused = Boolean(paused);
      syncAnimationState({ renderStaticFrame:true });
    }
  };
  mountedControllers.add(controller);

  document.addEventListener('visibilitychange', handleVisibilityChange);
  reducedMotionQuery?.addEventListener?.('change', handleReducedMotionChange);

  container.appendChild(gl.canvas);
  renderFrame(lastFrameTime);
  syncAnimationState();

  return function destroy() {
    destroyed = true;
    mountedControllers.delete(controller);
    stopAnimation();
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    reducedMotionQuery?.removeEventListener?.('change', handleReducedMotionChange);
    if (resizeObserver) resizeObserver.disconnect();
    if (interactive) {
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('touchmove', handleTouchMove);
    }
    if (gl.canvas.parentElement) {
      gl.canvas.parentElement.removeChild(gl.canvas);
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
}

/**
 * Auto-mounts LiquidChrome into every element with class "liquid-chrome-bg".
 * Reads optional overrides from data-* attributes:
 *   data-speed, data-amplitude, data-frequency-x, data-frequency-y,
 *   data-interactive="false", data-base-color="0.1,0.1,0.1"
 */
function autoInit() {
  document.querySelectorAll('.liquid-chrome-bg').forEach((el) => {
    if (el.dataset.liquidChromeMounted) return;
    el.dataset.liquidChromeMounted = 'true';

    const opts = {};
    if (el.dataset.speed) opts.speed = parseFloat(el.dataset.speed);
    if (el.dataset.amplitude) opts.amplitude = parseFloat(el.dataset.amplitude);
    if (el.dataset.frequencyX) opts.frequencyX = parseFloat(el.dataset.frequencyX);
    if (el.dataset.frequencyY) opts.frequencyY = parseFloat(el.dataset.frequencyY);
    if (el.dataset.interactive === 'false') opts.interactive = false;
    if (el.dataset.baseColor) {
      opts.baseColor = el.dataset.baseColor.split(',').map((n) => parseFloat(n));
    }

    createLiquidChrome(el, opts);
  });

  ensureBackgroundMotionToggle();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoInit, { once:true });
} else {
  autoInit();
}