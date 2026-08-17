/**
 * Dagoldol delivery map picker.
 *
 * The module is intentionally lazy: importing it does not load MapLibre or
 * create a WebGL context. MapLibre is fetched only when openDeliveryMap() is
 * called from an explicit customer action.
 */

const MAPLIBRE_VERSION = "5.12.0";
const MAPLIBRE_JS_URL = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`;
const MAPLIBRE_CSS_URL = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const NOMINATIM_EMAIL_IDENTIFIER = "dagoldol-trading-co-shop";
const REVERSE_CACHE_KEY = "dagoldol_reverse_geocode_cache_v1";
const REVERSE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1100;

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
    // Storage can be unavailable in private/opaque contexts. Never block checkout.
  }
}

function reverseCacheKey(lat, lon) {
  return `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function loadMapLibre() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("The interactive map is only available in a browser.");
  }
  if (window.maplibregl) return window.maplibregl;
  if (mapLibreLoadPromise) return mapLibreLoadPromise;

  ensureMapLibreCss();
  mapLibreLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-dagoldol-maplibre="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.maplibregl), { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load the map library.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = MAPLIBRE_JS_URL;
    script.async = true;
    script.dataset.dagoldolMaplibre = "true";
    script.addEventListener("load", () => {
      if (window.maplibregl) resolve(window.maplibregl);
      else reject(new Error("The map library loaded without initializing."));
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("Could not load the map library.")), { once: true });
    document.head.appendChild(script);
  }).catch(error => {
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

  const maplibregl = await loadMapLibre();
  const normalizedInitial = normalizeSavedLocation(initialLocation);
  const startLngLat = normalizedInitial
    ? [normalizedInitial.longitude, normalizedInitial.latitude]
    : PH_DEFAULT_CENTER;

  let selected = normalizedInitial
    ? toSelection(normalizedInitial, initialAddress || normalizedInitial.addressSnapshot || {}, normalizedInitial.source)
    : null;
  let reverseLookupToken = 0;
  let destroyed = false;

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
    renderWorldCopies: false
  });

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
      setStatus("Address found. Confirm the pin when it matches your delivery entrance.");
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

  map.once("load", () => {
    if (destroyed) return;
    container.parentElement?.classList.add("is-ready");
    map.resize();
    setSummary(selected);
    setStatus(selected
      ? "Move the pin if needed, or confirm this delivery location."
      : "Tap the map, drag the pin, or use your current location.");
  });

  return {
    getSelection() {
      return selected;
    },

    async useCurrentLocation() {
      if (!navigator.geolocation) {
        throw new Error("This browser does not provide location access.");
      }
      setStatus("Getting your current location…");
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 30000
        });
      }).catch(error => {
        if (error && error.code === 1) throw new Error("Location permission was denied. You can still tap the map to choose your address.");
        if (error && error.code === 3) throw new Error("Location timed out. Try again or tap the map manually.");
        throw new Error("Current location is unavailable. Tap the map to choose your address.");
      });

      const { latitude, longitude } = position.coords;
      if (!isPhilippinesCoordinate(latitude, longitude)) {
        throw new Error("Your current location appears to be outside the Philippines.");
      }
      map.flyTo({ center: [longitude, latitude], zoom: 17, essential: true });
      return selectAt(longitude, latitude, "geolocation");
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      reverseLookupToken += 1;
      try { marker.remove(); } catch { /* noop */ }
      try { map.remove(); } catch { /* noop */ }
      container.parentElement?.classList.remove("is-ready");
      container.replaceChildren();
    }
  };
}
