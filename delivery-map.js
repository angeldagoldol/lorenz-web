/**
 * Dagoldol delivery location picker.
 *
 * Version 3.3.3 moves the interactive picker away from a WebGL-only map path
 * and uses Leaflet 1.9.4 with raster tiles. This keeps the picker usable on
 * iPhone Safari, low-memory phones, and Windows machines whose browser/driver
 * cannot keep a stable WebGL map context.
 *
 * Geolocation is also deliberately independent from map initialization. The
 * browser can start acquiring the user's real device/network location as soon
 * as the user presses "Use my current location", even if map tiles are still
 * downloading.
 */

const LEAFLET_VERSION = "1.9.4";
const LEAFLET_JS_URLS = Object.freeze([
  `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`,
  `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`
]);
const LEAFLET_CSS_URLS = Object.freeze([
  `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`,
  `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`
]);
const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const NOMINATIM_EMAIL_IDENTIFIER = "dagoldol-trading-co-shop";
const REVERSE_CACHE_KEY = "dagoldol_reverse_geocode_cache_v1";
const REVERSE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const MAP_LIBRARY_LOAD_TIMEOUT_MS = 9000;
const DEFAULT_TRACKING_TIMEOUT_MS = 30000;

const PH_BOUNDS = Object.freeze({
  minLat: 4.0,
  maxLat: 21.5,
  minLon: 116.0,
  maxLon: 127.5
});
const PH_LEAFLET_BOUNDS = Object.freeze([
  [PH_BOUNDS.minLat, PH_BOUNDS.minLon],
  [PH_BOUNDS.maxLat, PH_BOUNDS.maxLon]
]);
const PH_DEFAULT_CENTER = Object.freeze([12.8797, 121.7740]);

let leafletLoadPromise = null;
let leafletCssPromise = null;
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
    // Private/opaque browser contexts can deny storage. Do not block checkout.
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

