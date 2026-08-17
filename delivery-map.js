/**
 * Dagoldol delivery map picker.
 *
 * The module is intentionally lazy: importing it does not load MapLibre or
 * create a WebGL context. MapLibre is fetched only when openDeliveryMap() is
 * called from an explicit user action.
 */

const MAPLIBRE_VERSION = "5.12.0";
const MAPLIBRE_JS_URL = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`;
const MAPLIBRE_CSS_URL = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const NOMINATIM_EMAIL_IDENTIFIER = "dagoldol-trading-co-shop";
const REVERSE_CACHE_KEY = "dagoldol_reverse_geocode_cache_v1";
const REVERSE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const MAP_LIBRARY_LOAD_TIMEOUT_MS = 10000;
const MAP_RENDER_LOAD_TIMEOUT_MS = 14000;

// Broad Philippine geographic envelope. It intentionally includes outlying
// islands while excluding clearly accidental pins in other countries.
const PH_BOUNDS = Object.freeze({
  minLat: 4.0,
  maxLat: 21.5,
  minLon: 116.0,
  maxLon: 127.5
});
const PH_MAP_BOUNDS = Object.freeze([
  [PH_BOUNDS.minLon, PH_BOUNDS.minLat],
  [PH_BOUNDS.maxLon, PH_BOUNDS.maxLat]
]);
const PH_DEFAULT_CENTER = Object.freeze([121.7740, 12.8797]);

let mapLibreLoadPromise = null;
let nominatimQueue = Promise.resolve();
let lastNominatimRequestAt = 0;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeComparable(value) {
  return cleanText(value).toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ");
}

function uniqueParts(parts) {
  const seen = new Set();
  const output = [];
  for (const raw of parts) {
    const value = cleanText(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function isPhilippinesCoordinate(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return latitude >= PH_BOUNDS.minLat && latitude <= PH_BOUNDS.maxLat &&
    longitude >= PH_BOUNDS.minLon && longitude <= PH_BOUNDS.maxLon;
}

export function normalizeSavedLocation(value) {
  if (!value || typeof value !== "object") return null;

  const latitude = Number(value.latitude ?? value.lat);
  const longitude = Number(value.longitude ?? value.lon ?? value.lng);
  if (!isPhilippinesCoordinate(latitude, longitude)) return null;

  const rawSnapshot = value.addressSnapshot || value.address_snapshot;
  let addressSnapshot = null;
  if (rawSnapshot && typeof rawSnapshot === "object") {
    addressSnapshot = {
      address: cleanText(rawSnapshot.address ?? rawSnapshot.street),
      city: cleanText(rawSnapshot.city),
      postal: cleanText(rawSnapshot.postal ?? rawSnapshot.postcode)
    };
  }

  return {
    latitude,
    longitude,
    source: cleanText(value.source) || "pin",
    pinnedAt: cleanText(value.pinnedAt ?? value.pinned_at) || null,
    addressSnapshot
  };
}

export function buildAddressFromNominatim(payload) {
  const address = payload && typeof payload.address === "object" ? payload.address : {};
  const countryCode = cleanText(address.country_code).toLowerCase();
  if (countryCode && countryCode !== "ph") return null;

  const roadLine = cleanText([
    cleanText(address.house_number),
    cleanText(address.road || address.pedestrian || address.residential || address.footway)
  ].filter(Boolean).join(" "));

  const neighbourhood = cleanText(
    address.neighbourhood ||
    address.suburb ||
    address.quarter ||
    address.hamlet ||
    address.village ||
    address.barangay
  );

  const streetAddress = uniqueParts([roadLine, neighbourhood]).join(", ") ||
    cleanText(payload?.name) ||
    cleanText(payload?.display_name).split(",")[0] ||
    "Pinned location";

  const city = cleanText(
    address.city ||
    address.town ||
    address.municipality ||
    address.city_district ||
    address.county ||
    address.state_district ||
    address.state
  );

  return {
    address: streetAddress,
    city,
    postal: cleanText(address.postcode),
    displayName: cleanText(payload?.display_name) || uniqueParts([streetAddress, city, address.postcode, "Philippines"]).join(", ")
  };
}

export function locationMatchesAddress(location, addressFields) {
  const normalized = normalizeSavedLocation(location);
  if (!normalized || !normalized.addressSnapshot) return false;

  const current = {
    address: normalizeComparable(addressFields?.address ?? addressFields?.street),
    city: normalizeComparable(addressFields?.city),
    postal: normalizeComparable(addressFields?.postal ?? addressFields?.postcode)
  };
  const snapshot = {
    address: normalizeComparable(normalized.addressSnapshot.address),
    city: normalizeComparable(normalized.addressSnapshot.city),
    postal: normalizeComparable(normalized.addressSnapshot.postal)
  };

  return current.address === snapshot.address &&
    current.city === snapshot.city &&
    current.postal === snapshot.postal;
}

/**
 * Capability probe used before MapLibre creates a WebGL context. This keeps a
 * device that cannot create a usable context from getting stuck on "Loading".
 */
export function isWebGLSupported(canvasFactory = null) {
  const makeCanvas = canvasFactory || (() => {
    if (typeof document === "undefined") return null;
    return document.createElement("canvas");
  });

  try {
    const canvas = makeCanvas();
    if (!canvas || typeof canvas.getContext !== "function") return false;
    const context = canvas.getContext("webgl2", {
      antialias: false,
      failIfMajorPerformanceCaveat: false,
      powerPreference: "low-power"
    }) || canvas.getContext("webgl", {
      antialias: false,
      failIfMajorPerformanceCaveat: false,
      powerPreference: "low-power"
    });
    return Boolean(context && typeof context.getParameter === "function");
  } catch {
    return false;
  }
}

/**
 * Pure device policy so mobile rendering budgets can be regression-tested.
 */
export function getMapRuntimeProfile({
  viewportWidth = 1024,
  devicePixelRatio = 1,
  touchCapable = false,
  coarsePointer = false,
  reducedMotion = false
} = {}) {
  const width = Number.isFinite(Number(viewportWidth)) ? Math.max(0, Number(viewportWidth)) : 1024;
  const dpr = Number.isFinite(Number(devicePixelRatio)) ? Math.max(1, Number(devicePixelRatio)) : 1;
  const constrained = width <= 720 && (Boolean(touchCapable) || Boolean(coarsePointer));

  return Object.freeze({
    constrained,
    pixelRatio: Math.min(dpr, constrained ? 1.5 : 2),
    maxTileCacheSize: constrained ? 24 : 64,
    maxTileCacheZoomLevels: constrained ? 2 : 4,
    fadeDuration: constrained || reducedMotion ? 0 : 200,
    dragRotate: false,
    touchPitch: false,
    reducedMotion: Boolean(reducedMotion),
    powerPreference: constrained ? "low-power" : "high-performance"
  });
}

function readRuntimeProfile() {
  if (typeof window === "undefined") return getMapRuntimeProfile();
  return getMapRuntimeProfile({
    viewportWidth: Number(window.innerWidth) || Number(document.documentElement?.clientWidth) || 1024,
    devicePixelRatio: Number(window.devicePixelRatio) || 1,
    touchCapable: (Number(navigator.maxTouchPoints) || 0) > 0,
    coarsePointer: window.matchMedia?.("(pointer: coarse)")?.matches === true,
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true
  });
}

function loadReverseCache() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return {};
    const raw = storage.getItem(REVERSE_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveReverseCache(cache) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    storage.setItem(REVERSE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage can be unavailable in private/opaque contexts. Never block checkout.
  }
}

function reverseCacheKey(lat, lon) {
  return `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
}

