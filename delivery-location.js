(function () {
  "use strict";

  const DEFAULT_CENTER = [7.2777, 125.3245];
  const DEFAULT_ZOOM = 13;
  const PIN_ZOOM = 17;
  const ARRIVAL_METERS = 100;
  const NEARBY_METERS = 300;
  const ROUTE_REFRESH_MIN_MS = 10000;
  const ROUTE_REFRESH_MIN_MOVE_M = 50;
  const NOMINATIM_MIN_INTERVAL_MS = 1100;
  const OSRM_MIN_INTERVAL_MS = 1100;
  const REVERSE_CACHE_KEY = "dagoldol_reverse_geocode_cache_v1";
  const REVERSE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  let checkoutMap = null;
  let checkoutMarker = null;
  let selectedLocation = null;
  let confirmedLocation = null;
  let reverseGeocodeToken = 0;
  let reverseGeocodeTimer = null;
  let nominatimQueue = Promise.resolve();
  let nominatimLastRequestAt = 0;
  let osrmQueue = Promise.resolve();
  let osrmLastRequestAt = 0;

  let routeMap = null;
  let routeDestinationMarker = null;
  let routeRiderMarker = null;
  let routePolyline = null;
  let routeWatchId = null;
  let routeDestination = null;
  let lastRoutePosition = null;
  let lastRouteAt = 0;
  let lastRiderPosition = null;
  let routeStoppedByUser = false;
  const accountPreviewMaps = new WeakMap();

  function byId(id) {
    return document.getElementById(id);
  }

  function loadReverseCache() {
    try {
      const raw = localStorage.getItem(REVERSE_CACHE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      return {};
    }
  }

  function saveReverseCache(cache) {
    try {
      localStorage.setItem(REVERSE_CACHE_KEY, JSON.stringify(cache));
    } catch (error) {
      /* Ignore storage/quota failures. */
    }
  }

  let reverseCache = loadReverseCache();

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function nominatimRequestJson(url) {
    const run = async () => {
      const elapsed = Date.now() - nominatimLastRequestAt;
      if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
        await wait(NOMINATIM_MIN_INTERVAL_MS - elapsed);
      }
      const response = await fetch(url, {
        headers: { "Accept": "application/json" }
      });
      nominatimLastRequestAt = Date.now();
      if (!response.ok) throw new Error(`Nominatim request failed (${response.status})`);
      return response.json();
    };

    const result = nominatimQueue.then(run, run);
    nominatimQueue = result.catch(() => undefined);
    return result;
  }

  window.DagoldolNominatimRequest = nominatimRequestJson;

  function osrmRequestJson(url) {
    const run = async () => {
      const elapsed = Date.now() - osrmLastRequestAt;
      if (elapsed < OSRM_MIN_INTERVAL_MS) {
        await wait(OSRM_MIN_INTERVAL_MS - elapsed);
      }
      const response = await fetch(url, { headers: { "Accept": "application/json" } });
      osrmLastRequestAt = Date.now();
      if (!response.ok) throw new Error(`OSRM request failed (${response.status})`);
      return response.json();
    };

    const result = osrmQueue.then(run, run);
    osrmQueue = result.catch(() => undefined);
    return result;
  }

  window.DagoldolOsrmRequest = osrmRequestJson;

  function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeLocation(value) {
    if (!value || typeof value !== "object") return null;
    const lat = finiteNumber(value.lat ?? value.latitude);
    const lon = finiteNumber(value.lon ?? value.lng ?? value.longitude);
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return {
      lat,
      lon,
      displayName: String(value.displayName || value.display_name || "").trim(),
      source: String(value.source || "pin").trim() || "pin",
      confirmed: value.confirmed === true || Boolean(value.confirmedAt || value.confirmed_at),
      confirmedAt: Number(value.confirmedAt || value.confirmed_at || 0) || null
    };
  }

  function locationFromAddress(address) {
    if (!address || typeof address !== "object") return null;
    return normalizeLocation(address.location || address.deliveryLocation || address);
  }

  function resolveAccountLocation(profileAddress, orderAddresses) {
    const profileLocation = locationFromAddress(profileAddress);
    if (profileLocation) return { ...profileLocation, provenance: "profile" };

    for (const orderAddress of Array.isArray(orderAddresses) ? orderAddresses : []) {
      const orderLocation = locationFromAddress(orderAddress);
      if (orderLocation) return { ...orderLocation, provenance: "latest-order" };
    }
    return null;
  }

  function publicLocation(location, sourceOverride) {
    const normalized = normalizeLocation(location);
    if (!normalized) return null;
    return {
      lat: Number(normalized.lat.toFixed(6)),
      lon: Number(normalized.lon.toFixed(6)),
      displayName: normalized.displayName || "",
      source: sourceOverride || normalized.source || "pin",
      confirmed: true,
      confirmedAt: Date.now()
    };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  function markerIcon(kind) {
    if (!window.L) return undefined;
    const label = kind === "rider" ? "YOU" : "PIN";
    return window.L.divIcon({
      className: `dagoldol-map-marker dagoldol-map-marker-${kind}`,
      html: `<span aria-hidden="true">${label}</span>`,
      iconSize: kind === "rider" ? [42, 42] : [46, 46],
      iconAnchor: kind === "rider" ? [21, 21] : [23, 42]
    });
  }

  function addBaseLayer(map) {
    window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(map);
  }

  function observeMapResize(element, map) {
    if (!element || !map || element.dataset.dagoldolResizeObserved === "1") return;
    element.dataset.dagoldolResizeObserved = "1";
    let timer = null;
    const invalidate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try { map.invalidateSize({ pan: false, debounceMoveend: true }); } catch (_) { /* map may be closing */ }
      }, 60);
    };
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(invalidate);
      observer.observe(element);
    }
    if (typeof window.addEventListener === "function") {
      window.addEventListener("orientationchange", invalidate, { passive: true });
      window.addEventListener("resize", invalidate, { passive: true });
    }
  }

  function ensureCheckoutMap() {
    const mapEl = byId("delivery-pin-map");
    if (!mapEl || !window.L) return null;
    if (checkoutMap) {
      window.setTimeout(() => checkoutMap.invalidateSize(), 0);
      return checkoutMap;
    }

    checkoutMap = window.L.map(mapEl, {
      zoomControl: true,
      attributionControl: true
    }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    addBaseLayer(checkoutMap);
    observeMapResize(mapEl, checkoutMap);

    checkoutMap.on("click", (event) => {
      setCheckoutPoint(event.latlng.lat, event.latlng.lng, {
        source: "map",
        reverseGeocode: true,
        center: false
      });
    });

    return checkoutMap;
  }

  function setCheckoutMarker(lat, lon, center) {
    const map = ensureCheckoutMap();
    if (!map) return;

    if (!checkoutMarker) {
      checkoutMarker = window.L.marker([lat, lon], {
        draggable: true,
        icon: markerIcon("destination"),
        title: "Exact delivery pin"
      }).addTo(map);
      checkoutMarker.on("dragend", () => {
        const point = checkoutMarker.getLatLng();
        setCheckoutPoint(point.lat, point.lng, {
          source: "dragged-pin",
          reverseGeocode: true,
          center: false
        });
      });
    } else {
      checkoutMarker.setLatLng([lat, lon]);
    }

    if (center) map.setView([lat, lon], PIN_ZOOM);
  }

  function setPinStatus(message, tone) {
    const status = byId("delivery-pin-status");
    if (!status) return;
    status.textContent = message;
    status.classList.remove("is-working", "is-ok", "is-error");
    if (tone) status.classList.add(`is-${tone}`);
  }

  function updatePinSummary() {
    const summary = byId("delivery-pin-summary");
    const coords = byId("delivery-pin-coordinates");
    const confirmBtn = byId("delivery-pin-confirm");
    if (!summary || !coords || !confirmBtn) return;

    if (!selectedLocation) {
      summary.classList.add("hidden");
      return;
    }

    summary.classList.remove("hidden");
    coords.textContent = `${selectedLocation.lat.toFixed(6)}, ${selectedLocation.lon.toFixed(6)}`;
    confirmBtn.textContent = confirmedLocation ? "Location confirmed ✓" : "Confirm this delivery pin";
    confirmBtn.classList.toggle("is-confirmed", !!confirmedLocation);
  }

  function dispatchInput(input) {
    if (!input) return;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function firstNonEmpty(object, keys) {
    for (const key of keys) {
      const value = object && object[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function buildStreetAddress(result) {
    const address = result && result.address ? result.address : {};
    const house = firstNonEmpty(address, ["house_number"]);
    const road = firstNonEmpty(address, ["road", "pedestrian", "residential", "street", "path", "footway"]);
    const neighbourhood = firstNonEmpty(address, ["neighbourhood", "quarter", "suburb", "village", "hamlet"]);
    const primary = [house, road].filter(Boolean).join(" ").trim();
    if (primary && neighbourhood && !primary.toLowerCase().includes(neighbourhood.toLowerCase())) {
      return `${primary}, ${neighbourhood}`;
    }
    if (primary) return primary;
    if (neighbourhood) return neighbourhood;

    const displayParts = String(result && result.display_name || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return displayParts.slice(0, Math.min(2, displayParts.length)).join(", ");
  }

  function buildCityMunicipality(result) {
    const address = result && result.address ? result.address : {};
    return firstNonEmpty(address, [
      "city",
      "municipality",
      "town",
      "city_district",
      "village",
      "county"
    ]);
  }

  async function reverseGeocode(lat, lon) {
    const cacheKey = `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
    const cached = reverseCache[cacheKey];
    if (cached && (Date.now() - cached.at) < REVERSE_CACHE_MAX_AGE_MS) {
      return cached.data;
    }

    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "18");
    url.searchParams.set("accept-language", "en");

    const data = await nominatimRequestJson(url.toString());
    reverseCache[cacheKey] = { data, at: Date.now() };
    saveReverseCache(reverseCache);
    return data;
  }

  function applyReverseGeocodeResult(result) {
    const street = buildStreetAddress(result);
    const city = buildCityMunicipality(result);
    const postal = firstNonEmpty(result && result.address, ["postcode"]);
    const addressInput = byId("order-address");
    const cityInput = byId("order-city");
    const postalInput = byId("order-postal");

    if (street && addressInput) addressInput.value = street;
    if (city && cityInput) cityInput.value = city;
    if (postal && postalInput) postalInput.value = postal;

    dispatchInput(addressInput);
    dispatchInput(cityInput);
    dispatchInput(postalInput);
    return { street, city, postal };
  }

  async function enrichCheckoutPoint(token) {
    if (!selectedLocation) return;
    try {
      setPinStatus("Pin set. Finding the street, city/municipality and postal code…", "working");
      const result = await reverseGeocode(selectedLocation.lat, selectedLocation.lon);
      if (token !== reverseGeocodeToken || !selectedLocation) return;
      selectedLocation.displayName = String(result.display_name || "").trim();
      const applied = applyReverseGeocodeResult(result);
      const missing = [];
      if (!applied.street) missing.push("street address");
      if (!applied.city) missing.push("city/municipality");
      if (!applied.postal) missing.push("postal code");
      if (missing.length) {
        setPinStatus(`Pin set. Map data filled what it could; please enter the missing ${missing.join(", ")}, then confirm the pin.`, "ok");
      } else {
        setPinStatus("Street, city/municipality and postal code filled automatically. Check them, then confirm this delivery pin.", "ok");
      }
      updatePinSummary();
    } catch (error) {
      console.error("[Dagoldol] reverse geocoding failed:", error);
      if (token !== reverseGeocodeToken) return;
      setPinStatus("The exact pin is saved, but the address could not be filled automatically. You can type the address and keep the pin.", "error");
      updatePinSummary();
    }
  }

  function setCheckoutPoint(latValue, lonValue, options) {
    const lat = finiteNumber(latValue);
    const lon = finiteNumber(lonValue);
    if (lat == null || lon == null) return;

    const opts = options || {};
    selectedLocation = {
      lat,
      lon,
      displayName: String(opts.displayName || "").trim(),
      source: opts.source || "pin"
    };
    confirmedLocation = null;
    setCheckoutMarker(lat, lon, opts.center !== false);
    updatePinSummary();

    if (opts.reverseGeocode !== false) {
      const token = ++reverseGeocodeToken;
      if (reverseGeocodeTimer) window.clearTimeout(reverseGeocodeTimer);
      setPinStatus("Pin set. Reading the address…", "working");
      reverseGeocodeTimer = window.setTimeout(() => enrichCheckoutPoint(token), 700);
    } else {
      setPinStatus("Saved pin loaded. Confirm it or move the pin if your delivery point changed.", "ok");
    }
  }

  function useCurrentLocation() {
    const button = byId("delivery-use-current");
    if (!navigator.geolocation) {
      setPinStatus("This browser does not provide device location. Tap the map to place the pin manually.", "error");
      return;
    }

    if (button) button.disabled = true;
    setPinStatus("Getting your current location…", "working");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (button) button.disabled = false;
        setCheckoutPoint(position.coords.latitude, position.coords.longitude, {
          source: "current-location",
          reverseGeocode: true,
          center: true
        });
      },
      (error) => {
        if (button) button.disabled = false;
        const message = error && error.code === 1
          ? "Location permission was denied. Allow location access or tap the map to pin manually."
          : "Your current location could not be read. Tap the map to pin your delivery point manually.";
        setPinStatus(message, "error");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 }
    );
  }

  function confirmCheckoutLocation() {
    if (!selectedLocation) {
      setPinStatus("Choose a point on the map first.", "error");
      return;
    }
    confirmedLocation = publicLocation(selectedLocation);
    setPinStatus("Delivery pin confirmed. The rider/admin will be able to route to this exact point.", "ok");
    updatePinSummary();
    document.dispatchEvent(new CustomEvent("dagoldol:delivery-location-confirmed", {
      detail: { ...confirmedLocation }
    }));
  }

  function initCheckout() {
    if (!byId("delivery-pin-map")) return;
    ensureCheckoutMap();
    const useCurrentBtn = byId("delivery-use-current");
    const confirmBtn = byId("delivery-pin-confirm");
    const clearBtn = byId("delivery-pin-clear");

    if (useCurrentBtn && !useCurrentBtn.dataset.locationWired) {
      useCurrentBtn.dataset.locationWired = "1";
      useCurrentBtn.addEventListener("click", useCurrentLocation);
    }
    if (confirmBtn && !confirmBtn.dataset.locationWired) {
      confirmBtn.dataset.locationWired = "1";
      confirmBtn.addEventListener("click", confirmCheckoutLocation);
    }
    if (clearBtn && !clearBtn.dataset.locationWired) {
      clearBtn.dataset.locationWired = "1";
      clearBtn.addEventListener("click", resetCheckout);
    }

    window.setTimeout(() => {
      if (checkoutMap) checkoutMap.invalidateSize();
    }, 60);
  }

  function loadSavedLocation(addressOrLocation) {
    initCheckout();
    const location = locationFromAddress(addressOrLocation) || normalizeLocation(addressOrLocation);
    if (!location) {
      if (!selectedLocation) {
        setPinStatus("For fastest delivery, use your current location or tap the map to place the exact pin.");
      }
      return;
    }
    selectedLocation = { ...location };
    confirmedLocation = publicLocation(location, location.source || "saved-pin");
    setCheckoutMarker(location.lat, location.lon, true);
    setPinStatus("Saved exact delivery pin loaded. Move it if needed, then confirm.", "ok");
    confirmedLocation = null;
    updatePinSummary();
  }

  function resetCheckout() {
    reverseGeocodeToken += 1;
    if (reverseGeocodeTimer) window.clearTimeout(reverseGeocodeTimer);
    reverseGeocodeTimer = null;
    selectedLocation = null;
    confirmedLocation = null;
    if (checkoutMarker && checkoutMap) {
      checkoutMap.removeLayer(checkoutMarker);
      checkoutMarker = null;
    }
    const summary = byId("delivery-pin-summary");
    if (summary) summary.classList.add("hidden");
    setPinStatus("For fastest delivery, use your current location or tap the map to place the exact pin.");
    if (checkoutMap) checkoutMap.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  }

  function getSelectedLocation() {
    return selectedLocation ? { ...selectedLocation } : null;
  }

  function getConfirmedLocation() {
    return confirmedLocation ? { ...confirmedLocation } : null;
  }

  function haversineMeters(a, b) {
    const earthRadiusM = 6371008.8;
    const toRad = (degrees) => degrees * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return "—";
    if (meters < 1000) return `${Math.max(1, Math.round(meters))} m`;
    return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
  }

  function getProximityState(meters) {
    const distance = Number(meters);
    if (!Number.isFinite(distance)) return { key: "unknown", label: "Locating…", tone: "working" };
    if (distance <= ARRIVAL_METERS) return { key: "arrived", label: "At delivery point", tone: "near" };
    if (distance <= NEARBY_METERS) return { key: "near", label: "Near customer", tone: "near" };
    if (distance <= 3000) return { key: "approaching", label: "Approaching customer", tone: "ok" };
    return { key: "far", label: "Far from customer", tone: "ok" };
  }

  function buildRoutePresentation({ directMeters, roadMeters, durationSeconds } = {}) {
    const direct = Number(directMeters);
    const road = Number(roadMeters);
    const hasDirect = Number.isFinite(direct);
    const hasRoad = Number.isFinite(road);
    const proximityMeters = hasDirect ? direct : road;
    const displayMeters = hasRoad ? road : direct;
    const state = getProximityState(proximityMeters);
    const directDistanceText = hasDirect ? formatDistance(direct) : "—";
    const distanceText = formatDistance(displayMeters);
    const etaText = Number.isFinite(Number(durationSeconds)) ? formatDuration(Number(durationSeconds)) : "—";
    const etaPart = etaText !== "—" ? ` · about ${etaText}` : "";
    const distancePart = hasDirect && hasRoad
      ? `${directDistanceText} from pin · ${distanceText} by road`
      : hasRoad
        ? `${distanceText} by road`
        : `${distanceText} from pin`;
    return {
      state,
      directDistanceText,
      distanceText,
      etaText,
      message: `${state.label} — ${distancePart}${etaPart}`
    };
  }

  function setRouteStatus(message, tone) {
    const status = byId("delivery-route-status");
    if (!status) return;
    status.textContent = message;
    status.classList.remove("is-working", "is-ok", "is-error", "is-near");
    if (tone) status.classList.add(`is-${tone}`);
  }

  function setMetric(id, value) {
    const element = byId(id);
    if (element) element.textContent = value;
  }

  function updateTrackingMeta(rider, accuracyMeters) {
    if (rider) lastRiderPosition = { ...rider };
    if (Number.isFinite(Number(accuracyMeters))) {
      setMetric("delivery-route-accuracy", `±${Math.max(1, Math.round(Number(accuracyMeters)))} m`);
    }
    const updated = byId("delivery-route-updated");
    if (updated) updated.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function applyRoutePresentation(presentation, { roadAvailable = false } = {}) {
    if (!presentation) return;
    setMetric("delivery-route-state", presentation.state.label);
    if (roadAvailable) {
      setMetric("delivery-route-road-distance", presentation.distanceText);
      setMetric("delivery-route-eta", presentation.etaText);
    }
    setRouteStatus(presentation.message, presentation.state.tone);
  }

  function updateArrivalStatus(rider, accuracyMeters) {
    if (!routeDestination || !rider) return;
    const directDistance = haversineMeters(rider, routeDestination);
    setMetric("delivery-route-proximity", formatDistance(directDistance));
    updateTrackingMeta(rider, accuracyMeters);

    const presentation = buildRoutePresentation({ directMeters: directDistance });
    applyRoutePresentation(presentation, { roadAvailable: false });
  }

  async function requestDrivingRoute(rider, destination) {
    const url = `https://router.project-osrm.org/route/v1/driving/${rider.lon},${rider.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson&steps=true`;
    const data = await osrmRequestJson(url);
    if (data.code !== "Ok" || !Array.isArray(data.routes) || !data.routes.length) {
      throw new Error(data.code || "No route returned");
    }
    return data.routes[0];
  }

  async function refreshDrivingRoute(rider, force) {
    if (!routeDestination || !routeMap) return;
    const now = Date.now();
    const moved = lastRoutePosition ? haversineMeters(lastRoutePosition, rider) : Infinity;
    if (!force && (now - lastRouteAt < ROUTE_REFRESH_MIN_MS || moved < ROUTE_REFRESH_MIN_MOVE_M)) return;

    lastRouteAt = now;
    lastRoutePosition = { ...rider };
    const routeInfo = byId("delivery-route-road-info");
    if (routeInfo) routeInfo.textContent = "Updating road route…";

    try {
      const route = await requestDrivingRoute(rider, routeDestination);
      const coordinates = route.geometry && Array.isArray(route.geometry.coordinates)
        ? route.geometry.coordinates.map(([lon, lat]) => [lat, lon])
        : [];

      if (routePolyline) routeMap.removeLayer(routePolyline);
      if (coordinates.length) {
        routePolyline = window.L.polyline(coordinates, {
          color: "#d8b56a",
          weight: 6,
          opacity: 0.9,
          lineJoin: "round",
          lineCap: "round"
        }).addTo(routeMap);
      }

      const presentation = buildRoutePresentation({
        directMeters: haversineMeters(rider, routeDestination),
        roadMeters: route.distance,
        durationSeconds: route.duration
      });
      setMetric("delivery-route-road-distance", presentation.distanceText);
      setMetric("delivery-route-eta", presentation.etaText);
      if (routeInfo) routeInfo.textContent = `${presentation.distanceText} remaining by road · estimated ${presentation.etaText}`;
      applyRoutePresentation(presentation, { roadAvailable: true });
      const bounds = window.L.latLngBounds([
        [rider.lat, rider.lon],
        [routeDestination.lat, routeDestination.lon]
      ]);
      if (coordinates.length) coordinates.forEach((point) => bounds.extend(point));
      routeMap.fitBounds(bounds.pad(0.12), { maxZoom: 17 });
    } catch (error) {
      console.error("[Dagoldol] road route failed:", error);
      if (routeInfo) routeInfo.textContent = "Road route unavailable right now; the live rider and customer pins are still shown.";
      setMetric("delivery-route-road-distance", "Unavailable");
      setMetric("delivery-route-eta", "Unavailable");
    }
  }

  function renderAdminAccountLocationMaps(root) {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    if (!scope || typeof scope.querySelectorAll !== "function") return 0;
    const previews = Array.from(scope.querySelectorAll("[data-customer-location-preview]"));
    let rendered = 0;

    previews.forEach((element) => {
      if (!element || accountPreviewMaps.has(element)) return;
      const lat = finiteNumber(element.dataset && element.dataset.lat);
      const lon = finiteNumber(element.dataset && element.dataset.lon);
      if (lat == null || lon == null) return;

      if (!window.L) {
        element.textContent = "Map preview unavailable. Use View customer location to open the saved coordinates.";
        element.classList.add("is-map-unavailable");
        return;
      }

      const map = window.L.map(element, {
        zoomControl: false,
        attributionControl: true,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        tap: false
      }).setView([lat, lon], 15);
      addBaseLayer(map);
      const marker = window.L.marker([lat, lon], {
        icon: markerIcon("destination"),
        title: "Customer saved delivery location"
      }).addTo(map);
      const label = String(element.dataset && element.dataset.label || "Customer location").trim();
      if (marker && typeof marker.bindPopup === "function") marker.bindPopup(escapeHtml(label));
      accountPreviewMaps.set(element, map);
      observeMapResize(element, map);
      rendered += 1;
      window.setTimeout(() => map.invalidateSize(), 30);
    });

    return rendered;
  }

  function ensureRouteMap() {
    const mapEl = byId("delivery-route-map");
    if (!mapEl || !window.L) return null;
    if (routeMap) {
      window.setTimeout(() => routeMap.invalidateSize(), 0);
      return routeMap;
    }
    routeMap = window.L.map(mapEl, { zoomControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    addBaseLayer(routeMap);
    observeMapResize(mapEl, routeMap);
    return routeMap;
  }

  function stopRouteWatch(userInitiated = false) {
    if (routeWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(routeWatchId);
    }
    routeWatchId = null;
    routeStoppedByUser = Boolean(userInitiated);
    if (userInitiated) {
      setMetric("delivery-route-state", "Tracking paused");
      setRouteStatus("Live GPS tracking is paused. The customer pin remains visible. Tap Refresh / reroute to resume.", "ok");
    }
  }

  function centerOnRider() {
    if (!routeMap || !lastRiderPosition) {
      setRouteStatus("Your live location is not available yet.", "working");
      return;
    }
    routeMap.setView([lastRiderPosition.lat, lastRiderPosition.lon], 17);
  }

  function startRouteWatch() {
    stopRouteWatch(false);
    routeStoppedByUser = false;
    if (!navigator.geolocation) {
      setMetric("delivery-route-state", "GPS unavailable");
      setRouteStatus("This device cannot provide live location. You can still open the customer pin in Maps.", "error");
      return;
    }

    setMetric("delivery-route-state", "Locating…");
    setRouteStatus("Getting your live delivery location…", "working");
    routeWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const rider = {
          lat: position.coords.latitude,
          lon: position.coords.longitude
        };
        if (!routeMap || routeStoppedByUser) return;

        if (!routeRiderMarker) {
          routeRiderMarker = window.L.marker([rider.lat, rider.lon], {
            icon: markerIcon("rider"),
            title: "Your live delivery position"
          }).addTo(routeMap);
        } else {
          routeRiderMarker.setLatLng([rider.lat, rider.lon]);
        }

        updateArrivalStatus(rider, position.coords.accuracy);
        refreshDrivingRoute(rider, !routePolyline);
      },
      (error) => {
        const message = error && error.code === 1
          ? "Location permission is required for live delivery navigation. Allow location access in the browser, or use Open in Maps."
          : "Your live position could not be updated. The customer's exact pin remains available.";
        setMetric("delivery-route-state", error && error.code === 1 ? "Permission needed" : "GPS unavailable");
        setRouteStatus(message, "error");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
  }

  function openAdminRoute(order) {
    const address = order && order.address ? order.address : {};
    const location = locationFromAddress(address);
    const modal = byId("delivery-route-modal");
    if (!modal || !location) return false;

    routeDestination = location;
    lastRoutePosition = null;
    lastRouteAt = 0;
    const orderLabel = byId("delivery-route-order");
    const addressLabel = byId("delivery-route-address");
    if (orderLabel) orderLabel.textContent = order.label || (order.id ? `Order ${order.id}` : "Customer delivery pin");
    if (addressLabel) {
      const addressParts = [address.address, address.city, address.postal].filter(Boolean);
      addressLabel.textContent = addressParts.join(", ") || location.displayName || `${location.lat}, ${location.lon}`;
    }

    const external = byId("delivery-open-external-map");
    if (external) {
      external.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${location.lat},${location.lon}`)}`;
    }

    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    const map = ensureRouteMap();
    if (map) {
      if (routeDestinationMarker) map.removeLayer(routeDestinationMarker);
      if (routeRiderMarker) {
        map.removeLayer(routeRiderMarker);
        routeRiderMarker = null;
      }
      if (routePolyline) {
        map.removeLayer(routePolyline);
        routePolyline = null;
      }
      routeDestinationMarker = window.L.marker([location.lat, location.lon], {
        icon: markerIcon("destination"),
        title: "Customer exact delivery pin"
      }).addTo(map);
      const destinationDetails = [
        `<strong>Customer delivery PIN</strong>`,
        address.landmark ? `Landmark: ${escapeHtml(address.landmark)}` : "",
        `${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}`
      ].filter(Boolean).join("<br>");
      if (routeDestinationMarker && typeof routeDestinationMarker.bindPopup === "function") {
        routeDestinationMarker.bindPopup(destinationDetails);
      }
      map.setView([location.lat, location.lon], PIN_ZOOM);
      window.setTimeout(() => map.invalidateSize(), 80);
    }

    setMetric("delivery-route-state", "Locating…");
    setMetric("delivery-route-proximity", "Locating…");
    setMetric("delivery-route-road-distance", "Waiting…");
    setMetric("delivery-route-eta", "Waiting…");
    setMetric("delivery-route-accuracy", "Waiting…");
    setMetric("delivery-route-updated", "Waiting…");
    const roadInfo = byId("delivery-route-road-info");
    if (roadInfo) roadInfo.textContent = "Road route will appear after your live location is available.";
    lastRiderPosition = null;
    startRouteWatch();

    const closeButton = byId("delivery-route-close");
    if (closeButton) closeButton.focus();
    return true;
  }

  function closeAdminRoute() {
    const modal = byId("delivery-route-modal");
    if (!modal) return;
    stopRouteWatch();
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function wireRouteModal() {
    const modal = byId("delivery-route-modal");
    const close = byId("delivery-route-close");
    const refresh = byId("delivery-route-refresh");
    const center = byId("delivery-route-center");
    const stop = byId("delivery-route-stop");
    if (close && !close.dataset.locationWired) {
      close.dataset.locationWired = "1";
      close.addEventListener("click", closeAdminRoute);
    }
    if (refresh && !refresh.dataset.locationWired) {
      refresh.dataset.locationWired = "1";
      refresh.addEventListener("click", () => {
        lastRouteAt = 0;
        lastRoutePosition = null;
        startRouteWatch();
      });
    }
    if (center && !center.dataset.locationWired) {
      center.dataset.locationWired = "1";
      center.addEventListener("click", centerOnRider);
    }
    if (stop && !stop.dataset.locationWired) {
      stop.dataset.locationWired = "1";
      stop.addEventListener("click", () => stopRouteWatch(true));
    }
    if (modal && !modal.dataset.locationWired) {
      modal.dataset.locationWired = "1";
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeAdminRoute();
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal && !modal.classList.contains("hidden")) closeAdminRoute();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireRouteModal();
    if (byId("delivery-pin-map")) initCheckout();
  });

  window.DagoldolDeliveryLocation = Object.freeze({
    initCheckout,
    loadSavedLocation,
    resetCheckout,
    getSelectedLocation,
    getConfirmedLocation,
    locationFromAddress,
    resolveAccountLocation,
    getProximityState,
    buildRoutePresentation,
    renderAdminAccountLocationMaps,
    openAdminRoute,
    closeAdminRoute
  });
})();