function formatAccuracy(position) {
  const accuracy = readAccuracy(position);
  if (!Number.isFinite(accuracy)) return "unknown accuracy";
  if (accuracy < 1000) return `±${Math.max(1, Math.round(accuracy))} m`;
  return `±${(accuracy / 1000).toFixed(1)} km`;
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

/**
 * Start live geolocation immediately. The high-accuracy watch is registered
 * before the one-shot network/cached request so a phone with a warm GPS can
 * provide a real fix without waiting for a coarse request to time out first.
 *
 * firstPosition resolves on the first valid browser position. The tracker may
 * continue briefly after that so callers can update the marker if accuracy
 * improves. stop() is idempotent and always clears the browser watch.
 */
export function startCurrentLocationTracking({
  geolocation = (typeof navigator !== "undefined" ? navigator.geolocation : null),
  permissions = (typeof navigator !== "undefined" ? navigator.permissions : null),
  secureContext = (typeof window === "undefined" ? true : window.isSecureContext),
  maxTrackingMs = DEFAULT_TRACKING_TIMEOUT_MS,
  onPosition = null,
  onError = null
} = {}) {
  let watchId = null;
  let stopped = false;
  let bestPosition = null;
  let firstSettled = false;
  let trackingTimer = null;
  let permissionState = "unknown";
  let resolveFirst;
  let rejectFirst;

  const firstPosition = new Promise((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (trackingTimer) clearTimeout(trackingTimer);
    if (watchId != null && geolocation && typeof geolocation.clearWatch === "function") {
      try { geolocation.clearWatch(watchId); } catch { /* noop */ }
    }
  };

  const fail = (error) => {
    if (stopped) return;
    const code = Number(error?.code || 0);
    const reason = code === 1 ? "permission_denied" : code === 3 ? "timeout" : "unavailable";
    const normalized = error?.name === "DagoldolLocationError"
      ? error
      : createLocationError(reason, code, error?.message || "Current location is unavailable.", error);
    normalized.permissionState = permissionState;
    if (typeof onError === "function") onError(normalized);
    if (!firstSettled) {
      firstSettled = true;
      rejectFirst(normalized);
      stop();
    }
  };

  const accept = (position) => {
    if (stopped || !isUsablePosition(position)) return;
    bestPosition = pickBetterPosition(bestPosition, position);
    if (typeof onPosition === "function") {
      try { onPosition(position, bestPosition); } catch { /* consumer errors must not break location */ }
    }
    if (!firstSettled) {
      firstSettled = true;
      resolveFirst(position);
    }
    if (readAccuracy(bestPosition) <= 35) stop();
  };

  void (async () => {
    if (!secureContext) {
      fail(createLocationError("insecure_context", 1, "Location requires a secure HTTPS page."));
      return;
    }
    if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
      fail(createLocationError("unsupported", 2, "This browser does not provide location access."));
      return;
    }

    permissionState = await getGeolocationPermissionState(permissions);
    if (permissionState === "denied") {
      fail(createLocationError("permission_denied", 1, "Location permission is blocked."));
      return;
    }

    trackingTimer = setTimeout(() => {
      if (!firstSettled) {
        fail(createLocationError("timeout", 3, "Location request timed out."));
      } else {
        stop();
      }
    }, Math.max(3000, Number(maxTrackingMs) || DEFAULT_TRACKING_TIMEOUT_MS));

    // Register the continuous high-accuracy watcher first.
    if (typeof geolocation.watchPosition === "function") {
      try {
        watchId = geolocation.watchPosition(
          accept,
          error => {
            if (error?.code === 1) fail(error);
            else if (typeof onError === "function") onError(error);
          },
          {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
          }
        );
      } catch (error) {
        if (typeof onError === "function") onError(error);
      }
    }

    // Then request a possibly cached/network position for a quick first marker.
    try {
      geolocation.getCurrentPosition(
        accept,
        error => {
          if (error?.code === 1) fail(error);
          else if (watchId == null && !firstSettled) fail(error);
          else if (typeof onError === "function") onError(error);
        },
        {
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 5 * 60 * 1000
        }
      );
    } catch (error) {
      if (watchId == null && !firstSettled) fail(error);
    }
  })();

  return {
    firstPosition,
    stop,
    getBestPosition() { return bestPosition; },
    getPermissionState() { return permissionState; }
  };
}

export async function getReliableCurrentPosition(options = {}) {
  let bestPosition = null;
  const tracker = startCurrentLocationTracking({
    ...options,
    maxTrackingMs: options.watchTimeoutMs || options.maxTrackingMs || DEFAULT_TRACKING_TIMEOUT_MS,
    onPosition(position, best) {
      bestPosition = best || pickBetterPosition(bestPosition, position);
      if (typeof options.onPosition === "function") options.onPosition(position, bestPosition);
    }
  });

  try {
    const first = await tracker.firstPosition;
    bestPosition = pickBetterPosition(bestPosition, first);
    const firstAccuracy = readAccuracy(bestPosition);
    const target = Number(options.targetAccuracyMeters) || 100;
    const acceptable = Number(options.acceptableFastAccuracyMeters) || 1200;

    if (firstAccuracy <= target) return bestPosition;

    // Even a usable network/Wi-Fi fix gets a short refinement window. Phones
    // often deliver a GPS fix a moment after the first coarse callback.
    const configuredSettleMs = Number(options.watchSettleMs);
    const settleMs = firstAccuracy <= acceptable
      ? Math.min(2500, Math.max(1, Number.isFinite(configuredSettleMs) ? configuredSettleMs : 1600))
      : Math.min(3500, Math.max(1, Number.isFinite(configuredSettleMs) ? configuredSettleMs : 2200));
    await wait(settleMs);
    return tracker.getBestPosition() || bestPosition;
  } finally {
    tracker.stop();
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
      return "Location access is blocked. In Windows open Settings → Privacy & security → Location, turn on Location services, then allow location for this Dagoldol site in Chrome/Edge and try again.";
    }
    if (isIOS) {
      return "Location access is blocked. On iPhone/iPad open Settings → Privacy & Security → Location Services, allow Safari/Chrome to use location, then allow this Dagoldol website and try again.";
    }
    return "Location permission is blocked. Enable Location Services for your browser and allow this Dagoldol site to use your location, then try again.";
  }

  if (reason === "timeout" || code === 3) {
    return "No device location fix arrived. Keep Location Services and Wi-Fi/mobile data on, then try again. On a Windows PC without GPS the browser may only provide an approximate network location; you can always drag the pin to the exact entrance.";
  }

  if (reason === "unsupported") {
    return "This browser cannot provide device location. Use a current Chrome, Edge, or Safari browser, or tap the map manually.";
  }

  if (isWindows) {
    return "Windows could not provide a location fix. Keep Location Services and Wi-Fi on, allow this site to use location, then try again. If the PC has no GPS, drag the pin from the approximate network location to the exact entrance.";
  }
  if (isIOS) {
    return "Your iPhone/iPad could not provide a location fix yet. Keep Location Services and Wi-Fi/mobile data on, allow this website to use location, then try again.";
  }
  return "Current location is unavailable right now. Check Location Services and browser permission, then try again or tap the map manually.";
}