function scheduleNominatimRequest(requestFn) {
  const task = nominatimQueue.then(async () => {
    const waitMs = Math.max(0, NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimRequestAt));
    if (waitMs) await wait(waitMs);
    lastNominatimRequestAt = Date.now();
    return requestFn();
  });
  nominatimQueue = task.catch(() => undefined);
  return task;
}

export async function reverseGeocodePin(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!isPhilippinesCoordinate(latitude, longitude)) {
    throw new Error("Please choose a location within the Philippines.");
  }

  const key = reverseCacheKey(latitude, longitude);
  const cache = loadReverseCache();
  const cached = cache[key];
  if (cached && Date.now() - Number(cached.at || 0) < REVERSE_CACHE_MAX_AGE_MS) {
    return cached.result || null;
  }

  return scheduleNominatimRequest(async () => {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "en");
    url.searchParams.set("email", NOMINATIM_EMAIL_IDENTIFIER);

    const response = await fetch(url.toString(), {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Address lookup failed (${response.status}).`);
    }

    const payload = await response.json();
    const parsed = buildAddressFromNominatim(payload);
    if (!parsed) {
      throw new Error("That pin could not be resolved to a Philippine address.");
    }

    const result = {
      ...parsed,
      latitude,
      longitude
    };
    cache[key] = { result, at: Date.now() };
    saveReverseCache(cache);
    return result;
  });
}

function ensureMapLibreCss() {
  if (typeof document === "undefined") return;
  if (document.querySelector('link[data-dagoldol-maplibre="true"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = MAPLIBRE_CSS_URL;
  link.dataset.dagoldolMaplibre = "true";
  document.head.appendChild(link);
}

function cleanupFailedMapLibreScript(script) {
  if (!script || window.maplibregl) return;
  try { script.remove(); } catch { /* noop */ }
}

async function waitForMapLibreScript(script) {
  if (window.maplibregl) return window.maplibregl;

  const promise = new Promise((resolve, reject) => {
    const onLoad = () => {
      script.dataset.loadState = "loaded";
      if (window.maplibregl) resolve(window.maplibregl);
      else reject(new Error("The map library loaded without initializing."));
    };
    const onError = () => {
      script.dataset.loadState = "error";
      reject(new Error("Could not load the map library."));
    };
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
  });

  try {
    return await withTimeout(promise, MAP_LIBRARY_LOAD_TIMEOUT_MS, "The map library took too long to load. Check your connection and try again.");
  } catch (error) {
    cleanupFailedMapLibreScript(script);
    throw error;
  }
}

async function loadMapLibre() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("The interactive map is only available in a browser.");
  }
  if (window.maplibregl) return window.maplibregl;
  if (mapLibreLoadPromise) return mapLibreLoadPromise;

  if (!isWebGLSupported()) {
    throw new Error("This device cannot start the interactive map. You can still enter the address manually or try another browser.");
  }

  ensureMapLibreCss();
  mapLibreLoadPromise = (async () => {
    let existing = document.querySelector('script[data-dagoldol-maplibre="true"]');
    if (existing && existing.dataset.loadState === "error") {
      cleanupFailedMapLibreScript(existing);
      existing = null;
    }
    if (existing && existing.dataset.loadState === "loaded" && !window.maplibregl) {
      cleanupFailedMapLibreScript(existing);
      existing = null;
    }

    if (!existing) {
      existing = document.createElement("script");
      existing.src = MAPLIBRE_JS_URL;
      existing.async = true;
      existing.dataset.dagoldolMaplibre = "true";
      existing.dataset.loadState = "loading";
      const loadPromise = waitForMapLibreScript(existing);
      document.head.appendChild(existing);
      return loadPromise;
    }

    return waitForMapLibreScript(existing);
  })().catch(error => {
    mapLibreLoadPromise = null;
    throw error;
  });

  return mapLibreLoadPromise;
}

function createSnapshot(address) {
  return {
    address: cleanText(address?.address ?? address?.street),
    city: cleanText(address?.city),
    postal: cleanText(address?.postal ?? address?.postcode)
  };
}

function toSelection(location, address, source) {
  const normalized = normalizeSavedLocation(location);
  if (!normalized) return null;
  return {
    latitude: normalized.latitude,
    longitude: normalized.longitude,
    source: cleanText(source || normalized.source) || "pin",
    pinnedAt: new Date().toISOString(),
    addressSnapshot: createSnapshot(address),
    address: createSnapshot(address),
    displayName: cleanText(address?.displayName)
  };
}

function scheduleResizePasses(map, container) {
  const timers = [];
  let raf1 = null;
  let raf2 = null;
  let destroyed = false;

  const resize = () => {
    if (destroyed) return;
    if (!container?.isConnected || container.clientWidth <= 0 || container.clientHeight <= 0) return;
    try { map.resize(); } catch { /* noop */ }
  };

  if (typeof requestAnimationFrame === "function") {
    raf1 = requestAnimationFrame(() => {
      resize();
      raf2 = requestAnimationFrame(resize);
    });
  }
  timers.push(setTimeout(resize, 120));
  timers.push(setTimeout(resize, 360));
  timers.push(setTimeout(resize, 900));

  const visualViewport = typeof window !== "undefined" ? window.visualViewport : null;
  visualViewport?.addEventListener("resize", resize, { passive: true });
  window.addEventListener("orientationchange", resize, { passive: true });
  window.addEventListener("resize", resize, { passive: true });

  return () => {
    destroyed = true;
    if (raf1 != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf1);
    if (raf2 != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf2);
    timers.forEach(timer => clearTimeout(timer));
    visualViewport?.removeEventListener("resize", resize);
    window.removeEventListener("orientationchange", resize);
    window.removeEventListener("resize", resize);
  };
}

function getCurrentPositionFrom(geolocation, options) {
  return new Promise((resolve, reject) => {
    if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
      reject(createLocationError("unsupported", 2, "Geolocation is unavailable."));
      return;
    }
    geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function createLocationError(reason, code, message, cause = null) {
  const error = new Error(message || "Location is unavailable.");
  error.name = "DagoldolLocationError";
  error.reason = reason;
  error.code = Number(code) || 0;
  if (cause) error.cause = cause;
  return error;
}

function isUsablePosition(position) {
  return Number.isFinite(Number(position?.coords?.latitude)) &&
    Number.isFinite(Number(position?.coords?.longitude));
}

function readAccuracy(position) {
  const accuracy = Number(position?.coords?.accuracy);
  return Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : Number.POSITIVE_INFINITY;
}

function pickBetterPosition(current, candidate) {
  if (!isUsablePosition(candidate)) return current || null;
  if (!isUsablePosition(current)) return candidate;
  return readAccuracy(candidate) < readAccuracy(current) ? candidate : current;
}

export async function getGeolocationPermissionState(permissions = (typeof navigator !== "undefined" ? navigator.permissions : null)) {
  if (!permissions || typeof permissions.query !== "function") return "unknown";
  try {
    const result = await permissions.query({ name: "geolocation" });
    const state = cleanText(result?.state).toLowerCase();
    return ["granted", "prompt", "denied"].includes(state) ? state : "unknown";
  } catch {
    return "unknown";
  }
}

function watchForBestPosition(geolocation, {
  seedPosition = null,
  targetAccuracyMeters = 100,
  acceptableAccuracyMeters = 1500,
  settleMs = 4000,
  watchTimeoutMs = 35000
} = {}) {
  return new Promise((resolve, reject) => {
    if (!geolocation || typeof geolocation.watchPosition !== "function") {
      if (seedPosition) resolve(seedPosition);
      else reject(createLocationError("unsupported", 2, "Continuous geolocation is unavailable."));
      return;
    }

    let bestPosition = isUsablePosition(seedPosition) ? seedPosition : null;
    let lastError = null;
    let watchId = null;
    let finished = false;
    let needsClearAfterRegistration = false;
    let settleTimer = null;

    const clearWatch = () => {
      if (watchId != null && typeof geolocation.clearWatch === "function") {
        try { geolocation.clearWatch(watchId); } catch { /* noop */ }
      } else if (watchId == null) {
        needsClearAfterRegistration = true;
      }
    };

    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      if (settleTimer) clearTimeout(settleTimer);
      clearWatch();
      if (bestPosition) {
        resolve(bestPosition);
        return;
      }
      reject(error || lastError || createLocationError("timeout", 3, "Location request timed out."));
    };

    const deadlineTimer = setTimeout(() => finish(lastError), Math.max(1, Number(watchTimeoutMs) || 35000));

    try {
      watchId = geolocation.watchPosition(
        position => {
          if (finished) return;
          const previousAccuracy = readAccuracy(bestPosition);
          bestPosition = pickBetterPosition(bestPosition, position);
          const bestAccuracy = readAccuracy(bestPosition);
          if (bestAccuracy <= targetAccuracyMeters) {
            finish();
            return;
          }
          if (bestAccuracy <= acceptableAccuracyMeters && bestAccuracy <= previousAccuracy) {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => finish(), Math.max(1, Number(settleMs) || 4000));
          }
        },
        error => {
          if (finished) return;
          lastError = error;
          if (error?.code === 1) {
            finish(createLocationError("permission_denied", 1, "Location permission was denied.", error));
          }
          // POSITION_UNAVAILABLE and TIMEOUT can be transient while a device is
          // still acquiring Wi-Fi/cell/GPS data. Keep the watch alive until our
          // own bounded deadline and return the best fix received, if any.
        },
        {
          enableHighAccuracy: true,
          timeout: Math.min(Math.max(10000, Number(watchTimeoutMs) || 35000), 20000),
          maximumAge: 0
        }
      );
      if (needsClearAfterRegistration && watchId != null && typeof geolocation.clearWatch === "function") {
        try { geolocation.clearWatch(watchId); } catch { /* noop */ }
      }
    } catch (error) {
      lastError = error;
      finish(error);
    }
  });
}

export async function getReliableCurrentPosition({
  geolocation = (typeof navigator !== "undefined" ? navigator.geolocation : null),
  permissions = (typeof navigator !== "undefined" ? navigator.permissions : null),
  secureContext = (typeof window === "undefined" ? true : window.isSecureContext),
  targetAccuracyMeters = 100,
  acceptableFastAccuracyMeters = 1200,
  acceptableWatchAccuracyMeters = 1500,
  watchSettleMs = 4000,
  fastTimeoutMs = 12000,
  watchTimeoutMs = 35000,
  fastMaximumAgeMs = 5 * 60 * 1000
} = {}) {
  if (!secureContext) {
    throw createLocationError("insecure_context", 1, "Location requires a secure HTTPS page.");
  }
  if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
    throw createLocationError("unsupported", 2, "This browser does not provide location access.");
  }

  const permissionState = await getGeolocationPermissionState(permissions);
  if (permissionState === "denied") {
    const denied = createLocationError("permission_denied", 1, "Location permission is blocked.");
    denied.permissionState = permissionState;
    throw denied;
  }

  let bestPosition = null;
  let fastError = null;
  try {
    const fastPosition = await getCurrentPositionFrom(geolocation, {
      enableHighAccuracy: false,
      timeout: Math.max(1, Number(fastTimeoutMs) || 12000),
      maximumAge: Math.max(0, Number(fastMaximumAgeMs) || 0)
    });
    bestPosition = pickBetterPosition(bestPosition, fastPosition);
    if (bestPosition && readAccuracy(bestPosition) <= acceptableFastAccuracyMeters) return bestPosition;
  } catch (error) {
    fastError = error;
    if (error?.code === 1) {
      const denied = createLocationError("permission_denied", 1, "Location permission was denied.", error);
      denied.permissionState = permissionState;
      throw denied;
    }
  }

  try {
    return await watchForBestPosition(geolocation, {
      seedPosition: bestPosition,
      targetAccuracyMeters,
      acceptableAccuracyMeters: acceptableWatchAccuracyMeters,
      settleMs: watchSettleMs,
      watchTimeoutMs
    });
  } catch (error) {
    if (bestPosition) return bestPosition;
    const code = Number(error?.code || fastError?.code || 0);
    const reason = code === 1 ? "permission_denied" : code === 3 ? "timeout" : "unavailable";
    const normalized = createLocationError(reason, code, error?.message || fastError?.message || "Current location is unavailable.", error || fastError);
    normalized.permissionState = permissionState;
    throw normalized;
  }
}

export function getLocationFailureMessage(error, {
  userAgent = (typeof navigator !== "undefined" ? navigator.userAgent : ""),
  permissionState = error?.permissionState || "unknown",
  secureContext = (typeof window === "undefined" ? true : window.isSecureContext)
} = {}) {
  const ua = String(userAgent || "");
  const isWindows = /Windows/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const reason = cleanText(error?.reason).toLowerCase();
  const code = Number(error?.code || 0);

  if (!secureContext || reason === "insecure_context") {
    return "Current location requires HTTPS. Open the deployed Dagoldol site over https:// and try again.";
  }

  if (reason === "permission_denied" || permissionState === "denied" || code === 1) {
    if (isWindows) {
      return "Location access is blocked. In Windows open Settings → Privacy & security → Location, turn on Location services and allow desktop apps/browser access, then allow location for this Dagoldol site and try again.";
    }
    if (isIOS) {
      return "Location access is blocked. On iPhone/iPad open Settings → Privacy & Security → Location Services, turn it on, allow Safari/Chrome to use location, then allow this website and try again.";
    }
    return "Location permission is blocked. Enable Location Services for your browser and allow this Dagoldol site to use your location, then try again.";
  }

  if (reason === "timeout" || code === 3) {
    return "Your device is taking longer to get a location fix. Keep Wi-Fi/GPS and Location Services on, leave this map open, then press Use my current location again. You can still tap the map manually.";
  }

  if (reason === "unsupported") {
    return "This browser cannot provide device location. Use a current Chrome, Edge, or Safari browser, or tap the map manually.";
  }

  if (isWindows) {
    return "Windows could not determine your location. Check Settings → Privacy & security → Location, keep Wi-Fi on, allow your browser to use location, then try again.";
  }
  if (isIOS) {
    return "Your iPhone/iPad could not determine the location yet. Check Location Services and this website's location permission, keep Wi-Fi or mobile data on, then try again.";
  }
  return "Current location is unavailable right now. Check Location Services and browser permission, then try again or tap the map manually.";
}

/**
 * Initialize the reusable delivery map in an already-visible modal.
 * Returns a controller. Call destroy() when the modal closes to release the
 * WebGL context and keep mobile memory use bounded.
 */
export async function openDeliveryMap({
  container,
  statusElement,
  summaryElement,
  initialLocation,
  initialAddress,
  onSelectionChange
} = {}) {
  if (!container) throw new Error("Map container is missing.");
  if (!isWebGLSupported()) {
    throw new Error("The interactive map cannot start on this device. You can still type the address manually.");
  }

  const maplibregl = await loadMapLibre();
  const runtimeProfile = readRuntimeProfile();
  const normalizedInitial = normalizeSavedLocation(initialLocation);
  const startLngLat = normalizedInitial
    ? [normalizedInitial.longitude, normalizedInitial.latitude]
    : PH_DEFAULT_CENTER;

  let selected = normalizedInitial
    ? toSelection(normalizedInitial, initialAddress || normalizedInitial.addressSnapshot || {}, normalizedInitial.source)
    : null;
  let reverseLookupToken = 0;
  let destroyed = false;
  let mapReady = false;
  let cleanupResize = () => {};

  const setStatus = (message, isError = false) => {
    if (!statusElement) return;
    statusElement.textContent = message || "";
    statusElement.classList.toggle("delivery-map-status-error", Boolean(isError));
  };

  const setSummary = (selection) => {
    if (!summaryElement) return;
    if (!selection) {
      summaryElement.textContent = "Tap the map, drag the pin, or use your current location.";
      return;
    }
    const addr = selection.address || {};
    const readable = uniqueParts([addr.address, addr.city, addr.postal]).join(", ");
    summaryElement.textContent = readable || `${selection.latitude.toFixed(5)}, ${selection.longitude.toFixed(5)}`;
  };

  const map = new maplibregl.Map({
    container,
    style: MAP_STYLE_URL,
    center: startLngLat,
    zoom: normalizedInitial ? 16 : 5.4,
    maxBounds: PH_MAP_BOUNDS,
    attributionControl: true,
    cooperativeGestures: false,
    renderWorldCopies: false,
    dragRotate: runtimeProfile.dragRotate,
    pitchWithRotate: false,
    touchPitch: runtimeProfile.touchPitch,
    pixelRatio: runtimeProfile.pixelRatio,
    maxTileCacheSize: runtimeProfile.maxTileCacheSize,
    maxTileCacheZoomLevels: runtimeProfile.maxTileCacheZoomLevels,
    fadeDuration: runtimeProfile.fadeDuration,
    reduceMotion: runtimeProfile.reducedMotion,
    cancelPendingTileRequestsWhileZooming: true,
    canvasContextAttributes: {
      antialias: false,
      powerPreference: runtimeProfile.powerPreference,
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
      desynchronized: runtimeProfile.constrained
    }
  });

  cleanupResize = scheduleResizePasses(map, container);

  const mapLoadPromise = new Promise((resolve, reject) => {
    map.once("load", () => {
      mapReady = true;
      resolve(true);
    });
    map.on("error", event => {
      const message = cleanText(event?.error?.message || event?.message);
      console.warn("[Dagoldol] MapLibre map resource error:", event?.error || event);
      if (!mapReady && message) {
        setStatus("The map is still loading some data. If it does not appear, close it and try again.", true);
      }
    });
    map.on("webglcontextlost", () => {
      setStatus("The map graphics were interrupted by this device. Close the map and reopen it, or enter the address manually.", true);
    });
    map.on("webglcontextrestored", () => {
      setStatus("Map graphics restored. You can continue choosing the location.");
      try { map.resize(); } catch { /* noop */ }
    });
  });

  try {
    await withTimeout(
      mapLoadPromise,
      MAP_RENDER_LOAD_TIMEOUT_MS,
      "The map took too long to render on this device. Close it and try again, or enter the address manually."
    );
  } catch (error) {
    cleanupResize();
    try { map.remove(); } catch { /* noop */ }
    container.replaceChildren();
    throw error;
  }

  if (destroyed) {
    cleanupResize();
    try { map.remove(); } catch { /* noop */ }
    throw new Error("The map was closed before it finished loading.");
  }

  container.parentElement?.classList.add("is-ready");
  try { map.resize(); } catch { /* noop */ }
  setSummary(selected);
  setStatus(selected
    ? "Move the pin if needed, or confirm this delivery location."
    : "Tap the map, drag the pin, or use your current location.");

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  const marker = new maplibregl.Marker({
    draggable: true,
    color: "#4FE3C1"
  }).setLngLat(startLngLat);

  if (normalizedInitial) marker.addTo(map);

  async function selectAt(lng, lat, source = "pin") {
    if (destroyed) return null;
    if (!isPhilippinesCoordinate(lat, lng)) {
      setStatus("Please choose a location within the Philippines.", true);
      return null;
    }

    if (!marker.getElement().isConnected) marker.addTo(map);
    marker.setLngLat([lng, lat]);
    const token = ++reverseLookupToken;
    setStatus("Finding the address for this pin…");

    try {
      const address = await reverseGeocodePin(lat, lng);
      if (destroyed || token !== reverseLookupToken) return null;
      selected = toSelection({ latitude: lat, longitude: lng, source }, address, source);
      setSummary(selected);
      setStatus("Address found. Confirm the pin when it matches the delivery entrance.");
      if (typeof onSelectionChange === "function") onSelectionChange(selected);
      return selected;
    } catch (error) {
      if (destroyed || token !== reverseLookupToken) return null;
      selected = toSelection({ latitude: lat, longitude: lng, source }, {}, source);
      setSummary(selected);
      setStatus(error?.message || "Could not look up that address. You can still confirm the pin and edit the address fields manually.", true);
      if (typeof onSelectionChange === "function") onSelectionChange(selected);
      return selected;
    }
  }

  map.on("click", event => {
    void selectAt(event.lngLat.lng, event.lngLat.lat, "pin");
  });

  marker.on("dragend", () => {
    const lngLat = marker.getLngLat();
    void selectAt(lngLat.lng, lngLat.lat, "drag");
  });

  return {
    getSelection() {
      return selected;
    },

    async useCurrentLocation() {
      if (!navigator.geolocation) {
        throw new Error(getLocationFailureMessage(
          createLocationError("unsupported", 2, "Geolocation is unavailable."),
          { userAgent: navigator.userAgent, permissionState: "unknown", secureContext: window.isSecureContext }
        ));
      }

      const permissionState = await getGeolocationPermissionState(navigator.permissions);
      setStatus(permissionState === "prompt"
        ? "Allow location access if your browser asks. The first location fix can take up to about 35 seconds."
        : "Getting your current location… The first location fix can take up to about 35 seconds.");

      let position;
      try {
        position = await getReliableCurrentPosition({
          geolocation: navigator.geolocation,
          permissions: navigator.permissions,
          secureContext: window.isSecureContext
        });
      } catch (error) {
        throw new Error(getLocationFailureMessage(error, {
          userAgent: navigator.userAgent,
          permissionState,
          secureContext: window.isSecureContext
        }));
      }

      const { latitude, longitude } = position.coords;
      if (!isPhilippinesCoordinate(latitude, longitude)) {
        throw new Error("Your current location appears to be outside the Philippines. Tap the map manually if this is incorrect.");
      }

      const accuracy = readAccuracy(position);
      const zoom = accuracy <= 100 ? 17 : accuracy <= 500 ? 15.5 : accuracy <= 1500 ? 14 : 12.5;
      try {
        if (runtimeProfile.constrained) map.jumpTo({ center: [longitude, latitude], zoom });
        else map.easeTo({ center: [longitude, latitude], zoom, duration: 500, essential: false });
      } catch {
        try { map.jumpTo({ center: [longitude, latitude], zoom }); } catch { /* noop */ }
      }

      const selection = await selectAt(longitude, latitude, "geolocation");
      if (selection) {
        const accuracyText = Number.isFinite(accuracy)
          ? accuracy < 1000
            ? `±${Math.max(1, Math.round(accuracy))} m`
            : `±${(accuracy / 1000).toFixed(1)} km`
          : "an estimated accuracy";
        setStatus(accuracy <= 250
          ? `Current location found (${accuracyText}). Confirm the pin or drag it to the exact rider entrance.`
          : `Approximate current location found (${accuracyText}). Drag the pin to the exact rider entrance before confirming.`);
      }
      return selection;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      reverseLookupToken += 1;
      cleanupResize();
      try { marker.remove(); } catch { /* noop */ }
      try { map.remove(); } catch { /* noop */ }
      container.parentElement?.classList.remove("is-ready");
      container.replaceChildren();
    }
  };
}