async function loadScriptFromUrls(urls) {
  let lastError = null;
  for (const url of urls) {
    try {
      const existing = [...document.querySelectorAll('script[data-dagoldol-leaflet="true"]')]
        .find(script => script.src === url);
      const script = existing || document.createElement("script");
      if (!existing) {
        script.src = url;
        script.async = true;
        script.dataset.dagoldolLeaflet = "true";
      }

      const ready = new Promise((resolve, reject) => {
        if (window.L?.map) {
          resolve(window.L);
          return;
        }
        const onLoad = () => window.L?.map ? resolve(window.L) : reject(new Error("Leaflet loaded without initializing."));
        const onError = () => reject(new Error(`Could not load Leaflet from ${url}`));
        script.addEventListener("load", onLoad, { once: true });
        script.addEventListener("error", onError, { once: true });
      });

      if (!existing) document.head.appendChild(script);
      return await withTimeout(ready, MAP_LIBRARY_LOAD_TIMEOUT_MS, "The map library took too long to load.");
    } catch (error) {
      lastError = error;
      const failed = [...document.querySelectorAll('script[data-dagoldol-leaflet="true"]')]
        .find(script => script.src === url);
      if (failed && !window.L) {
        try { failed.remove(); } catch { /* noop */ }
      }
    }
  }
  throw lastError || new Error("Could not load the interactive map library.");
}

function ensureLeafletCss() {
  if (typeof document === "undefined") return Promise.resolve();
  if (document.querySelector('link[data-dagoldol-leaflet="true"]')) return leafletCssPromise || Promise.resolve();

  leafletCssPromise = new Promise(resolve => {
    let index = 0;
    const tryNext = () => {
      if (index >= LEAFLET_CSS_URLS.length) {
        resolve();
        return;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS_URLS[index++];
      link.dataset.dagoldolLeaflet = "true";
      link.addEventListener("load", () => resolve(), { once: true });
      link.addEventListener("error", () => {
        try { link.remove(); } catch { /* noop */ }
        tryNext();
      }, { once: true });
      document.head.appendChild(link);
    };
    tryNext();
  });

  return leafletCssPromise;
}

async function loadLeaflet() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("The interactive map is only available in a browser.");
  }
  if (window.L?.map) return window.L;
  if (leafletLoadPromise) return leafletLoadPromise;

  leafletLoadPromise = (async () => {
    void ensureLeafletCss();
    return loadScriptFromUrls(LEAFLET_JS_URLS);
  })().catch(error => {
    leafletLoadPromise = null;
    throw error;
  });

  return leafletLoadPromise;
}

function scheduleInvalidateSize(map, container) {
  const timers = [];
  let raf1 = null;
  let raf2 = null;
  let destroyed = false;

  const invalidate = () => {
    if (destroyed) return;
    if (!container?.isConnected || container.clientWidth <= 0 || container.clientHeight <= 0) return;
    try { map.invalidateSize({ pan: false, animate: false }); } catch { /* noop */ }
  };

  if (typeof requestAnimationFrame === "function") {
    raf1 = requestAnimationFrame(() => {
      invalidate();
      raf2 = requestAnimationFrame(invalidate);
    });
  }
  timers.push(setTimeout(invalidate, 80));
  timers.push(setTimeout(invalidate, 240));
  timers.push(setTimeout(invalidate, 700));

  const visualViewport = typeof window !== "undefined" ? window.visualViewport : null;
  visualViewport?.addEventListener("resize", invalidate, { passive: true });
  window.addEventListener("orientationchange", invalidate, { passive: true });
  window.addEventListener("resize", invalidate, { passive: true });

  return () => {
    destroyed = true;
    if (raf1 != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf1);
    if (raf2 != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf2);
    timers.forEach(timer => clearTimeout(timer));
    visualViewport?.removeEventListener("resize", invalidate);
    window.removeEventListener("orientationchange", invalidate);
    window.removeEventListener("resize", invalidate);
  };
}

function zoomForAccuracy(accuracy) {
  if (accuracy <= 60) return 18;
  if (accuracy <= 150) return 17;
  if (accuracy <= 500) return 16;
  if (accuracy <= 1500) return 14;
  return 12;
}

export async function getCurrentLocationSelection({
  onProgress = null,
  geolocation = (typeof navigator !== "undefined" ? navigator.geolocation : null),
  permissions = (typeof navigator !== "undefined" ? navigator.permissions : null),
  secureContext = (typeof window === "undefined" ? true : window.isSecureContext)
} = {}) {
  const permissionState = await getGeolocationPermissionState(permissions);
  if (typeof onProgress === "function") onProgress({ type: "permission", permissionState });

  let position;
  try {
    position = await getReliableCurrentPosition({
      geolocation,
      permissions,
      secureContext,
      watchTimeoutMs: DEFAULT_TRACKING_TIMEOUT_MS,
      onPosition(current, best) {
        if (typeof onProgress === "function") onProgress({ type: "position", position: current, bestPosition: best });
      }
    });
  } catch (error) {
    throw new Error(getLocationFailureMessage(error, {
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      permissionState,
      secureContext
    }));
  }

  const latitude = Number(position.coords.latitude);
  const longitude = Number(position.coords.longitude);
  if (!isPhilippinesCoordinate(latitude, longitude)) {
    throw new Error("Your current location appears to be outside the Philippines. Tap the map manually if this is incorrect.");
  }

  let address = {};
  try {
    address = await reverseGeocodePin(latitude, longitude);
  } catch {
    address = {};
  }
  return toSelection({ latitude, longitude, source: "geolocation" }, address, "geolocation");
}

/**
 * Initialize the reusable delivery map in an already-visible modal.
 * The map becomes interactive as soon as Leaflet initializes; raster tile
 * failures never block pinning or geolocation.
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

  const L = await loadLeaflet();
  const normalizedInitial = normalizeSavedLocation(initialLocation);
  const startLatLng = normalizedInitial
    ? [normalizedInitial.latitude, normalizedInitial.longitude]
    : PH_DEFAULT_CENTER;

  let selected = normalizedInitial
    ? toSelection(normalizedInitial, initialAddress || normalizedInitial.addressSnapshot || {}, normalizedInitial.source)
    : null;
  let reverseLookupToken = 0;
  let destroyed = false;
  let tileFailureShown = false;
  let locationTracker = null;
  let lastAccurateReverse = Number.POSITIVE_INFINITY;

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

  const map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
    maxBounds: PH_LEAFLET_BOUNDS,
    maxBoundsViscosity: 0.8,
    minZoom: 5,
    maxZoom: 19,
    preferCanvas: true,
    zoomAnimation: false,
    fadeAnimation: false,
    markerZoomAnimation: false,
    inertia: true,
    worldCopyJump: false
  });

  map.setView(startLatLng, normalizedInitial ? 16 : 5.4, { animate: false });
  container.parentElement?.classList.add("is-ready");
  const cleanupResize = scheduleInvalidateSize(map, container);

  const tiles = L.tileLayer(OSM_TILE_URL, {
    minZoom: 5,
    maxZoom: 19,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 2,
    crossOrigin: true,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
  });
  tiles.on("tileerror", () => {
    if (tileFailureShown || destroyed) return;
    tileFailureShown = true;
    setStatus("Some map tiles are slow to load, but the pin and current-location button still work. You can continue.", true);
  });
  tiles.addTo(map);

  const markerIcon = L.divIcon({
    className: "dagoldol-leaflet-marker",
    html: '<span class="dagoldol-leaflet-marker-core" aria-hidden="true"></span>',
    iconSize: [34, 42],
    iconAnchor: [17, 41]
  });
  const marker = L.marker(startLatLng, {
    draggable: true,
    keyboard: true,
    icon: markerIcon,
    autoPan: true
  });
  let markerAdded = false;
  let accuracyCircle = null;

  const ensureMarker = () => {
    if (markerAdded) return;
    marker.addTo(map);
    markerAdded = true;
  };
  if (normalizedInitial) ensureMarker();

  const centerMap = (lat, lon, accuracy = 80) => {
    const zoom = zoomForAccuracy(Number(accuracy));
    try { map.setView([lat, lon], zoom, { animate: false }); } catch { /* noop */ }
  };

  const showRawPosition = (position, { center = true } = {}) => {
    if (destroyed || !isUsablePosition(position)) return null;
    const latitude = Number(position.coords.latitude);
    const longitude = Number(position.coords.longitude);
    if (!isPhilippinesCoordinate(latitude, longitude)) return null;
    const accuracy = readAccuracy(position);

    ensureMarker();
    marker.setLatLng([latitude, longitude]);
    if (center) centerMap(latitude, longitude, accuracy);

    if (accuracyCircle) {
      try { accuracyCircle.remove(); } catch { /* noop */ }
      accuracyCircle = null;
    }
    if (Number.isFinite(accuracy) && accuracy > 0) {
      accuracyCircle = L.circle([latitude, longitude], {
        radius: Math.min(Math.max(accuracy, 8), 5000),
        interactive: false,
        color: "#4FE3C1",
        weight: 1,
        opacity: 0.7,
        fillColor: "#4FE3C1",
        fillOpacity: 0.08
      }).addTo(map);
    }

    const existingAddress = selected?.address || {};
    selected = toSelection({ latitude, longitude, source: "geolocation" }, existingAddress, "geolocation");
    setSummary(selected);
    if (typeof onSelectionChange === "function") onSelectionChange(selected);
    return selected;
  };

  async function selectAt(lng, lat, source = "pin") {
    if (destroyed) return null;
    if (!isPhilippinesCoordinate(lat, lng)) {
      setStatus("Please choose a location within the Philippines.", true);
      return null;
    }

    ensureMarker();
    marker.setLatLng([lat, lng]);
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
    void selectAt(event.latlng.lng, event.latlng.lat, "pin");
  });

  marker.on("dragend", () => {
    const latLng = marker.getLatLng();
    void selectAt(latLng.lng, latLng.lat, "drag");
  });

  setSummary(selected);
  setStatus(selected
    ? "Move the pin if needed, or confirm this delivery location."
    : "Tap the map, drag the pin, or use your current location.");

  return {
    getSelection() {
      return selected;
    },

    async setSelection(selection, { center = true } = {}) {
      const normalized = normalizeSavedLocation(selection);
      if (!normalized) return null;
      selected = toSelection(normalized, selection.address || selection.addressSnapshot || {}, selection.source || normalized.source);
      ensureMarker();
      marker.setLatLng([normalized.latitude, normalized.longitude]);
      if (center) centerMap(normalized.latitude, normalized.longitude, 80);
      setSummary(selected);
      if (typeof onSelectionChange === "function") onSelectionChange(selected);
      return selected;
    },

    async useCurrentLocation() {
      if (locationTracker) locationTracker.stop();
      const permissionState = await getGeolocationPermissionState(navigator.permissions);
      setStatus(permissionState === "prompt"
        ? "Allow location access if your browser asks. The pin will move as soon as your device reports a position."
        : "Getting your current location… The pin will move as soon as your device reports a position.");

      let firstValidPosition = null;
      locationTracker = startCurrentLocationTracking({
        geolocation: navigator.geolocation,
        permissions: navigator.permissions,
        secureContext: window.isSecureContext,
        maxTrackingMs: DEFAULT_TRACKING_TIMEOUT_MS,
        onPosition(position, bestPosition) {
          const current = bestPosition || position;
          if (!isUsablePosition(current)) return;
          const latitude = Number(current.coords.latitude);
          const longitude = Number(current.coords.longitude);
          if (!isPhilippinesCoordinate(latitude, longitude)) return;
          const accuracy = readAccuracy(current);
          showRawPosition(current, { center: true });
          setStatus(`Location received (${formatAccuracy(current)}). Improving the fix if your device can provide a more precise position…`);

          // Reverse geocode the first fix, then once more if GPS becomes clearly
          // more precise. This avoids hammering the public geocoder.
          if (!firstValidPosition || (accuracy <= 100 && lastAccurateReverse > 100)) {
            firstValidPosition = current;
            lastAccurateReverse = accuracy;
            void selectAt(longitude, latitude, "geolocation");
          }
        },
        onError(error) {
          if (error?.code === 1) {
            setStatus(getLocationFailureMessage(error, {
              userAgent: navigator.userAgent,
              permissionState,
              secureContext: window.isSecureContext
            }), true);
          }
        }
      });

      let position;
      try {
        position = await locationTracker.firstPosition;
      } catch (error) {
        throw new Error(getLocationFailureMessage(error, {
          userAgent: navigator.userAgent,
          permissionState,
          secureContext: window.isSecureContext
        }));
      }

      const latitude = Number(position.coords.latitude);
      const longitude = Number(position.coords.longitude);
      if (!isPhilippinesCoordinate(latitude, longitude)) {
        locationTracker.stop();
        throw new Error("Your current location appears to be outside the Philippines. Tap the map manually if this is incorrect.");
      }

      showRawPosition(position, { center: true });
      const selection = await selectAt(longitude, latitude, "geolocation");
      if (selection) {
        const accuracy = readAccuracy(position);
        setStatus(accuracy <= 100
          ? `Current location pinpointed (${formatAccuracy(position)}). The pin may move slightly if GPS improves; drag it to the exact entrance if needed.`
          : `Current location found (${formatAccuracy(position)}). This device is reporting an approximate position; drag the pin to the exact entrance if needed.`);
      }
      return selection || selected;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      reverseLookupToken += 1;
      if (locationTracker) {
        locationTracker.stop();
        locationTracker = null;
      }
      cleanupResize();
      try { if (accuracyCircle) accuracyCircle.remove(); } catch { /* noop */ }
      try { marker.remove(); } catch { /* noop */ }
      try { tiles.remove(); } catch { /* noop */ }
      try { map.remove(); } catch { /* noop */ }
      container.parentElement?.classList.remove("is-ready");
      container.replaceChildren();
    }
  };
}
