(function(){
function reportBootstrapFailure(message){
  console.error(`[Dagoldol] ${message}`);
  const banner = document.getElementById("global-error-banner");
  const text = document.getElementById("global-error-banner-text");
  if (banner && text) {
    text.textContent = message;
    banner.classList.remove("hidden");
  }
}

if (!window.supabase || typeof window.supabase.createClient !== "function") {
  reportBootstrapFailure("The shop could not start because the Supabase client library did not load. Check your connection and refresh the page.");
  return;
}

if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
  reportBootstrapFailure("The shop could not start because its public Supabase configuration is missing.");
  return;
}

if (!window.DAGOLDOL_AUTH_RESILIENCE || typeof window.DAGOLDOL_AUTH_RESILIENCE.createResilientSupabaseFetch !== "function") {
  reportBootstrapFailure("The shop could not start because its account resilience module did not load. Refresh the page and try again.");
  return;
}

const {
  createResilientSupabaseFetch,
  describeAuthError
} = window.DAGOLDOL_AUTH_RESILIENCE;

const resilientSupabaseFetch = createResilientSupabaseFetch({
  nativeFetch: window.fetch.bind(window),
  supabaseOrigin: new URL(window.SUPABASE_URL).origin,
  proxyPrefix: "/api/supabase",
  onFallback: ({ originalUrl }) => {
    let path = "Supabase request";
    try { path = new URL(originalUrl).pathname; } catch (_) {}
    console.warn(`[Dagoldol] Direct ${path} request failed; retrying through the same-origin Vercel fallback.`);
  }
});

const supabase = window.supabase.createClient(
  window.SUPABASE_URL,
  window.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    },
    global: {
      fetch: resilientSupabaseFetch
    }
  }
);

window.addEventListener("error", (e) => {
  console.error("[Dagoldol] Uncaught script error:", e.message, "at", (e.filename || "?") + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[Dagoldol] Unhandled promise rejection:", e.reason);
});

const OWNER_EMAIL = "angelmclorenzdagoldol@gmail.com";
const DOCUMENT_TITLE_BASE = "Dagoldol Trading Co. | Fine Everyday Goods";

const APP_ROUTES = Object.freeze({
  SHOP: "/",
  CHECKOUT: "/checkout",
  ORDERS: "/account/orders",
  ADMIN: "/admin"
});

const CHECKOUT_DRAFT_STORAGE_KEY = "dagoldol_checkout_draft_v1";

function normalizeAppPath(pathname = window.location.pathname){
  let path = String(pathname || "/").replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

function navigateAppPath(path, { replace = false } = {}){
  const normalized = normalizeAppPath(path);
  const current = normalizeAppPath();
  if (current === normalized && !window.location.search && !window.location.hash) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", normalized);
  updateDocumentTitleUnread(unreadChatCount || 0);
}

const BULK_TIER_1_MIN_QTY = 250;
const BULK_TIER_1_RATE = 0.05;
const BULK_TIER_2_MIN_QTY = 256;
const BULK_TIER_2_RATE = 0.02;

const LOW_STOCK_THRESHOLD = 10;

const DEFAULT_GCASH_NUMBER = "0963 202 0564";
const DEFAULT_BANK_NAME = "BDO Unibank";
const DEFAULT_BANK_ACCOUNT_NAME = "Dagoldol Trading Co.";
const DEFAULT_BANK_ACCOUNT_NUMBER = "0012 3456 7890";
const DEFAULT_DELIVERY_ORIGIN_ADDRESS = "Davao-Bukidnon Hwy, Sitio Pamuhatan, Marilog District, Davao City, Davao del Sur, 8000, Philippines";
const DEFAULT_DELIVERY_ORIGIN_LATITUDE = 7.2777;
const DEFAULT_DELIVERY_ORIGIN_LONGITUDE = 125.3245;

let currentSettings = {
  gcash_number: DEFAULT_GCASH_NUMBER,
  gcash_qr_image: null,
  bank_name: DEFAULT_BANK_NAME,
  bank_account_name: DEFAULT_BANK_ACCOUNT_NAME,
  bank_account_number: DEFAULT_BANK_ACCOUNT_NUMBER,
  bank_qr_image: null,
  shop_logo_image: null,
  delivery_origin_address: DEFAULT_DELIVERY_ORIGIN_ADDRESS,
  delivery_origin_latitude: DEFAULT_DELIVERY_ORIGIN_LATITUDE,
  delivery_origin_longitude: DEFAULT_DELIVERY_ORIGIN_LONGITUDE
};

// Same-origin public catalogue snapshot generated at deploy time.
// It is a resilience layer for browsers/networks that temporarily fail direct
// Supabase REST reads. Checkout stock verification never trusts this snapshot.
let catalogueSnapshotPromise = null;
let catalogueUsingSnapshot = false;
let catalogueHydrationPromise = null;

function shouldUseFastMobileBootstrap(){
  const viewportWidth = Number(window.innerWidth) || Number(document.documentElement?.clientWidth) || 1024;
  const touchCapable = (Number(navigator.maxTouchPoints) || 0) > 0;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches === true;
  const noHover = window.matchMedia?.("(hover: none)")?.matches === true;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  const saveData = connection?.saveData === true;
  const effectiveType = String(connection?.effectiveType || "").toLowerCase();
  const slowNetwork = saveData || effectiveType === "slow-2g" || effectiveType === "2g" || effectiveType === "3g";

  return slowNetwork || (viewportWidth <= 720 && (touchCapable || coarsePointer || noHover));
}

async function loadCatalogueSnapshot(){
  if (catalogueSnapshotPromise) return catalogueSnapshotPromise;

  catalogueSnapshotPromise = (async () => {
    try {
      const response = await fetch("/catalogue-snapshot.json", {
        cache: "default",
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
      const payload = await response.json();
      return payload && typeof payload === "object" ? payload : null;
    } catch (error) {
      console.warn("[Dagoldol] Same-origin catalogue snapshot unavailable:", error);
      return null;
    }
  })();

  return catalogueSnapshotPromise;
}

async function replaceEmbeddedProductImagesFromSnapshot(mappedProducts){
  const hasEmbeddedImages = (mappedProducts || []).some(product =>
    (product.sizes || []).some(size => typeof size.image === "string" && size.image.startsWith("data:image/"))
  );
  if (!hasEmbeddedImages) return mappedProducts;

  const snapshot = await loadCatalogueSnapshot();
  if (!Array.isArray(snapshot?.products)) return mappedProducts;

  const replacementByVariant = new Map();
  snapshot.products.forEach(row => {
    const productId = String(row?.id ?? "");
    (Array.isArray(row?.sizes) ? row.sizes : []).forEach(size => {
      const image = typeof size?.image === "string" ? size.image : "";
      if (!image || image.startsWith("data:image/")) return;
      replacementByVariant.set(`${productId}::${String(size.feet)}`, image);
    });
  });

  if (!replacementByVariant.size) return mappedProducts;

  return mappedProducts.map(product => ({
    ...product,
    sizes: (product.sizes || []).map(size => {
      if (typeof size.image !== "string" || !size.image.startsWith("data:image/")) return size;
      const replacement = replacementByVariant.get(`${String(product.id)}::${String(size.feet)}`);
      return replacement ? { ...size, image: replacement } : size;
    })
  }));
}

function settingsFromRows(rows){
  const map = {};
  (rows || []).forEach(row => {
    if (row && row.key != null) map[row.key] = row.value;
  });
  return {
    gcash_number: map.gcash_number || DEFAULT_GCASH_NUMBER,
    gcash_qr_image: map.gcash_qr_image || null,
    bank_name: map.bank_name || DEFAULT_BANK_NAME,
    bank_account_name: map.bank_account_name || DEFAULT_BANK_ACCOUNT_NAME,
    bank_account_number: map.bank_account_number || DEFAULT_BANK_ACCOUNT_NUMBER,
    bank_qr_image: map.bank_qr_image || null,
    shop_logo_image: map.shop_logo_image || null,
    delivery_origin_address: map.delivery_origin_address || DEFAULT_DELIVERY_ORIGIN_ADDRESS,
    delivery_origin_latitude: Number(map.delivery_origin_latitude || DEFAULT_DELIVERY_ORIGIN_LATITUDE),
    delivery_origin_longitude: Number(map.delivery_origin_longitude || DEFAULT_DELIVERY_ORIGIN_LONGITUDE)
  };
}

async function primeSettingsFromSnapshot(){
  const snapshot = await loadCatalogueSnapshot();
  if (!Array.isArray(snapshot?.settings)) {
    applySettingsToDom();
    return false;
  }

  currentSettings = settingsFromRows(snapshot.settings);
  shopOriginCoords = null;
  applySettingsToDom();
  return true;
}

async function refreshSettingsLive({ reportError = false } = {}){
  try {
    const { data, error } = await supabase.from("settings").select("*");
    if (error) throw error;
    currentSettings = settingsFromRows(data || []);
    shopOriginCoords = null;
    applySettingsToDom();
    return true;
  } catch (error) {
    console.warn("[Dagoldol] Live settings read failed:", error);
    if (reportError) reportLoadError("Settings", error);
    return false;
  }
}

async function loadSettings(){
  const liveLoaded = await refreshSettingsLive();
  if (liveLoaded) return;

  const snapshotLoaded = await primeSettingsFromSnapshot();
  if (!snapshotLoaded) {
    console.error("[Dagoldol] Settings are unavailable from both live Supabase and the deploy snapshot.");
  }
}

async function saveSetting(key, value){
  const { error } = await supabase.from("settings").upsert({ key, value });
  if (error) console.error(`[Dagoldol] Could not save setting "${key}":`, error);
  return error || null;
}

function applySettingsToDom(){
  const numberEl = document.getElementById("gcash-number-text");
  if (numberEl) numberEl.textContent = currentSettings.gcash_number;

  const imgEl = document.getElementById("gcash-qr-img");
  const placeholderEl = document.getElementById("gcash-qr-placeholder");
  if (imgEl && placeholderEl) {
    if (currentSettings.gcash_qr_image) {
      imgEl.src = currentSettings.gcash_qr_image;
      imgEl.classList.remove("hidden");
      imgEl.classList.add("zoomable-img");
      placeholderEl.classList.add("hidden");
    } else {
      imgEl.removeAttribute("src");
      imgEl.classList.add("hidden");
      imgEl.classList.remove("zoomable-img");
      placeholderEl.classList.remove("hidden");
    }
  }

  const bankNameEl = document.getElementById("bank-name-text");
  const bankAccountNameEl = document.getElementById("bank-account-name-text");
  const bankAccountNumberEl = document.getElementById("bank-account-number-text");
  if (bankNameEl) bankNameEl.textContent = currentSettings.bank_name;
  if (bankAccountNameEl) bankAccountNameEl.textContent = currentSettings.bank_account_name;
  if (bankAccountNumberEl) bankAccountNumberEl.textContent = currentSettings.bank_account_number;

  const bankQrImgEl = document.getElementById("bank-qr-img");
  const bankQrPlaceholderEl = document.getElementById("bank-qr-placeholder");
  if (bankQrImgEl && bankQrPlaceholderEl) {
    if (currentSettings.bank_qr_image) {
      bankQrImgEl.src = currentSettings.bank_qr_image;
      bankQrImgEl.classList.remove("hidden");
      bankQrImgEl.classList.add("zoomable-img");
      bankQrPlaceholderEl.classList.add("hidden");
    } else {
      bankQrImgEl.removeAttribute("src");
      bankQrImgEl.classList.add("hidden");
      bankQrImgEl.classList.remove("zoomable-img");
      bankQrPlaceholderEl.classList.remove("hidden");
    }
  }

  applyBrandLogoToDom();
}

// ===================== Uploadable shop logo (header brand mark) =====================
function applyBrandLogoToDom(){
  const logoImgEls = document.querySelectorAll(".brand-logo-img");
  const logoSvgEls = document.querySelectorAll(".brand-logo-svg");
  const hasLogo = !!currentSettings.shop_logo_image;
  logoImgEls.forEach(el => {
    if (hasLogo) {
      el.src = currentSettings.shop_logo_image;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
      el.removeAttribute("src");
    }
  });
  logoSvgEls.forEach(el => {
    el.classList.toggle("hidden", hasLogo);
  });
}

const SHOP_ORIGIN_ADDRESS = DEFAULT_DELIVERY_ORIGIN_ADDRESS;
const SHOP_ORIGIN_FALLBACK_COORDS = { lat: DEFAULT_DELIVERY_ORIGIN_LATITUDE, lon: DEFAULT_DELIVERY_ORIGIN_LONGITUDE };

const FREE_ZONE_ADDRESSES = [
  "Katipunan National High School, Katipunan, Arakan, Cotabato, Philippines",
  "Kimasog, Marilog District, Davao City, Davao del Sur, Philippines"
];
let freeZoneCoordsCache = null;

async function getFreeZoneCoords(){
  if (freeZoneCoordsCache) return freeZoneCoordsCache;
  const results = await Promise.all(FREE_ZONE_ADDRESSES.map(addr => geocodeAddress(addr)));
  freeZoneCoordsCache = results.filter(Boolean);
  return freeZoneCoordsCache;
}

const DELIVERY_FREE_KM_THRESHOLD = 5;
const DELIVERY_RATE_PER_KM = 60;
const DELIVERY_FALLBACK_FEE = 600;
const DELIVERY_ESTIMATE_MIN_DAYS = 3;
const DELIVERY_ESTIMATE_MAX_DAYS = 6;

let shopOriginCoords = null;

function getConfiguredDeliveryOrigin(){
  const lat = Number(currentSettings.delivery_origin_latitude);
  const lon = Number(currentSettings.delivery_origin_longitude);
  const isValid = Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= 4 && lat <= 21.5 && lon >= 116 && lon <= 127.5;
  if (!isValid) return null;
  return {
    lat,
    lon,
    address: cleanAddressValue(currentSettings.delivery_origin_address) || SHOP_ORIGIN_ADDRESS
  };
}

async function getShopOriginCoords(){
  if (shopOriginCoords) return shopOriginCoords;

  const configured = getConfiguredDeliveryOrigin();
  if (configured) {
    shopOriginCoords = { lat: configured.lat, lon: configured.lon };
    return shopOriginCoords;
  }

  const geocoded = await geocodeAddress(SHOP_ORIGIN_ADDRESS);
  shopOriginCoords = geocoded || SHOP_ORIGIN_FALLBACK_COORDS;
  return shopOriginCoords;
}

async function calculateDeliveryFeeForCoords(destCoords){
  if (!destCoords || !Number.isFinite(Number(destCoords.lat)) || !Number.isFinite(Number(destCoords.lon))) {
    return { fee: DELIVERY_FALLBACK_FEE, km: null };
  }

  const origin = await getShopOriginCoords();
  const km = await getRoadDistanceKm(origin, { lat: Number(destCoords.lat), lon: Number(destCoords.lon) });
  if (km == null) return { fee: DELIVERY_FALLBACK_FEE, km: null };

  if (km <= DELIVERY_FREE_KM_THRESHOLD) return { fee: 0, km };

  const freeZones = await getFreeZoneCoords();
  for (const fz of freeZones) {
    const fzKm = await getRoadDistanceKm(fz, { lat: Number(destCoords.lat), lon: Number(destCoords.lon) });
    if (fzKm != null && fzKm <= DELIVERY_FREE_KM_THRESHOLD) {
      return { fee: 0, km };
    }
  }

  return { fee: DELIVERY_RATE_PER_KM * km, km };
}

async function calculateDeliveryFee(addressStr){
  const destCoords = await geocodeAddress(addressStr);
  if (!destCoords) return { fee: DELIVERY_FALLBACK_FEE, km: null };
  return calculateDeliveryFeeForCoords(destCoords);
}

// ===================== Measurement types (feet / size / sqm) =====================
const FEET_OPTIONS = [2, 4, 6, 8, 10, 12, 13, 14, 15];
const SIZE_OPTIONS = ["XS", "S", "M", "L", "XL", "XXL"];
const SQM_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20];
const UNIT_TYPE_LABELS = { feet: "Feet (length)", size: "Size (S / M / L…)", sqm: "Square Meters (sqm)" };

function optionsForUnitType(unitType){
  if (unitType === "size") return SIZE_OPTIONS;
  if (unitType === "sqm") return SQM_OPTIONS;
  return FEET_OPTIONS;
}

function formatUnitValue(unitType, value){
  if (unitType === "size") return `${value}`;
  if (unitType === "sqm") return `${value} sqm`;
  return `${value} ft`;
}

function sortSizesByUnit(sizes, unitType){
  const copy = (sizes || []).slice();
  if (unitType === "size") {
    copy.sort((a, b) => SIZE_OPTIONS.indexOf(a.feet) - SIZE_OPTIONS.indexOf(b.feet));
  } else {
    copy.sort((a, b) => Number(a.feet) - Number(b.feet));
  }
  return copy;
}

function getBulkFeeRate(totalQty){
  if (totalQty >= BULK_TIER_2_MIN_QTY) return BULK_TIER_2_RATE;
  if (totalQty >= BULK_TIER_1_MIN_QTY) return BULK_TIER_1_RATE;
  return 0;
}

// ===================== Session state =====================
let currentUser = null;
let currentUserId = null;
let currentUserProfile = null;
let products = [];
let brands = [];
let flashSales = [];
let promoCodes = [];
let bundles = [];
let myOrdersCache = [];
let adminOrdersCache = [];

let currentDeliveryFee = DELIVERY_FALLBACK_FEE;
let currentDeliveryKm = null;
let deliveryRecalcToken = 0;
let deliveryDebounceTimer = null;

let appliedPromo = null;

let pendingQrDataUrl = undefined;
let pendingBankQrDataUrl = undefined;
let pendingLogoDataUrl = undefined;

let pendingPaymentProofPath = null;

const GENERIC_ICON = `<circle cx="24" cy="24" r="14" fill="none" stroke="currentColor" stroke-width="2"/><path d="M18 24 h12 M24 18 v12" stroke="currentColor" stroke-width="2"/>`;

// ===================== Data mapping helpers =====================
function mapProductRow(row){
  const unitType = row.unit_type || "feet";
  const sizes = Array.isArray(row.sizes) ? row.sizes.slice() : [];
  const sorted = sortSizesByUnit(sizes, unitType);
  return { id: row.id, name: row.name, desc: row.description, accent: row.accent, icon: row.icon, sizes: sorted, brandId: row.brand_id || null, unitType };
}

function mapBrandRow(row){
  return { id: row.id, name: row.name, logo: row.logo || null, description: row.description || "" };
}

function mapFlashSaleRow(row){
  return {
    id: row.id,
    productId: row.product_id,
    discountPercent: Number(row.discount_percent) || 0,
    startAt: Number(row.start_at),
    endAt: Number(row.end_at),
    active: !!row.active,
    label: row.label || "Flash Sale"
  };
}

function mapPromoRow(row){
  return {
    id: row.id,
    code: row.code,
    kind: row.kind || "coupon",
    discountType: row.discount_type,
    value: Number(row.value) || 0,
    minSpend: Number(row.min_spend) || 0,
    maxUses: row.max_uses == null ? null : Number(row.max_uses),
    usedCount: Number(row.used_count) || 0,
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    active: !!row.active
  };
}

function mapBundleRow(row){
  return {
    id: row.id,
    name: row.name,
    desc: row.description,
    accent: row.accent,
    icon: row.icon,
    items: Array.isArray(row.items) ? row.items : [],
    bundlePrice: Number(row.bundle_price) || 0,
    active: row.active !== false
  };
}

function mapOrderRow(row){
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    items: row.items,
    subtotal: row.subtotal,
    deliveryFee: row.delivery_fee,
    bulkFeeRate: row.bulk_fee_rate,
    bulkFee: row.bulk_fee,
    promoCode: row.promo_code || null,
    promoDiscount: row.promo_discount || 0,
    total: row.total,
    paymentMethod: row.payment_method,
    paymentReference: row.payment_reference || "",
    paymentProof: row.payment_proof || null,
    paymentProofDisplayUrl: null,
    halfPayment: !!row.half_payment,
    amountDueNow: row.amount_due_now != null ? row.amount_due_now : row.total,
    amountDueLater: row.amount_due_later || 0,
    address: row.address,
    placedAt: row.placed_at,
    deliveryDays: row.delivery_days,
    statusOverride: row.status_override,
    cancelled: row.cancelled,
    rated: row.rated || {}
  };
}

// ===================== Elements: login / signup =====================
const loginForm = document.getElementById("login-form");
const loginEmailInput = document.getElementById("login-email");
const passwordInput = document.getElementById("password");
const errorMessage = document.getElementById("error-message");
const loginSuccess = document.getElementById("login-success");

const loginCard = document.getElementById("login-card");
const signupCard = document.getElementById("signup-card");
const showSignupBtn = document.getElementById("show-signup");
const showLoginBtn = document.getElementById("show-login");

const signupForm = document.getElementById("signup-form");
const signupEmailInput = document.getElementById("signup-email");
const signupUsernameInput = document.getElementById("signup-username");
const signupPasswordInput = document.getElementById("signup-password");
const signupConfirmInput = document.getElementById("signup-confirm");
const signupError = document.getElementById("signup-error");

const loginScreen = document.getElementById("login-screen");
const shopScreen = document.getElementById("shop-screen");
const adminScreen = document.getElementById("admin-screen");
const adminWelcomeName = document.getElementById("admin-welcome-name");
const logoutBtn = document.getElementById("logout-btn");
const adminLogoutBtn = document.getElementById("admin-logout-btn");
const catalogue = document.getElementById("catalogue");
const bundlesSection = document.getElementById("bundles-section");
const bundlesList = document.getElementById("bundles-list");
const loginGateMessageEl = document.getElementById("login-gate-message");
const loginBackBtn = document.getElementById("login-back-btn");
const signupBackBtn = document.getElementById("signup-back-btn");


// ===================== FIX #12: global error banner =====================
let errorBannerTimer = null;
function showErrorBanner(message){
  const banner = document.getElementById("global-error-banner");
  const textEl = document.getElementById("global-error-banner-text");
  if (!banner || !textEl) { console.error("[Dagoldol]", message); return; }
  textEl.textContent = message;
  banner.classList.remove("hidden");
  clearTimeout(errorBannerTimer);
  errorBannerTimer = setTimeout(() => banner.classList.add("hidden"), 9000);
}
function hideErrorBanner(){
  const banner = document.getElementById("global-error-banner");
  if (banner) banner.classList.add("hidden");
  clearTimeout(errorBannerTimer);
}
(function wireErrorBannerClose(){
  const closeBtn = document.getElementById("global-error-banner-close");
  if (closeBtn) closeBtn.addEventListener("click", hideErrorBanner);
})();
function reportLoadError(context, error){
  console.error(`[Dagoldol] ${context}:`, error);
  showErrorBanner(`Couldn't load ${context.toLowerCase()}. Please refresh, or try again in a moment.`);
}

// ===================== SECURITY FIX #5: honeypot helper =====================
function isHoneypotTripped(fieldId){
  const el = document.getElementById(fieldId);
  return !!(el && el.value && el.value.trim().length > 0);
}

// ===================== FIX #4: password strength =====================
const MIN_PASSWORD_LENGTH = 8;
function scorePasswordStrength(pw){
  let score = 0;
  if (!pw) return 0;
  if (pw.length >= MIN_PASSWORD_LENGTH) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return Math.min(score, 4);
}
function wirePasswordStrengthMeter(inputEl, fillEl, labelEl){
  if (!inputEl || !fillEl || !labelEl) return;
  const labels = ["Too short", "Weak", "Okay", "Good", "Strong"];
  const colors = ["#b8492f", "#b8492f", "#c9a25c", "#7a966e", "#7a966e"];
  inputEl.addEventListener("input", () => {
    const pw = inputEl.value;
    if (!pw) { fillEl.style.width = "0%"; labelEl.textContent = "Enter a password"; return; }
    const score = scorePasswordStrength(pw);
    const pct = pw.length < MIN_PASSWORD_LENGTH ? 15 : (score / 4) * 100;
    fillEl.style.width = `${pct}%`;
    fillEl.style.background = colors[score];
    labelEl.textContent = pw.length < MIN_PASSWORD_LENGTH ? `Too short (min ${MIN_PASSWORD_LENGTH})` : labels[score];
  });
}
wirePasswordStrengthMeter(document.getElementById("signup-password"), document.getElementById("signup-pw-strength-fill"), document.getElementById("signup-pw-strength-label"));
wirePasswordStrengthMeter(document.getElementById("reset-password"), document.getElementById("reset-pw-strength-fill"), document.getElementById("reset-pw-strength-label"));

// ===================== Show/hide password toggle =====================
function resetPasswordVisibility(input){
  if (!input) return;
  input.type = "password";
  const btn = document.querySelector(`.password-toggle-btn[data-target="${input.id}"]`);
  if (!btn) return;
  btn.textContent = "Show";
  btn.setAttribute("aria-label", "Show password");
}

document.querySelectorAll(".password-toggle-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    btn.textContent = isHidden ? "Hide" : "Show";
    btn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
  });
});

// ===================== FIX #7: Supabase Storage image upload helper =====================
async function uploadImageToStorage(file, bucket, pathPrefix, maxSize){
  const blob = await resizeImageToBlob(file, maxSize || 800);
  const fileName = `${pathPrefix}/${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.jpg`;
  const { error: uploadError } = await supabase.storage.from(bucket).upload(fileName, blob, {
    contentType: "image/jpeg",
    upsert: false
  });
  if (uploadError) {
    console.error(`[Dagoldol] Storage upload to "${bucket}" failed:`, uploadError);
    throw uploadError;
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(fileName);
  return data.publicUrl;
}

async function uploadPrivateImageToStorage(file, bucket, pathPrefix, maxSize){
  const blob = await resizeImageToBlob(file, maxSize || 800);
  const fileName = `${pathPrefix}/${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.jpg`;
  const { error: uploadError } = await supabase.storage.from(bucket).upload(fileName, blob, {
    contentType: "image/jpeg",
    upsert: false
  });
  if (uploadError) {
    console.error(`[Dagoldol] Private Storage upload to "${bucket}" failed:`, uploadError);
    throw uploadError;
  }
  return fileName;
}

async function createSignedStorageUrl(bucket, path, expiresInSeconds = 300){
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path; // Legacy public URLs remain readable during migration.
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error) {
    console.error(`[Dagoldol] Could not create signed URL for "${bucket}/${path}":`, error);
    return null;
  }
  return data && data.signedUrl ? data.signedUrl : null;
}

// ===================== Image lightbox (click-to-zoom) =====================
function openImageLightbox(src, caption){
  if (!src) return;
  let overlay = document.getElementById("image-lightbox-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "image-lightbox-overlay";
    overlay.className = "image-lightbox-overlay hidden";
    overlay.innerHTML = `
      <div class="image-lightbox-content">
        <button type="button" class="image-lightbox-close" id="image-lightbox-close" aria-label="Close">&times;</button>
        <img id="image-lightbox-img" src="" alt="Full size view">
        <p class="image-lightbox-caption" id="image-lightbox-caption"></p>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeImageLightbox();
    });
    document.getElementById("image-lightbox-close").addEventListener("click", closeImageLightbox);
  }
  document.getElementById("image-lightbox-img").src = src;
  document.getElementById("image-lightbox-caption").textContent = caption || "";
  overlay.classList.remove("hidden");
  document.addEventListener("keydown", lightboxEscHandler);
}
function closeImageLightbox(){
  const overlay = document.getElementById("image-lightbox-overlay");
  if (overlay) overlay.classList.add("hidden");
  document.removeEventListener("keydown", lightboxEscHandler);
}
function lightboxEscHandler(e){
  if (e.key === "Escape") closeImageLightbox();
}
document.addEventListener("click", (e) => {
  const img = e.target.closest(".zoomable-img");
  if (img && img.tagName === "IMG" && img.src) {
    openImageLightbox(img.src, img.alt || "");
  }
});

// ===================== Account menu =====================
const accountMenuToggle = document.getElementById("account-menu-toggle");
const accountMenuEl = document.getElementById("account-menu");
const accountMenuLabel = document.getElementById("account-menu-label");
const accountMenuWrap = document.querySelector(".account-menu-wrap");
const menuLoginBtn = document.getElementById("menu-login-btn");
const menuSignupBtn = document.getElementById("menu-signup-btn");
const accountMenuDividerGuest = document.getElementById("account-menu-divider-guest");
const accountMenuDividerLogout = document.getElementById("account-menu-divider-logout");

function closeAccountMenu(){
  if (!accountMenuEl) return;
  accountMenuEl.classList.add("hidden");
  if (accountMenuToggle) accountMenuToggle.setAttribute("aria-expanded", "false");
}

function toggleAccountMenu(){
  if (!accountMenuEl) return;
  const willOpen = accountMenuEl.classList.contains("hidden");
  accountMenuEl.classList.toggle("hidden", !willOpen);
  if (accountMenuToggle) accountMenuToggle.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) {
    const firstItem = accountMenuEl.querySelector(".account-menu-item:not(.hidden)");
    if (firstItem) firstItem.focus();
  }
}

if (accountMenuToggle && accountMenuEl) {
  accountMenuToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAccountMenu();
  });

  accountMenuEl.addEventListener("click", (e) => {
    if (e.target.closest("button, a")) closeAccountMenu();
  });

  accountMenuEl.addEventListener("keydown", (e) => {
    const items = Array.from(accountMenuEl.querySelectorAll('[role="menuitem"]'))
      .filter(item => !item.classList.contains("hidden") && !item.hasAttribute("disabled"));
    if (!items.length) return;

    const currentIndex = Math.max(0, items.indexOf(document.activeElement));
    let nextIndex = -1;
    if (e.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    else if (e.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = items.length - 1;

    if (nextIndex >= 0) {
      e.preventDefault();
      items[nextIndex].focus();
    }
  });

  document.addEventListener("click", (e) => {
    if (accountMenuEl.classList.contains("hidden")) return;
    if (accountMenuWrap.contains(e.target)) return;
    closeAccountMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !accountMenuEl.classList.contains("hidden")) {
      closeAccountMenu();
      accountMenuToggle.focus();
    }
  });
}

function setHeaderGuestState(){
  menuLoginBtn.classList.remove("hidden");
  menuSignupBtn.classList.remove("hidden");
  accountMenuDividerGuest.classList.remove("hidden");
  ordersBtn.classList.add("hidden");
  profileBtn.classList.add("hidden");
  chatBtn.classList.add("hidden");
  accountMenuDividerLogout.classList.add("hidden");
  logoutBtn.classList.add("hidden");
  accountMenuLabel.textContent = "Account";
  renderAvatar(headerAvatar, null, "?");
  if (chatCountBadge) chatCountBadge.classList.add("hidden");
}

function setHeaderCustomerState(displayName, avatarUrl){
  menuLoginBtn.classList.add("hidden");
  menuSignupBtn.classList.add("hidden");
  accountMenuDividerGuest.classList.add("hidden");
  ordersBtn.classList.remove("hidden");
  profileBtn.classList.remove("hidden");
  chatBtn.classList.remove("hidden");
  accountMenuDividerLogout.classList.remove("hidden");
  logoutBtn.classList.remove("hidden");
  accountMenuLabel.textContent = displayName;
  renderAvatar(headerAvatar, avatarUrl || null, displayName);
}

// ===================== Login gate =====================
let pendingLoginIntent = null;

function showLoginGate(message){
  shopScreen.classList.add("hidden");
  adminScreen.classList.add("hidden");
  hideCustomerRouteScreens();
  loginScreen.classList.remove("hidden");
  showLoginCard();
  if (message) {
    loginGateMessageEl.textContent = message;
    loginGateMessageEl.classList.remove("hidden");
  } else {
    loginGateMessageEl.classList.add("hidden");
  }
  loginEmailInput.focus();
}

function requireLogin(intentFn, message){
  if (currentUserId) { intentFn(); return; }
  pendingLoginIntent = intentFn;
  showLoginGate(message);
}

async function exitLoginScreenToGuestShop(){
  pendingLoginIntent = null;
  loginGateMessageEl.classList.add("hidden");
  loginScreen.classList.add("hidden");
  navigateAppPath(APP_ROUTES.SHOP, { replace: true });
  await enterGuestShop({ applyRoute: false });
}

if (loginBackBtn) loginBackBtn.addEventListener("click", exitLoginScreenToGuestShop);
if (signupBackBtn) signupBackBtn.addEventListener("click", exitLoginScreenToGuestShop);
if (menuLoginBtn) menuLoginBtn.addEventListener("click", () => showLoginGate(null));
if (menuSignupBtn) menuSignupBtn.addEventListener("click", () => { showLoginGate(null); showSignupCard(); });

// ===================== Guest cart (localStorage) =====================
const GUEST_CART_STORAGE_KEY = "dagoldol_guest_cart";

function getGuestCart(){
  try {
    const raw = localStorage.getItem(GUEST_CART_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("[Dagoldol] Could not read guest cart:", err);
    return [];
  }
}

function saveGuestCart(cart){
  try {
    localStorage.setItem(GUEST_CART_STORAGE_KEY, JSON.stringify(cart));
  } catch (err) {
    console.error("[Dagoldol] Could not save guest cart:", err);
  }
}

function clearGuestCart(){
  try { localStorage.removeItem(GUEST_CART_STORAGE_KEY); } catch (err) { /* ignore */ }
}

function cartLineKey(item){
  return item.isBundle ? `bundle:${item.bundleId}` : `product:${item.productId}:${item.feet}`;
}

function mergeCarts(profileCart, guestCart){
  const merged = (profileCart || []).map(item => ({ ...item }));
  guestCart.forEach(gItem => {
    const key = cartLineKey(gItem);
    const existing = merged.find(m => cartLineKey(m) === key);
    if (existing) {
      existing.qty = clampQty(existing.qty + gItem.qty);
    } else {
      merged.push({ ...gItem });
    }
  });
  return merged;
}

async function mergeGuestCartIntoProfile(){
  const guestCart = getGuestCart();
  if (!guestCart.length) return;
  const merged = mergeCarts(currentUserProfile.cart || [], guestCart);
  currentUserProfile.cart = merged;
  const { error } = await supabase.from("profiles").update({ cart: merged }).eq("id", currentUserId);
  if (error) console.error("[Dagoldol] Could not merge guest cart into profile:", error);
  clearGuestCart();
}

// ===================== Elements: size select modal =====================
const sizeModal = document.getElementById("size-modal");
const sizeModalClose = document.getElementById("size-modal-close");
const sizeModalProductName = document.getElementById("size-modal-product-name");
const sizeModalPhoto = document.getElementById("size-modal-photo");
const sizeOptionsEl = document.getElementById("size-options");
const sizeModalQtyInput = document.getElementById("size-modal-qty");
const sizeModalError = document.getElementById("size-modal-error");
const sizeModalConfirmBtn = document.getElementById("size-modal-confirm");

// ===================== Elements: checkout route =====================
const checkoutScreen = document.getElementById("checkout-screen");
const checkoutBackBtn = document.getElementById("checkout-back-btn");
const orderForm = document.getElementById("order-form");
const orderNameInput = document.getElementById("order-name");
const orderPhoneInput = document.getElementById("order-phone");
const orderAddressInput = document.getElementById("order-address");
const orderCityInput = document.getElementById("order-city");
const orderPostalInput = document.getElementById("order-postal");
const orderLandmarkInput = document.getElementById("order-landmark");
const orderSaveCheckbox = document.getElementById("order-save");
const orderHalfPaymentCheckbox = document.getElementById("order-half-payment");
const orderError = document.getElementById("order-error");
const deliveryStatusEl = document.getElementById("delivery-distance-status");
const checkoutLocationOpenBtn = document.getElementById("checkout-location-open");
const checkoutLocationCurrentEl = document.getElementById("checkout-location-current");

const orderPromoCodeInput = document.getElementById("order-promo-code");
const orderPromoApplyBtn = document.getElementById("order-promo-apply");
const promoStatusEl = document.getElementById("promo-status");

const paymentDetailGcash = document.getElementById("payment-detail-gcash");
const paymentDetailBank = document.getElementById("payment-detail-bank");
const costSubtotalEl = document.getElementById("cost-subtotal");
const costPromoRow = document.getElementById("cost-promo-row");
const costPromoLabel = document.getElementById("cost-promo-label");
const costPromoEl = document.getElementById("cost-promo");
const costDeliveryEl = document.getElementById("cost-delivery");
const costBulkRow = document.getElementById("cost-bulk-row");
const costBulkLabel = document.getElementById("cost-bulk-label");
const costBulkEl = document.getElementById("cost-bulk");
const costTotalEl = document.getElementById("cost-total");
const costDueNowRow = document.getElementById("cost-due-now-row");
const costDueNowEl = document.getElementById("cost-due-now");
const costDueLaterRow = document.getElementById("cost-due-later-row");
const costDueLaterEl = document.getElementById("cost-due-later");

const orderPaymentRefInput = document.getElementById("order-payment-ref");
const orderPaymentProofInput = document.getElementById("order-payment-proof-input");
const paymentProofPreview = document.getElementById("payment-proof-preview");
const orderPaymentProofRemoveBtn = document.getElementById("order-payment-proof-remove");

// ===================== Elements: cart =====================
const cartBtn = document.getElementById("cart-btn");
const cartCountBadge = document.getElementById("cart-count");
const cartModal = document.getElementById("cart-modal");
const cartModalClose = document.getElementById("cart-modal-close");
const cartItemsList = document.getElementById("cart-items-list");
const cartTotalEl = document.getElementById("cart-total");
const cartCheckoutBtn = document.getElementById("cart-checkout-btn");
const modalItemsList = document.getElementById("modal-items-list");

// ===================== Elements: orders / tracking route =====================
const ordersBtn = document.getElementById("orders-btn");
const ordersScreen = document.getElementById("orders-screen");
const ordersBackBtn = document.getElementById("orders-back-btn");
const ordersList = document.getElementById("orders-list");
const ordersLoadMoreBtn = document.getElementById("orders-load-more-btn");

// ===================== Elements: profile =====================
const profileBtn = document.getElementById("profile-btn");
const profileModal = document.getElementById("profile-modal");
const profileModalClose = document.getElementById("profile-modal-close");
const profileForm = document.getElementById("profile-form");
const profileUsernameDisplay = document.getElementById("profile-username-display");
const profileNameInput = document.getElementById("profile-name");
const profileEmailInput = document.getElementById("profile-email");
const profilePhoneInput = document.getElementById("profile-phone");
const profileBioInput = document.getElementById("profile-bio");
const profileSuccess = document.getElementById("profile-success");
const profileError = document.getElementById("profile-error");
const profileAvatarInput = document.getElementById("profile-avatar-input");
const profileAvatarPreview = document.getElementById("profile-avatar-preview");
const profileAvatarRemoveBtn = document.getElementById("profile-avatar-remove");
const profileAvatarUploadStatus = document.getElementById("profile-avatar-upload-status");
const headerAvatar = document.getElementById("header-avatar");
const profileAddressInput = document.getElementById("profile-address");
const profileCityInput = document.getElementById("profile-city");
const profilePostalInput = document.getElementById("profile-postal");
const profileLandmarkInput = document.getElementById("profile-landmark");
const profileLocationOpenBtn = document.getElementById("profile-location-open");
const profileLocationCurrentEl = document.getElementById("profile-location-current");

// ===================== Elements: delivery location map =====================
const deliveryMapModal = document.getElementById("delivery-map-modal");
const deliveryMapCloseBtn = document.getElementById("delivery-map-close");
const deliveryMapCancelBtn = document.getElementById("delivery-map-cancel");
const deliveryMapConfirmBtn = document.getElementById("delivery-map-confirm");
const deliveryMapCurrentLocationBtn = document.getElementById("delivery-map-current-location");
const deliveryMapCanvas = document.getElementById("delivery-map-canvas");
const deliveryMapLoading = document.getElementById("delivery-map-loading");
const deliveryMapStatus = document.getElementById("delivery-map-status");
const deliveryMapSummary = document.getElementById("delivery-map-summary");

// ===================== Elements: contact =====================
const contactBtn = document.getElementById("contact-btn");
const contactModal = document.getElementById("contact-modal");
const contactModalClose = document.getElementById("contact-modal-close");
const contactForm = document.getElementById("contact-form");
const contactNameInput = document.getElementById("contact-name");
const contactEmailInput = document.getElementById("contact-email");
const contactMessageInput = document.getElementById("contact-message");
const contactError = document.getElementById("contact-error");

let orderItems = [];
let orderItems_isCartCheckout = false;
let pendingAvatarUrl = undefined;

// ===================== Delivery location state =====================
let checkoutPinnedLocation = null;
let checkoutPinnedLocationStale = false;
let profilePinnedLocation = null;
let profilePinnedLocationStale = false;
let adminDeliveryOriginDraft = null;
let deliveryMapTarget = null;
let deliveryMapController = null;
let pendingDeliveryMapSelection = null;
let pendingCurrentLocationRequest = null;
let deliveryMapRequestToken = 0;
let deliveryMapModulePromise = null;

function cleanAddressValue(value){
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function getCheckoutAddressFields(){
  return {
    address: cleanAddressValue(orderAddressInput?.value),
    city: cleanAddressValue(orderCityInput?.value),
    postal: cleanAddressValue(orderPostalInput?.value)
  };
}

function getProfileAddressFields(){
  return {
    address: cleanAddressValue(profileAddressInput?.value),
    city: cleanAddressValue(profileCityInput?.value),
    postal: cleanAddressValue(profilePostalInput?.value)
  };
}

function normalizePinnedLocationValue(value, fallbackAddress = null){
  if (!value || typeof value !== "object") return null;
  const latitude = Number(value.latitude ?? value.lat);
  const longitude = Number(value.longitude ?? value.lon ?? value.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < 4 || latitude > 21.5 || longitude < 116 || longitude > 127.5) return null;

  const rawSnapshot = value.addressSnapshot || value.address_snapshot || fallbackAddress;
  const addressSnapshot = rawSnapshot ? {
    address: cleanAddressValue(rawSnapshot.address ?? rawSnapshot.street),
    city: cleanAddressValue(rawSnapshot.city),
    postal: cleanAddressValue(rawSnapshot.postal ?? rawSnapshot.postcode)
  } : null;

  return {
    latitude,
    longitude,
    source: cleanAddressValue(value.source) || "pin",
    pinnedAt: cleanAddressValue(value.pinnedAt ?? value.pinned_at) || null,
    addressSnapshot,
    address: value.address && typeof value.address === "object" ? {
      address: cleanAddressValue(value.address.address ?? value.address.street),
      city: cleanAddressValue(value.address.city),
      postal: cleanAddressValue(value.address.postal ?? value.address.postcode)
    } : null,
    displayName: cleanAddressValue(value.displayName)
  };
}

function pinnedLocationMatchesFields(location, fields){
  const normalized = normalizePinnedLocationValue(location, fields);
  if (!normalized || !normalized.addressSnapshot) return false;
  const normalize = (value) => cleanAddressValue(value).toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ");
  return normalize(normalized.addressSnapshot.address) === normalize(fields.address) &&
    normalize(normalized.addressSnapshot.city) === normalize(fields.city) &&
    normalize(normalized.addressSnapshot.postal) === normalize(fields.postal);
}

function serializePinnedLocation(location, fields, isStale = false){
  if (isStale) return null;
  const normalized = normalizePinnedLocationValue(location, fields);
  if (!normalized) return null;
  return {
    latitude: normalized.latitude,
    longitude: normalized.longitude,
    source: normalized.source || "pin",
    pinned_at: normalized.pinnedAt || new Date().toISOString(),
    address_snapshot: {
      address: cleanAddressValue(fields.address),
      city: cleanAddressValue(fields.city),
      postal: cleanAddressValue(fields.postal)
    }
  };
}

function renderPinnedLocationCard(cardEl, location, fields, isStale = false){
  if (!cardEl) return;
  const normalized = normalizePinnedLocationValue(location, fields);
  const title = cardEl.querySelector(".delivery-location-card-title");
  const copy = cardEl.querySelector(".delivery-location-card-copy");

  if (!normalized){
    cardEl.dataset.state = "empty";
    if (title) title.textContent = "No map pin selected";
    if (copy) copy.textContent = "You can still type the address manually.";
    return;
  }

  if (isStale){
    cardEl.dataset.state = "stale";
    if (title) title.textContent = "Address changed after pinning";
    if (copy) copy.textContent = "Open the map and confirm the pin again before we use it for routing.";
    return;
  }

  cardEl.dataset.state = "saved";
  if (title) title.textContent = "Exact delivery pin saved";
  if (copy) {
    const readable = [fields.address, fields.city, fields.postal].filter(Boolean).join(", ");
    copy.textContent = readable || `${normalized.latitude.toFixed(5)}, ${normalized.longitude.toFixed(5)}`;
  }
}

function loadDeliveryMapModule(){
  if (!deliveryMapModulePromise){
    const version = encodeURIComponent(window.DAGOLDOL_CONFIG?.ASSET_VERSION || "3.3.3");
    deliveryMapModulePromise = import(`./delivery-map.js?v=${version}`);
  }
  return deliveryMapModulePromise;
}

function hideCustomerRouteScreens(){
  if (checkoutScreen) checkoutScreen.classList.add("hidden");
  if (ordersScreen) ordersScreen.classList.add("hidden");
}

function showShopScreenOnly(){
  loginScreen.classList.add("hidden");
  adminScreen.classList.add("hidden");
  hideCustomerRouteScreens();
  shopScreen.classList.remove("hidden");
}

function showCustomerRouteScreen(screen){
  loginScreen.classList.add("hidden");
  adminScreen.classList.add("hidden");
  shopScreen.classList.add("hidden");
  hideCustomerRouteScreens();
  if (screen) screen.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function serializeCheckoutDraftItem(item){
  if (item && item.isBundle) {
    return { isBundle: true, bundleId: item.bundleId, qty: clampQty(item.qty) };
  }
  return {
    isBundle: false,
    productId: item.productId,
    feet: item.feet,
    qty: clampQty(item.qty)
  };
}

function saveCheckoutDraft(items, isCartCheckout){
  try {
    const safeItems = (items || []).filter(Boolean).map(serializeCheckoutDraftItem);
    sessionStorage.setItem(CHECKOUT_DRAFT_STORAGE_KEY, JSON.stringify({
      version: 1,
      isCartCheckout: Boolean(isCartCheckout),
      items: safeItems
    }));
  } catch (err) {
    console.warn("[Dagoldol] Could not persist checkout draft:", err);
  }
}

function readCheckoutDraft(){
  try {
    const raw = sessionStorage.getItem(CHECKOUT_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch (err) {
    console.warn("[Dagoldol] Could not read checkout draft:", err);
    return null;
  }
}

function clearCheckoutDraft(){
  try { sessionStorage.removeItem(CHECKOUT_DRAFT_STORAGE_KEY); } catch (err) { /* ignore */ }
}

function rebuildCheckoutItemsFromDraft(draft){
  if (!draft || !Array.isArray(draft.items)) return [];
  const rebuilt = [];

  for (const item of draft.items) {
    if (item && item.isBundle) {
      const bundle = findBundle(item.bundleId);
      if (bundle) rebuilt.push(buildBundleOrderLine(bundle, clampQty(item.qty)));
      continue;
    }

    const product = findProduct(item && item.productId);
    if (!product) continue;
    const entry = getSizeEntry(product, item.feet);
    if (!entry || isSizeOutOfStock(product, item.feet)) continue;
    const eff = effectivePriceForFeet(product, item.feet);
    rebuilt.push({
      productId: product.id,
      feet: item.feet,
      name: `${product.name} (${formatUnitValue(product.unitType, item.feet)})`,
      price: eff.price,
      qty: clampQty(item.qty)
    });
  }

  return rebuilt;
}

function buildCheckoutItemsFromCart(){
  return getCart().map(item => {
    const info = cartLineInfo(item);
    if (!info) return null;
    if (item.isBundle) {
      const bundle = findBundle(item.bundleId);
      return bundle ? buildBundleOrderLine(bundle, item.qty) : null;
    }
    return {
      productId: item.productId,
      feet: item.feet,
      name: `${info.name} (${info.meta})`,
      price: info.unitPrice,
      qty: item.qty
    };
  }).filter(Boolean);
}

function beginCheckout(items, isCartCheckout, loginMessage){
  const safeItems = (items || []).filter(Boolean);
  if (!safeItems.length) return;
  saveCheckoutDraft(safeItems, isCartCheckout);
  requireLogin(() => openOrderModal(safeItems, isCartCheckout), loginMessage);
}

function formatPrice(n){
  const num = Number(n) || 0;
  const rounded = Math.round(num * 100) / 100;
  const isWhole = Math.abs(rounded % 1) < 0.005;
  return `₱${rounded.toLocaleString("en-PH", {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2
  })}`;
}

function clampQty(value){
  const n = Math.floor(Number(value));
  if (isNaN(n)) return 1;
  return Math.min(10000, Math.max(1, n));
}
function formatDate(date){
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function formatDateTime(date){
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " · " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function formatChatTime(ts){
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function paymentMethodLabel(method){
  if (method === "gcash") return "GCash";
  if (method === "bank") return "Bank Transfer";
  return method || "—";
}
function escapeHtml(str){
  return String(str == null ? "" : str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function createEntityId(prefix){
  const timePart = Date.now().toString(36).toUpperCase();
  let entropyPart = "";

  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    entropyPart = window.crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  } else if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(5);
    window.crypto.getRandomValues(bytes);
    entropyPart = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  } else {
    entropyPart = Math.floor(Math.random() * 0xFFFFFFFFFF).toString(16).padStart(10, "0").toUpperCase();
  }

  return `${prefix}-${timePart}-${entropyPart}`;
}

// ===================== Per-size (feet) helpers =====================
function getSizeEntry(product, feet){
  if (!product) return null;
  return (product.sizes || []).find(s => String(s.feet) === String(feet)) || null;
}
function priceForFeet(product, feet){
  const entry = getSizeEntry(product, feet);
  return entry ? Number(entry.price) || 0 : 0;
}
function stockForFeet(product, feet){
  const entry = getSizeEntry(product, feet);
  if (!entry || entry.stock === undefined || entry.stock === null || entry.stock === "") return Infinity;
  return Number(entry.stock);
}
function isSizeOutOfStock(product, feet){
  const stock = stockForFeet(product, feet);
  return stock !== Infinity && stock <= 0;
}

// ===================== Flash sales =====================
async function loadFlashSales(){
  try {
    const { data, error } = await supabase.from("flash_sales").select("*");
    if (error) throw error;
    flashSales = (data || []).map(mapFlashSaleRow);
    return;
  } catch (error) {
    if (catalogueUsingSnapshot) {
      const snapshot = await loadCatalogueSnapshot();
      if (Array.isArray(snapshot?.flashSales)) {
        flashSales = snapshot.flashSales.map(mapFlashSaleRow);
        return;
      }
      console.warn("[Dagoldol] Flash sales unavailable while using catalogue snapshot:", error);
      flashSales = [];
      return;
    }
    reportLoadError("Flash sales", error);
    flashSales = [];
  }
}

function getActiveFlashSale(productId){
  const now = Date.now();
  return flashSales.find(fs => fs.productId === productId && fs.active && fs.startAt <= now && now <= fs.endAt) || null;
}

function flashSaleStatusLabel(fs){
  const now = Date.now();
  if (!fs.active) return "Inactive";
  if (now < fs.startAt) return "Upcoming";
  if (now > fs.endAt) return "Expired";
  return "Live now";
}

function effectivePriceForFeet(product, feet){
  const original = priceForFeet(product, feet);
  const sale = getActiveFlashSale(product.id);
  if (!sale) return { original, price: original, sale: null };
  const price = Math.max(0, original * (1 - sale.discountPercent / 100));
  return { original, price, sale };
}

function priceRangeLabel(product){
  const sizes = product.sizes || [];
  if (sizes.length === 0) return "Size & price TBD";
  const prices = sizes.map(s => effectivePriceForFeet(product, s.feet).price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatPrice(min) : `${formatPrice(min)} – ${formatPrice(max)}`;
}

function productMinPrice(product){
  const sizes = product.sizes || [];
  if (!sizes.length) return 0;
  return Math.min(...sizes.map(s => effectivePriceForFeet(product, s.feet).price));
}

// ===================== Brands =====================
async function loadBrands(){
  try {
    const { data, error } = await supabase.from("brands").select("*").order("name");
    if (error) throw error;
    brands = (data || []).map(mapBrandRow);
    return;
  } catch (error) {
    if (catalogueUsingSnapshot) {
      const snapshot = await loadCatalogueSnapshot();
      if (Array.isArray(snapshot?.brands)) {
        brands = snapshot.brands.map(mapBrandRow);
        return;
      }
      console.warn("[Dagoldol] Brands unavailable while using catalogue snapshot:", error);
      brands = [];
      return;
    }
    reportLoadError("Brands", error);
    brands = [];
  }
}
function findBrand(brandId){
  return brands.find(b => b.id === brandId) || null;
}

// ===================== Inventory / low stock =====================
function computeLowStockItems(){
  const items = [];
  products.forEach(p => {
    (p.sizes || []).forEach(s => {
      if (s.stock === undefined || s.stock === null || s.stock === "") return;
      const stock = Number(s.stock);
      if (stock <= LOW_STOCK_THRESHOLD) {
        items.push({ productId: p.id, productName: p.name, feet: s.feet, stock, unitType: p.unitType });
      }
    });
  });
  items.sort((a, b) => a.stock - b.stock);
  return items;
}

// ===================== Stock decrement / restore (atomic RPC) =====================
async function decrementStockForLines(lines){
  if (!lines.length) return { ok: true };
  const { error } = await supabase.rpc("decrement_stock_for_order", { p_lines: lines });
  if (error) {
    console.error("[Dagoldol] Atomic stock decrement failed:", error);
    return { ok: false, error };
  }
  return { ok: true };
}

async function restoreStockForLines(lines){
  if (!lines.length) return { ok: true };
  const { error } = await supabase.rpc("restore_stock_for_order", { p_lines: lines });
  if (error) {
    console.error("[Dagoldol] Stock restore failed:", error);
    return { ok: false, error };
  }
  return { ok: true };
}

function expandOrderLinesForStock(items){
  const lines = [];
  items.forEach(item => {
    if (item.isBundle) {
      (item.components || []).forEach(comp => {
        lines.push({ productId: comp.productId, feet: comp.feet, qty: comp.qty * item.qty });
      });
    } else {
      lines.push({ productId: item.productId, feet: item.feet, qty: item.qty });
    }
  });
  return lines;
}

async function verifyStockAvailable(items){
  // Checkout must verify against the live database. The deploy-time snapshot is
  // deliberately browsing-only because inventory may have changed since build.
  const freshProducts = await loadProducts({ allowSnapshotFallback: false, showLoadError: false });
  if (!freshProducts.length) {
    return { ok: false, message: "We couldn't verify live stock right now. Check your connection and try again before placing the order." };
  }
  const lines = expandOrderLinesForStock(items);
  for (const line of lines) {
    const product = freshProducts.find(p => p.id === line.productId);
    if (!product) return { ok: false, message: "One of the items in your order is no longer available." };
    const stock = stockForFeet(product, line.feet);
    if (stock !== Infinity && stock < line.qty) {
      return { ok: false, message: `Sorry, only ${stock} left in stock for "${product.name}" (${formatUnitValue(product.unitType, line.feet)}). Please adjust the quantity.` };
    }
  }
  return { ok: true };
}

// ===================== Promo codes (vouchers & coupons) =====================
async function loadPromoCodes(){
  const { data, error } = await supabase.from("promo_codes").select("*");
  if (error) { reportLoadError("Promo codes", error); promoCodes = []; return; }
  promoCodes = (data || []).map(mapPromoRow);
}

function validatePromoCode(codeRaw, subtotal){
  const code = (codeRaw || "").trim().toUpperCase();
  if (!code) return { ok: false, message: "Enter a code first." };

  const row = promoCodes.find(p => p.code.trim().toUpperCase() === code);
  if (!row) return { ok: false, message: "That code isn't recognized." };
  if (!row.active) return { ok: false, message: "That code is no longer active." };
  if (row.expiresAt && Date.now() > row.expiresAt) return { ok: false, message: "That code has expired." };
  if (row.maxUses != null && row.usedCount >= row.maxUses) return { ok: false, message: "That code has already reached its usage limit." };
  if (subtotal < row.minSpend) return { ok: false, message: `This code needs a minimum spend of ${formatPrice(row.minSpend)}.` };

  let discount = row.discountType === "percent" ? subtotal * (row.value / 100) : row.value;
  discount = Math.max(0, Math.min(discount, subtotal));

  return { ok: true, row, discount };
}

async function incrementPromoUsage(promoId){
  const { data, error } = await supabase.from("promo_codes").select("used_count").eq("id", promoId).single();
  if (error || !data) { console.error("[Dagoldol] Could not read promo usage:", error); return; }
  const { error: updateError } = await supabase.from("promo_codes").update({ used_count: (Number(data.used_count) || 0) + 1 }).eq("id", promoId);
  if (updateError) console.error("[Dagoldol] Could not increment promo usage:", updateError);
}

// ===================== Bundles =====================
async function loadBundles(){
  const { data, error } = await supabase.from("bundles").select("*").order("name");
  if (error) {
    if (catalogueUsingSnapshot) {
      console.warn("[Dagoldol] Bundles unavailable while using catalogue snapshot:", error);
      bundles = [];
      return;
    }
    reportLoadError("Bundles", error);
    bundles = [];
    return;
  }
  bundles = (data || []).map(mapBundleRow).filter(b => b.active);
}
function findBundle(bundleId){
  return bundles.find(b => b.id === bundleId) || null;
}
function bundleRegularTotal(bundle){
  return (bundle.items || []).reduce((sum, comp) => {
    const product = findProduct(comp.productId);
    if (!product) return sum;
    return sum + effectivePriceForFeet(product, comp.feet).price * comp.qty;
  }, 0);
}
function bundleComponentLabel(comp){
  const product = findProduct(comp.productId);
  const name = product ? product.name : "(removed item)";
  const label = product ? formatUnitValue(product.unitType, comp.feet) : `${comp.feet} ft`;
  return `${escapeHtml(name)} (${escapeHtml(label)}) ×${comp.qty}`;
}

async function renderBundlesSection(){
  if (!bundlesSection || !bundlesList) return;
  if (!bundles.length) {
    bundlesSection.classList.add("hidden");
    return;
  }
  bundlesSection.classList.remove("hidden");

  bundlesList.innerHTML = bundles.map(b => {
    const regularTotal = bundleRegularTotal(b);
    const savings = Math.max(0, regularTotal - b.bundlePrice);
    return `
      <article class="bundle-card">
        <p class="bundle-name">${escapeHtml(b.name)}</p>
        <p class="bundle-desc">${escapeHtml(b.desc || "")}</p>
        <div class="bundle-items-list">${(b.items || []).map(bundleComponentLabel).join("<br>")}</div>
        <div class="bundle-price-row">
          <span class="bundle-price">${formatPrice(b.bundlePrice)}</span>
          ${savings > 0 ? `<span class="bundle-savings">You save ${formatPrice(savings)}</span>` : ""}
        </div>
        <div class="qty-row">
          <span>Qty</span>
          <input type="number" class="qty-input" id="bundle-qty-${b.id}" min="1" max="10000" value="1">
        </div>
        <div class="product-actions">
          <button class="btn-secondary" type="button" data-id="${b.id}" data-action="bundle-cart">Add to Cart</button>
          <button class="btn-add" type="button" data-id="${b.id}" data-action="bundle-order">Place Order</button>
        </div>
      </article>
    `;
  }).join("");

  bundlesList.querySelectorAll("[data-action='bundle-cart']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const bundle = findBundle(btn.dataset.id);
      if (!bundle) return;
      const qtyInput = document.getElementById(`bundle-qty-${bundle.id}`);
      const qty = clampQty(qtyInput.value);
      await addBundleToCart(bundle.id, qty);
      showToast(`Added ${bundle.name} to your cart.`);
    });
  });

  bundlesList.querySelectorAll("[data-action='bundle-order']").forEach(btn => {
    btn.addEventListener("click", () => {
      const bundle = findBundle(btn.dataset.id);
      if (!bundle) return;
      const qtyInput = document.getElementById(`bundle-qty-${bundle.id}`);
      const qty = clampQty(qtyInput.value);
      beginCheckout(
        [buildBundleOrderLine(bundle, qty)],
        false,
        "Log in to place your order — we'll bring you right back to checkout."
      );
    });
  });
}

function buildBundleOrderLine(bundle, qty){
  return {
    isBundle: true,
    bundleId: bundle.id,
    name: bundle.name,
    price: bundle.bundlePrice,
    qty,
    components: (bundle.items || []).map(c => ({ productId: c.productId, feet: c.feet, qty: c.qty }))
  };
}

// =====================================================================
// ===================== RECOMMENDATION ENGINE ==========================
// =====================================================================
let coOccurrenceMap = {};
let trendingScores = {};
let recommendationRpcNoticeShown = false;

async function loadRecommendationData(){
  const { data, error } = await supabase.rpc("get_public_recommendation_signals");
  if (error) {
    coOccurrenceMap = {};
    trendingScores = {};
    if (!recommendationRpcNoticeShown) {
      recommendationRpcNoticeShown = true;
      console.info("[Dagoldol] Public recommendation aggregate is not available yet. Apply database/phase3-security-and-storage.sql to enable trending and frequently-bought-together without exposing raw orders.");
    }
    return;
  }

  let payload = data;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch (err) { payload = null; }
  }

  const trending = payload && typeof payload.trending === "object" ? payload.trending : {};
  const cooccurrence = payload && typeof payload.cooccurrence === "object" ? payload.cooccurrence : {};

  trendingScores = Object.fromEntries(
    Object.entries(trending || {}).map(([key, value]) => [key, Number(value) || 0])
  );

  coOccurrenceMap = {};
  Object.entries(cooccurrence || {}).forEach(([productId, related]) => {
    if (!related || typeof related !== "object") return;
    coOccurrenceMap[productId] = Object.fromEntries(
      Object.entries(related).map(([key, value]) => [key, Number(value) || 0])
    );
  });
}

const RECS_MIN_REFRESH_INTERVAL_MS = 30000;
let recommendationsChannel = null;
let recsLastRefreshAt = 0;
let recsRefreshTimer = null;
let recsRefreshPromise = null;

async function refreshRecommendationsLive(){
  if (document.hidden) return;
  if (recsRefreshPromise) return recsRefreshPromise;

  recsLastRefreshAt = Date.now();
  recsRefreshPromise = (async () => {
    await loadRecommendationData();
    await renderTrendingSection();
    await renderRecommendedSection();
  })();

  try {
    await recsRefreshPromise;
  } finally {
    recsRefreshPromise = null;
  }
}

function scheduleRecsRefresh(){
  if (document.hidden) return;
  const elapsed = Date.now() - recsLastRefreshAt;
  if (elapsed >= RECS_MIN_REFRESH_INTERVAL_MS) {
    void refreshRecommendationsLive();
  } else if (!recsRefreshTimer) {
    recsRefreshTimer = setTimeout(() => {
      recsRefreshTimer = null;
      void refreshRecommendationsLive();
    }, RECS_MIN_REFRESH_INTERVAL_MS - elapsed);
  }
}

function subscribeRecommendationsRealtime(){
  if (recommendationsChannel) supabase.removeChannel(recommendationsChannel);
  recommendationsChannel = supabase
    .channel("orders-changes-recs")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, () => scheduleRecsRefresh())
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders" }, () => scheduleRecsRefresh())
    .subscribe();
}

function teardownRecommendationsRealtime(){
  if (recommendationsChannel) { supabase.removeChannel(recommendationsChannel); recommendationsChannel = null; }
  clearTimeout(recsRefreshTimer);
  recsRefreshTimer = null;
  recsLastRefreshAt = 0;
  recsRefreshPromise = null;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && recommendationsChannel) scheduleRecsRefresh();
});

function computeTrendingProductIds(limit){
  return Object.entries(trendingScores)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter(id => findProduct(id))
    .slice(0, limit);
}

function computeFrequentlyBoughtTogether(productId, limit){
  const map = coOccurrenceMap[productId] || {};
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ productId: id, count }))
    .filter(s => findProduct(s.productId))
    .slice(0, limit);
}

async function computePersonalizedRecommendations(limit){
  const myOrders = await fetchMyOrders(500, 0);
  const brandCounts = {};
  const prices = [];

  myOrders.forEach(order => {
    if (order.cancelled) return;
    expandOrderLinesForStock(order.items).forEach(line => {
      const product = findProduct(line.productId);
      if (product && product.brandId) brandCounts[product.brandId] = (brandCounts[product.brandId] || 0) + line.qty;
    });
    (order.items || []).forEach(item => { if (!item.isBundle) prices.push(item.price); });
  });

  const hasHistory = myOrders.length > 0;
  const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  const scored = products.map(p => {
    let score = trendingScores[p.id] || 0;
    if (p.brandId && brandCounts[p.brandId]) score += brandCounts[p.brandId] * 5;
    if (avgPrice != null) {
      const sizePrices = (p.sizes || []).map(s => effectivePriceForFeet(p, s.feet).price);
      const closestGap = sizePrices.length ? Math.min(...sizePrices.map(pr => Math.abs(pr - avgPrice))) : Infinity;
      if (closestGap !== Infinity && closestGap <= avgPrice * 0.5) score += 3;
    }
    return { productId: p.id, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return { hasHistory, items: scored.slice(0, limit).map(s => s.productId).filter(id => findProduct(id)) };
}

function buildMiniProductCardHTML(p, idPrefix){
  if (!p) return "";
  const sale = getActiveFlashSale(p.id);
  const brand = findBrand(p.brandId);
  const allOutOfStock = (p.sizes || []).length > 0 && p.sizes.every(s => isSizeOutOfStock(p, s.feet));
  const rangePrices = (p.sizes || []).map(s => effectivePriceForFeet(p, s.feet));
  const hasDiscount = sale && rangePrices.some(r => r.price < r.original);
  return `
    <article class="product-card">
      <div class="product-photo">
        ${sale ? `<span class="flash-sale-badge">-${sale.discountPercent}% ${escapeHtml(sale.label)}</span>` : ""}
        ${buildProductCardPhoto(p, idPrefix)}
      </div>
      <div class="product-body">
        ${brand ? `<p class="product-brand-tag">${escapeHtml(brand.name)}</p>` : ""}
        <h3 class="product-name"><a class="product-detail-link" href="${escapeHtml(productDetailsHref(p.id))}">${escapeHtml(p.name)}</a></h3>
        <p class="product-desc">${escapeHtml(p.desc)}</p>
        ${renderRatingLine(p.id)}
        <div class="product-footer">
          <span class="product-price">${hasDiscount ? `<span class="product-price-strike">${priceRangeLabelOriginal(p)}</span>` : ""}${priceRangeLabel(p)}</span>
          <span class="product-number">${allOutOfStock ? "Out of stock" : `${(p.sizes || []).length} size${(p.sizes || []).length === 1 ? "" : "s"}`}</span>
        </div>
        <div class="qty-row">
          <span>Qty</span>
          <input type="number" class="qty-input" min="1" max="10000" value="1">
        </div>
        <div class="product-actions">
          <button class="btn-secondary" type="button" data-id="${p.id}" data-action="cart" ${allOutOfStock ? "disabled" : ""}>Add to Cart</button>
          <button class="btn-add" type="button" data-id="${p.id}" data-action="order" ${allOutOfStock ? "disabled" : ""}>Place Order</button>
        </div>
      </div>
    </article>
  `;
}

function wireProductActionButtons(containerEl){
  if (!(containerEl instanceof HTMLElement)) return;
  if (containerEl.dataset.productActionsBound === "true") return;
  containerEl.dataset.productActionsBound = "true";

  containerEl.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action='cart'], [data-action='order']");
    if (!(btn instanceof HTMLButtonElement) || !containerEl.contains(btn)) return;

    const card = btn.closest(".product-card");
    const qtyInput = card ? card.querySelector(".qty-input") : null;
    const qty = clampQty(qtyInput ? qtyInput.value : 1);
    if (qtyInput) qtyInput.value = qty;

    openSizeModal(btn.dataset.id, qty, btn.dataset.action === "order" ? "order" : "cart");
  });
}

async function renderTrendingSection(){
  const section = document.getElementById("trending-section");
  const list = document.getElementById("trending-list");
  if (!section || !list) return;

  const ids = computeTrendingProductIds(6);
  if (!ids.length) { section.classList.add("hidden"); list.innerHTML = ""; return; }

  section.classList.remove("hidden");
  list.innerHTML = ids.map((id, i) => buildMiniProductCardHTML(findProduct(id), `trend-${i}`)).join("");
  wireProductActionButtons(list);
}

async function renderRecommendedSection(){
  const section = document.getElementById("recommended-section");
  const list = document.getElementById("recommended-list");
  const heading = document.getElementById("recommended-heading");
  if (!section || !list || !currentUserId) return;

  const { hasHistory, items } = await computePersonalizedRecommendations(6);
  if (!items.length) { section.classList.add("hidden"); list.innerHTML = ""; return; }

  section.classList.remove("hidden");
  if (heading) heading.textContent = hasHistory ? "Recommended for You" : "Popular Picks";
  list.innerHTML = items.map((id, i) => buildMiniProductCardHTML(findProduct(id), `reco-${i}`)).join("");
  wireProductActionButtons(list);
}

function renderFrequentlyBoughtTogether(productId){
  const container = document.getElementById("size-modal-fbt");
  if (!container) return;

  const suggestions = computeFrequentlyBoughtTogether(productId, 3);
  if (!suggestions.length) { container.classList.add("hidden"); container.innerHTML = ""; return; }

  container.classList.remove("hidden");
  container.innerHTML = `
    <span class="field-label-standalone">Frequently bought together</span>
    <div class="fbt-list">
      ${suggestions.map(s => {
        const p = findProduct(s.productId);
        if (!p) return "";
        return `
          <div class="fbt-item">
            <span class="fbt-item-name">${escapeHtml(p.name)}</span>
            <span class="fbt-item-price">${priceRangeLabel(p)}</span>
            <button type="button" class="btn-secondary fbt-add-btn" data-id="${p.id}">+ Add</button>
          </div>
        `;
      }).join("")}
    </div>
  `;

  container.querySelectorAll(".fbt-add-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const product = findProduct(btn.dataset.id);
      if (!product || !product.sizes || !product.sizes.length) return;
      const firstAvailable = product.sizes.find(s => !isSizeOutOfStock(product, s.feet)) || product.sizes[0];
      if (isSizeOutOfStock(product, firstAvailable.feet)) {
        showToast(`${product.name} is out of stock right now.`);
        return;
      }
      await addToCart(product.id, firstAvailable.feet, 1);
      showToast(`Added ${product.name} to your cart.`);
    });
  });
}

// ===================== Avatar / image resize + upload helpers =====================
function renderAvatar(el, url, label){
  if (url) {
    el.innerHTML = `<img src="${escapeHtml(url)}" alt="Profile photo" loading="lazy" decoding="async">`;
  } else {
    const initial = (label || "?").trim().charAt(0).toUpperCase() || "?";
    el.textContent = initial;
  }
}

function resizeImageToBlob(file, maxSize){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image"));
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > h) {
          if (w > maxSize) { h = Math.round(h * (maxSize / w)); w = maxSize; }
        } else {
          if (h > maxSize) { w = Math.round(w * (maxSize / h)); h = maxSize; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Could not process image"));
        }, "image/jpeg", 0.85);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

profileAvatarInput.addEventListener("change", async () => {
  const file = profileAvatarInput.files[0];
  if (!file) return;
  try {
    if (profileAvatarUploadStatus) profileAvatarUploadStatus.classList.remove("hidden");
    pendingAvatarUrl = await uploadImageToStorage(file, "avatars", currentUserId || "guest", 240);
    renderAvatar(profileAvatarPreview, pendingAvatarUrl, currentUser);
  } catch (err) {
    profileError.textContent = "Could not upload that image. Try a different photo.";
  } finally {
    if (profileAvatarUploadStatus) profileAvatarUploadStatus.classList.add("hidden");
  }
});

profileAvatarRemoveBtn.addEventListener("click", () => {
  pendingAvatarUrl = null;
  renderAvatar(profileAvatarPreview, null, currentUser);
});

// ===================== Payment proof upload (private Storage object) =====================
function resetPaymentProofField(){
  pendingPaymentProofPath = null;
  if (orderPaymentRefInput) orderPaymentRefInput.value = "";
  if (paymentProofPreview) paymentProofPreview.innerHTML = "";
  if (orderPaymentProofInput) orderPaymentProofInput.value = "";
  if (orderPaymentProofRemoveBtn) orderPaymentProofRemoveBtn.classList.add("hidden");
}

if (orderPaymentProofInput) {
  orderPaymentProofInput.addEventListener("change", async () => {
    const file = orderPaymentProofInput.files[0];
    if (!file) return;
    const statusEl = document.getElementById("payment-proof-upload-status");
    try {
      if (statusEl) statusEl.classList.remove("hidden");
      if (!currentUserId) throw new Error("Authentication is required before uploading payment proof.");
      pendingPaymentProofPath = await uploadPrivateImageToStorage(file, "payment-proofs", currentUserId, 700);
      const previewUrl = await createSignedStorageUrl("payment-proofs", pendingPaymentProofPath, 300);
      if (!previewUrl) throw new Error("The payment proof uploaded but its private preview could not be opened.");
      paymentProofPreview.innerHTML = `<img src="${escapeHtml(previewUrl)}" alt="Payment screenshot" class="zoomable-img" loading="lazy" decoding="async">`;
      orderPaymentProofRemoveBtn.classList.remove("hidden");
      orderError.textContent = "";
    } catch (err) {
      console.error("[Dagoldol] Payment proof upload failed:", err);
      orderError.textContent = "Could not securely upload that screenshot. Try a different photo or try again.";
    } finally {
      if (statusEl) statusEl.classList.add("hidden");
    }
  });
}

if (orderPaymentProofRemoveBtn) {
  orderPaymentProofRemoveBtn.addEventListener("click", () => {
    pendingPaymentProofPath = null;
    paymentProofPreview.innerHTML = "";
    orderPaymentProofInput.value = "";
    orderPaymentProofRemoveBtn.classList.add("hidden");
  });
}

// ===================== Products =====================
async function fetchLiveProducts(){
  try {
    const { data, error } = await supabase.from("products").select("*").order("name");
    if (error) throw error;
    const mappedProducts = (data || []).map(mapProductRow);
    return {
      ok: true,
      products: await replaceEmbeddedProductImagesFromSnapshot(mappedProducts),
      error: null
    };
  } catch (error) {
    console.warn("[Dagoldol] Live products read failed:", error);
    return { ok: false, products: [], error };
  }
}

async function loadProducts({ allowSnapshotFallback = true, showLoadError = true } = {}){
  const liveResult = await fetchLiveProducts();
  if (liveResult.ok) {
    catalogueUsingSnapshot = false;
    return liveResult.products;
  }

  if (allowSnapshotFallback) {
    const snapshot = await loadCatalogueSnapshot();
    if (Array.isArray(snapshot?.products) && snapshot.products.length) {
      catalogueUsingSnapshot = true;
      console.warn("[Dagoldol] Rendering the deploy-time catalogue snapshot because the live products request failed.");
      return snapshot.products.map(mapProductRow);
    }
  }

  if (showLoadError) reportLoadError("Products", liveResult.error);
  return [];
}

function findProduct(productId){
  return products.find(p => p.id === productId);
}

let productRoutesMap = {};
let productRoutesLoadPromise = null;

async function loadProductRoutesMap(){
  if (productRoutesLoadPromise) return productRoutesLoadPromise;
  productRoutesLoadPromise = (async () => {
    try {
      const response = await fetch("/product-routes.json", { cache: "no-store" });
      if (!response.ok) return {};
      const payload = await response.json();
      productRoutesMap = payload && typeof payload === "object" ? payload : {};
    } catch (err) {
      productRoutesMap = {};
    }
    return productRoutesMap;
  })();
  return productRoutesLoadPromise;
}

function productDetailsHref(productId){
  const mapped = productRoutesMap[String(productId)];
  if (typeof mapped === "string" && mapped.startsWith("/")) return mapped;
  return `/?product=${encodeURIComponent(String(productId))}&action=cart`;
}

function buildProductPhoto(product, index){
  const scale = 4.4;
  const cx = 200, cy = 130;
  const tx = (cx - 24 * scale).toFixed(1);
  const ty = (cy - 24 * scale).toFixed(1);
  return `
    <svg viewBox="0 0 400 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(product.name)}">
      <defs>
        <radialGradient id="grad-${index}" cx="50%" cy="35%" r="75%">
          <stop offset="0%" stop-color="${product.accent}" stop-opacity="0.55"/>
          <stop offset="100%" stop-color="#141210" stop-opacity="1"/>
        </radialGradient>
      </defs>
      <rect width="400" height="260" fill="url(#grad-${index})"/>
      <circle cx="200" cy="130" r="86" fill="${product.accent}" opacity="0.18"/>
      <g transform="translate(${tx}, ${ty}) scale(${scale})" stroke="#f3ede1" fill="none" style="color:#f3ede1">
        ${product.icon || GENERIC_ICON}
      </g>
    </svg>
  `;
}

function getProductDisplayImage(product){
  const sizes = product.sizes || [];
  const inStockWithImage = sizes.find(s => s.image && !isSizeOutOfStock(product, s.feet));
  if (inStockWithImage) return inStockWithImage.image;
  const anyWithImage = sizes.find(s => s.image);
  return anyWithImage ? anyWithImage.image : null;
}

function buildProductCardPhoto(product, index){
  const image = getProductDisplayImage(product);
  if (image) {
    return `<img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" class="zoomable-img" loading="lazy" decoding="async">`;
  }
  return buildProductPhoto(product, index);
}

// ===================== Ratings =====================
let ratingsMap = {};

function buildRatingsMapFromRows(rows){
  const map = {};
  (rows || []).forEach(r => {
    if (!r || r.product_id == null) return;
    if (!map[r.product_id]) map[r.product_id] = { sum: 0, count: 0 };
    map[r.product_id].sum += Number(r.value) || 0;
    map[r.product_id].count += 1;
  });
  return map;
}

async function loadRatingsMap(){
  let rows = null;
  let liveError = null;

  try {
    const { data, error } = await supabase.from("ratings").select("product_id, value");
    if (error) throw error;
    rows = data || [];
  } catch (error) {
    liveError = error;
    if (catalogueUsingSnapshot) {
      const snapshot = await loadCatalogueSnapshot();
      if (Array.isArray(snapshot?.ratings)) rows = snapshot.ratings;
    }
  }

  if (!rows && liveError) {
    reportLoadError("Ratings", liveError);
  }

  ratingsMap = buildRatingsMapFromRows(rows || []);
}

function getAverageRating(productId){
  const entry = ratingsMap[productId];
  if (!entry || entry.count === 0) return null;
  return { avg: entry.sum / entry.count, count: entry.count };
}

async function addRating(orderId, productId, value){
  const { error } = await supabase.from("ratings").insert({
    user_id: currentUserId,
    order_id: orderId,
    product_id: productId,
    value
  });
  if (error) {
    console.error("[Dagoldol] Rating insert failed:", error);
    return { ok: false, error };
  }

  const entry = ratingsMap[productId] || { sum: 0, count: 0 };
  entry.sum += value;
  entry.count += 1;
  ratingsMap[productId] = entry;
  return { ok: true };
}

function renderRatingLine(productId){
  const rating = getAverageRating(productId);
  if (!rating) return `<p class="product-rating no-rating">No ratings yet</p>`;
  return `<p class="product-rating">★ ${rating.avg.toFixed(1)} <span>(${rating.count} rating${rating.count === 1 ? "" : "s"})</span></p>`;
}

// ===================== FIX #10: search + filter + sort =====================
const CATALOGUE_PAGE_SIZE = 12;
let catalogueVisibleCount = CATALOGUE_PAGE_SIZE;
let catalogueFilterState = { search: "", brandId: "", priceRange: "", sort: "default" };

const catalogueSearchInput = document.getElementById("catalogue-search");
const catalogueBrandFilter = document.getElementById("catalogue-brand-filter");
const cataloguePriceFilter = document.getElementById("catalogue-price-filter");
const catalogueSortSelect = document.getElementById("catalogue-sort");
const catalogueFilterClearBtn = document.getElementById("catalogue-filter-clear");
const catalogueResultCountEl = document.getElementById("catalogue-result-count");
const catalogueLoadMoreBtn = document.getElementById("catalogue-load-more-btn");

let catalogueSearchDebounce = null;
if (catalogueSearchInput) {
  catalogueSearchInput.addEventListener("input", () => {
    clearTimeout(catalogueSearchDebounce);
    catalogueSearchDebounce = setTimeout(() => {
      catalogueFilterState.search = catalogueSearchInput.value.trim().toLowerCase();
      catalogueVisibleCount = CATALOGUE_PAGE_SIZE;
      renderCatalogueList();
    }, 250);
  });
}
if (catalogueBrandFilter) {
  catalogueBrandFilter.addEventListener("change", () => {
    catalogueFilterState.brandId = catalogueBrandFilter.value;
    catalogueVisibleCount = CATALOGUE_PAGE_SIZE;
    renderCatalogueList();
  });
}
if (cataloguePriceFilter) {
  cataloguePriceFilter.addEventListener("change", () => {
    catalogueFilterState.priceRange = cataloguePriceFilter.value;
    catalogueVisibleCount = CATALOGUE_PAGE_SIZE;
    renderCatalogueList();
  });
}
if (catalogueSortSelect) {
  catalogueSortSelect.addEventListener("change", () => {
    catalogueFilterState.sort = catalogueSortSelect.value;
    catalogueVisibleCount = CATALOGUE_PAGE_SIZE;
    renderCatalogueList();
  });
}
if (catalogueFilterClearBtn) {
  catalogueFilterClearBtn.addEventListener("click", () => {
    catalogueFilterState = { search: "", brandId: "", priceRange: "", sort: "default" };
    if (catalogueSearchInput) catalogueSearchInput.value = "";
    if (catalogueBrandFilter) catalogueBrandFilter.value = "";
    if (cataloguePriceFilter) cataloguePriceFilter.value = "";
    if (catalogueSortSelect) catalogueSortSelect.value = "default";
    catalogueVisibleCount = CATALOGUE_PAGE_SIZE;
    renderCatalogueList();
  });
}
if (catalogueLoadMoreBtn) {
  catalogueLoadMoreBtn.addEventListener("click", () => {
    catalogueVisibleCount += CATALOGUE_PAGE_SIZE;
    renderCatalogueList();
  });
}

function populateBrandFilterOptions(){
  if (!catalogueBrandFilter) return;
  const current = catalogueBrandFilter.value;
  catalogueBrandFilter.innerHTML = `<option value="">All brands</option>` +
    brands.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");
  catalogueBrandFilter.value = current;
}

function getFilteredSortedProducts(){
  let list = products.slice();

  if (catalogueFilterState.search) {
    const q = catalogueFilterState.search;
    list = list.filter(p =>
      (p.name || "").toLowerCase().includes(q) ||
      (p.desc || "").toLowerCase().includes(q) ||
      (findBrand(p.brandId)?.name || "").toLowerCase().includes(q)
    );
  }
  if (catalogueFilterState.brandId) {
    list = list.filter(p => p.brandId === catalogueFilterState.brandId);
  }
  if (catalogueFilterState.priceRange) {
    const [min, max] = catalogueFilterState.priceRange.split("-").map(Number);
    list = list.filter(p => {
      const price = productMinPrice(p);
      return price >= min && price <= max;
    });
  }

  if (catalogueFilterState.sort === "price-asc") {
    list.sort((a, b) => productMinPrice(a) - productMinPrice(b));
  } else if (catalogueFilterState.sort === "price-desc") {
    list.sort((a, b) => productMinPrice(b) - productMinPrice(a));
  } else if (catalogueFilterState.sort === "rating-desc") {
    list.sort((a, b) => (getAverageRating(b.id)?.avg || 0) - (getAverageRating(a.id)?.avg || 0));
  }

  return list;
}

function buildFullProductCardHTML(p, index){
  const sale = getActiveFlashSale(p.id);
  const brand = findBrand(p.brandId);
  const allOutOfStock = (p.sizes || []).length > 0 && p.sizes.every(s => isSizeOutOfStock(p, s.feet));
  const rangePrices = (p.sizes || []).map(s => effectivePriceForFeet(p, s.feet));
  const hasDiscount = sale && rangePrices.some(r => r.price < r.original);
  return `
    <article class="product-card">
      <div class="product-photo">
        ${sale ? `<span class="flash-sale-badge">-${sale.discountPercent}% ${escapeHtml(sale.label)}</span>` : ""}
        ${buildProductCardPhoto(p, index)}
      </div>
      <div class="product-body">
        <p class="product-number">No. ${String(index + 1).padStart(2, "0")}</p>
        ${brand ? `<p class="product-brand-tag">${escapeHtml(brand.name)}</p>` : ""}
        <h3 class="product-name"><a class="product-detail-link" href="${escapeHtml(productDetailsHref(p.id))}">${escapeHtml(p.name)}</a></h3>
        <p class="product-desc">${escapeHtml(p.desc)}</p>
        ${renderRatingLine(p.id)}
        <div class="product-footer">
          <span class="product-price">${hasDiscount ? `<span class="product-price-strike">${priceRangeLabelOriginal(p)}</span>` : ""}${priceRangeLabel(p)}</span>
          <span class="product-number">${allOutOfStock ? "Out of stock" : `${(p.sizes || []).length} size${(p.sizes || []).length === 1 ? "" : "s"}`}</span>
        </div>
        <div class="qty-row">
          <span>Qty</span>
          <input type="number" class="qty-input" id="qty-${p.id}" min="1" max="10000" value="1">
          <span>(1–10,000)</span>
        </div>
        <div class="product-actions">
          <button class="btn-secondary" type="button" data-id="${p.id}" data-action="cart" ${allOutOfStock ? "disabled" : ""}>Add to Cart</button>
          <button class="btn-add" type="button" data-id="${p.id}" data-action="order" ${allOutOfStock ? "disabled" : ""}>Place Order</button>
        </div>
      </div>
    </article>
  `;
}

function buildSkeletonCards(count){
  return Array.from({ length: count }).map(() => `
    <div class="skeleton-card" aria-hidden="true">
      <div class="skeleton skeleton-photo"></div>
      <div class="skeleton-card-body">
        <div class="skeleton skeleton-line" style="width:40%;"></div>
        <div class="skeleton skeleton-line" style="width:80%; height:16px;"></div>
        <div class="skeleton skeleton-line" style="width:95%;"></div>
        <div class="skeleton skeleton-line" style="width:60%;"></div>
        <div class="skeleton skeleton-line" style="width:45%; height:26px; margin-top:6px;"></div>
      </div>
    </div>
  `).join("");
}

function buildSkeletonRows(count){
  return Array.from({ length: count }).map(() => `
    <div class="skeleton-row" aria-hidden="true">
      <div class="skeleton skeleton-line" style="width:30%; height:16px;"></div>
      <div class="skeleton skeleton-line" style="width:90%;"></div>
      <div class="skeleton skeleton-line" style="width:70%;"></div>
    </div>
  `).join("");
}

function renderCatalogueList(){
  if (products.length === 0) {
    catalogue.innerHTML = buildEmptyState(EMPTY_ICON_CRATE, "Nothing here yet", "The catalogue is empty right now — check back soon.");
    if (catalogueLoadMoreBtn) catalogueLoadMoreBtn.classList.add("hidden");
    if (catalogueResultCountEl) catalogueResultCountEl.textContent = "";
    return;
  }

  const filtered = getFilteredSortedProducts();
  const visible = filtered.slice(0, catalogueVisibleCount);

  if (catalogueResultCountEl) {
    const filtersActive = catalogueFilterState.search || catalogueFilterState.brandId || catalogueFilterState.priceRange;
    catalogueResultCountEl.textContent = filtersActive
      ? `${filtered.length} product${filtered.length === 1 ? "" : "s"} found`
      : "";
  }

  if (visible.length === 0) {
    catalogue.innerHTML = buildEmptyState(EMPTY_ICON_SEARCH, "No matches", "No products match your search or filters — try clearing a filter.");
    if (catalogueLoadMoreBtn) catalogueLoadMoreBtn.classList.add("hidden");
    return;
  }

  catalogue.innerHTML = visible.map((p, i) => buildFullProductCardHTML(p, i)).join("");

  if (catalogueLoadMoreBtn) {
    catalogueLoadMoreBtn.classList.toggle("hidden", catalogueVisibleCount >= filtered.length);
  }

  wireProductActionButtons(catalogue);
}

function scheduleNonCriticalShopWork(task, timeout = 900){
  if (typeof task !== "function") return;
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => { void task(); }, { timeout });
    return;
  }
  window.setTimeout(() => { void task(); }, Math.min(timeout, 350));
}

async function renderCatalogueFromSnapshotFast(){
  const snapshot = await loadCatalogueSnapshot();
  if (!Array.isArray(snapshot?.products) || snapshot.products.length === 0) return false;

  catalogueUsingSnapshot = true;
  products = snapshot.products.map(mapProductRow);
  brands = Array.isArray(snapshot.brands) ? snapshot.brands.map(mapBrandRow) : [];
  flashSales = Array.isArray(snapshot.flashSales) ? snapshot.flashSales.map(mapFlashSaleRow) : [];
  ratingsMap = buildRatingsMapFromRows(Array.isArray(snapshot.ratings) ? snapshot.ratings : []);

  catalogueVisibleCount = CATALOGUE_PAGE_SIZE;
  populateBrandFilterOptions();
  renderCatalogueList();
  return true;
}

async function hydrateCatalogueLiveAfterFastRender(){
  if (catalogueHydrationPromise) return catalogueHydrationPromise;

  catalogueHydrationPromise = (async () => {
    const liveProductsPromise = fetchLiveProducts();

    const [, , , , liveProductsResult] = await Promise.all([
      loadRatingsMap(),
      loadBrands(),
      loadFlashSales(),
      loadBundles(),
      liveProductsPromise
    ]);

    if (liveProductsResult?.ok) {
      products = liveProductsResult.products;
      catalogueUsingSnapshot = false;
    }

    await loadProductRoutesMap();
    await renderBundlesSection();
    populateBrandFilterOptions();
    catalogueVisibleCount = Math.max(CATALOGUE_PAGE_SIZE, catalogueVisibleCount);
    renderCatalogueList();

    scheduleNonCriticalShopWork(async () => {
      await loadRecommendationData();
      await renderTrendingSection();
      await renderRecommendedSection();
    }, 1200);
  })();

  try {
    await catalogueHydrationPromise;
  } finally {
    catalogueHydrationPromise = null;
  }
}

async function renderCatalogue(){
  catalogue.innerHTML = buildSkeletonCards(CATALOGUE_PAGE_SIZE);

  if (shouldUseFastMobileBootstrap()) {
    const renderedSnapshot = await renderCatalogueFromSnapshotFast();
    if (renderedSnapshot) {
      scheduleNonCriticalShopWork(hydrateCatalogueLiveAfterFastRender, 300);
      return;
    }
  }

  products = await loadProducts();
  await Promise.all([loadRatingsMap(), loadBrands(), loadFlashSales(), loadBundles(), loadProductRoutesMap()]);
  await renderBundlesSection();
  populateBrandFilterOptions();

  await loadRecommendationData();
  await renderTrendingSection();
  await renderRecommendedSection();

  catalogueVisibleCount = CATALOGUE_PAGE_SIZE;
  renderCatalogueList();
}

function priceRangeLabelOriginal(product){
  const sizes = product.sizes || [];
  if (sizes.length === 0) return "";
  const prices = sizes.map(s => priceForFeet(product, s.feet));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatPrice(min) : `${formatPrice(min)}–${formatPrice(max)}`;
}

// ===================== Size select modal =====================
let sizeModalState = { productId: null, action: null, qty: 1, selectedFeet: null };
function openSizeModal(productId, qty, action){
  const product = findProduct(productId);
  if (!product) return;

  if (!product.sizes || product.sizes.length === 0) {
    showToast("This item doesn't have any sizes set up yet — check back soon.");
    return;
  }

  const firstAvailable = product.sizes.find(s => !isSizeOutOfStock(product, s.feet)) || product.sizes[0];
  sizeModalState = { productId, action, qty: clampQty(qty || 1), selectedFeet: firstAvailable.feet };
  sizeModalProductName.textContent = product.name;
  sizeModalQtyInput.value = sizeModalState.qty;
  sizeModalError.textContent = "";
  sizeModalConfirmBtn.textContent = action === "cart" ? "Add to Cart" : "Continue to Order";

  renderSizeOptions(product);
  renderSizeModalPhoto(product);
  renderFrequentlyBoughtTogether(product.id);

  openModalAccessible(sizeModal, sizeModalConfirmBtn);
}

function renderSizeOptions(product){
  const sale = getActiveFlashSale(product.id);
  sizeOptionsEl.innerHTML = product.sizes.map(s => {
    const selected = String(s.feet) === String(sizeModalState.selectedFeet);
    const outOfStock = isSizeOutOfStock(product, s.feet);
    const stock = stockForFeet(product, s.feet);
    const eff = effectivePriceForFeet(product, s.feet);
    let stockNote = "";
    if (outOfStock) stockNote = `<span class="size-option-stock stock-low">Out of stock</span>`;
    else if (stock !== Infinity && stock <= LOW_STOCK_THRESHOLD) stockNote = `<span class="size-option-stock stock-low">Only ${stock} left</span>`;
    return `
      <label class="size-option ${selected ? "selected" : ""} ${outOfStock ? "out-of-stock" : ""}">
        <input type="radio" name="size-feet" value="${escapeHtml(String(s.feet))}" ${selected ? "checked" : ""} ${outOfStock ? "disabled" : ""}>
        <span class="size-option-feet">${escapeHtml(formatUnitValue(product.unitType, s.feet))}</span>
        <span class="size-option-price">${sale ? `<span class="product-price-strike">${formatPrice(eff.original)}</span> ` : ""}${formatPrice(eff.price)}</span>
        ${stockNote}
      </label>
    `;
  }).join("");

  sizeOptionsEl.querySelectorAll("input[name='size-feet']").forEach(radio => {
    radio.addEventListener("change", () => {
      sizeModalState.selectedFeet = radio.value;
      sizeOptionsEl.querySelectorAll(".size-option").forEach(option => {
        const input = option.querySelector("input[name='size-feet']");
        option.classList.toggle("selected", Boolean(input && input.checked));
      });
      renderSizeModalPhoto(product);
      updateSizeModalQtyMax(product);
    });
  });

  updateSizeModalQtyMax(product);
}

function updateSizeModalQtyMax(product){
  const stock = stockForFeet(product, sizeModalState.selectedFeet);
  if (stock !== Infinity) {
    sizeModalQtyInput.max = stock;
    if (Number(sizeModalQtyInput.value) > stock) sizeModalQtyInput.value = Math.max(1, stock);
  } else {
    sizeModalQtyInput.max = 10000;
  }
}

function renderSizeModalPhoto(product){
  const entry = getSizeEntry(product, sizeModalState.selectedFeet);
  if (entry && entry.image) {
    sizeModalPhoto.innerHTML = `<img src="${escapeHtml(entry.image)}" alt="${escapeHtml(product.name)}, ${escapeHtml(formatUnitValue(product.unitType, entry.feet))}" class="zoomable-img" loading="lazy" decoding="async">`;
  } else {
    sizeModalPhoto.innerHTML = buildProductPhoto(product, 0);
  }
}

function closeSizeModal(){
  closeModalAccessible(sizeModal);
}

sizeModalClose.addEventListener("click", closeSizeModal);
sizeModal.addEventListener("click", (e) => {
  if (e.target === sizeModal) closeSizeModal();
});

sizeModalQtyInput.addEventListener("change", () => {
  const product = findProduct(sizeModalState.productId);
  const stock = product ? stockForFeet(product, sizeModalState.selectedFeet) : Infinity;
  let qty = clampQty(sizeModalQtyInput.value);
  if (stock !== Infinity) qty = Math.min(qty, Math.max(1, stock));
  sizeModalQtyInput.value = qty;
});

sizeModalConfirmBtn.addEventListener("click", async () => {
  const product = findProduct(sizeModalState.productId);
  if (!product) return;

  const feet = sizeModalState.selectedFeet;
  const entry = getSizeEntry(product, feet);
  const qty = clampQty(sizeModalQtyInput.value);

  if (!entry) {
    sizeModalError.textContent = "Please choose a size.";
    return;
  }
  if (isSizeOutOfStock(product, feet)) {
    sizeModalError.textContent = "That size is out of stock. Please choose another.";
    return;
  }
  const stock = stockForFeet(product, feet);
  if (stock !== Infinity && qty > stock) {
    sizeModalError.textContent = `Only ${stock} left in stock for that size.`;
    return;
  }

  const eff = effectivePriceForFeet(product, feet);

  if (sizeModalState.action === "cart") {
    await addToCart(product.id, feet, qty);
    closeSizeModal();
    showToast(`Added ${product.name} (${formatUnitValue(product.unitType, feet)}) to your cart.`);
  } else {
    closeSizeModal();
    beginCheckout([{
      productId: product.id,
      feet,
      name: `${product.name} (${formatUnitValue(product.unitType, feet)})`,
      price: eff.price,
      qty
    }], false, "Log in to place your order — we'll bring you right back to checkout.");
  }
});

// ===================== Cart (stored on the profile row) =====================
function getCart(){
  const rawCart = currentUserId ? ((currentUserProfile && currentUserProfile.cart) || []) : getGuestCart();
  return rawCart.filter(item => {
    if (item.isBundle) return !!findBundle(item.bundleId);
    const product = findProduct(item.productId);
    return product && getSizeEntry(product, item.feet);
  });
}

async function saveCart(cart){
  if (!currentUserId) {
    saveGuestCart(cart);
    return;
  }
  currentUserProfile.cart = cart;
  const { error } = await supabase.from("profiles").update({ cart }).eq("id", currentUserId);
  if (error) console.error("Could not save cart:", error);
}

async function addToCart(productId, feet, qty){
  const cart = getCart();
  const existing = cart.find(item => !item.isBundle && item.productId === productId && String(item.feet) === String(feet));
  if (existing) {
    existing.qty = clampQty(existing.qty + qty);
  } else {
    cart.push({ productId, feet, qty: clampQty(qty) });
  }
  await saveCart(cart);
  updateCartBadge();
}

async function addBundleToCart(bundleId, qty){
  const cart = getCart();
  const existing = cart.find(item => item.isBundle && item.bundleId === bundleId);
  if (existing) {
    existing.qty = clampQty(existing.qty + qty);
  } else {
    cart.push({ isBundle: true, bundleId, qty: clampQty(qty) });
  }
  await saveCart(cart);
  updateCartBadge();
}

async function removeCartLine(item){
  const cart = getCart().filter(i => {
    if (item.isBundle) return !(i.isBundle && i.bundleId === item.bundleId);
    return !(!i.isBundle && i.productId === item.productId && String(i.feet) === String(item.feet));
  });
  await saveCart(cart);
  updateCartBadge();
  renderCartModal();
}

function cartLineInfo(item){
  if (item.isBundle) {
    const bundle = findBundle(item.bundleId);
    if (!bundle) return null;
    return { name: bundle.name, unitPrice: bundle.bundlePrice, meta: "Bundle" };
  }
  const product = findProduct(item.productId);
  if (!product) return null;
  const eff = effectivePriceForFeet(product, item.feet);
  return { name: product.name, unitPrice: eff.price, meta: formatUnitValue(product.unitType, item.feet) };
}

function cartTotalCount(){
  return getCart().reduce((sum, item) => sum + item.qty, 0);
}

function cartTotalPrice(){
  return getCart().reduce((sum, item) => {
    const info = cartLineInfo(item);
    if (!info) return sum;
    return sum + info.unitPrice * item.qty;
  }, 0);
}

function updateCartBadge(){
  const count = cartTotalCount();
  cartCountBadge.textContent = count;
  cartCountBadge.classList.toggle("hidden", count === 0);
}

function renderCartModal(){
  const cart = getCart();

  if (cart.length === 0) {
    cartItemsList.innerHTML = buildEmptyState(EMPTY_ICON_CART, "Your cart is empty", "Go add something nice from the catalogue.");
  } else {
    cartItemsList.innerHTML = cart.map(item => {
      const info = cartLineInfo(item);
      if (!info) return "";
      const lineTotal = info.unitPrice * item.qty;
      return `
        <div class="cart-line">
          <div class="cart-line-info">
            <span class="cart-line-name">${escapeHtml(info.name)}</span>
            <span class="cart-line-meta">${escapeHtml(info.meta)} · Qty ${item.qty} · ${formatPrice(lineTotal)}</span>
          </div>
          <button type="button" class="cart-remove" data-id="${item.isBundle ? item.bundleId : item.productId}" data-feet="${item.feet || ""}" data-bundle="${item.isBundle ? "1" : "0"}" aria-label="Remove ${escapeHtml(info.name)}">&times;</button>
        </div>
      `;
    }).join("");

    cartItemsList.querySelectorAll(".cart-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.bundle === "1") {
          removeCartLine({ isBundle: true, bundleId: btn.dataset.id });
        } else {
          removeCartLine({ productId: btn.dataset.id, feet: btn.dataset.feet });
        }
      });
    });
  }

  cartTotalEl.textContent = formatPrice(cartTotalPrice());
}

function openCartModal(){
  renderCartModal();
  openModalAccessible(cartModal, cartCheckoutBtn);
}
function closeCartModal(){
  closeModalAccessible(cartModal);
}

cartBtn.addEventListener("click", openCartModal);
cartModalClose.addEventListener("click", closeCartModal);
cartModal.addEventListener("click", (e) => {
  if (e.target === cartModal) closeCartModal();
});

cartCheckoutBtn.addEventListener("click", () => {
  const cart = getCart();
  if (cart.length === 0) return;
  const items = cart.map(item => {
    const info = cartLineInfo(item);
    if (item.isBundle) {
      const bundle = findBundle(item.bundleId);
      return buildBundleOrderLine(bundle, item.qty);
    }
    return {
      productId: item.productId,
      feet: item.feet,
      name: `${info.name} (${info.meta})`,
      price: info.unitPrice,
      qty: item.qty
    };
  });
  closeCartModal();
  beginCheckout(items, true, "Log in to check out — your cart will be right here waiting.");
});

// ===================== Order modal: payment method + cost breakdown =====================
function getSelectedPaymentMethod(){
  const checked = orderForm.querySelector("input[name='payment-method']:checked");
  return checked ? checked.value : "gcash";
}

function updatePaymentDetailPanels(){
  const method = getSelectedPaymentMethod();
  paymentDetailGcash.classList.toggle("hidden", method !== "gcash");
  paymentDetailBank.classList.toggle("hidden", method !== "bank");
}

function isHalfPaymentChecked(){
  return !!(orderHalfPaymentCheckbox && orderHalfPaymentCheckbox.checked);
}

function currentOrderSubtotal(){
  return orderItems.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function updateOrderCostBreakdown(){
  const subtotal = currentOrderSubtotal();
  const totalQty = orderItems.reduce((sum, item) => sum + item.qty, 0);

  const bulkRate = getBulkFeeRate(totalQty);
  const bulkFee = subtotal * bulkRate;

  const promoDiscount = appliedPromo ? appliedPromo.discountAmount : 0;

  const total = Math.max(0, subtotal - promoDiscount + currentDeliveryFee + bulkFee);
  const halfPayment = isHalfPaymentChecked();

  costSubtotalEl.textContent = formatPrice(subtotal);

  costPromoRow.classList.toggle("hidden", !appliedPromo);
  if (appliedPromo) {
    costPromoLabel.textContent = `Discount (${appliedPromo.row.code})`;
    costPromoEl.textContent = `-${formatPrice(promoDiscount)}`;
  }

  costDeliveryEl.textContent = formatPrice(currentDeliveryFee);

  costBulkRow.classList.toggle("hidden", bulkRate === 0);
  costBulkLabel.textContent = `Bulk order fee (${Math.round(bulkRate * 100)}%)`;
  costBulkEl.textContent = formatPrice(bulkFee);

  costTotalEl.textContent = formatPrice(total);

  costDueNowRow.classList.toggle("hidden", !halfPayment);
  costDueLaterRow.classList.toggle("hidden", !halfPayment);
  if (halfPayment) {
    const dueNow = total / 2;
    const dueLater = total - dueNow;
    costDueNowEl.textContent = formatPrice(dueNow);
    costDueLaterEl.textContent = formatPrice(dueLater);
  }

  updatePaymentDetailPanels();
}

document.querySelectorAll("input[name='payment-method']").forEach(radio => {
  radio.addEventListener("change", updateOrderCostBreakdown);
});

if (orderHalfPaymentCheckbox) {
  orderHalfPaymentCheckbox.addEventListener("change", updateOrderCostBreakdown);
}

// ===================== Promo code apply (order modal) =====================
function resetPromoField(){
  appliedPromo = null;
  if (orderPromoCodeInput) orderPromoCodeInput.value = "";
  if (promoStatusEl) {
    promoStatusEl.textContent = "";
    promoStatusEl.classList.remove("promo-status-ok", "promo-status-error");
  }
}

if (orderPromoApplyBtn) {
  orderPromoApplyBtn.addEventListener("click", async () => {
    await loadPromoCodes();
    const subtotal = currentOrderSubtotal();
    const result = validatePromoCode(orderPromoCodeInput.value, subtotal);

    if (!result.ok) {
      appliedPromo = null;
      promoStatusEl.textContent = result.message;
      promoStatusEl.classList.remove("promo-status-ok");
      promoStatusEl.classList.add("promo-status-error");
      updateOrderCostBreakdown();
      return;
    }

    appliedPromo = { row: result.row, discountAmount: result.discount };
    promoStatusEl.textContent = `"${result.row.code}" applied — ${formatPrice(result.discount)} off.`;
    promoStatusEl.classList.remove("promo-status-error");
    promoStatusEl.classList.add("promo-status-ok");
    updateOrderCostBreakdown();
  });
}

// ===================== FIX #6: delivery distance recalculation w/ caching =====================
const NOMINATIM_APP_IDENTIFIER = "dagoldol-trading-co-shop";
const GEOCODE_CACHE_KEY = "dagoldol_geocode_cache_v1";
const GEOCODE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function loadGeocodeCache(){
  try {
    const raw = localStorage.getItem(GEOCODE_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) { return {}; }
}
function saveGeocodeCache(cache){
  try { localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache)); } catch (err) { /* ignore quota errors */ }
}
let geocodeCache = loadGeocodeCache();

async function geocodeAddress(addressStr){
  const key = addressStr.trim().toLowerCase();
  const cached = geocodeCache[key];
  if (cached && (Date.now() - cached.at) < GEOCODE_CACHE_MAX_AGE_MS) {
    return cached.coords;
  }
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ph&email=${encodeURIComponent(NOMINATIM_APP_IDENTIFIER)}&q=${encodeURIComponent(addressStr)}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.length === 0) {
      geocodeCache[key] = { coords: null, at: Date.now() };
      saveGeocodeCache(geocodeCache);
      return null;
    }
    const coords = { lat: Number(data[0].lat), lon: Number(data[0].lon) };
    geocodeCache[key] = { coords, at: Date.now() };
    saveGeocodeCache(geocodeCache);
    return coords;
  } catch (err) {
    console.error("[Dagoldol] geocodeAddress failed:", err);
    return null;
  }
}

async function getRoadDistanceKm(origin, dest){
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${dest.lon},${dest.lat}?overview=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) return null;
    return data.routes[0].distance / 1000;
  } catch (err) {
    console.error("[Dagoldol] getRoadDistanceKm failed:", err);
    return null;
  }
}

async function recalcDeliveryFee(){
  const address = orderAddressInput.value.trim();
  const city = orderCityInput.value.trim();
  const postal = orderPostalInput.value.trim();
  const hasCurrentPin = Boolean(checkoutPinnedLocation && !checkoutPinnedLocationStale);

  if ((!address || !city) && !hasCurrentPin) {
    deliveryStatusEl.textContent = "Enter your address or pin your delivery location to calculate the delivery fee.";
    deliveryStatusEl.classList.remove("delivery-status-error");
    currentDeliveryFee = DELIVERY_FALLBACK_FEE;
    currentDeliveryKm = null;
    updateOrderCostBreakdown();
    return;
  }

  const fullAddress = `${address}, ${city}${postal ? ", " + postal : ""}, Philippines`;
  const myToken = ++deliveryRecalcToken;

  deliveryStatusEl.textContent = hasCurrentPin
    ? "Calculating delivery distance from your exact map pin…"
    : "Calculating delivery distance…";
  deliveryStatusEl.classList.remove("delivery-status-error");

  const result = hasCurrentPin
    ? await calculateDeliveryFeeForCoords({
        lat: checkoutPinnedLocation.latitude,
        lon: checkoutPinnedLocation.longitude
      })
    : await calculateDeliveryFee(fullAddress);

  if (myToken !== deliveryRecalcToken) return;

  currentDeliveryFee = result.fee;
  currentDeliveryKm = result.km;

  if (result.km != null) {
    const pinNote = hasCurrentPin ? " · exact map pin" : "";
    if (result.fee === 0) {
      deliveryStatusEl.textContent = `${result.km.toFixed(1)} km from the shop${pinNote} · Free delivery`;
    } else {
      deliveryStatusEl.textContent = `${result.km.toFixed(1)} km from the shop${pinNote} · ${formatPrice(result.fee)} delivery fee`;
    }
    deliveryStatusEl.classList.remove("delivery-status-error");
  } else {
    deliveryStatusEl.textContent = hasCurrentPin
      ? `Couldn't route from the pinned location — using the standard delivery fee of ${formatPrice(DELIVERY_FALLBACK_FEE)}.`
      : `Couldn't pinpoint that address — using the standard delivery fee of ${formatPrice(DELIVERY_FALLBACK_FEE)}.`;
    deliveryStatusEl.classList.add("delivery-status-error");
  }

  updateOrderCostBreakdown();
}

function scheduleDeliveryRecalc(){
  clearTimeout(deliveryDebounceTimer);
  deliveryDebounceTimer = setTimeout(recalcDeliveryFee, 700);
}

[orderAddressInput, orderCityInput, orderPostalInput].forEach(input => {
  input.addEventListener("input", () => {
    if (checkoutPinnedLocation) {
      checkoutPinnedLocationStale = !pinnedLocationMatchesFields(checkoutPinnedLocation, getCheckoutAddressFields());
      renderPinnedLocationCard(checkoutLocationCurrentEl, checkoutPinnedLocation, getCheckoutAddressFields(), checkoutPinnedLocationStale);
    }
    scheduleDeliveryRecalc();
  });
});

[profileAddressInput, profileCityInput, profilePostalInput].filter(Boolean).forEach(input => {
  input.addEventListener("input", () => {
    if (!profilePinnedLocation) return;
    profilePinnedLocationStale = !pinnedLocationMatchesFields(profilePinnedLocation, getProfileAddressFields());
    renderPinnedLocationCard(profileLocationCurrentEl, profilePinnedLocation, getProfileAddressFields(), profilePinnedLocationStale);
  });
});

// ===================== Routed checkout =====================
function openOrderModal(items, isCartCheckout, { replaceRoute = false } = {}){
  const safeItems = (items || []).filter(Boolean);
  if (!safeItems.length) {
    showToast("There is nothing to check out yet.");
    showShopScreenOnly();
    navigateAppPath(APP_ROUTES.SHOP, { replace: true });
    return false;
  }

  orderItems = safeItems;
  orderItems_isCartCheckout = !!isCartCheckout;
  saveCheckoutDraft(orderItems, orderItems_isCartCheckout);
  orderError.textContent = "";
  resetPaymentProofField();
  resetPromoField();

  modalItemsList.innerHTML = safeItems.map(item => `
    <div class="cart-line">
      <div class="cart-line-info">
        <span class="cart-line-name">${escapeHtml(item.name)}</span>
        <span class="cart-line-meta">Qty ${item.qty} · ${formatPrice(item.price * item.qty)}</span>
      </div>
    </div>
  `).join("");

  const gcashRadio = orderForm.querySelector("input[name='payment-method'][value='gcash']");
  if (gcashRadio) gcashRadio.checked = true;
  if (orderHalfPaymentCheckbox) orderHalfPaymentCheckbox.checked = false;

  const saved = currentUserProfile && currentUserProfile.address;
  orderNameInput.value = saved ? saved.name : "";
  orderPhoneInput.value = saved ? saved.phone : "";
  orderAddressInput.value = saved ? saved.address : "";
  orderCityInput.value = saved ? saved.city : "";
  orderPostalInput.value = saved ? saved.postal : "";
  orderLandmarkInput.value = saved ? (saved.landmark || "") : "";
  orderSaveCheckbox.checked = true;

  checkoutPinnedLocation = normalizePinnedLocationValue(saved?.location, getCheckoutAddressFields());
  checkoutPinnedLocationStale = checkoutPinnedLocation
    ? !pinnedLocationMatchesFields(checkoutPinnedLocation, getCheckoutAddressFields())
    : false;
  renderPinnedLocationCard(checkoutLocationCurrentEl, checkoutPinnedLocation, getCheckoutAddressFields(), checkoutPinnedLocationStale);

  currentDeliveryFee = DELIVERY_FALLBACK_FEE;
  currentDeliveryKm = null;
  updateOrderCostBreakdown();

  if (saved && saved.address && saved.city) {
    void recalcDeliveryFee();
  } else {
    deliveryStatusEl.textContent = "Enter your address to calculate the delivery fee.";
    deliveryStatusEl.classList.remove("delivery-status-error");
  }

  showCustomerRouteScreen(checkoutScreen);
  navigateAppPath(APP_ROUTES.CHECKOUT, { replace: replaceRoute });
  requestAnimationFrame(() => orderNameInput.focus({ preventScroll: true }));
  return true;
}

function resetCheckoutUiState(){
  clearTimeout(deliveryDebounceTimer);
  orderForm.reset();
  orderItems = [];
  orderItems_isCartCheckout = false;
  checkoutPinnedLocation = null;
  checkoutPinnedLocationStale = false;
  renderPinnedLocationCard(checkoutLocationCurrentEl, null, {}, false);
  resetPaymentProofField();
  resetPromoField();
}

function closeOrderModal({ replaceRoute = false, preserveDraft = true } = {}){
  resetCheckoutUiState();
  if (!preserveDraft) clearCheckoutDraft();
  showShopScreenOnly();
  navigateAppPath(APP_ROUTES.SHOP, { replace: replaceRoute });
}

async function openCheckoutFromPersistedState({ replaceRoute = true } = {}){
  const draft = readCheckoutDraft();
  let items = rebuildCheckoutItemsFromDraft(draft);
  let isCartCheckout = Boolean(draft && draft.isCartCheckout);

  if (!items.length) {
    items = buildCheckoutItemsFromCart();
    isCartCheckout = items.length > 0;
  }

  if (!items.length) {
    clearCheckoutDraft();
    showShopScreenOnly();
    navigateAppPath(APP_ROUTES.SHOP, { replace: true });
    showToast("Your checkout has no items. Add something to your cart first.");
    return false;
  }

  return openOrderModal(items, isCartCheckout, { replaceRoute });
}

if (checkoutBackBtn) {
  checkoutBackBtn.addEventListener("click", () => closeOrderModal({ replaceRoute: true, preserveDraft: true }));
}

let isSubmittingOrder = false;

orderForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSubmittingOrder) return;
  isSubmittingOrder = true;

  const submitBtn = orderForm.querySelector("button[type='submit']");
  submitBtn.disabled = true;

  try {
    const name = orderNameInput.value.trim();
    const phone = orderPhoneInput.value.trim();
    const address = orderAddressInput.value.trim();
    const city = orderCityInput.value.trim();
    const postal = orderPostalInput.value.trim();
    const landmark = orderLandmarkInput.value.trim();
    const paymentReference = orderPaymentRefInput ? orderPaymentRefInput.value.trim() : "";

    if (!name || !phone || !address || !city || !postal || !landmark) {
      orderError.textContent = "Please fill in every field before confirming — including a landmark so the rider can find you.";
      return;
    }

    if (!paymentReference) {
      orderError.textContent = "Please send your payment first, then enter the reference number from your GCash / bank receipt before confirming your order.";
      orderPaymentRefInput.focus();
      return;
    }

    const stockCheck = await verifyStockAvailable(orderItems);
    if (!stockCheck.ok) {
      orderError.textContent = stockCheck.message;
      return;
    }

    clearTimeout(deliveryDebounceTimer);
    await recalcDeliveryFee();

    const serializedLocation = serializePinnedLocation(
      checkoutPinnedLocation,
      { address, city, postal },
      checkoutPinnedLocationStale
    );

    if (orderSaveCheckbox.checked) {
      const newAddress = { name, phone, address, city, postal, landmark, location: serializedLocation };
      currentUserProfile.address = newAddress;
      const { error: addressSaveError } = await supabase.from("profiles").update({ address: newAddress }).eq("id", currentUserId);
      if (addressSaveError) {
        console.error("[Dagoldol] Could not save delivery address:", addressSaveError);
        showToast("Your order can continue, but the saved address could not be updated on this account.");
      }
    }

    const paymentMethod = getSelectedPaymentMethod();
    const halfPayment = isHalfPaymentChecked();
    const subtotal = currentOrderSubtotal();
    const totalQty = orderItems.reduce((sum, item) => sum + item.qty, 0);
    const bulkFeeRate = getBulkFeeRate(totalQty);
    const bulkFee = subtotal * bulkFeeRate;
    const deliveryFee = currentDeliveryFee;
    const promoDiscount = appliedPromo ? appliedPromo.discountAmount : 0;
    const total = Math.max(0, subtotal - promoDiscount + deliveryFee + bulkFee);
    const amountDueNow = halfPayment ? total / 2 : total;
    const amountDueLater = halfPayment ? total - amountDueNow : 0;
    const deliveryDays = DELIVERY_ESTIMATE_MAX_DAYS;
    const placedAt = Date.now();

    const row = {
      id: createEntityId("ORD"),
      user_id: currentUserId,
      username: currentUser,
      items: orderItems.map(item => item.isBundle
        ? { isBundle: true, bundleId: item.bundleId, name: item.name, price: item.price, qty: item.qty, components: item.components }
        : { productId: item.productId, feet: item.feet, name: item.name, price: item.price, qty: item.qty }),
      subtotal,
      delivery_fee: deliveryFee,
      bulk_fee_rate: bulkFeeRate,
      bulk_fee: bulkFee,
      promo_code: appliedPromo ? appliedPromo.row.code : null,
      promo_discount: promoDiscount,
      total,
      payment_method: paymentMethod,
      payment_reference: paymentReference,
      payment_proof: pendingPaymentProofPath || null,
      half_payment: halfPayment,
      amount_due_now: amountDueNow,
      amount_due_later: amountDueLater,
      address: { name, phone, address, city, postal, landmark, location: serializedLocation },
      placed_at: placedAt,
      delivery_days: deliveryDays,
      status_override: 0,
      cancelled: false,
      rated: {}
    };

    const stockLines = expandOrderLinesForStock(orderItems);
    const decrementResult = await decrementStockForLines(stockLines);
    if (!decrementResult.ok) {
      orderError.textContent = "Sorry — one or more items just sold out while you were checking out. Please adjust quantities and try again.";
      return;
    }

    const { error } = await supabase.from("orders").insert(row);

    if (error) {
      await restoreStockForLines(stockLines);
      console.error(error);
      orderError.textContent = "Something went wrong placing your order. Please try again.";
      return;
    }

    if (appliedPromo) await incrementPromoUsage(appliedPromo.row.id);

    const label = orderItems.length === 1 ? orderItems[0].name : `${orderItems.length} items`;
    const kmNote = currentDeliveryKm != null ? ` (${currentDeliveryKm.toFixed(1)} km delivery)` : "";
    const halfNote = halfPayment ? ` · Pay ${formatPrice(amountDueNow)} now, ${formatPrice(amountDueLater)} on delivery` : "";
    const promoNote = appliedPromo ? ` · Code ${appliedPromo.row.code} saved ${formatPrice(promoDiscount)}` : "";
    showToast(`Order placed for ${label} · ${paymentMethodLabel(paymentMethod)} · Total ${formatPrice(total)}${halfNote}${promoNote}${kmNote}. Delivery estimate: ${DELIVERY_ESTIMATE_MIN_DAYS}–${DELIVERY_ESTIMATE_MAX_DAYS} days after placement.`);

    if (orderItems_isCartCheckout) {
      await saveCart([]);
      updateCartBadge();
    }

    closeOrderModal({ replaceRoute: true, preserveDraft: false });
    await renderCatalogue();
    updateCartBadge();
  } finally {
    isSubmittingOrder = false;
    submitBtn.disabled = false;
  }
});

let toastSeq = 0;
function showToast(message){
  const container = document.getElementById("toast-container");
  if (!container) return;
  const id = `toast-${++toastSeq}`;
  const el = document.createElement("div");
  el.className = "toast";
  el.id = id;
  const p = document.createElement("p");
  p.textContent = message;
  el.appendChild(p);
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add("toast-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
  }, 4600);
}

const EMPTY_ICON_CART = `<svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 10h4l3.6 19.2a3 3 0 0 0 3 2.4h13.4a3 3 0 0 0 3-2.4L38 15H12.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="19" cy="38" r="2.2" fill="currentColor"/><circle cx="31" cy="38" r="2.2" fill="currentColor"/></svg>`;
const EMPTY_ICON_ORDERS = `<svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="10" y="7" width="28" height="34" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M16 16h16M16 23h16M16 30h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const EMPTY_ICON_CHAT = `<svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 12a3 3 0 0 1 3-3h26a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H21l-8 7v-7h-2a3 3 0 0 1-3-3V12Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const EMPTY_ICON_MESSAGE = `<svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 13a2 2 0 0 1 2-2h28a2 2 0 0 1 2 2v18a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V13Z" stroke="currentColor" stroke-width="1.6"/><path d="M9 13l15 11L39 13" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const EMPTY_ICON_CRATE = `<svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M6 15 24 7l18 8-18 8L6 15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M6 15v18l18 8V23M42 15v18l-18 8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const EMPTY_ICON_SEARCH = `<svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="21" cy="21" r="12" stroke="currentColor" stroke-width="1.6"/><path d="M30 30l9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const EMPTY_ICON_PEOPLE = `<svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="18" cy="17" r="6" stroke="currentColor" stroke-width="1.6"/><path d="M6 39c1.2-8 6-12 12-12s10.8 4 12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="33" cy="15" r="4.5" stroke="currentColor" stroke-width="1.6"/><path d="M31 24.2c5 .5 8.4 4.3 9.4 10.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const EMPTY_ICON_ACTIVITY = `<svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M6 26h8l4-12 8 20 4-12h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function buildEmptyState(icon, heading, body){
  return `
    <div class="empty-state">
      ${icon}
      <p><strong>${escapeHtml(heading)}</strong>${escapeHtml(body)}</p>
    </div>
  `;
}

// ===================== Orders / Tracking / Ratings =====================
const TRACKER_STEPS = ["Order Placed", "Processing", "Shipped", "Out for Delivery", "Delivered"];
const MY_ORDERS_PAGE_SIZE = 8;
let myOrdersVisibleCount = MY_ORDERS_PAGE_SIZE;

function getOrderStatus(order){
  const rawStep = Number(order && order.statusOverride);
  const stepIndex = Number.isInteger(rawStep)
    ? Math.min(TRACKER_STEPS.length - 1, Math.max(0, rawStep))
    : 0;
  return { stepIndex, delivered: stepIndex === TRACKER_STEPS.length - 1 };
}

function isOrderCancellable(order){
  if (order.cancelled) return false;
  const status = getOrderStatus(order);
  return status.stepIndex < 2;
}

async function fetchMyOrders(limit, offset){
  let query = supabase
    .from("orders")
    .select("*")
    .eq("user_id", currentUserId)
    .order("placed_at", { ascending: false });
  if (limit != null) query = query.range(offset || 0, (offset || 0) + limit - 1);
  const { data, error } = await query;
  if (error) { reportLoadError("Your orders", error); return []; }
  return (data || []).map(mapOrderRow);
}

async function cancelOrder(orderId){
  const order = myOrdersCache.find(o => o.id === orderId);
  if (!order || !isOrderCancellable(order)) return;

  const { error } = await supabase
    .from("orders")
    .update({ cancelled: true })
    .eq("id", orderId)
    .eq("user_id", currentUserId);

  if (error) {
    console.error("[Dagoldol] Order cancellation failed:", error);
    showErrorBanner("Could not cancel that order. Please try again.");
    return;
  }

  const restoreResult = await restoreStockForLines(expandOrderLinesForStock(order.items));
  if (!restoreResult.ok) {
    const { error: rollbackError } = await supabase
      .from("orders")
      .update({ cancelled: false })
      .eq("id", orderId)
      .eq("user_id", currentUserId);

    if (rollbackError) {
      console.error("[Dagoldol] Cancellation rollback also failed:", rollbackError);
      showErrorBanner("The cancellation could not be completed safely. Contact the shop owner before retrying; the order state needs review.");
    } else {
      showErrorBanner("The order was not cancelled because inventory could not be restored. Please try again.");
    }
    await renderOrdersModal();
    return;
  }

  await renderOrdersModal();
  showToast(`Order ${orderId} has been cancelled.`);
}

function renderOrderTracker(order){
  const status = getOrderStatus(order);
  const stepsHtml = TRACKER_STEPS.map((label, i) => {
    let cls = "tracker-step";
    if (i < status.stepIndex) cls += " done";
    else if (i === status.stepIndex) cls += " done active";
    return `
      <div class="${cls}">
        <div class="tracker-dot"></div>
        <div class="tracker-label">${label}</div>
      </div>
    `;
  }).join("");

  const etaText = status.delivered
    ? "Delivered — status confirmed by the shop."
    : `Delivery estimate: ${DELIVERY_ESTIMATE_MIN_DAYS}–${DELIVERY_ESTIMATE_MAX_DAYS} days after placement.`;

  return `
    <div class="tracker">${stepsHtml}</div>
    <p class="order-eta">${etaText}</p>
  `;
}

function renderStars(productId, order, currentRating){
  if (currentRating) {
    return `<span class="rate-done">You rated this ${currentRating}★. Thank you!</span>`;
    }
  const stars = [1, 2, 3, 4, 5].map(n =>
    `<span class="star" data-value="${n}" role="button" tabindex="0" aria-label="Rate ${n} star${n === 1 ? "" : "s"}">★</span>`
  ).join("");
  return `<div class="star-rating" data-order="${order.id}" data-product="${productId}">${stars}</div>`;
}

function renderOrderCard(order){
  const itemsSummary = order.items.map(item => `${escapeHtml(item.name)} ×${item.qty}`).join(", ");
  const feeNotes = [
    order.bulkFee ? `${Math.round((order.bulkFeeRate || 0) * 100)}% bulk order fee` : ""
  ].filter(Boolean).join(" · ");
  const halfNote = order.halfPayment
    ? ` · Half payment: ${formatPrice(order.amountDueNow)} paid, ${formatPrice(order.amountDueLater)} due on delivery`
    : "";
  const refNote = order.paymentReference ? ` · Ref: ${escapeHtml(order.paymentReference)}` : "";
  const promoNote = order.promoCode ? ` · Code ${escapeHtml(order.promoCode)} (-${formatPrice(order.promoDiscount)})` : "";
  const paymentLine = `<p class="order-payment-line">${escapeHtml(paymentMethodLabel(order.paymentMethod))}${feeNotes ? ` · incl. ${escapeHtml(feeNotes)}` : ""} · Delivery ${formatPrice(order.deliveryFee)}${halfNote}${refNote}${promoNote}</p>`;

  if (order.cancelled) {
    return `
      <div class="order-card order-card-cancelled">
        <div class="order-card-header">
          <span class="order-id">${escapeHtml(order.id)}</span>
          <span class="order-date">Placed ${formatDate(new Date(order.placedAt))}</span>
        </div>
        <p class="order-items-summary">${itemsSummary} — ${formatPrice(order.total)}</p>
        ${paymentLine}
        <p class="order-cancelled-badge">Cancelled</p>
      </div>
    `;
  }

  const status = getOrderStatus(order);
  let ratingSection = "";
  if (status.delivered) {
    ratingSection = order.items.filter(item => !item.isBundle).map(item => {
      const already = order.rated[item.productId];
      return `
        <div class="rate-item">
          <span class="rate-item-name">Rate: ${escapeHtml(item.name)}</span>
          ${renderStars(item.productId, order, already)}
        </div>
      `;
    }).join("");
  }

  const cancelSection = isOrderCancellable(order)
    ? `<button type="button" class="btn-cancel-order" data-order="${order.id}">Cancel this order</button>`
    : "";

  return `
    <div class="order-card">
      <div class="order-card-header">
        <span class="order-id">${escapeHtml(order.id)}</span>
        <span class="order-date">Placed ${formatDate(new Date(order.placedAt))}</span>
      </div>
      <p class="order-items-summary">${itemsSummary} — ${formatPrice(order.total)}</p>
      ${paymentLine}
      ${renderOrderTracker(order)}
      ${cancelSection}
      ${ratingSection}
    </div>
  `;
}

async function renderOrdersModal(){
  ordersList.innerHTML = buildSkeletonRows(3);
  myOrdersCache = await fetchMyOrders(myOrdersVisibleCount, 0);

  if (myOrdersCache.length === 0) {
    ordersList.innerHTML = buildEmptyState(EMPTY_ICON_ORDERS, "No orders yet", "Everything you order will show up here with live tracking.");
    if (ordersLoadMoreBtn) ordersLoadMoreBtn.classList.add("hidden");
    return;
  }

  ordersList.innerHTML = myOrdersCache.map(renderOrderCard).join("");

  if (ordersLoadMoreBtn) {
    ordersLoadMoreBtn.classList.toggle("hidden", myOrdersCache.length < myOrdersVisibleCount);
  }

  ordersList.querySelectorAll(".btn-cancel-order").forEach(btn => {
    btn.addEventListener("click", () => {
      if (confirm(`Cancel order ${btn.dataset.order}? This cannot be undone.`)) {
        cancelOrder(btn.dataset.order);
      }
    });
  });

  ordersList.querySelectorAll(".star-rating").forEach(widget => {
    const orderId = widget.dataset.order;
    const productId = widget.dataset.product;
    const starEls = widget.querySelectorAll(".star");

    starEls.forEach(star => {
      star.addEventListener("mouseenter", () => {
        const value = Number(star.dataset.value);
        starEls.forEach(s => s.classList.toggle("filled", Number(s.dataset.value) <= value));
      });
      star.addEventListener("click", () => {
        const value = Number(star.dataset.value);
        submitRating(orderId, productId, value);
      });
      star.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          submitRating(orderId, productId, Number(star.dataset.value));
        }
      });
      star.addEventListener("focus", () => {
        const value = Number(star.dataset.value);
        starEls.forEach(s => s.classList.toggle("filled", Number(s.dataset.value) <= value));
      });
    });

    widget.addEventListener("mouseleave", () => {
      starEls.forEach(s => s.classList.remove("filled"));
    });
    widget.addEventListener("focusout", (e) => {
      if (!widget.contains(e.relatedTarget)) starEls.forEach(s => s.classList.remove("filled"));
    });
  });
}

if (ordersLoadMoreBtn) {
  ordersLoadMoreBtn.addEventListener("click", () => {
    myOrdersVisibleCount += MY_ORDERS_PAGE_SIZE;
    renderOrdersModal();
  });
}

async function submitRating(orderId, productId, value){
  const order = myOrdersCache.find(o => o.id === orderId);
  if (!order || order.rated[productId]) return;

  const ratingResult = await addRating(orderId, productId, value);
  if (!ratingResult.ok) {
    showToast("That rating could not be saved. Make sure the Phase 3 database migration has been applied, then try again.");
    return;
  }

  const nextRated = { ...(order.rated || {}), [productId]: value };
  const { error } = await supabase
    .from("orders")
    .update({ rated: nextRated })
    .eq("id", orderId)
    .eq("user_id", currentUserId);

  if (error) {
    console.error("[Dagoldol] Could not mark the order rating state:", error);
    showErrorBanner("Your rating was saved, but the order history could not refresh its rated state. Reload the page before rating again.");
  } else {
    order.rated = nextRated;
  }

  await renderOrdersModal();
  renderCatalogueList();
  updateCartBadge();
}

async function openOrdersModal({ replaceRoute = false } = {}){
  myOrdersVisibleCount = MY_ORDERS_PAGE_SIZE;
  await renderOrdersModal();
  showCustomerRouteScreen(ordersScreen);
  navigateAppPath(APP_ROUTES.ORDERS, { replace: replaceRoute });
  requestAnimationFrame(() => ordersBackBtn?.focus({ preventScroll: true }));
}

function closeOrdersModal({ replaceRoute = false } = {}){
  showShopScreenOnly();
  navigateAppPath(APP_ROUTES.SHOP, { replace: replaceRoute });
}

ordersBtn.addEventListener("click", () => requireLogin(() => openOrdersModal(), "Log in to view your orders."));
if (ordersBackBtn) ordersBackBtn.addEventListener("click", () => closeOrdersModal({ replaceRoute: true }));

// ===================== Profile =====================
function openProfileModal(){
  const profile = (currentUserProfile && currentUserProfile.profile) || {};
  const savedAddress = (currentUserProfile && currentUserProfile.address) || {};
  pendingAvatarUrl = undefined;

  profileUsernameDisplay.value = currentUser;
  profileNameInput.value = profile.name || "";
  profileEmailInput.value = profile.email || "";
  profilePhoneInput.value = profile.phone || savedAddress.phone || "";
  profileBioInput.value = profile.bio || "";
  profileAddressInput.value = savedAddress.address || "";
  profileCityInput.value = savedAddress.city || "";
  profilePostalInput.value = savedAddress.postal || "";
  profileLandmarkInput.value = savedAddress.landmark || "";
  profilePinnedLocation = normalizePinnedLocationValue(savedAddress.location, getProfileAddressFields());
  profilePinnedLocationStale = profilePinnedLocation
    ? !pinnedLocationMatchesFields(profilePinnedLocation, getProfileAddressFields())
    : false;
  renderPinnedLocationCard(profileLocationCurrentEl, profilePinnedLocation, getProfileAddressFields(), profilePinnedLocationStale);

  profileError.textContent = "";
  profileSuccess.classList.add("hidden");
  renderAvatar(profileAvatarPreview, profile.avatar || null, currentUser);

  openModalAccessible(profileModal, profileNameInput);
}

function closeProfileModal(){
  closeModalAccessible(profileModal);
}

profileBtn.addEventListener("click", () => requireLogin(openProfileModal, "Log in to view your profile."));
profileModalClose.addEventListener("click", closeProfileModal);
profileModal.addEventListener("click", (e) => {
  if (e.target === profileModal) closeProfileModal();
});

profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const name = profileNameInput.value.trim();
  const email = profileEmailInput.value.trim();
  const phone = profilePhoneInput.value.trim();
  const bio = profileBioInput.value.trim();
  const address = profileAddressInput.value.trim();
  const city = profileCityInput.value.trim();
  const postal = profilePostalInput.value.trim();
  const landmark = profileLandmarkInput.value.trim();

  const existingAvatar = (currentUserProfile.profile && currentUserProfile.profile.avatar) || null;
  const avatar = pendingAvatarUrl === undefined ? existingAvatar : pendingAvatarUrl;

  const newProfile = { name, email, phone, bio, avatar };
  const hasDeliveryAddress = Boolean(address || city || postal || landmark || profilePinnedLocation);
  const newAddress = hasDeliveryAddress ? {
    name: name || currentUserProfile.address?.name || currentUser,
    phone: phone || currentUserProfile.address?.phone || "",
    address,
    city,
    postal,
    landmark,
    location: serializePinnedLocation(
      profilePinnedLocation,
      { address, city, postal },
      profilePinnedLocationStale
    )
  } : null;

  const { error } = await supabase
    .from("profiles")
    .update({ profile: newProfile, address: newAddress })
    .eq("id", currentUserId);

  if (error) {
    profileError.textContent = "Could not save your profile. Please try again.";
    return;
  }

  currentUserProfile.profile = newProfile;
  currentUserProfile.address = newAddress;
  profilePinnedLocation = normalizePinnedLocationValue(newAddress?.location, getProfileAddressFields());
  profilePinnedLocationStale = false;
  renderPinnedLocationCard(profileLocationCurrentEl, profilePinnedLocation, getProfileAddressFields(), false);
  accountMenuLabel.textContent = name || currentUser;
  renderAvatar(headerAvatar, avatar, currentUser);
  profileError.textContent = "";
  profileSuccess.textContent = "Profile and delivery address saved.";
  profileSuccess.classList.remove("hidden");
});

// ===================== Contact the owner =====================
function openContactModal(){
  contactError.textContent = "";
  openModalAccessible(contactModal, contactNameInput);
}
function closeContactModal(){
  closeModalAccessible(contactModal);
  contactForm.reset();
}

contactBtn.addEventListener("click", openContactModal);
contactModalClose.addEventListener("click", closeContactModal);
contactModal.addEventListener("click", (e) => {
  if (e.target === contactModal) closeContactModal();
});

contactForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (isHoneypotTripped("contact-hp")) {
    closeContactModal();
    return;
  }

  const name = contactNameInput.value.trim();
  const email = contactEmailInput.value.trim();
  const message = contactMessageInput.value.trim();

  if (!name || !email || !message) {
    contactError.textContent = "Please fill in every field before sending.";
    return;
  }

  const { error } = await supabase.from("messages").insert({
    id: createEntityId("MSG"),
    name, email, message,
    sent_at: Date.now()
  });

  if (error) {
    console.error("[Dagoldol] Could not save contact message:", error);
    contactError.textContent = "Your message could not be saved right now. Please try again, or email the owner directly from the Contact page.";
    return;
  }

  const subject = encodeURIComponent(`New message from ${name} — Dagoldol Shop`);
  const body = encodeURIComponent(`From: ${name} <${email}>\n\n${message}`);

  closeContactModal();
  showToast("Message saved to Dagoldol. Your email app will also be opened with a copy you can send to the owner.");
  window.location.href = `mailto:${OWNER_EMAIL}?subject=${subject}&body=${body}`;
});

// ===================== Modal accessibility: focus trap + Escape =====================
let activeModalEl = null;
const modalFocusStack = [];

function getFocusableEls(container){
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null);
}

function trapFocusKeydown(e){
  if (e.key === "Escape") {
    e.preventDefault();
    closeTopModal();
    return;
  }
  if (e.key !== "Tab" || !activeModalEl) return;
  const focusable = getFocusableEls(activeModalEl);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function openModalAccessible(modalEl, preferredFocusEl){
  const existingIndex = modalFocusStack.findIndex(entry => entry.modalEl === modalEl);
  if (existingIndex !== -1) modalFocusStack.splice(existingIndex, 1);

  modalFocusStack.push({
    modalEl,
    returnFocusEl: document.activeElement
  });
  modalEl.classList.remove("hidden");
  activeModalEl = modalEl;
  document.removeEventListener("keydown", trapFocusKeydown);
  document.addEventListener("keydown", trapFocusKeydown);
  const toFocus = (preferredFocusEl && !preferredFocusEl.disabled) ? preferredFocusEl : getFocusableEls(modalEl)[0];
  if (toFocus) toFocus.focus();
}

function closeModalAccessible(modalEl){
  modalEl.classList.add("hidden");
  const index = modalFocusStack.map(entry => entry.modalEl).lastIndexOf(modalEl);
  const entry = index >= 0 ? modalFocusStack.splice(index, 1)[0] : null;
  const top = modalFocusStack[modalFocusStack.length - 1] || null;
  activeModalEl = top ? top.modalEl : null;

  if (!activeModalEl) {
    document.removeEventListener("keydown", trapFocusKeydown);
  }

  if (entry?.returnFocusEl && document.body.contains(entry.returnFocusEl)) {
    entry.returnFocusEl.focus({ preventScroll: true });
  } else if (activeModalEl) {
    const fallback = getFocusableEls(activeModalEl)[0];
    if (fallback) fallback.focus({ preventScroll: true });
  }
}

function closeDeliveryMapModal(){
  deliveryMapRequestToken += 1;
  if (deliveryMapController){
    deliveryMapController.destroy();
    deliveryMapController = null;
  }
  pendingDeliveryMapSelection = null;
  deliveryMapTarget = null;
  if (deliveryMapConfirmBtn) deliveryMapConfirmBtn.disabled = true;
  if (deliveryMapLoading) deliveryMapLoading.textContent = "Loading map…";
  if (deliveryMapCanvas?.parentElement) deliveryMapCanvas.parentElement.classList.remove("is-ready");
  if (deliveryMapModal) closeModalAccessible(deliveryMapModal);
}

function currentSettingsDeliveryOriginLocation(){
  const configured = getConfiguredDeliveryOrigin();
  if (!configured) return null;
  return normalizePinnedLocationValue({
    latitude: configured.lat,
    longitude: configured.lon,
    source: "admin-origin",
    addressSnapshot: {
      address: configured.address,
      city: "",
      postal: ""
    },
    displayName: configured.address
  }, { address: configured.address, city: "", postal: "" });
}

function getAdminDeliveryOriginAddressFields(){
  const address = cleanAddressValue(
    adminDeliveryOriginDraft?.displayName ||
    adminDeliveryOriginDraft?.addressSnapshot?.address ||
    currentSettings.delivery_origin_address ||
    SHOP_ORIGIN_ADDRESS
  );
  return { address, city: "", postal: "" };
}

function formatDeliveryOriginSelectionAddress(selection){
  const explicit = cleanAddressValue(selection?.displayName);
  if (explicit) return explicit;
  const reverseAddress = selection?.address || {};
  return [reverseAddress.address, reverseAddress.city, reverseAddress.postal, "Philippines"]
    .map(cleanAddressValue)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(", ");
}

function updateAdminDeliveryOriginUi(){
  const card = document.getElementById("admin-delivery-origin-card");
  const addressInput = document.getElementById("admin-delivery-origin-address");
  const latitudeInput = document.getElementById("admin-delivery-origin-latitude");
  const longitudeInput = document.getElementById("admin-delivery-origin-longitude");
  const location = normalizePinnedLocationValue(adminDeliveryOriginDraft, getAdminDeliveryOriginAddressFields()) || currentSettingsDeliveryOriginLocation();
  const address = cleanAddressValue(
    adminDeliveryOriginDraft?.displayName ||
    adminDeliveryOriginDraft?.addressSnapshot?.address ||
    currentSettings.delivery_origin_address ||
    SHOP_ORIGIN_ADDRESS
  );

  if (addressInput) addressInput.value = address;
  if (latitudeInput) latitudeInput.value = location ? location.latitude.toFixed(6) : "";
  if (longitudeInput) longitudeInput.value = location ? location.longitude.toFixed(6) : "";
  if (card) {
    card.dataset.state = location ? "saved" : "empty";
    const title = card.querySelector(".delivery-location-card-title");
    const copy = card.querySelector(".delivery-location-card-copy");
    if (title) title.textContent = location ? "Delivery start location set" : "No delivery origin pinned";
    if (copy) copy.textContent = location
      ? `${address || "Pinned shop location"} · ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
      : "The existing Davao fallback will be used until you pin the owner/shop location.";
  }
}

function addressForDeliveryMapTarget(target){
  if (target === "profile") return getProfileAddressFields();
  if (target === "admin-origin") return getAdminDeliveryOriginAddressFields();
  return getCheckoutAddressFields();
}

function locationForDeliveryMapTarget(target){
  if (target === "profile") return profilePinnedLocation;
  if (target === "admin-origin") return adminDeliveryOriginDraft || currentSettingsDeliveryOriginLocation();
  return checkoutPinnedLocation;
}

function showCurrentLocationProgress(payload, target){
  if (!deliveryMapStatus || deliveryMapTarget !== target || deliveryMapModal?.classList.contains("hidden")) return;
  if (payload?.type === "position" && payload.position?.coords){
    const accuracy = Number(payload.bestPosition?.coords?.accuracy ?? payload.position.coords.accuracy);
    const accuracyText = Number.isFinite(accuracy)
      ? accuracy < 1000 ? `±${Math.max(1, Math.round(accuracy))} m` : `±${(accuracy / 1000).toFixed(1)} km`
      : "estimated accuracy";
    deliveryMapStatus.classList.remove("delivery-map-status-error");
    deliveryMapStatus.textContent = `Current location received (${accuracyText}). Preparing the pin…`;
  }
}

async function getCurrentLocationSelection(target){
  const requestTarget = target || deliveryMapTarget;
  if (!requestTarget) return null;

  if (deliveryMapController){
    return deliveryMapController.useCurrentLocation();
  }

  if (!pendingCurrentLocationRequest){
    const requestToken = deliveryMapRequestToken;
    pendingCurrentLocationRequest = (async () => {
      const mapModule = await loadDeliveryMapModule();
      const selection = await mapModule.getCurrentLocationSelection({
        onProgress(payload){ showCurrentLocationProgress(payload, requestTarget); }
      });
      if (requestToken !== deliveryMapRequestToken || deliveryMapTarget !== requestTarget) return null;
      return selection;
    })().finally(() => {
      pendingCurrentLocationRequest = null;
    });
  }

  return pendingCurrentLocationRequest;
}

async function openDeliveryMapPicker(target){
  if (!deliveryMapModal || !deliveryMapCanvas) return;
  if (deliveryMapController){
    deliveryMapController.destroy();
    deliveryMapController = null;
  }
  deliveryMapCanvas.replaceChildren();
  deliveryMapCanvas.parentElement?.classList.remove("is-ready");
  deliveryMapTarget = target;
  deliveryMapRequestToken += 1;
  pendingDeliveryMapSelection = locationForDeliveryMapTarget(target);
  if (deliveryMapConfirmBtn) deliveryMapConfirmBtn.disabled = !pendingDeliveryMapSelection;
  if (deliveryMapCurrentLocationBtn) deliveryMapCurrentLocationBtn.disabled = false;
  if (deliveryMapStatus) {
    deliveryMapStatus.classList.remove("delivery-map-status-error");
    deliveryMapStatus.textContent = target === "admin-origin"
      ? "Loading the map so you can set the delivery starting point…"
      : "Loading the delivery map…";
  }
  if (deliveryMapSummary) deliveryMapSummary.textContent = "Preparing map…";
  if (deliveryMapLoading) deliveryMapLoading.textContent = "Loading map…";

  openModalAccessible(deliveryMapModal, deliveryMapCloseBtn || deliveryMapCurrentLocationBtn);

  try {
    const mapModule = await loadDeliveryMapModule();
    if (deliveryMapTarget !== target || deliveryMapModal.classList.contains("hidden")) return;

    deliveryMapController = await mapModule.openDeliveryMap({
      container: deliveryMapCanvas,
      statusElement: deliveryMapStatus,
      summaryElement: deliveryMapSummary,
      initialLocation: locationForDeliveryMapTarget(target),
      initialAddress: addressForDeliveryMapTarget(target),
      onSelectionChange(selection){
        pendingDeliveryMapSelection = selection;
        if (deliveryMapConfirmBtn) deliveryMapConfirmBtn.disabled = !selection;
      }
    });
    if (pendingDeliveryMapSelection){
      await deliveryMapController.setSelection(pendingDeliveryMapSelection, { center: true });
    }
    if (deliveryMapCurrentLocationBtn) deliveryMapCurrentLocationBtn.disabled = false;
  } catch (error) {
    console.error("[Dagoldol] Could not initialize delivery map:", error);
    if (deliveryMapLoading) deliveryMapLoading.textContent = "Map unavailable";
    if (deliveryMapStatus){
      deliveryMapStatus.textContent = error?.message || "The interactive map could not load. You can close it and type the delivery address manually.";
      deliveryMapStatus.classList.add("delivery-map-status-error");
    }
    // Geolocation does not depend on the map renderer. Keep the button usable so
    // a customer can still capture device coordinates even if map tiles/scripts fail.
    if (deliveryMapCurrentLocationBtn) deliveryMapCurrentLocationBtn.disabled = false;
  }
}

function applyMapSelectionToTarget(target, selection){
  const normalized = normalizePinnedLocationValue(selection, addressForDeliveryMapTarget(target));
  if (!normalized) return false;
  const reverseAddress = selection?.address || {};

  if (target === "profile") {
    if (reverseAddress.address) profileAddressInput.value = reverseAddress.address;
    if (reverseAddress.city) profileCityInput.value = reverseAddress.city;
    if (reverseAddress.postal) profilePostalInput.value = reverseAddress.postal;
    profilePinnedLocation = normalizePinnedLocationValue({
      ...selection,
      addressSnapshot: getProfileAddressFields()
    }, getProfileAddressFields());
    profilePinnedLocationStale = false;
    renderPinnedLocationCard(profileLocationCurrentEl, profilePinnedLocation, getProfileAddressFields(), false);
    return true;
  }

  if (target === "admin-origin") {
    const originAddress = formatDeliveryOriginSelectionAddress(selection) || SHOP_ORIGIN_ADDRESS;
    adminDeliveryOriginDraft = normalizePinnedLocationValue({
      ...selection,
      source: "admin-origin",
      displayName: originAddress,
      addressSnapshot: { address: originAddress, city: "", postal: "" }
    }, { address: originAddress, city: "", postal: "" });
    if (adminDeliveryOriginDraft) adminDeliveryOriginDraft.displayName = originAddress;
    updateAdminDeliveryOriginUi();
    return Boolean(adminDeliveryOriginDraft);
  }

  if (reverseAddress.address) orderAddressInput.value = reverseAddress.address;
  if (reverseAddress.city) orderCityInput.value = reverseAddress.city;
  if (reverseAddress.postal) orderPostalInput.value = reverseAddress.postal;
  checkoutPinnedLocation = normalizePinnedLocationValue({
    ...selection,
    addressSnapshot: getCheckoutAddressFields()
  }, getCheckoutAddressFields());
  checkoutPinnedLocationStale = false;
  renderPinnedLocationCard(checkoutLocationCurrentEl, checkoutPinnedLocation, getCheckoutAddressFields(), false);
  void recalcDeliveryFee();
  return true;
}

async function openDeliveryMapForCheckout(){
  await openDeliveryMapPicker("checkout");
}

async function openDeliveryMapForProfile(){
  await openDeliveryMapPicker("profile");
}

if (checkoutLocationOpenBtn) checkoutLocationOpenBtn.addEventListener("click", () => { void openDeliveryMapForCheckout(); });
if (profileLocationOpenBtn) profileLocationOpenBtn.addEventListener("click", () => { void openDeliveryMapForProfile(); });
if (deliveryMapCloseBtn) deliveryMapCloseBtn.addEventListener("click", closeDeliveryMapModal);
if (deliveryMapCancelBtn) deliveryMapCancelBtn.addEventListener("click", closeDeliveryMapModal);
if (deliveryMapModal) deliveryMapModal.addEventListener("click", (event) => {
  if (event.target === deliveryMapModal) closeDeliveryMapModal();
});
if (deliveryMapCurrentLocationBtn) deliveryMapCurrentLocationBtn.addEventListener("click", async () => {
  const targetAtStart = deliveryMapTarget;
  if (!targetAtStart) return;
  const originalLabel = deliveryMapCurrentLocationBtn.textContent;
  deliveryMapCurrentLocationBtn.disabled = true;
  deliveryMapCurrentLocationBtn.textContent = "Locating…";
  if (deliveryMapStatus){
    deliveryMapStatus.classList.remove("delivery-map-status-error");
    deliveryMapStatus.textContent = "Requesting your device location… Keep Location Services and Wi-Fi/mobile data on.";
  }
  try {
    const selection = await getCurrentLocationSelection(targetAtStart);
    if (!selection || deliveryMapTarget !== targetAtStart) return;
    pendingDeliveryMapSelection = selection;
    if (deliveryMapController){
      await deliveryMapController.setSelection(selection, { center: true });
    } else if (deliveryMapSummary){
      const address = selection.address || {};
      deliveryMapSummary.textContent = [address.address, address.city, address.postal]
        .map(cleanAddressValue).filter(Boolean).join(", ") ||
        `${Number(selection.latitude).toFixed(5)}, ${Number(selection.longitude).toFixed(5)}`;
    }
    if (deliveryMapConfirmBtn) deliveryMapConfirmBtn.disabled = false;
  } catch (error) {
    if (deliveryMapStatus){
      deliveryMapStatus.textContent = error?.message || "Current location is unavailable. Tap the map to choose manually.";
      deliveryMapStatus.classList.add("delivery-map-status-error");
    }
  } finally {
    deliveryMapCurrentLocationBtn.disabled = false;
    deliveryMapCurrentLocationBtn.textContent = originalLabel || "Use my current location";
  }
});
if (deliveryMapConfirmBtn) deliveryMapConfirmBtn.addEventListener("click", () => {
  const selection = deliveryMapController?.getSelection?.() || pendingDeliveryMapSelection;
  if (!selection || !deliveryMapTarget) return;
  const target = deliveryMapTarget;
  if (applyMapSelectionToTarget(target, selection)) closeDeliveryMapModal();
});

function closeTopModal(){
  if (!activeModalEl) return;
  const map = {
    "size-modal": closeSizeModal,
    "profile-modal": closeProfileModal,
    "delivery-map-modal": closeDeliveryMapModal,
    "cart-modal": closeCartModal,
    "contact-modal": closeContactModal,
    "chat-modal": () => closeModalAccessible(chatModal)
  };
  const fn = map[activeModalEl.id];
  if (fn) fn();
  else closeModalAccessible(activeModalEl);
}

// ===================== Skip-to-content link =====================
(function wireSkipLink(){
  const skipLink = document.getElementById("skip-to-content");
  if (!skipLink) return;
  skipLink.addEventListener("click", (e) => {
    e.preventDefault();
    let target = null;
    if (!shopScreen.classList.contains("hidden")) {
      target = document.getElementById("catalogue");
    } else if (checkoutScreen && !checkoutScreen.classList.contains("hidden")) {
      target = document.getElementById("order-form");
    } else if (ordersScreen && !ordersScreen.classList.contains("hidden")) {
      target = document.getElementById("orders-list");
    } else if (!adminScreen.classList.contains("hidden")) {
      target = document.querySelector(".admin-panel");
    } else if (!loginScreen.classList.contains("hidden")) {
      target = document.querySelector(".login-card:not(.hidden)");
    }
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus();
    target.scrollIntoView({ block: "start" });
  });
})();

// =====================================================================
// ===================== DIRECT MESSAGES + REACTIONS ====================
// =====================================================================
const REACTION_EMOJIS = ["👍", "😆", "😮", "😢", "😡", "❤️"];

const CHAT_PRESENCE_CHANNEL_NAME = "dagoldol-presence";
let presenceChannel = null;
let presenceState = {};

let chatMessagesChannel = null;
let chatThreadsChannel = null;

let unreadChatCount = 0;
let dmTypingDebounce = null;

let currentDmThread = null;
let currentDmMessages = [];
let dmThreadsCache = [];
let cachedSellerProfile = null;

// ---- Elements ----
const chatBtn = document.getElementById("chat-btn");
const chatCountBadge = document.getElementById("chat-count");
const chatModal = document.getElementById("chat-modal");
const chatModalClose = document.getElementById("chat-modal-close");
const chatNewUsernameInput = document.getElementById("chat-new-username");
const chatNewStartBtn = document.getElementById("chat-new-start-btn");
const chatNewErrorEl = document.getElementById("chat-new-error");
const chatMessageSellerBtn = document.getElementById("chat-message-seller-btn");
const adminChatBtn = document.getElementById("admin-chat-btn");
const adminChatCountBadge = document.getElementById("admin-chat-count");

// ---- Thread id + profile lookup ----
function makeDmThreadId(idA, idB){
  return [idA, idB].sort().join("::");
}

async function findProfileByUsername(username){
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username")
    .ilike("username", username.trim())
    .maybeSingle();
  if (error) { console.error("[Dagoldol] findProfileByUsername:", error); return null; }
  if (!data) console.warn(`[Dagoldol] No profile row returned for username "${username}". If you're sure that account exists, this is almost always a Supabase Row Level Security policy blocking the lookup (RLS silently returns 0 rows instead of an error) — see the profiles SELECT policy.`);
  return data;
}

// The seller/admin account's username. Update this if the seller's account
// is ever renamed. Used as the primary lookup for "Message the Seller" so it
// doesn't depend on the profiles.role value being set/cased exactly right.
const SELLER_USERNAME = "lorenz";

async function getSellerProfile(){
  if (cachedSellerProfile) return cachedSellerProfile;

  // Try role="admin" first — this doesn't depend on matching the username
  // string exactly (whitespace/casing typos in the DB won't break it).
  const { data: byRole, error: roleError } = await supabase
    .from("profiles")
    .select("id, username, role")
    .ilike("role", "admin")
    .limit(1)
    .maybeSingle();
  if (roleError) console.error("[Dagoldol] getSellerProfile role lookup:", roleError);

  let profile = byRole || null;

  if (!profile) {
    profile = await findProfileByUsername(SELLER_USERNAME);
  }

  if (!profile) {
    console.error(`[Dagoldol] Could not find the seller's profile. Tried role="admin" and username "${SELLER_USERNAME}", found neither. Run this in the Supabase SQL editor to check what's actually stored: select id, username, role, length(username) from profiles;`);
    return null;
  }

  cachedSellerProfile = profile;
  return profile;
}

// ---- Thread + message data layer ----
async function ensureDmThread(otherId, otherUsername){
  const threadId = makeDmThreadId(currentUserId, otherId);
  const { data, error } = await supabase.from("dm_threads").select("*").eq("id", threadId).maybeSingle();
  if (error) { console.error("[Dagoldol] ensureDmThread:", error); return null; }
  if (data) return data;

  const now = Date.now();
  const [aId, bId] = [currentUserId, otherId].sort();
  const row = {
    id: threadId,
    user_a_id: aId,
    user_a_username: aId === currentUserId ? currentUser : otherUsername,
    user_b_id: bId,
    user_b_username: bId === currentUserId ? currentUser : otherUsername,
    created_at: now,
    last_message_at: null,
    last_message_preview: "",
    user_a_last_read_at: now,
    user_b_last_read_at: now
  };
  const { error: insertError } = await supabase.from("dm_threads").insert(row);
  if (insertError) { console.error("[Dagoldol] ensureDmThread insert:", insertError); return null; }
  return row;
}

async function fetchMyDmThreads(){
  const { data, error } = await supabase
    .from("dm_threads")
    .select("*")
    .or(`user_a_id.eq.${currentUserId},user_b_id.eq.${currentUserId}`)
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (error) { console.error("[Dagoldol] fetchMyDmThreads:", error); return []; }
  return data || [];
}

function otherPartyOfThread(thread){
  return thread.user_a_id === currentUserId
    ? { id: thread.user_b_id, username: thread.user_b_username }
    : { id: thread.user_a_id, username: thread.user_a_username };
}
function myDmReadField(thread){
  return thread.user_a_id === currentUserId ? "user_a_last_read_at" : "user_b_last_read_at";
}

function mapDmMessageRow(row){
  return {
    id: row.id, threadId: row.thread_id, senderId: row.sender_id,
    senderUsername: row.sender_username, body: row.body,
    sentAt: Number(row.sent_at), reactions: row.reactions || {}
  };
}

async function fetchDmMessages(threadId){
  const { data, error } = await supabase.from("dm_messages").select("*").eq("thread_id", threadId).order("sent_at", { ascending: true });
  if (error) { console.error("[Dagoldol] fetchDmMessages:", error); return []; }
  return (data || []).map(mapDmMessageRow);
}

async function sendDmMessage(threadId, body){
  const sentAt = Date.now();
  const row = {
    id: createEntityId("DM"),
    thread_id: threadId, sender_id: currentUserId, sender_username: currentUser,
    body, sent_at: sentAt, reactions: {}
  };
  const { error } = await supabase.from("dm_messages").insert(row);
  if (error) { console.error("[Dagoldol] sendDmMessage:", error); return null; }

  const { error: threadError } = await supabase
    .from("dm_threads")
    .update({ last_message_at: sentAt, last_message_preview: body.slice(0, 80) })
    .eq("id", threadId);

  if (threadError) {
    console.error("[Dagoldol] Message saved but thread preview update failed:", threadError);
  }
  return row;
}

async function markDmThreadRead(threadId, thread){
  const field = myDmReadField(thread);
  const now = Date.now();
  await supabase.from("dm_threads").update({ [field]: now }).eq("id", threadId);
  thread[field] = now;
}

async function computeMyDmUnreadCount(){
  const threads = await fetchMyDmThreads();
  return threads.filter(t => {
    const field = myDmReadField(t);
    return t.last_message_at && (!t[field] || t.last_message_at > t[field]);
  }).length;
}

// ---- Reactions ----
async function toggleDmReaction(message, emoji){
  const reactions = {};
  Object.entries(message.reactions || {}).forEach(([key, uids]) => { reactions[key] = uids.slice(); });

  let hadThisEmoji = false;
  Object.keys(reactions).forEach(key => {
    const before = reactions[key].length;
    reactions[key] = reactions[key].filter(uid => uid !== currentUserId);
    if (key === emoji && reactions[key].length < before) hadThisEmoji = true;
    if (!reactions[key].length) delete reactions[key];
  });
  if (!hadThisEmoji) {
    reactions[emoji] = [...(reactions[emoji] || []), currentUserId];
  }

  const { error } = await supabase.from("dm_messages").update({ reactions }).eq("id", message.id);
  if (error) { console.error("[Dagoldol] toggleDmReaction:", error); return; }
  message.reactions = reactions;
}

// ---- Rendering messages with reactions ----
function renderDmMessages(containerEl, messages){
  if (!containerEl) return;
  containerEl.innerHTML = messages.map(m => {
    const mine = m.senderId === currentUserId;
    const chips = Object.entries(m.reactions || {})
      .filter(([, uids]) => uids.length)
      .map(([emoji, uids]) => `
        <button type="button" class="reaction-chip ${uids.includes(currentUserId) ? "reaction-chip-mine" : ""}" data-msg="${m.id}" data-emoji="${emoji}">${emoji} ${uids.length}</button>
      `).join("");
    return `
      <div class="chat-bubble-row ${mine ? "chat-bubble-row-mine" : ""}">
        <div class="chat-bubble ${mine ? "chat-bubble-mine" : "chat-bubble-theirs"}">
          <button type="button" class="chat-react-toggle" data-msg="${m.id}" aria-label="React">+</button>
          <div class="reaction-picker" data-msg="${m.id}">
            ${REACTION_EMOJIS.map(e => `<button type="button" class="reaction-picker-btn" data-msg="${m.id}" data-emoji="${e}">${e}</button>`).join("")}
          </div>
          <p class="chat-bubble-text">${escapeHtml(m.body)}</p>
          <p class="chat-bubble-meta">${formatChatTime(m.sentAt)}</p>
        </div>
        ${chips ? `<div class="reaction-chips ${mine ? "reaction-chips-mine" : ""}">${chips}</div>` : ""}
      </div>
    `;
  }).join("");
  containerEl.scrollTop = containerEl.scrollHeight;

  containerEl.querySelectorAll(".chat-react-toggle").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const picker = containerEl.querySelector(`.reaction-picker[data-msg="${btn.dataset.msg}"]`);
      containerEl.querySelectorAll(".reaction-picker.open").forEach(p => { if (p !== picker) p.classList.remove("open"); });
      if (picker) picker.classList.toggle("open");
    });
  });
  containerEl.querySelectorAll(".reaction-picker-btn, .reaction-chip").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const msg = currentDmMessages.find(m => m.id === btn.dataset.msg);
      if (!msg) return;
      await toggleDmReaction(msg, btn.dataset.emoji);
      renderDmMessages(containerEl, currentDmMessages);
    });
  });
}
document.addEventListener("click", () => {
  document.querySelectorAll(".reaction-picker.open").forEach(p => p.classList.remove("open"));
});

// ---- Presence ----
function isUserOnline(userId){
  return !!(presenceState[userId] && presenceState[userId].length);
}
function isUserTypingInThread(userId, threadId){
  const entries = presenceState[userId] || [];
  return entries.some(p => p.typing && p.activeThread === threadId);
}
function setDmTyping(typing){
  if (!presenceChannel || !currentDmThread) return;
  presenceChannel.track({ username: currentUser, typing, activeThread: currentDmThread.id });
}

function initPresenceGeneric(){
  if (presenceChannel) supabase.removeChannel(presenceChannel);
  presenceChannel = supabase.channel(CHAT_PRESENCE_CHANNEL_NAME, { config: { presence: { key: currentUserId } } });
  presenceChannel.on("presence", { event: "sync" }, () => {
    presenceState = presenceChannel.presenceState();
    renderDmThreadList();
    if (currentDmThread) {
      const other = otherPartyOfThread(currentDmThread);
      const dot = document.getElementById("dm-online-dot");
      if (dot) dot.className = isUserOnline(other.id) ? "online-dot" : "offline-dot";
      const typingEl = document.getElementById("dm-typing-indicator");
      if (typingEl) typingEl.classList.toggle("hidden", !isUserTypingInThread(other.id, currentDmThread.id));
    }
  });
  presenceChannel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") await presenceChannel.track({ username: currentUser, typing: false, activeThread: null });
  });
}

// ---- Thread list + conversation panel ----
async function refreshDmThreadList(){
  dmThreadsCache = await fetchMyDmThreads();
  renderDmThreadList();
}

function renderDmThreadList(){
  const listEl = document.getElementById("chat-threads-inner");
  if (!listEl) return;
  if (!dmThreadsCache.length) {
    listEl.innerHTML = buildEmptyState(EMPTY_ICON_CHAT, "No conversations yet", "Start one above by entering a username.");
    return;
  }
  listEl.innerHTML = dmThreadsCache.map(t => {
    const other = otherPartyOfThread(t);
    const field = myDmReadField(t);
    const unread = t.last_message_at && (!t[field] || t.last_message_at > t[field]);
    const active = currentDmThread && currentDmThread.id === t.id;
    return `
      <button type="button" class="admin-chat-thread-item ${active ? "active" : ""}" data-thread="${t.id}">
        <span class="${isUserOnline(other.id) ? "online-dot" : "offline-dot"}"></span>
        <span class="admin-chat-thread-name">${escapeHtml(other.username)}</span>
        ${unread ? `<span class="admin-chat-thread-badge">•</span>` : ""}
        <span class="admin-chat-thread-preview">${escapeHtml((t.last_message_preview || "").slice(0, 40))}</span>
      </button>
    `;
  }).join("");
  listEl.querySelectorAll("[data-thread]").forEach(btn => {
    btn.addEventListener("click", () => openDmThreadById(btn.dataset.thread));
  });
}

async function openDmThreadById(threadId){
  const thread = dmThreadsCache.find(t => t.id === threadId);
  if (!thread) return;
  currentDmThread = thread;
  currentDmMessages = await fetchDmMessages(threadId);
  renderDmConversationPanel();
  await markDmThreadRead(threadId, thread);
  unreadChatCount = await computeMyDmUnreadCount();
  updateChatBadge();
  updateDocumentTitleUnread(unreadChatCount);
  renderDmThreadList();
}

function renderDmConversationPanel(){
  const panel = document.getElementById("chat-conversation-panel");
  if (!panel) return;
  if (!currentDmThread) { panel.innerHTML = `<p class="admin-empty">Select a conversation, or start a new one.</p>`; return; }
  const other = otherPartyOfThread(currentDmThread);
  panel.innerHTML = `
    <div class="chat-conversation-header">
      <span id="dm-online-dot" class="${isUserOnline(other.id) ? "online-dot" : "offline-dot"}"></span>
      <span>${escapeHtml(other.username)}</span>
    </div>
    <div class="chat-messages-list" id="dm-messages-list"></div>
    <p class="chat-typing-indicator hidden" id="dm-typing-indicator">${escapeHtml(other.username)} is typing…</p>
    <form class="chat-input-row" id="dm-form">
      <input type="text" id="dm-input" placeholder="Type a message…" maxlength="2000" autocomplete="off">
      <button type="submit" class="btn-primary" style="width:auto;">Send</button>
    </form>
  `;
  renderDmMessages(document.getElementById("dm-messages-list"), currentDmMessages);

  document.getElementById("dm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("dm-input");
    const body = input.value.trim();
    if (!body) return;
    input.value = "";
    setDmTyping(false);
    const row = await sendDmMessage(currentDmThread.id, body);
    if (row && !currentDmMessages.some(message => message.id === row.id)) {
      currentDmMessages.push(mapDmMessageRow(row));
      renderDmMessages(document.getElementById("dm-messages-list"), currentDmMessages);
    }
  });
  document.getElementById("dm-input").addEventListener("input", () => {
    setDmTyping(true);
    clearTimeout(dmTypingDebounce);
    dmTypingDebounce = setTimeout(() => setDmTyping(false), 2000);
  });
}

function updateChatBadge(){
  if (chatCountBadge) {
    chatCountBadge.textContent = unreadChatCount;
    chatCountBadge.classList.toggle("hidden", unreadChatCount === 0);
  }
  if (adminChatCountBadge) {
    adminChatCountBadge.textContent = unreadChatCount;
    adminChatCountBadge.classList.toggle("hidden", unreadChatCount === 0);
  }
}

function currentRouteTitleBase(){
  const path = normalizeAppPath();
  if (path === APP_ROUTES.CHECKOUT) return "Checkout — Dagoldol";
  if (path === APP_ROUTES.ORDERS) return "My Orders — Dagoldol";
  if (path === APP_ROUTES.ADMIN) return "Dagoldol — Admin";
  return DOCUMENT_TITLE_BASE;
}

function updateDocumentTitleUnread(count){
  const base = currentRouteTitleBase();
  document.title = count > 0 ? `(${count}) ${base}` : base;
}

function showChatNotification(title, body){
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted" && document.hidden) {
    try { new Notification(title, { body }); } catch (err) { /* ignore */ }
  }
}

// Random profile suggestions were removed in Phase 3. The current chat UI supports explicit username lookup and direct seller messaging only.

async function openChatModal(){
  if (!currentUserId) return;
  if (chatNewUsernameInput) chatNewUsernameInput.value = "";
  if (chatNewErrorEl) chatNewErrorEl.textContent = "";
  currentDmThread = null;
  renderDmConversationPanel();
  await refreshDmThreadList();
  openModalAccessible(chatModal, chatNewUsernameInput);
}

if (chatNewStartBtn) {
  chatNewStartBtn.addEventListener("click", async () => {
    const username = chatNewUsernameInput.value.trim();
    chatNewErrorEl.textContent = "";
    if (!username) { chatNewErrorEl.textContent = "Enter a username."; return; }
    if (username.toLowerCase() === (currentUser || "").toLowerCase()) { chatNewErrorEl.textContent = "You can't chat with yourself."; return; }

    const profile = await findProfileByUsername(username);
    if (!profile) { chatNewErrorEl.textContent = `No user found with the username "${username}".`; return; }

    const thread = await ensureDmThread(profile.id, profile.username);
    if (!thread) { chatNewErrorEl.textContent = "Could not start that chat — check the browser console (F12). This usually means the dm_threads/dm_messages tables haven't been created in Supabase yet."; return; }

    chatNewUsernameInput.value = "";
    await refreshDmThreadList();
    await openDmThreadById(thread.id);
  });
}

if (chatMessageSellerBtn) {
  chatMessageSellerBtn.addEventListener("click", async () => {
    const seller = await getSellerProfile();
    if (!seller) {
      showToast("Could not find the seller's account — check the browser console (F12) for details, or that your Supabase profiles table allows this lookup.");
      return;
    }
    if (seller.id === currentUserId) {
      showToast("You're logged in as the seller — there's no one to message. Log in as a customer account to test this.");
      return;
    }
    const thread = await ensureDmThread(seller.id, seller.username);
    if (!thread) {
      showToast("Could not start that chat — check the browser console (F12). This usually means the dm_threads/dm_messages tables haven't been created in Supabase yet.");
      return;
    }
    await refreshDmThreadList();
    await openDmThreadById(thread.id);
  });
}

if (chatBtn) chatBtn.addEventListener("click", () => requireLogin(openChatModal, "Log in to chat."));
if (adminChatBtn) adminChatBtn.addEventListener("click", openChatModal);
if (chatModalClose) chatModalClose.addEventListener("click", () => closeModalAccessible(chatModal));
if (chatModal) chatModal.addEventListener("click", (e) => { if (e.target === chatModal) closeModalAccessible(chatModal); });

// ---- Realtime ----
function subscribeDmRealtime(){
  if (chatMessagesChannel) supabase.removeChannel(chatMessagesChannel);
  chatMessagesChannel = supabase
    .channel("dm-messages-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "dm_messages" }, async (payload) => {
      const msg = mapDmMessageRow(payload.new);
      if (currentDmThread && msg.threadId === currentDmThread.id) {
        if (!currentDmMessages.some(m => m.id === msg.id)) currentDmMessages.push(msg);
        renderDmMessages(document.getElementById("dm-messages-list"), currentDmMessages);
        if (msg.senderId !== currentUserId) await markDmThreadRead(currentDmThread.id, currentDmThread);
      } else if (msg.senderId !== currentUserId) {
        unreadChatCount += 1;
        updateChatBadge();
        updateDocumentTitleUnread(unreadChatCount);
        showChatNotification(msg.senderUsername, msg.body);
        showToast(`New message from ${msg.senderUsername}: ${msg.body}`);
      }
      await refreshDmThreadList();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "dm_messages" }, (payload) => {
      const updated = mapDmMessageRow(payload.new);
      const idx = currentDmMessages.findIndex(m => m.id === updated.id);
      if (idx > -1) {
        currentDmMessages[idx] = updated;
        renderDmMessages(document.getElementById("dm-messages-list"), currentDmMessages);
      }
    })
    .subscribe();

  if (chatThreadsChannel) supabase.removeChannel(chatThreadsChannel);
  chatThreadsChannel = supabase
    .channel("dm-threads-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "dm_threads" }, () => refreshDmThreadList())
    .subscribe();
}

function teardownChatRealtime(){
  if (presenceChannel) { supabase.removeChannel(presenceChannel); presenceChannel = null; }
  if (chatMessagesChannel) { supabase.removeChannel(chatMessagesChannel); chatMessagesChannel = null; }
  if (chatThreadsChannel) { supabase.removeChannel(chatThreadsChannel); chatThreadsChannel = null; }
  presenceState = {};
  currentDmThread = null;
  currentDmMessages = [];
  dmThreadsCache = [];
  unreadChatCount = 0;
  updateDocumentTitleUnread(0);
}

// =====================================================================
// ===================== ADMIN DASHBOARD ===============================
// =====================================================================

const adminTabButtons = document.querySelectorAll(".admin-tab-btn");
const adminTabPanels = {
  orders: document.getElementById("admin-tab-orders"),
  products: document.getElementById("admin-tab-products"),
  bundles: document.getElementById("admin-tab-bundles"),
  brands: document.getElementById("admin-tab-brands"),
  "flash-sales": document.getElementById("admin-tab-flash-sales"),
  promos: document.getElementById("admin-tab-promos"),
  messages: document.getElementById("admin-tab-messages"),
  accounts: document.getElementById("admin-tab-accounts"),
  analytics: document.getElementById("admin-tab-analytics"),
  activity: document.getElementById("admin-tab-activity"),
  settings: document.getElementById("admin-tab-settings")
};

async function activateAdminTab(tab){
  const targetButton = Array.from(adminTabButtons).find(button => button.dataset.tab === tab);
  if (!targetButton || !adminTabPanels[tab]) return;

  adminTabButtons.forEach(button => button.classList.toggle("active", button === targetButton));
  Object.entries(adminTabPanels).forEach(([key, panel]) => {
    panel.classList.toggle("hidden", key !== tab);
  });

  if (tab === "orders") await renderAdminOrders();
  else if (tab === "products") await renderAdminProducts();
  else if (tab === "bundles") await renderAdminBundles();
  else if (tab === "brands") await renderAdminBrands();
  else if (tab === "flash-sales") await renderAdminFlashSales();
  else if (tab === "promos") await renderAdminPromos();
  else if (tab === "messages") await renderAdminMessages();
  else if (tab === "accounts") await renderAdminAccounts();
  else if (tab === "analytics") await renderAdminAnalytics();
  else if (tab === "activity") await renderAdminActivity();
  else if (tab === "settings") await renderAdminSettings();
}

adminTabButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    void activateAdminTab(btn.dataset.tab);
  });
});

// ---------- Orders tab (FIX #8: paginated) ----------
const ADMIN_ORDERS_PAGE_SIZE = 15;
let adminOrdersVisibleCount = ADMIN_ORDERS_PAGE_SIZE;

async function fetchAllOrders(limit){
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .order("placed_at", { ascending: false })
    .range(0, (limit || ADMIN_ORDERS_PAGE_SIZE) - 1);
  if (error) { reportLoadError("Orders", error); return []; }
  return (data || []).map(row => ({ username: row.username, order: mapOrderRow(row) }));
}

async function setOrderStatus(orderId, stepIndex){
  const { error } = await supabase.from("orders").update({ status_override: stepIndex }).eq("id", orderId);
  if (error) { console.error(error); return; }
  await renderAdminOrders();
}

async function deleteOrder(orderId){
  const { error } = await supabase.from("orders").delete().eq("id", orderId);
  if (error) { console.error(error); return; }
  await renderAdminOrders();
}

async function hydrateAdminPaymentProofUrls(entries){
  await Promise.all((entries || []).map(async ({ order }) => {
    if (!order || !order.paymentProof) return;
    order.paymentProofDisplayUrl = await createSignedStorageUrl("payment-proofs", order.paymentProof, 300);
  }));
}

async function renderAdminOrders(){
  if (adminTabPanels.orders) adminTabPanels.orders.innerHTML = `<h2 class="admin-section-title">Orders</h2>${buildSkeletonRows(4)}`;
  adminOrdersCache = await fetchAllOrders(adminOrdersVisibleCount);
  await hydrateAdminPaymentProofUrls(adminOrdersCache);
  renderAdminOrdersTab();
}

function renderAdminOrdersTab(){
  const panel = adminTabPanels.orders;
  const flat = adminOrdersCache;

  if (flat.length === 0) {
    panel.innerHTML = `<h2 class="admin-section-title">Orders</h2>${buildEmptyState(EMPTY_ICON_ORDERS, "No orders yet", "Orders placed by customers will show up here.")}`;
    return;
  }

  panel.innerHTML = `
    <h2 class="admin-section-title">Orders (showing ${flat.length})</h2>
    <div class="admin-card-list">
      ${flat.map(({ username, order }) => {
        const itemsSummary = order.items.map(item => `${escapeHtml(item.name)} ×${item.qty}`).join(", ");
        const halfNote = order.halfPayment
          ? ` · <strong>Half payment:</strong> ${formatPrice(order.amountDueNow)} paid upfront, ${formatPrice(order.amountDueLater)} due on delivery`
          : "";
        const promoNote = order.promoCode ? ` · Code <strong>${escapeHtml(order.promoCode)}</strong> (-${formatPrice(order.promoDiscount)})` : "";
        const refLine = order.paymentReference
          ? `<br><strong>Payment reference:</strong> ${escapeHtml(order.paymentReference)}`
          : `<br><span style="color:var(--rust)">No payment reference on file</span>`;
        const proofThumb = order.paymentProofDisplayUrl
          ? `<br><span class="admin-payment-proof-thumb"><img src="${escapeHtml(order.paymentProofDisplayUrl)}" alt="Payment proof for ${escapeHtml(order.id)}" class="zoomable-img" loading="lazy" decoding="async"></span>`
          : (order.paymentProof ? `<br><span style="color:var(--rust)">Payment proof is stored but could not be opened.</span>` : "");
        const statusSection = order.cancelled
          ? `<p class="order-cancelled-badge">Cancelled by customer</p>`
          : (() => {
              const status = getOrderStatus(order);
              const statusBtns = TRACKER_STEPS.map((label, i) => `
                <button type="button" class="admin-status-btn ${i === status.stepIndex ? "current" : ""}" data-order="${order.id}" data-step="${i}">${label}</button>
              `).join("");
              return `<div class="admin-status-controls">${statusBtns}</div>`;
            })();

        return `
          <div class="admin-card">
            <div class="admin-card-header">
              <span class="admin-card-title">${escapeHtml(order.id)}</span>
              <span class="admin-card-meta">${formatDate(new Date(order.placedAt))}</span>
            </div>
            <div class="admin-card-body">
              <strong>${escapeHtml(username)}</strong> · ${itemsSummary}<br>
              Subtotal ${formatPrice(order.subtotal)}${promoNote} + delivery ${formatPrice(order.deliveryFee)}${order.bulkFee ? ` + bulk fee (${Math.round((order.bulkFeeRate || 0) * 100)}%) ${formatPrice(order.bulkFee)}` : ""} = <strong>${formatPrice(order.total)}</strong><br>
              Payment: <strong>${escapeHtml(paymentMethodLabel(order.paymentMethod))}</strong>${halfNote} · Ship to: ${escapeHtml(order.address.name)}, ${escapeHtml(order.address.address)}, ${escapeHtml(order.address.city)} ${escapeHtml(order.address.postal)} · ${escapeHtml(order.address.phone)}
              ${order.address.landmark ? `<br><span class="admin-card-landmark">📍 Landmark: ${escapeHtml(order.address.landmark)}</span>` : ""}
              ${refLine}${proofThumb}
            </div>
            ${statusSection}
            <div class="admin-card-actions">
              <button type="button" class="admin-btn-danger" data-order="${order.id}" data-action="delete-order">Delete order</button>
            </div>
          </div>
        `;
      }).join("")}
    </div>
    <div class="load-more-row">
      <button type="button" class="btn-secondary load-more-btn ${flat.length < adminOrdersVisibleCount ? "hidden" : ""}" id="admin-orders-load-more-btn">Load more orders</button>
    </div>
  `;

  panel.querySelectorAll(".admin-status-btn").forEach(btn => {
    btn.addEventListener("click", () => setOrderStatus(btn.dataset.order, Number(btn.dataset.step)));
  });
  panel.querySelectorAll("[data-action='delete-order']").forEach(btn => {
    btn.addEventListener("click", () => {
      if (confirm(`Delete order ${btn.dataset.order}? This cannot be undone.`)) {
        deleteOrder(btn.dataset.order);
      }
    });
  });
  const loadMoreBtn = document.getElementById("admin-orders-load-more-btn");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      adminOrdersVisibleCount += ADMIN_ORDERS_PAGE_SIZE;
      renderAdminOrders();
    });
  }
}

// ---------- Products tab: per-size builder (now with stock) + brand + low-stock banner ----------
function createSizeBuilderRow(unitType, optionValue, existing){
  const checked = !!existing;
  const price = existing ? existing.price : "";
  const stock = existing && existing.stock !== undefined && existing.stock !== null ? existing.stock : "";
  const image = existing ? existing.image : null;
  const label = formatUnitValue(unitType, optionValue);
  return `
    <div class="size-builder-row" data-feet="${escapeHtml(String(optionValue))}" ${image ? `data-image="${escapeHtml(image)}"` : ""}>
      <label class="size-builder-checkbox-row">
        <input type="checkbox" class="size-builder-enable" ${checked ? "checked" : ""}>
        <span>${escapeHtml(label)}</span>
      </label>
      <div>
        <span class="size-builder-label-small">Price</span>
        <input type="number" class="size-builder-price" placeholder="Price" min="0" step="0.01" value="${price}" ${checked ? "" : "disabled"}>
      </div>
      <div>
        <span class="size-builder-label-small">Stock (blank = unlimited)</span>
        <input type="number" class="size-builder-stock" placeholder="Stock" min="0" step="1" value="${stock}" ${checked ? "" : "disabled"}>
      </div>
      <div class="size-builder-image">
        <div class="size-thumb">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(label)} photo" class="zoomable-img" loading="lazy" decoding="async">` : ""}</div>
        <label class="link-btn size-builder-upload-label">Photo<input type="file" accept="image/*" class="hidden size-builder-upload"></label>
        <span class="avatar-upload-status hidden size-builder-upload-status">Uploading…</span>
      </div>
    </div>
  `;
}

function renderSizeBuilder(containerEl, existingSizes, unitType){
  const map = {};
  (existingSizes || []).forEach(s => { map[String(s.feet)] = s; });
  const options = optionsForUnitType(unitType);
  containerEl.innerHTML = options.map(opt => createSizeBuilderRow(unitType, opt, map[String(opt)])).join("");

  containerEl.querySelectorAll(".size-builder-row").forEach(row => {
    const checkbox = row.querySelector(".size-builder-enable");
    const priceInput = row.querySelector(".size-builder-price");
    const stockInput = row.querySelector(".size-builder-stock");
    const uploadInput = row.querySelector(".size-builder-upload");
    const uploadStatus = row.querySelector(".size-builder-upload-status");

    checkbox.addEventListener("change", () => {
      priceInput.disabled = !checkbox.checked;
      stockInput.disabled = !checkbox.checked;
    });

    uploadInput.addEventListener("change", async () => {
      const file = uploadInput.files[0];
      if (!file) return;
      try {
        if (uploadStatus) uploadStatus.classList.remove("hidden");
        const url = await uploadImageToStorage(file, "product-images", "sizes", 500);
        row.dataset.image = url;
        row.querySelector(".size-thumb").innerHTML = `<img src="${escapeHtml(url)}" alt="size photo" class="zoomable-img" loading="lazy" decoding="async">`;
        if (!checkbox.checked) {
          checkbox.checked = true;
          priceInput.disabled = false;
          stockInput.disabled = false;
          priceInput.focus();
        }
      } catch (err) {
        console.error("[Dagoldol] Could not upload size photo:", err);
        showErrorBanner("Could not upload that photo. Check your connection and try again.");
      } finally {
        if (uploadStatus) uploadStatus.classList.add("hidden");
      }
    });
  });
}

function collectSizesFromBuilder(containerEl, unitType){
  const sizes = [];
  containerEl.querySelectorAll(".size-builder-row").forEach(row => {
    const checkbox = row.querySelector(".size-builder-enable");
    if (!checkbox.checked) return;
    const feet = unitType === "size" ? row.dataset.feet : Number(row.dataset.feet);
    const price = Number(row.querySelector(".size-builder-price").value) || 0;
    const stockRaw = row.querySelector(".size-builder-stock").value;
    const stock = stockRaw === "" ? undefined : Math.max(0, Math.floor(Number(stockRaw)));
    const image = row.dataset.image || null;
    const entry = { feet, price, image };
    if (stock !== undefined) entry.stock = stock;
    sizes.push(entry);
  });
  return sortSizesByUnit(sizes, unitType);
}

function renderBrandSelectOptions(selectedId){
  const options = [`<option value="">No brand</option>`].concat(
    brands.map(b => `<option value="${b.id}" ${b.id === selectedId ? "selected" : ""}>${escapeHtml(b.name)}</option>`)
  );
  return options.join("");
}

async function addProduct(name, desc, accent, sizes, brandId, unitType){
  const id = "p" + Date.now().toString(36);
  const { error } = await supabase.from("products").insert({ id, name, description: desc, accent, icon: GENERIC_ICON, sizes, brand_id: brandId || null, unit_type: unitType });
  if (error) console.error("[Dagoldol] addProduct failed:", error);
  return error || null;
}

async function updateProduct(id, name, desc, accent, sizes, brandId, unitType){
  const { error } = await supabase.from("products").update({ name, description: desc, accent, sizes, brand_id: brandId || null, unit_type: unitType }).eq("id", id);
  if (error) console.error("[Dagoldol] updateProduct failed:", error);
  return error || null;
}

async function deleteProduct(id){
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) console.error(error);
}

async function renderAdminProducts(){
  if (adminTabPanels.products) adminTabPanels.products.innerHTML = `<h2 class="admin-section-title">Products</h2>${buildSkeletonRows(3)}`;
  products = await loadProducts();
  await Promise.all([loadRatingsMap(), loadBrands(), loadFlashSales()]);
  renderAdminProductsTab();
}

function renderLowStockBanner(){
  const lowStock = computeLowStockItems();
  if (lowStock.length === 0) return "";
  return `
    <div class="low-stock-banner">
      <p class="low-stock-banner-title">⚠ Low Stock Alerts (${lowStock.length})</p>
      ${lowStock.map(item => `
        <p class="low-stock-line"><strong>${escapeHtml(item.productName)}</strong> — ${escapeHtml(formatUnitValue(item.unitType, item.feet))}: ${item.stock <= 0 ? "<strong style=\"color:var(--rust)\">Out of stock</strong>" : `${item.stock} left`}</p>
      `).join("")}
    </div>
  `;
}

function renderAdminProductsTab(){
  const panel = adminTabPanels.products;

  panel.innerHTML = `
    <h2 class="admin-section-title">Products (${products.length})</h2>
    ${renderLowStockBanner()}

    <form class="admin-add-form" id="admin-add-product-form">
      <p class="admin-form-title">Add a new product</p>
      <label class="field">
        <span>Name</span>
        <input type="text" id="admin-new-name" placeholder="Product name" required>
      </label>
      <label class="field">
        <span>Description</span>
        <input type="text" id="admin-new-desc" placeholder="Short description" required>
      </label>
      <label class="field">
        <span>Brand</span>
        <select id="admin-new-brand">${renderBrandSelectOptions(null)}</select>
      </label>
      <label class="field">
        <span>Accent color</span>
        <div class="admin-color-field">
          <input type="color" id="admin-new-accent" value="#8a6b3d">
        </div>
      </label>

      <label class="field">
        <span>Measurement type</span>
        <select id="admin-new-unit-type">
          <option value="feet">Feet — sold by length (2 ft – 15 ft)</option>
          <option value="size">Size — a label like S / M / L</option>
          <option value="sqm">Square Meters (sqm) — sold by area</option>
        </select>
      </label>
      <p class="field-hint" style="margin:-10px 0 14px;">Pick one — a product is sold in feet, size, or sqm, never a mix. Changing this after sizes are entered below resets the size list to match the new type.</p>

      <div class="admin-sizes-field">
        <span class="field-label-standalone">Sizes, pricing &amp; stock — check every size you offer, set its price and stock (leave stock blank for unlimited), and add a photo for that size</span>
        <div class="size-builder-grid" id="admin-new-size-builder"></div>
      </div>

      <p id="admin-product-error" class="error-message"></p>
      <button type="submit" class="btn-primary" style="margin-top:4px;">Add product</button>
    </form>

    <div class="admin-card-list">
      ${products.map(p => {
        const brand = findBrand(p.brandId);
        const sale = getActiveFlashSale(p.id);
        return `
        <div class="admin-card" data-product-card="${p.id}">
          <div class="admin-card-header">
            <span class="admin-card-title">${escapeHtml(p.name)}${brand ? ` <span style="color:var(--brass); font-size:0.8rem;">· ${escapeHtml(brand.name)}</span>` : ""}</span>
            <span class="admin-card-meta">${priceRangeLabel(p)}${sale ? ` · ⚡ ${sale.discountPercent}% off` : ""}</span>
          </div>
          <div class="admin-card-body">
            ${escapeHtml(p.desc)} <span style="color:var(--brass); font-size:0.76rem;">· ${UNIT_TYPE_LABELS[p.unitType] || "Feet"}</span><br>
            ${(p.sizes || []).length ? p.sizes.map(s => `${escapeHtml(formatUnitValue(p.unitType, s.feet))}: ${formatPrice(s.price)}${s.stock !== undefined ? ` (stock: ${s.stock})` : ""}`).join(" · ") : "No sizes set yet"}
            ${(() => { const r = getAverageRating(p.id); return r ? `<br>★ ${r.avg.toFixed(1)} (${r.count} rating${r.count === 1 ? "" : "s"})` : ""; })()}
          </div>
          <div class="admin-card-actions">
            <button type="button" class="admin-btn-edit" data-id="${p.id}" data-action="edit-product">Edit</button>
            <button type="button" class="admin-btn-danger" data-id="${p.id}" data-action="delete-product">Delete</button>
          </div>
        </div>
      `;
      }).join("")}
    </div>
  `;

  const newUnitTypeSelect = document.getElementById("admin-new-unit-type");
  renderSizeBuilder(document.getElementById("admin-new-size-builder"), [], newUnitTypeSelect.value);
  newUnitTypeSelect.addEventListener("change", () => {
    renderSizeBuilder(document.getElementById("admin-new-size-builder"), [], newUnitTypeSelect.value);
  });

  document.getElementById("admin-add-product-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("admin-new-name").value.trim();
    const desc = document.getElementById("admin-new-desc").value.trim();
    const brandId = document.getElementById("admin-new-brand").value || null;
    const accent = document.getElementById("admin-new-accent").value;
    const unitType = newUnitTypeSelect.value;
    const sizeBuilderEl = document.getElementById("admin-new-size-builder");
    const sizes = collectSizesFromBuilder(sizeBuilderEl, unitType);
    const errEl = document.getElementById("admin-product-error");

    if (!name || !desc) {
      errEl.textContent = "Please fill in every field.";
      return;
    }
    if (sizes.length === 0) {
      errEl.textContent = "Please select at least one size and set its price.";
      return;
    }

    errEl.textContent = "";
    const submitBtn = document.getElementById("admin-add-product-form").querySelector("button[type='submit']");
    submitBtn.disabled = true;
    const error = await addProduct(name, desc, accent, sizes, brandId, unitType);
    submitBtn.disabled = false;

    if (error) {
      errEl.textContent = `Could not add product: ${error.message || "unknown error"}. Check the browser console (F12) for details, and make sure your Supabase "products" table allows inserts, and has "brand_id" and "unit_type" columns.`;
      return;
    }

    await renderAdminProducts();
    renderCatalogueList();
  });

  panel.querySelectorAll("[data-action='delete-product']").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (confirm(`Remove "${findProduct(btn.dataset.id)?.name}" from the catalogue?`)) {
        await deleteProduct(btn.dataset.id);
        await renderAdminProducts();
        renderCatalogueList();
      }
    });
  });

  panel.querySelectorAll("[data-action='edit-product']").forEach(btn => {
    btn.addEventListener("click", () => renderProductEditForm(btn.dataset.id));
  });
}

function renderProductEditForm(id){
  const product = findProduct(id);
  if (!product) return;
  const card = document.querySelector(`[data-product-card="${id}"]`);
  if (!card) return;

  const builderId = `admin-edit-size-builder-${id}`;
  const unitTypeSelectId = `admin-edit-unit-type-${id}`;
  const currentUnitType = product.unitType || "feet";

  card.innerHTML = `
    <p class="admin-form-title">Editing ${escapeHtml(product.name)}</p>
    <label class="field"><span>Name</span><input type="text" class="admin-edit-name" value="${escapeHtml(product.name)}"></label>
    <label class="field"><span>Description</span><input type="text" class="admin-edit-desc" value="${escapeHtml(product.desc)}"></label>
    <label class="field"><span>Brand</span><select class="admin-edit-brand">${renderBrandSelectOptions(product.brandId)}</select></label>
    <label class="field"><span>Accent color</span><div class="admin-color-field"><input type="color" class="admin-edit-accent" value="${product.accent}"></div></label>
    <label class="field">
      <span>Measurement type</span>
      <select id="${unitTypeSelectId}" class="admin-edit-unit-type">
        <option value="feet" ${currentUnitType === "feet" ? "selected" : ""}>Feet — sold by length (2 ft – 15 ft)</option>
        <option value="size" ${currentUnitType === "size" ? "selected" : ""}>Size — a label like S / M / L</option>
        <option value="sqm" ${currentUnitType === "sqm" ? "selected" : ""}>Square Meters (sqm) — sold by area</option>
      </select>
    </label>
    <p class="field-hint" style="margin:-10px 0 14px;">Changing this resets the size list below to match the new type — re-enter prices/stock after switching.</p>
    <div class="admin-sizes-field">
      <span class="field-label-standalone">Sizes, pricing &amp; stock</span>
      <div class="size-builder-grid" id="${builderId}"></div>
    </div>
    <p class="error-message" id="admin-edit-error-${id}"></p>
    <div class="admin-card-actions">
      <button type="button" class="btn-primary" data-id="${id}" data-action="save-product" style="width:auto; padding:8px 16px; margin-top:0;">Save</button>
      <button type="button" class="admin-btn-edit" data-action="cancel-edit">Cancel</button>
    </div>
  `;

  const unitTypeSelect = document.getElementById(unitTypeSelectId);
  renderSizeBuilder(document.getElementById(builderId), product.sizes, currentUnitType);
  unitTypeSelect.addEventListener("change", () => {
    renderSizeBuilder(document.getElementById(builderId), [], unitTypeSelect.value);
  });

  card.querySelector("[data-action='save-product']").addEventListener("click", async () => {
    const name = card.querySelector(".admin-edit-name").value.trim();
    const desc = card.querySelector(".admin-edit-desc").value.trim();
    const brandId = card.querySelector(".admin-edit-brand").value || null;
    const accent = card.querySelector(".admin-edit-accent").value;
    const unitType = unitTypeSelect.value;
    const sizes = collectSizesFromBuilder(document.getElementById(builderId), unitType);
    const errEl = document.getElementById(`admin-edit-error-${id}`);

    if (!name || !desc) { errEl.textContent = "Please fill in every field."; return; }
    if (sizes.length === 0) { errEl.textContent = "Please select at least one size and set its price."; return; }

    const saveBtn = card.querySelector("[data-action='save-product']");
    saveBtn.disabled = true;
    const error = await updateProduct(id, name, desc, accent, sizes, brandId, unitType);
    saveBtn.disabled = false;

    if (error) {
      errEl.textContent = `Could not save changes: ${error.message || "unknown error"}. Check the browser console (F12) for details.`;
      return;
    }

    await renderAdminProducts();
    renderCatalogueList();
  });

  card.querySelector("[data-action='cancel-edit']").addEventListener("click", renderAdminProductsTab);
}

// ---------- Brands tab ----------
async function addBrand(name, description, logo){
  const id = "brand-" + Date.now().toString(36);
  const { error } = await supabase.from("brands").insert({ id, name, description, logo: logo || null });
  if (error) console.error("[Dagoldol] addBrand failed:", error);
  return error || null;
}

async function deleteBrand(id){
  const { error } = await supabase.from("brands").delete().eq("id", id);
  if (error) console.error(error);
}

async function renderAdminBrands(){
  if (adminTabPanels.brands) adminTabPanels.brands.innerHTML = `<h2 class="admin-section-title">Brands</h2>${buildSkeletonRows(2)}`;
  await loadBrands();
  renderAdminBrandsTab();
}

let pendingBrandLogoUrl = null;

function renderAdminBrandsTab(){
  const panel = adminTabPanels.brands;

  panel.innerHTML = `
    <h2 class="admin-section-title">Brands (${brands.length})</h2>

    <form class="admin-add-form" id="admin-add-brand-form">
      <p class="admin-form-title">Add a brand</p>
      <label class="field">
        <span>Brand name</span>
        <input type="text" id="admin-new-brand-name" placeholder="Brand name" required>
      </label>
      <label class="field">
        <span>Description (optional)</span>
        <input type="text" id="admin-new-brand-desc" placeholder="Short description">
      </label>
      <div class="avatar-field">
        <div class="size-thumb" id="admin-new-brand-logo-preview" style="width:56px; height:56px;"></div>
        <div class="avatar-field-controls">
          <label class="link-btn avatar-upload-label" for="admin-new-brand-logo-input">Choose logo</label>
          <input type="file" id="admin-new-brand-logo-input" accept="image/*" class="hidden">
          <span class="avatar-upload-status hidden" id="admin-new-brand-logo-status">Uploading…</span>
        </div>
      </div>
      <p id="admin-brand-error" class="error-message"></p>
      <button type="submit" class="btn-primary" style="margin-top:4px;">Add brand</button>
    </form>

    <div class="admin-card-list">
      ${brands.map(b => `
        <div class="admin-card">
          <div class="admin-card-header">
            <span class="admin-card-title">
              <span class="brand-chip">
                <span class="brand-chip-logo">${b.logo ? `<img src="${escapeHtml(b.logo)}" alt="${escapeHtml(b.name)}" class="zoomable-img" loading="lazy" decoding="async">` : ""}</span>
                ${escapeHtml(b.name)}
              </span>
            </span>
          </div>
          <div class="admin-card-body">${escapeHtml(b.description || "No description.")}</div>
          <div class="admin-card-actions">
            <button type="button" class="admin-btn-danger" data-id="${b.id}" data-action="delete-brand">Delete</button>
          </div>
        </div>
      `).join("") || buildEmptyState(EMPTY_ICON_CRATE, "No brands yet", "Add one above to start tagging products.")}
    </div>
  `;

  pendingBrandLogoUrl = null;
  const logoInput = document.getElementById("admin-new-brand-logo-input");
  const logoPreview = document.getElementById("admin-new-brand-logo-preview");
  const logoStatus = document.getElementById("admin-new-brand-logo-status");
  logoInput.addEventListener("change", async () => {
    const file = logoInput.files[0];
    if (!file) return;
    try {
      if (logoStatus) logoStatus.classList.remove("hidden");
      pendingBrandLogoUrl = await uploadImageToStorage(file, "brand-logos", "logos", 200);
      logoPreview.innerHTML = `<img src="${escapeHtml(pendingBrandLogoUrl)}" alt="Brand logo" loading="lazy" decoding="async">`;
    } catch (err) {
      console.error("[Dagoldol] Could not upload brand logo:", err);
      showErrorBanner("Could not upload that logo. Check your connection and try again.");
    } finally {
      if (logoStatus) logoStatus.classList.add("hidden");
    }
  });

  document.getElementById("admin-add-brand-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("admin-new-brand-name").value.trim();
    const description = document.getElementById("admin-new-brand-desc").value.trim();
    const errEl = document.getElementById("admin-brand-error");

    if (!name) { errEl.textContent = "Please enter a brand name."; return; }

    errEl.textContent = "";
    const submitBtn = document.getElementById("admin-add-brand-form").querySelector("button[type='submit']");
    submitBtn.disabled = true;
    const error = await addBrand(name, description, pendingBrandLogoUrl);
    submitBtn.disabled = false;

    if (error) {
      errEl.textContent = `Could not add brand: ${error.message || "unknown error"}. Make sure your Supabase project has a "brands" table.`;
      return;
    }

    await renderAdminBrands();
    populateBrandFilterOptions();
  });

  panel.querySelectorAll("[data-action='delete-brand']").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (confirm("Delete this brand? Products keep their existing name but will show no brand tag.")) {
        await deleteBrand(btn.dataset.id);
        await renderAdminBrands();
        populateBrandFilterOptions();
        renderCatalogueList();
      }
    });
  });
}

// ---------- Flash Sales tab ----------
async function addFlashSale(productId, discountPercent, startAt, endAt, label){
  const id = "fs-" + Date.now().toString(36);
  const { error } = await supabase.from("flash_sales").insert({
    id, product_id: productId, discount_percent: discountPercent, start_at: startAt, end_at: endAt, active: true, label
  });
  if (error) console.error("[Dagoldol] addFlashSale failed:", error);
  return error || null;
}

async function deleteFlashSale(id){
  const { error } = await supabase.from("flash_sales").delete().eq("id", id);
  if (error) console.error(error);
}

async function toggleFlashSaleActive(id, active){
  const { error } = await supabase.from("flash_sales").update({ active }).eq("id", id);
  if (error) console.error(error);
}

async function renderAdminFlashSales(){
  if (adminTabPanels["flash-sales"]) adminTabPanels["flash-sales"].innerHTML = `<h2 class="admin-section-title">Flash Sales</h2>${buildSkeletonRows(2)}`;
  products = products.length ? products : await loadProducts();
  await loadFlashSales();
  renderAdminFlashSalesTab();
}

function datetimeLocalToMs(value){
  if (!value) return null;
  const t = new Date(value).getTime();
  return isNaN(t) ? null : t;
}
function renderAdminFlashSalesTab(){
  const panel = adminTabPanels["flash-sales"];

  const productOptions = products.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");

  panel.innerHTML = `
    <h2 class="admin-section-title">Flash Sales (${flashSales.length})</h2>

    <form class="admin-add-form" id="admin-add-flash-form">
      <p class="admin-form-title">Create a flash sale</p>
      <label class="field">
        <span>Product</span>
        <select id="admin-flash-product" required>${productOptions}</select>
      </label>
      <div class="field-row">
        <label class="field">
          <span>Discount %</span>
          <input type="number" id="admin-flash-discount" min="1" max="90" value="20" required>
        </label>
        <label class="field">
          <span>Label</span>
          <input type="text" id="admin-flash-label" value="Flash Sale" required>
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span>Starts</span>
          <input type="datetime-local" id="admin-flash-start" required>
        </label>
        <label class="field">
          <span>Ends</span>
          <input type="datetime-local" id="admin-flash-end" required>
        </label>
      </div>
      <p id="admin-flash-error" class="error-message"></p>
      <button type="submit" class="btn-primary" style="margin-top:4px;">Create flash sale</button>
    </form>

    <div class="admin-card-list">
      ${flashSales.map(fs => {
        const product = findProduct(fs.productId);
        const statusLabel = flashSaleStatusLabel(fs);
        return `
          <div class="admin-card">
            <div class="admin-card-header">
              <span class="admin-card-title">${product ? escapeHtml(product.name) : "(removed product)"} · -${fs.discountPercent}%</span>
              <span class="admin-card-meta">${statusLabel}</span>
            </div>
            <div class="admin-card-body">
              ${escapeHtml(fs.label)}<br>
              ${formatDateTime(new Date(fs.startAt))} → ${formatDateTime(new Date(fs.endAt))}
            </div>
            <div class="admin-card-actions">
              <button type="button" class="admin-btn-edit" data-id="${fs.id}" data-active="${fs.active ? "0" : "1"}" data-action="toggle-flash">${fs.active ? "Deactivate" : "Activate"}</button>
              <button type="button" class="admin-btn-danger" data-id="${fs.id}" data-action="delete-flash">Delete</button>
            </div>
          </div>
        `;
      }).join("") || buildEmptyState(EMPTY_ICON_CRATE, "No flash sales yet", "Create one above to feature a limited-time discount.")}
    </div>
  `;

  document.getElementById("admin-add-flash-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const productId = document.getElementById("admin-flash-product").value;
    const discountPercent = Number(document.getElementById("admin-flash-discount").value) || 0;
    const label = document.getElementById("admin-flash-label").value.trim() || "Flash Sale";
    const startAt = datetimeLocalToMs(document.getElementById("admin-flash-start").value);
    const endAt = datetimeLocalToMs(document.getElementById("admin-flash-end").value);
    const errEl = document.getElementById("admin-flash-error");

    if (!productId || !startAt || !endAt || discountPercent <= 0) {
      errEl.textContent = "Please fill in every field with a valid discount and date range.";
      return;
    }
    if (endAt <= startAt) {
      errEl.textContent = "The end time must be after the start time.";
      return;
    }

    errEl.textContent = "";
    const submitBtn = document.getElementById("admin-add-flash-form").querySelector("button[type='submit']");
    submitBtn.disabled = true;
    const error = await addFlashSale(productId, discountPercent, startAt, endAt, label);
    submitBtn.disabled = false;

    if (error) {
      errEl.textContent = `Could not create flash sale: ${error.message || "unknown error"}. Make sure your Supabase project has a "flash_sales" table.`;
      return;
    }

    await renderAdminFlashSales();
    renderCatalogueList();
  });

  panel.querySelectorAll("[data-action='toggle-flash']").forEach(btn => {
    btn.addEventListener("click", async () => {
      await toggleFlashSaleActive(btn.dataset.id, btn.dataset.active === "1");
      await renderAdminFlashSales();
      renderCatalogueList();
    });
  });

  panel.querySelectorAll("[data-action='delete-flash']").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (confirm("Delete this flash sale?")) {
        await deleteFlashSale(btn.dataset.id);
        await renderAdminFlashSales();
        renderCatalogueList();
      }
    });
  });
}

// ---------- Vouchers & Coupons tab ----------
async function addPromoCode(row){
  const id = "promo-" + Date.now().toString(36);
  const { error } = await supabase.from("promo_codes").insert({
    id,
    code: row.code,
    kind: row.kind,
    discount_type: row.discountType,
    value: row.value,
    min_spend: row.minSpend,
    max_uses: row.maxUses,
    used_count: 0,
    expires_at: row.expiresAt,
    active: true
  });
  if (error) console.error("[Dagoldol] addPromoCode failed:", error);
  return error || null;
}

async function deletePromoCode(id){
  const { error } = await supabase.from("promo_codes").delete().eq("id", id);
  if (error) console.error(error);
}

async function togglePromoActive(id, active){
  const { error } = await supabase.from("promo_codes").update({ active }).eq("id", id);
  if (error) console.error(error);
}

async function renderAdminPromos(){
  if (adminTabPanels.promos) adminTabPanels.promos.innerHTML = `<h2 class="admin-section-title">Vouchers &amp; Coupons</h2>${buildSkeletonRows(2)}`;
  await loadPromoCodes();
  renderAdminPromosTab();
}

function renderAdminPromosTab(){
  const panel = adminTabPanels.promos;

  panel.innerHTML = `
    <h2 class="admin-section-title">Vouchers &amp; Coupons (${promoCodes.length})</h2>

    <form class="admin-add-form" id="admin-add-promo-form">
      <p class="admin-form-title">Create a code</p>
      <div class="field-row">
        <label class="field">
          <span>Code</span>
          <input type="text" id="admin-promo-code" placeholder="e.g. SAVE10" required style="text-transform:uppercase;">
        </label>
        <label class="field">
          <span>Kind</span>
          <select id="admin-promo-kind">
            <option value="coupon">Coupon</option>
            <option value="voucher">Voucher</option>
          </select>
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span>Discount type</span>
          <select id="admin-promo-discount-type">
            <option value="percent">Percent off</option>
            <option value="fixed">Fixed amount off</option>
          </select>
        </label>
        <label class="field">
          <span>Value</span>
          <input type="number" id="admin-promo-value" min="0" step="0.01" placeholder="e.g. 10" required>
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span>Minimum spend (optional)</span>
          <input type="number" id="admin-promo-min-spend" min="0" step="0.01" value="0">
        </label>
        <label class="field">
          <span>Max uses (optional)</span>
          <input type="number" id="admin-promo-max-uses" min="1" step="1" placeholder="Unlimited">
        </label>
      </div>
      <label class="field">
        <span>Expires (optional)</span>
        <input type="datetime-local" id="admin-promo-expires">
      </label>
      <p id="admin-promo-error" class="error-message"></p>
      <button type="submit" class="btn-primary" style="margin-top:4px;">Create code</button>
    </form>

    <div class="admin-card-list">
      ${promoCodes.map(p => {
        const valueLabel = p.discountType === "percent" ? `${p.value}% off` : `${formatPrice(p.value)} off`;
        const usesLabel = p.maxUses != null ? `${p.usedCount} / ${p.maxUses} used` : `${p.usedCount} used`;
        const expiresLabel = p.expiresAt ? formatDateTime(new Date(p.expiresAt)) : "No expiry";
        const statusLabel = !p.active ? "Inactive" : (p.expiresAt && Date.now() > p.expiresAt ? "Expired" : (p.maxUses != null && p.usedCount >= p.maxUses ? "Limit reached" : "Active"));
        return `
          <div class="admin-card">
            <div class="admin-card-header">
              <span class="admin-card-title">${escapeHtml(p.code)} <span style="color:var(--brass-bright); font-size:0.8rem;">(${escapeHtml(p.kind)})</span></span>
              <span class="admin-card-meta">${statusLabel}</span>
            </div>
            <div class="admin-card-body">
              ${valueLabel}${p.minSpend > 0 ? ` · min. spend ${formatPrice(p.minSpend)}` : ""}<br>
              ${usesLabel} · Expires: ${expiresLabel}
            </div>
            <div class="admin-card-actions">
              <button type="button" class="admin-btn-edit" data-id="${p.id}" data-active="${p.active ? "0" : "1"}" data-action="toggle-promo">${p.active ? "Deactivate" : "Activate"}</button>
              <button type="button" class="admin-btn-danger" data-id="${p.id}" data-action="delete-promo">Delete</button>
            </div>
          </div>
        `;
      }).join("") || buildEmptyState(EMPTY_ICON_CRATE, "No codes yet", "Create a voucher or coupon above.")}
    </div>
  `;

  document.getElementById("admin-add-promo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("admin-promo-code").value.trim().toUpperCase();
    const kind = document.getElementById("admin-promo-kind").value;
    const discountType = document.getElementById("admin-promo-discount-type").value;
    const value = Number(document.getElementById("admin-promo-value").value) || 0;
    const minSpend = Number(document.getElementById("admin-promo-min-spend").value) || 0;
    const maxUsesRaw = document.getElementById("admin-promo-max-uses").value;
    const maxUses = maxUsesRaw === "" ? null : Math.max(1, Math.floor(Number(maxUsesRaw)));
    const expiresAt = datetimeLocalToMs(document.getElementById("admin-promo-expires").value);
    const errEl = document.getElementById("admin-promo-error");

    if (!code || value <= 0) {
      errEl.textContent = "Please enter a code and a discount value greater than 0.";
      return;
    }
    if (promoCodes.some(p => p.code.toUpperCase() === code)) {
      errEl.textContent = "That code already exists.";
      return;
    }

    errEl.textContent = "";
    const submitBtn = document.getElementById("admin-add-promo-form").querySelector("button[type='submit']");
    submitBtn.disabled = true;
    const error = await addPromoCode({ code, kind, discountType, value, minSpend, maxUses, expiresAt });
    submitBtn.disabled = false;

    if (error) {
      errEl.textContent = `Could not create code: ${error.message || "unknown error"}. Make sure your Supabase project has a "promo_codes" table.`;
      return;
    }

    await renderAdminPromos();
  });

  panel.querySelectorAll("[data-action='toggle-promo']").forEach(btn => {
    btn.addEventListener("click", async () => {
      await togglePromoActive(btn.dataset.id, btn.dataset.active === "1");
      await renderAdminPromos();
    });
  });

  panel.querySelectorAll("[data-action='delete-promo']").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (confirm("Delete this code?")) {
        await deletePromoCode(btn.dataset.id);
        await renderAdminPromos();
      }
    });
  });
}

// ---------- Bundles tab ----------
const BUNDLE_MAX_ROWS = 5;

async function addBundle(name, desc, accent, items, bundlePrice){
  const id = "bundle-" + Date.now().toString(36);
  const { error } = await supabase.from("bundles").insert({
    id, name, description: desc, accent, icon: GENERIC_ICON, items, bundle_price: bundlePrice, active: true
  });
  if (error) console.error("[Dagoldol] addBundle failed:", error);
  return error || null;
}

async function deleteBundleRow(id){
  const { error } = await supabase.from("bundles").delete().eq("id", id);
  if (error) console.error(error);
}

async function toggleBundleActive(id, active){
  const { error } = await supabase.from("bundles").update({ active }).eq("id", id);
  if (error) console.error(error);
}

async function loadAllBundlesForAdmin(){
  const { data, error } = await supabase.from("bundles").select("*").order("name");
  if (error) { reportLoadError("Bundles", error); return []; }
  return (data || []).map(mapBundleRow);
}

async function renderAdminBundles(){
  if (adminTabPanels.bundles) adminTabPanels.bundles.innerHTML = `<h2 class="admin-section-title">Product Bundles</h2>${buildSkeletonRows(2)}`;
  products = products.length ? products : await loadProducts();
  const allBundles = await loadAllBundlesForAdmin();
  renderAdminBundlesTab(allBundles);
}

function bundleBuilderRow(index){
  const sizeOptions = `<option value="">Size</option>`;
  return `
    <div class="bundle-builder-row" data-row="${index}">
      <select class="bundle-builder-product">
        <option value="">Select product…</option>
        ${products.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}
      </select>
      <select class="bundle-builder-size">${sizeOptions}</select>
      <input type="number" class="bundle-builder-qty" min="1" value="1" placeholder="Qty">
    </div>
  `;
}

function wireBundleBuilderRow(rowEl){
  const productSelect = rowEl.querySelector(".bundle-builder-product");
  const sizeSelect = rowEl.querySelector(".bundle-builder-size");
  productSelect.addEventListener("change", () => {
    const product = findProduct(productSelect.value);
    sizeSelect.innerHTML = product
      ? product.sizes.map(s => `<option value="${escapeHtml(String(s.feet))}">${escapeHtml(formatUnitValue(product.unitType, s.feet))} — ${formatPrice(s.price)}</option>`).join("")
      : `<option value="">Size</option>`;
  });
}

function renderAdminBundlesTab(allBundles){
  const panel = adminTabPanels.bundles;

  panel.innerHTML = `
    <h2 class="admin-section-title">Product Bundles (${allBundles.length})</h2>

    <form class="admin-add-form" id="admin-add-bundle-form">
      <p class="admin-form-title">Create a bundle</p>
      <label class="field">
        <span>Bundle name</span>
        <input type="text" id="admin-bundle-name" placeholder="e.g. Starter Set" required>
      </label>
      <label class="field">
        <span>Description</span>
        <input type="text" id="admin-bundle-desc" placeholder="Short description" required>
      </label>

      <div class="admin-sizes-field">
        <span class="field-label-standalone">Items in this bundle (pick product, size, and quantity for each)</span>
        <div id="admin-bundle-rows">
          ${Array.from({ length: BUNDLE_MAX_ROWS }).map((_, i) => bundleBuilderRow(i)).join("")}
        </div>
      </div>

      <label class="field">
        <span>Bundle price (the special combined price)</span>
        <input type="number" id="admin-bundle-price" min="0" step="0.01" placeholder="e.g. 4500" required>
      </label>

      <p id="admin-bundle-error" class="error-message"></p>
      <button type="submit" class="btn-primary" style="margin-top:4px;">Create bundle</button>
    </form>

    <div class="admin-card-list">
      ${allBundles.map(b => {
        const regularTotal = b.items.reduce((sum, comp) => {
          const product = findProduct(comp.productId);
          return product ? sum + priceForFeet(product, comp.feet) * comp.qty : sum;
        }, 0);
        const savings = Math.max(0, regularTotal - b.bundlePrice);
        return `
          <div class="admin-card">
            <div class="admin-card-header">
              <span class="admin-card-title">${escapeHtml(b.name)}</span>
              <span class="admin-card-meta">${b.active ? "Active" : "Inactive"}</span>
            </div>
            <div class="admin-card-body">
              ${escapeHtml(b.desc)}<br>
              ${b.items.map(bundleComponentLabel).join(" · ")}<br>
              Bundle price: <strong>${formatPrice(b.bundlePrice)}</strong> (regular total ${formatPrice(regularTotal)}${savings > 0 ? `, saves ${formatPrice(savings)}` : ""})
            </div>
            <div class="admin-card-actions">
              <button type="button" class="admin-btn-edit" data-id="${b.id}" data-active="${b.active ? "0" : "1"}" data-action="toggle-bundle">${b.active ? "Deactivate" : "Activate"}</button>
              <button type="button" class="admin-btn-danger" data-id="${b.id}" data-action="delete-bundle">Delete</button>
            </div>
          </div>
        `;
      }).join("") || buildEmptyState(EMPTY_ICON_CRATE, "No bundles yet", "Create one above to combine products at a special price.")}
    </div>
  `;

  document.querySelectorAll("#admin-bundle-rows .bundle-builder-row").forEach(wireBundleBuilderRow);

  document.getElementById("admin-add-bundle-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("admin-bundle-name").value.trim();
    const desc = document.getElementById("admin-bundle-desc").value.trim();
    const bundlePrice = Number(document.getElementById("admin-bundle-price").value) || 0;
    const errEl = document.getElementById("admin-bundle-error");

    const items = [];
    document.querySelectorAll("#admin-bundle-rows .bundle-builder-row").forEach(row => {
      const productId = row.querySelector(".bundle-builder-product").value;
      const rawSize = row.querySelector(".bundle-builder-size").value;
      const product = findProduct(productId);
      const feet = (product && product.unitType === "size") ? rawSize : Number(rawSize);
      const qty = Math.max(1, Math.floor(Number(row.querySelector(".bundle-builder-qty").value)) || 1);
      if (productId && (feet || feet === 0)) items.push({ productId, feet, qty });
    });

    if (!name || !desc) { errEl.textContent = "Please fill in every field."; return; }
    if (items.length === 0) { errEl.textContent = "Please add at least one item to the bundle."; return; }
    if (bundlePrice <= 0) { errEl.textContent = "Please set a bundle price greater than 0."; return; }

    errEl.textContent = "";
    const submitBtn = document.getElementById("admin-add-bundle-form").querySelector("button[type='submit']");
    submitBtn.disabled = true;
    const error = await addBundle(name, desc, "#8a6b3d", items, bundlePrice);
    submitBtn.disabled = false;

    if (error) {
      errEl.textContent = `Could not create bundle: ${error.message || "unknown error"}. Make sure your Supabase project has a "bundles" table.`;
      return;
    }

    await renderAdminBundles();
    renderCatalogueList();
  });

  panel.querySelectorAll("[data-action='toggle-bundle']").forEach(btn => {
    btn.addEventListener("click", async () => {
      await toggleBundleActive(btn.dataset.id, btn.dataset.active === "1");
      await renderAdminBundles();
      renderCatalogueList();
    });
  });

  panel.querySelectorAll("[data-action='delete-bundle']").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (confirm(`Delete the "${btn.closest('.admin-card').querySelector('.admin-card-title').textContent}" bundle?`)) {
        await deleteBundleRow(btn.dataset.id);
        await renderAdminBundles();
        renderCatalogueList();
      }
    });
  });
}

// ---------- Messages tab ----------
let adminMessagesCache = [];

async function deleteMessage(id){
  const { error } = await supabase.from("messages").delete().eq("id", id);
  if (error) { console.error(error); return; }
  await renderAdminMessages();
}

async function renderAdminMessages(){
  if (adminTabPanels.messages) adminTabPanels.messages.innerHTML = `<h2 class="admin-section-title">Messages</h2>${buildSkeletonRows(2)}`;
  const { data, error } = await supabase.from("messages").select("*").order("sent_at", { ascending: false });
  if (error) reportLoadError("Messages", error);
  adminMessagesCache = error ? [] : (data || []);
  renderAdminMessagesTab();
}

function renderAdminMessagesTab(){
  const panel = adminTabPanels.messages;
  const messages = adminMessagesCache;

  if (messages.length === 0) {
    panel.innerHTML = `<h2 class="admin-section-title">Messages</h2>${buildEmptyState(EMPTY_ICON_MESSAGE, "No messages yet", "Notes sent through the Contact form will land here.")}`;
    return;
  }

  panel.innerHTML = `
    <h2 class="admin-section-title">Messages (${messages.length})</h2>
    <div class="admin-card-list">
      ${messages.map(m => `
        <div class="admin-card">
          <div class="admin-card-header">
            <span class="admin-card-title">${escapeHtml(m.name)}</span>
            <span class="admin-card-meta">${formatDateTime(new Date(m.sent_at))}</span>
          </div>
          <div class="admin-card-body"><strong>${escapeHtml(m.email)}</strong><br>${escapeHtml(m.message)}</div>
          <div class="admin-card-actions">
            <button type="button" class="admin-btn-danger" data-id="${m.id}" data-action="delete-message">Delete</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;

  panel.querySelectorAll("[data-action='delete-message']").forEach(btn => {
    btn.addEventListener("click", () => deleteMessage(btn.dataset.id));
  });
}

// ---------- Accounts tab ----------
let adminAccountsCache = [];
let adminOrderCountsByUserId = new Map();

async function deleteAuthUserViaEdgeFunction(userId){
  try {
    const { data, error } = await supabase.functions.invoke("delete-auth-user", {
      body: { userId }
    });

    if (error) {
      console.warn("[Dagoldol] delete-auth-user Edge Function call failed:", error);
      return {
        ok: false,
        message: "The protected account-deletion service is unavailable or refused the request."
      };
    }

    if (data && data.error) {
      return { ok: false, message: String(data.error) };
    }

    return { ok: true, message: "" };
  } catch (err) {
    console.warn("[Dagoldol] delete-auth-user Edge Function could not be reached:", err);
    return {
      ok: false,
      message: "The protected account-deletion service could not be reached."
    };
  }
}

async function deleteAccount(username, profileId){
  const result = await deleteAuthUserViaEdgeFunction(profileId);

  if (!result.ok) {
    showErrorBanner(`Account "${username}" was not deleted. ${result.message}`);
    return;
  }

  showToast(`Account "${username}" was deleted through the protected administrator function.`);
  await renderAdminAccounts();
}

async function renderAdminAccounts(){
  if (adminTabPanels.accounts) adminTabPanels.accounts.innerHTML = `<h2 class="admin-section-title">Accounts</h2>${buildSkeletonRows(3)}`;

  const [profilesResult, orderCountResult] = await Promise.all([
    supabase.from("profiles").select("*").eq("role", "customer"),
    supabase.from("orders").select("user_id")
  ]);

  if (profilesResult.error) reportLoadError("Accounts", profilesResult.error);
  if (orderCountResult.error) reportLoadError("Account order counts", orderCountResult.error);

  adminAccountsCache = profilesResult.error ? [] : (profilesResult.data || []);
  adminOrderCountsByUserId = new Map();

  if (!orderCountResult.error) {
    (orderCountResult.data || []).forEach(row => {
      const userId = row.user_id;
      if (!userId) return;
      adminOrderCountsByUserId.set(userId, (adminOrderCountsByUserId.get(userId) || 0) + 1);
    });
  }

  renderAdminAccountsTab();
}

function renderAdminAccountsTab(){
  const panel = adminTabPanels.accounts;
  const customers = adminAccountsCache;

  if (customers.length === 0) {
    panel.innerHTML = `<h2 class="admin-section-title">Accounts</h2>${buildEmptyState(EMPTY_ICON_PEOPLE, "No accounts yet", "Customer accounts will appear here once people sign up.")}`;
    return;
  }

  panel.innerHTML = `
    <h2 class="admin-section-title">Accounts (${customers.length})</h2>
    <div class="admin-card-list">
      ${customers.map(account => {
        const username = account.username;
        const orderCount = adminOrderCountsByUserId.get(account.id) || 0;
        const cart = account.cart || [];
        const cartCount = cart.reduce((s, i) => s + i.qty, 0);
        const addr = account.address ? `${escapeHtml(account.address.city)}, ${escapeHtml(account.address.postal)}` : "No saved address";
        const profile = account.profile || {};
        const profileLine = (profile.name || profile.email || profile.phone)
          ? `<br>Profile: ${[profile.name, profile.email, profile.phone].filter(Boolean).map(escapeHtml).join(" · ")}`
          : "";
        return `
          <div class="admin-card">
            <div class="admin-card-header">
              <span class="admin-card-title">${escapeHtml(username)}</span>
              <span class="admin-card-meta">${orderCount} order${orderCount === 1 ? "" : "s"}</span>
            </div>
            <div class="admin-card-body">${addr} · ${cartCount} item${cartCount === 1 ? "" : "s"} currently in cart${profileLine}</div>
            <div class="admin-card-actions">
              <button type="button" class="admin-btn-danger" data-username="${escapeHtml(username)}" data-id="${account.id}" data-action="delete-account">Delete account</button>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;

  panel.querySelectorAll("[data-action='delete-account']").forEach(btn => {
    btn.addEventListener("click", () => {
      if (confirm(`Delete the customer account "${btn.dataset.username}"? Only accounts without retained order, rating, or chat history can be deleted. This cannot be undone.`)) {
        deleteAccount(btn.dataset.username, btn.dataset.id);
      }
    });
  });
}

// ---------- Activity tab ----------
let adminActivityCache = [];

async function clearActivity(){
  const { error } = await supabase.from("activity").delete().gt("at", 0);
  if (error) { console.error(error); return; }
  await renderAdminActivity();
}

async function renderAdminActivity(){
  if (adminTabPanels.activity) adminTabPanels.activity.innerHTML = `<h2 class="admin-section-title">Activity</h2>${buildSkeletonRows(3)}`;
  const { data, error } = await supabase.from("activity").select("*").order("at", { ascending: false }).limit(200);
  if (error) reportLoadError("Activity log", error);
  adminActivityCache = error ? [] : (data || []);
  renderAdminActivityTab();
}

function renderAdminActivityTab(){
  const panel = adminTabPanels.activity;
  const log = adminActivityCache;

  if (log.length === 0) {
    panel.innerHTML = `<h2 class="admin-section-title">Activity</h2>${buildEmptyState(EMPTY_ICON_ACTIVITY, "Nothing logged yet", "Sign-ups and logins will be recorded here.")}`;
    return;
  }

  panel.innerHTML = `
    <h2 class="admin-section-title">Activity (most recent ${log.length})</h2>
    <div class="admin-card-list">
      ${log.map(entry => `
        <div class="admin-card admin-card-compact">
          <div class="admin-card-header">
            <span class="admin-card-title">${entry.type === "signup" ? "New account created" : "Logged in"}</span>
            <span class="admin-card-meta">${formatDateTime(new Date(entry.at))}</span>
          </div>
          <div class="admin-card-body"><strong>${escapeHtml(entry.username)}</strong></div>
        </div>
      `).join("")}
    </div>
    <button type="button" class="admin-btn-danger" id="admin-clear-activity" style="margin-top:20px;">Clear activity log</button>
  `;

  const clearBtn = document.getElementById("admin-clear-activity");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("Clear the entire activity log? This cannot be undone.")) clearActivity();
    });
  }
}

// ---------- FIX #11: Analytics tab ----------
function truncateLabel(str, max){
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function buildBarChartSVG(items){
  const width = 640;
  const barHeight = 22, gap = 12, padT = 6;
  const labelW = 168;
  const chartLeft = 8 + labelW;
  const chartRight = width - 78;
  const height = padT + items.length * (barHeight + gap);

  if (!items.length) {
    return `<svg viewBox="0 0 ${width} 70" role="img" aria-label="No sales data yet"><text x="${width / 2}" y="38" text-anchor="middle" class="chart-empty-note">No sales data yet</text></svg>`;
  }

  const maxVal = Math.max(1, ...items.map(i => i.value));
  const bars = items.map((item, i) => {
    const y = padT + i * (barHeight + gap);
    const barW = Math.max(2, (item.value / maxVal) * (chartRight - chartLeft));
    const titleText = `${item.label}: ${formatPrice(item.value)}${item.sub ? ` (${item.sub})` : ""}`;
    return `
      <text x="${chartLeft - 10}" y="${(y + barHeight * 0.68).toFixed(1)}" text-anchor="end" class="chart-bar-label">${escapeHtml(truncateLabel(item.label, 22))}</text>
      <rect x="${chartLeft}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barHeight}" rx="2" class="chart-bar"><title>${escapeHtml(titleText)}</title></rect>
      <text x="${(chartLeft + barW + 8).toFixed(1)}" y="${(y + barHeight * 0.68).toFixed(1)}" class="chart-bar-value">${escapeHtml(formatPrice(item.value))}</text>
    `;
  }).join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Top products by revenue">${bars}</svg>`;
}

function buildAreaChartSVG(series){
  const width = 640, height = 200, padL = 4, padR = 4, padT = 14, padB = 22;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const values = series.map(s => s.value);
  const total = values.reduce((a, b) => a + b, 0);

  if (!series.length || total <= 0) {
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="No revenue in this period yet">
      <line x1="${padL}" y1="${padT + innerH}" x2="${width - padR}" y2="${padT + innerH}" class="chart-axis-line"/>
      <text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="chart-empty-note">No revenue in this period yet</text>
    </svg>`;
  }

  const maxVal = Math.max(1, ...values);
  const stepX = series.length > 1 ? innerW / (series.length - 1) : 0;
  const points = series.map((s, i) => ({
    x: padL + stepX * i,
    y: padT + innerH - (s.value / maxVal) * innerH
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${(padT + innerH).toFixed(1)} L${points[0].x.toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  const firstLabel = new Date(series[0].date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const lastLabel = new Date(series[series.length - 1].date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const lastPoint = points[points.length - 1];

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Daily revenue over the last ${series.length} days">
      <line x1="${padL}" y1="${(padT + innerH).toFixed(1)}" x2="${width - padR}" y2="${(padT + innerH).toFixed(1)}" class="chart-axis-line"/>
      <path d="${areaPath}" class="chart-area-fill"/>
      <path d="${linePath}" class="chart-line-path"/>
      <circle cx="${lastPoint.x.toFixed(1)}" cy="${lastPoint.y.toFixed(1)}" r="3.5" class="chart-line-dot"><title>${escapeHtml(lastLabel)}: ${escapeHtml(formatPrice(series[series.length - 1].value))}</title></circle>
      <text x="${padL}" y="${height - 4}" class="chart-bar-label">${escapeHtml(firstLabel)}</text>
      <text x="${width - padR}" y="${height - 4}" text-anchor="end" class="chart-bar-label">${escapeHtml(lastLabel)}</text>
    </svg>
  `;
}

function buildDailyRevenueSeries(orders, days){
  const dayMs = 24 * 60 * 60 * 1000;
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    buckets[todayMidnight - i * dayMs] = 0;
  }

  orders.forEach(o => {
    if (o.cancelled) return;
    const d = new Date(o.placedAt);
    const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (key in buckets) buckets[key] += Number(o.total) || 0;
  });

  return Object.keys(buckets)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => ({ date: Number(k), value: buckets[k] }));
}

async function renderAdminAnalytics(){
  if (adminTabPanels.analytics) adminTabPanels.analytics.innerHTML = `<h2 class="admin-section-title">Sales Analytics</h2>${buildSkeletonRows(2)}`;
  const { data, error } = await supabase.from("orders").select("*").order("placed_at", { ascending: false });
  if (error) { reportLoadError("Analytics", error); renderAdminAnalyticsTab([]); return; }
  renderAdminAnalyticsTab((data || []).map(mapOrderRow));
}

function renderAdminAnalyticsTab(allOrders){
  const panel = adminTabPanels.analytics;
  const activeOrders = allOrders.filter(o => !o.cancelled);

  const totalRevenue = activeOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  const totalOrders = activeOrders.length;
  const avgOrderValue = totalOrders ? totalRevenue / totalOrders : 0;
  const cancelledCount = allOrders.length - activeOrders.length;

  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const revenueLast30 = activeOrders
    .filter(o => now - o.placedAt <= THIRTY_DAYS)
    .reduce((sum, o) => sum + (Number(o.total) || 0), 0);

  const productStats = {};
  activeOrders.forEach(order => {
    (order.items || []).forEach(item => {
      const qty = Math.max(0, Number(item.qty) || 0);
      const unitPrice = Math.max(0, Number(item.price) || 0);
      const key = item.isBundle ? `bundle:${item.bundleId || item.name}` : `product:${item.productId}`;
      const currentProduct = !item.isBundle ? findProduct(item.productId) : null;
      const name = item.isBundle
        ? `${item.name || "Bundle"} (Bundle)`
        : (currentProduct ? currentProduct.name : (item.name || "Removed product"));

      if (!productStats[key]) productStats[key] = { name, qty: 0, revenue: 0 };
      productStats[key].qty += qty;
      productStats[key].revenue += unitPrice * qty;
    });
  });
  const topProducts = Object.values(productStats).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

  const paymentStats = {};
  activeOrders.forEach(o => { paymentStats[o.paymentMethod] = (paymentStats[o.paymentMethod] || 0) + 1; });

  const dailySeries = buildDailyRevenueSeries(activeOrders, 30);
  const barChartItems = topProducts.map(p => ({ label: p.name, value: p.revenue, sub: `${p.qty} unit${p.qty === 1 ? "" : "s"} sold` }));

  panel.innerHTML = `
    <h2 class="admin-section-title">Sales Analytics</h2>
    <div class="analytics-grid">
      <div class="analytics-stat-card">
        <p class="analytics-stat-label">Total Revenue</p>
        <p class="analytics-stat-value">${formatPrice(totalRevenue)}</p>
      </div>
      <div class="analytics-stat-card">
        <p class="analytics-stat-label">Revenue (Last 30 Days)</p>
        <p class="analytics-stat-value">${formatPrice(revenueLast30)}</p>
      </div>
      <div class="analytics-stat-card">
        <p class="analytics-stat-label">Orders (non-cancelled)</p>
        <p class="analytics-stat-value">${totalOrders}</p>
      </div>
      <div class="analytics-stat-card">
        <p class="analytics-stat-label">Average Order Value</p>
        <p class="analytics-stat-value">${formatPrice(avgOrderValue)}</p>
      </div>
      <div class="analytics-stat-card">
        <p class="analytics-stat-label">Cancelled Orders</p>
        <p class="analytics-stat-value">${cancelledCount}</p>
      </div>
    </div>

    <h3 class="analytics-section-title">Revenue — Last 30 Days</h3>
    <div class="analytics-chart-card">
      ${buildAreaChartSVG(dailySeries)}
    </div>

    <h3 class="analytics-section-title">Top Items by Revenue</h3>
    <div class="analytics-chart-card">
      ${buildBarChartSVG(barChartItems)}
    </div>

    <h3 class="analytics-section-title">Orders by Payment Method</h3>
    ${Object.keys(paymentStats).length ? `
      <div class="analytics-table-wrap">
        <table class="analytics-table">
          <thead><tr><th>Method</th><th>Orders</th></tr></thead>
          <tbody>
            ${Object.entries(paymentStats).map(([method, count]) => `<tr><td>${escapeHtml(paymentMethodLabel(method))}</td><td>${count}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    ` : `<p class="admin-empty">No sales data yet.</p>`}
  `;
}

// ---------- Settings tab: GCash number + real QR code upload + shop logo upload ----------
async function renderAdminSettings(){
  await loadSettings();
  renderAdminSettingsTab();
}

function renderAdminSettingsTab(){
  const panel = adminTabPanels.settings;
  pendingQrDataUrl = undefined;
  pendingBankQrDataUrl = undefined;
  pendingLogoDataUrl = undefined;
  adminDeliveryOriginDraft = currentSettingsDeliveryOriginLocation();

  panel.innerHTML = `
    <h2 class="admin-section-title">Payment Settings</h2>
    <div class="admin-card">
      <p class="admin-form-title">GCash</p>
      <label class="field">
        <span>GCash number shown to customers</span>
        <input type="text" id="admin-gcash-number" value="${escapeHtml(currentSettings.gcash_number)}">
      </label>

      <div class="admin-sizes-field">
        <span class="field-label-standalone">Your real GCash QR code (upload a screenshot from your GCash app — this is exactly what customers will scan, and they can tap it to view it full-size)</span>
        <div class="avatar-field" style="align-items:flex-start;">
          <div class="size-thumb" id="admin-qr-preview" style="width:120px; height:120px;">
            ${currentSettings.gcash_qr_image ? `<img src="${escapeHtml(currentSettings.gcash_qr_image)}" alt="GCash QR code" class="zoomable-img" loading="lazy" decoding="async">` : ""}
          </div>
          <div class="avatar-field-controls">
            <label class="link-btn avatar-upload-label" for="admin-qr-input">Choose QR photo</label>
            <input type="file" id="admin-qr-input" accept="image/*" class="hidden">
            <button type="button" class="link-btn avatar-remove-btn" id="admin-qr-remove">Remove QR photo</button>
            <span class="avatar-upload-status hidden" id="admin-qr-upload-status">Uploading…</span>
          </div>
        </div>
      </div>

      <div class="admin-sizes-field" style="padding-top:18px; border-top:1px dashed var(--line);">
        <p class="admin-form-title">Bank Transfer</p>
        <p class="field-hint" style="margin:-6px 0 14px;">These are the single bank-account details customers see when they choose Bank Transfer at checkout.</p>

        <label class="field">
          <span>Bank name</span>
          <input type="text" id="admin-bank-name" maxlength="80" value="${escapeHtml(currentSettings.bank_name)}" placeholder="e.g. BDO Unibank">
        </label>

        <label class="field">
          <span>Account holder name</span>
          <input type="text" id="admin-bank-account-name" maxlength="120" value="${escapeHtml(currentSettings.bank_account_name)}" placeholder="e.g. Dagoldol Trading Co.">
        </label>

        <label class="field">
          <span>Account number</span>
          <input type="text" id="admin-bank-account-number" maxlength="80" value="${escapeHtml(currentSettings.bank_account_number)}" placeholder="e.g. 0012 3456 7890" inputmode="numeric">
        </label>

        <span class="field-label-standalone">Bank payment QR code (upload the QR customers should scan for a quick bank payment)</span>
        <div class="avatar-field" style="align-items:flex-start;">
          <div class="size-thumb" id="admin-bank-qr-preview" style="width:120px; height:120px;">
            ${currentSettings.bank_qr_image ? `<img src="${escapeHtml(currentSettings.bank_qr_image)}" alt="Bank transfer QR code" class="zoomable-img" loading="lazy" decoding="async">` : ""}
          </div>
          <div class="avatar-field-controls">
            <label class="link-btn avatar-upload-label" for="admin-bank-qr-input">Choose bank QR photo</label>
            <input type="file" id="admin-bank-qr-input" accept="image/*" class="hidden">
            <button type="button" class="link-btn avatar-remove-btn" id="admin-bank-qr-remove">Remove bank QR photo</button>
            <span class="avatar-upload-status hidden" id="admin-bank-qr-upload-status">Uploading…</span>
          </div>
        </div>
      </div>

      <div class="admin-sizes-field admin-delivery-origin-section" style="padding-top:18px; border-top:1px dashed var(--line);">
        <div class="delivery-location-heading-row">
          <div>
            <p class="admin-form-title" style="margin-bottom:6px;">Delivery Origin</p>
            <p class="field-hint" style="margin:0;">Pin the owner/shop/warehouse starting point used for delivery-distance routing. This does not change the current delivery-price formula.</p>
          </div>
          <button type="button" class="btn-secondary delivery-location-open-btn" id="admin-delivery-origin-open">Set starting point</button>
        </div>
        <div class="delivery-location-card" id="admin-delivery-origin-card" data-state="saved" aria-live="polite">
          <span class="delivery-location-card-title">Delivery start location set</span>
          <span class="delivery-location-card-copy"></span>
        </div>
        <label class="field">
          <span>Saved delivery origin address</span>
          <input type="text" id="admin-delivery-origin-address" readonly>
        </label>
        <div class="field-row">
          <label class="field">
            <span>Latitude</span>
            <input type="text" id="admin-delivery-origin-latitude" readonly inputmode="decimal">
          </label>
          <label class="field">
            <span>Longitude</span>
            <input type="text" id="admin-delivery-origin-longitude" readonly inputmode="decimal">
          </label>
        </div>
      </div>

      <p id="admin-settings-error" class="error-message"></p>
      <p id="admin-settings-success" class="success-message hidden"></p>
      <button type="button" class="btn-primary" id="admin-settings-save" style="width:auto; padding:10px 22px;">Save payment &amp; delivery settings</button>
    </div>

    <div class="admin-card" style="margin-top:20px;">
      <p class="admin-form-title">Shop Logo</p>
      <p class="field-hint" style="margin:0 0 14px;">Replace the default seal icon in the header with your own logo photo. Leave it empty to keep the default seal.</p>
      <div class="avatar-field" style="align-items:flex-start;">
        <div class="size-thumb" id="admin-logo-preview" style="width:80px; height:80px; border-radius:50%;">
          ${currentSettings.shop_logo_image ? `<img src="${escapeHtml(currentSettings.shop_logo_image)}" alt="Shop logo" class="zoomable-img" loading="lazy" decoding="async">` : ""}
        </div>
        <div class="avatar-field-controls">
          <label class="link-btn avatar-upload-label" for="admin-logo-input">Choose logo photo</label>
          <input type="file" id="admin-logo-input" accept="image/*" class="hidden">
          <button type="button" class="link-btn avatar-remove-btn" id="admin-logo-remove">Remove logo photo</button>
          <span class="avatar-upload-status hidden" id="admin-logo-upload-status">Uploading…</span>
        </div>
      </div>
      <p id="admin-logo-error" class="error-message"></p>
      <p id="admin-logo-success" class="success-message hidden"></p>
      <button type="button" class="btn-primary" id="admin-logo-save" style="width:auto; padding:10px 22px;">Save shop logo</button>
    </div>

  `;

  const qrInput = document.getElementById("admin-qr-input");
  const qrPreview = document.getElementById("admin-qr-preview");
  const qrRemoveBtn = document.getElementById("admin-qr-remove");
  const qrUploadStatus = document.getElementById("admin-qr-upload-status");
  const bankQrInput = document.getElementById("admin-bank-qr-input");
  const bankQrPreview = document.getElementById("admin-bank-qr-preview");
  const bankQrRemoveBtn = document.getElementById("admin-bank-qr-remove");
  const bankQrUploadStatus = document.getElementById("admin-bank-qr-upload-status");
  const saveBtn = document.getElementById("admin-settings-save");
  const errEl = document.getElementById("admin-settings-error");
  const successEl = document.getElementById("admin-settings-success");
  const adminDeliveryOriginOpenBtn = document.getElementById("admin-delivery-origin-open");

  updateAdminDeliveryOriginUi();
  adminDeliveryOriginOpenBtn?.addEventListener("click", () => {
    void openDeliveryMapPicker("admin-origin");
  });

  qrInput.addEventListener("change", async () => {
    const file = qrInput.files[0];
    if (!file) return;
    try {
      errEl.textContent = "";
      if (qrUploadStatus) qrUploadStatus.classList.remove("hidden");
      pendingQrDataUrl = await uploadImageToStorage(file, "payment-settings", "qr", 600);
      qrPreview.innerHTML = `<img src="${escapeHtml(pendingQrDataUrl)}" alt="GCash QR code" class="zoomable-img" loading="lazy" decoding="async">`;
    } catch (err) {
      errEl.textContent = "Could not upload that GCash QR image. Try a different photo.";
    } finally {
      if (qrUploadStatus) qrUploadStatus.classList.add("hidden");
    }
  });

  qrRemoveBtn.addEventListener("click", () => {
    pendingQrDataUrl = null;
    qrPreview.innerHTML = "";
  });

  bankQrInput.addEventListener("change", async () => {
    const file = bankQrInput.files[0];
    if (!file) return;
    try {
      errEl.textContent = "";
      if (bankQrUploadStatus) bankQrUploadStatus.classList.remove("hidden");
      pendingBankQrDataUrl = await uploadImageToStorage(file, "payment-settings", "bank-qr", 600);
      bankQrPreview.innerHTML = `<img src="${escapeHtml(pendingBankQrDataUrl)}" alt="Bank transfer QR code" class="zoomable-img" loading="lazy" decoding="async">`;
    } catch (err) {
      errEl.textContent = "Could not upload that bank QR image. Try a different photo.";
    } finally {
      if (bankQrUploadStatus) bankQrUploadStatus.classList.add("hidden");
    }
  });

  bankQrRemoveBtn.addEventListener("click", () => {
    pendingBankQrDataUrl = null;
    bankQrPreview.innerHTML = "";
  });

  saveBtn.addEventListener("click", async () => {
    const number = document.getElementById("admin-gcash-number").value.trim();
    const bankName = document.getElementById("admin-bank-name").value.trim();
    const bankAccountName = document.getElementById("admin-bank-account-name").value.trim();
    const bankAccountNumber = document.getElementById("admin-bank-account-number").value.trim();
    const originLocation = normalizePinnedLocationValue(adminDeliveryOriginDraft, getAdminDeliveryOriginAddressFields()) || currentSettingsDeliveryOriginLocation();
    const originAddress = cleanAddressValue(document.getElementById("admin-delivery-origin-address")?.value) || SHOP_ORIGIN_ADDRESS;

    if (!number) {
      errEl.textContent = "Please enter a GCash number.";
      return;
    }
    if (!bankName || !bankAccountName || !bankAccountNumber) {
      errEl.textContent = "Please complete the bank name, account holder name, and account number.";
      return;
    }
    if (!originLocation) {
      errEl.textContent = "Please pin a valid delivery origin within the Philippines.";
      return;
    }

    saveBtn.disabled = true;
    errEl.textContent = "";
    successEl.classList.add("hidden");

    const qrImage = pendingQrDataUrl === undefined ? currentSettings.gcash_qr_image : pendingQrDataUrl;
    const bankQrImage = pendingBankQrDataUrl === undefined ? currentSettings.bank_qr_image : pendingBankQrDataUrl;

    const saveErrors = await Promise.all([
      saveSetting("gcash_number", number),
      saveSetting("gcash_qr_image", qrImage || ""),
      saveSetting("bank_name", bankName),
      saveSetting("bank_account_name", bankAccountName),
      saveSetting("bank_account_number", bankAccountNumber),
      saveSetting("bank_qr_image", bankQrImage || ""),
      saveSetting("delivery_origin_address", originAddress),
      saveSetting("delivery_origin_latitude", String(originLocation.latitude)),
      saveSetting("delivery_origin_longitude", String(originLocation.longitude))
    ]);

    saveBtn.disabled = false;

    if (saveErrors.some(Boolean)) {
      errEl.textContent = "Could not save all payment settings. Check the settings-table permissions for the admin account and try again.";
      await loadSettings();
      return;
    }

    currentSettings = {
      ...currentSettings,
      gcash_number: number,
      gcash_qr_image: qrImage || null,
      bank_name: bankName,
      bank_account_name: bankAccountName,
      bank_account_number: bankAccountNumber,
      bank_qr_image: bankQrImage || null,
      delivery_origin_address: originAddress,
      delivery_origin_latitude: originLocation.latitude,
      delivery_origin_longitude: originLocation.longitude
    };
    shopOriginCoords = null;
    adminDeliveryOriginDraft = currentSettingsDeliveryOriginLocation();
    applySettingsToDom();
    updateAdminDeliveryOriginUi();
    successEl.textContent = "Payment and delivery settings saved. Checkout routing now starts from the pinned owner location.";
    successEl.classList.remove("hidden");
  });

  // ---- Shop logo upload/save ----
  const logoInput = document.getElementById("admin-logo-input");
  const logoPreview = document.getElementById("admin-logo-preview");
  const logoRemoveBtn = document.getElementById("admin-logo-remove");
  const logoUploadStatus = document.getElementById("admin-logo-upload-status");
  const logoSaveBtn = document.getElementById("admin-logo-save");
  const logoErrEl = document.getElementById("admin-logo-error");
  const logoSuccessEl = document.getElementById("admin-logo-success");

  logoInput.addEventListener("change", async () => {
    const file = logoInput.files[0];
    if (!file) return;
    try {
      if (logoUploadStatus) logoUploadStatus.classList.remove("hidden");
      pendingLogoDataUrl = await uploadImageToStorage(file, "payment-settings", "logo", 240);
      logoPreview.innerHTML = `<img src="${escapeHtml(pendingLogoDataUrl)}" alt="Shop logo" class="zoomable-img" loading="lazy" decoding="async">`;
    } catch (err) {
      logoErrEl.textContent = "Could not upload that image. Try a different photo.";
    } finally {
      if (logoUploadStatus) logoUploadStatus.classList.add("hidden");
    }
  });

  logoRemoveBtn.addEventListener("click", () => {
    pendingLogoDataUrl = null;
    logoPreview.innerHTML = "";
  });

  logoSaveBtn.addEventListener("click", async () => {
    logoSaveBtn.disabled = true;
    logoErrEl.textContent = "";
    logoSuccessEl.classList.add("hidden");

    const logoImage = pendingLogoDataUrl === undefined ? currentSettings.shop_logo_image : pendingLogoDataUrl;
    const logoError = await saveSetting("shop_logo_image", logoImage || "");

    logoSaveBtn.disabled = false;

    if (logoError) {
      logoErrEl.textContent = "Could not save the logo. Make sure your Supabase \"settings\" table exists.";
      return;
    }

    currentSettings = { ...currentSettings, shop_logo_image: logoImage || null };
    applySettingsToDom();
    logoSuccessEl.textContent = "Shop logo saved. It now appears in the header for everyone.";
    logoSuccessEl.classList.remove("hidden");
  });

}

let appRouteReady = false;

async function consumeProductDeepLink(){
  if (normalizeAppPath() !== APP_ROUTES.SHOP) return false;
  const params = new URLSearchParams(window.location.search);
  const productId = params.get("product");
  if (!productId) return false;

  const product = findProduct(productId);
  window.history.replaceState({}, "", APP_ROUTES.SHOP);
  if (!product) {
    showToast("That product is no longer available.");
    return false;
  }

  const action = params.get("action") === "order" ? "order" : "cart";
  openSizeModal(product.id, 1, action);
  return true;
}

async function applyCurrentAppRoute(){
  const path = normalizeAppPath();
  const isAdmin = currentUserProfile && currentUserProfile.role === "admin";

  if (isAdmin) {
    hideCustomerRouteScreens();
    shopScreen.classList.add("hidden");
    loginScreen.classList.add("hidden");
    adminScreen.classList.remove("hidden");
    if (path !== APP_ROUTES.ADMIN) navigateAppPath(APP_ROUTES.ADMIN, { replace: true });
    return;
  }

  if (path === APP_ROUTES.CHECKOUT) {
    if (!currentUserId) {
      pendingLoginIntent = () => applyCurrentAppRoute();
      showLoginGate("Log in to continue checkout — your checkout draft is saved for this browser tab.");
      return;
    }
    await openCheckoutFromPersistedState({ replaceRoute: true });
    return;
  }

  if (path === APP_ROUTES.ORDERS) {
    if (!currentUserId) {
      pendingLoginIntent = () => applyCurrentAppRoute();
      showLoginGate("Log in to view your orders.");
      return;
    }
    await openOrdersModal({ replaceRoute: true });
    return;
  }

  if (path === APP_ROUTES.ADMIN) {
    if (!currentUserId) {
      pendingLoginIntent = () => applyCurrentAppRoute();
      showLoginGate("Log in with an administrator account to open the admin dashboard.");
      return;
    }
    showShopScreenOnly();
    navigateAppPath(APP_ROUTES.SHOP, { replace: true });
    showToast("This account does not have administrator access.");
    return;
  }

  if (checkoutScreen && !checkoutScreen.classList.contains("hidden")) {
    resetCheckoutUiState();
  }
  showShopScreenOnly();

  if (path !== APP_ROUTES.SHOP) {
    navigateAppPath(APP_ROUTES.SHOP, { replace: true });
  }

  await consumeProductDeepLink();
}

window.addEventListener("popstate", () => {
  if (!appRouteReady) return;
  void applyCurrentAppRoute();
});

// ===================== Restore session on page load =====================
async function initSession(){
  if (shouldUseFastMobileBootstrap()) {
    applySettingsToDom();
    void (async () => {
      await primeSettingsFromSnapshot();
      await refreshSettingsLive();
    })();
  } else {
    await loadSettings();
  }

  updateDocumentTitleUnread(0);

  const { data } = await supabase.auth.getSession();
  const session = data && data.session;
  if (!session) {
    appRouteReady = true;
    await enterGuestShop({ applyRoute: true });
    return;
  }

  const profile = await fetchProfile(session.user.id);
  if (!profile) {
    await supabase.auth.signOut({ scope: "local" });
    currentUserId = null;
    currentUser = null;
    currentUserProfile = null;
    appRouteReady = true;
    await enterGuestShop({ applyRoute: true });
    return;
  }

  currentUserId = session.user.id;
  currentUser = profile.username;
  currentUserProfile = profile;
  appRouteReady = true;
  await enterShop();
}

// ===================== Enter the shop (or the admin dashboard) =====================
async function enterShop(){
  const account = currentUserProfile;

  errorMessage.textContent = "";
  loginScreen.classList.add("hidden");
  loginGateMessageEl.classList.add("hidden");
  loginForm.reset();
  signupForm.reset();
  hideCustomerRouteScreens();

  if (account.role === "admin") {
    shopScreen.classList.add("hidden");
    adminWelcomeName.textContent = currentUser;
    adminScreen.classList.remove("hidden");
    navigateAppPath(APP_ROUTES.ADMIN, { replace: normalizeAppPath() !== APP_ROUTES.ADMIN });

    adminOrdersVisibleCount = ADMIN_ORDERS_PAGE_SIZE;
    await activateAdminTab("orders");

    initPresenceGeneric();
    subscribeDmRealtime();
    unreadChatCount = await computeMyDmUnreadCount();
    updateChatBadge();
    updateDocumentTitleUnread(unreadChatCount);
    pendingLoginIntent = null;
    return;
  }

  adminScreen.classList.add("hidden");
  const profile = account.profile || {};
  await mergeGuestCartIntoProfile();
  setHeaderCustomerState(profile.name || currentUser, profile.avatar || null);
  showShopScreenOnly();
  await renderCatalogue();
  updateCartBadge();

  initPresenceGeneric();
  subscribeDmRealtime();

  recsLastRefreshAt = Date.now();
  subscribeRecommendationsRealtime();

  unreadChatCount = await computeMyDmUnreadCount();
  updateChatBadge();
  updateDocumentTitleUnread(unreadChatCount);

  if (pendingLoginIntent) {
    const intent = pendingLoginIntent;
    pendingLoginIntent = null;
    await intent();
  } else {
    await applyCurrentAppRoute();
  }
}

async function enterGuestShop({ applyRoute = true } = {}){
  errorMessage.textContent = "";
  loginScreen.classList.add("hidden");
  loginGateMessageEl.classList.add("hidden");
  adminScreen.classList.add("hidden");
  hideCustomerRouteScreens();
  shopScreen.classList.remove("hidden");
  setHeaderGuestState();
  await renderCatalogue();
  updateCartBadge();
  if (applyRoute) await applyCurrentAppRoute();
}

async function backToLogin(){
  await supabase.auth.signOut({ scope: "local" });
  teardownChatRealtime();
  teardownRecommendationsRealtime();
  currentUser = null;
  currentUserId = null;
  currentUserProfile = null;
  pendingLoginIntent = null;
  closeAccountMenu();
  adminScreen.classList.add("hidden");
  navigateAppPath(APP_ROUTES.SHOP, { replace: true });
  await enterGuestShop({ applyRoute: false });
}

// ===================== Login handling =====================
async function fetchProfile(userId){
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (error) {
    console.error("[Dagoldol] fetchProfile error:", error);
    return null;
  }
  return data;
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (isHoneypotTripped("login-hp")) return;

  const email = loginEmailInput.value.trim();
  const password = passwordInput.value;
  const submitBtn = loginForm.querySelector("button[type='submit']");
  submitBtn.disabled = true;

  let data, error;
  try {
    const result = await supabase.auth.signInWithPassword({ email, password });
    data = result.data;
    error = result.error;
  } catch (err) {
    console.error("[Dagoldol] signInWithPassword threw an exception:", err);
    submitBtn.disabled = false;
    errorMessage.textContent = describeAuthError(err, "login");
    passwordInput.value = "";
    resetPasswordVisibility(passwordInput);
    passwordInput.focus();
    return;
  }


  if (error || !data?.user) {
    submitBtn.disabled = false;
    console.error("[Dagoldol] signInWithPassword error:", error);
    errorMessage.textContent = describeAuthError(error || { code: "invalid_credentials" }, "login");
    errorMessage.classList.remove("shake");
    void errorMessage.offsetWidth;
    errorMessage.classList.add("shake");
    passwordInput.value = "";
    resetPasswordVisibility(passwordInput);
    passwordInput.focus();
    return;
  }

  const profile = await fetchProfile(data.user.id);
  submitBtn.disabled = false;


  if (!profile) {
    errorMessage.textContent = "Your account isn't fully set up yet. Please contact the shop owner.";
    await supabase.auth.signOut({ scope: "local" });
    return;
  }

  currentUserId = data.user.id;
  currentUser = profile.username;
  currentUserProfile = profile;

  await supabase.from("activity").insert({
    id: createEntityId("LOG"),
    type: "login",
    username: currentUser,
    at: Date.now()
  });

  await enterShop();
});

logoutBtn.addEventListener("click", backToLogin);
adminLogoutBtn.addEventListener("click", backToLogin);

// ===================== Sign up handling =====================
function showSignupCard(){
  loginCard.classList.add("hidden");
  signupCard.classList.add("hidden");
  const forgotCard = document.getElementById("forgot-card");
  if (forgotCard) forgotCard.classList.add("hidden");
  signupCard.classList.remove("hidden");
  loginSuccess.classList.add("hidden");
  errorMessage.textContent = "";
  signupEmailInput.focus();
}

function showLoginCard(){
  signupCard.classList.add("hidden");
  const forgotCard = document.getElementById("forgot-card");
  if (forgotCard) forgotCard.classList.add("hidden");
  loginCard.classList.remove("hidden");
  signupError.textContent = "";
  loginEmailInput.focus();
}

function showForgotCard(){
  loginCard.classList.add("hidden");
  signupCard.classList.add("hidden");
  const forgotCard = document.getElementById("forgot-card");
  if (forgotCard) {
    forgotCard.classList.remove("hidden");
    const forgotEmail = document.getElementById("forgot-email");
    if (forgotEmail) forgotEmail.focus();
  }
}

showSignupBtn.addEventListener("click", showSignupCard);
showLoginBtn.addEventListener("click", showLoginCard);
const showForgotBtn = document.getElementById("show-forgot");
const forgotBackBtn = document.getElementById("forgot-back-btn");
const forgotShowLoginBtn = document.getElementById("forgot-show-login");
if (showForgotBtn) showForgotBtn.addEventListener("click", showForgotCard);
if (forgotBackBtn) forgotBackBtn.addEventListener("click", exitLoginScreenToGuestShop);
if (forgotShowLoginBtn) forgotShowLoginBtn.addEventListener("click", showLoginCard);

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (isHoneypotTripped("signup-hp")) return;

  const newEmail = signupEmailInput.value.trim();
  const newUsername = signupUsernameInput.value.trim();
  const newPassword = signupPasswordInput.value;
  const confirmPassword = signupConfirmInput.value;

  if (!newEmail || !newUsername || !newPassword) {
    signupError.textContent = "Please fill in every field.";
    return;
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    signupError.textContent = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    return;
  }
  if (newPassword !== confirmPassword) {
    signupError.textContent = "Passwords don't match. Try again.";
    return;
  }

  const submitBtn = signupForm.querySelector("button[type='submit']");
  submitBtn.disabled = true;

  let data, error;
  try {
    const result = await supabase.auth.signUp({ email: newEmail, password: newPassword });
    data = result.data;
    error = result.error;
  } catch (err) {
    console.error("[Dagoldol] signUp threw an exception:", err);
    submitBtn.disabled = false;
    signupError.textContent = describeAuthError(err, "signup");
    return;
  }

  if (error) {
    console.error("[Dagoldol] signUp error:", error);
    submitBtn.disabled = false;
    signupError.textContent = describeAuthError(error, "signup");
    return;
  }

  if (!data.user) {
    submitBtn.disabled = false;
    signupError.textContent = "Check your email to confirm your account, then log in.";
    return;
  }

  const { error: profileError } = await supabase.from("profiles").insert({
    id: data.user.id,
    username: newUsername,
    role: "customer",
    address: null,
    profile: {},
    cart: []
  });

  submitBtn.disabled = false;

  if (profileError) {
    console.error("[Dagoldol] profile insert error:", profileError);
    signupError.textContent = profileError.message.includes("duplicate")
      ? "That display name is already taken."
      : "Account created, but the profile setup failed — please contact the shop owner.";
    return;
  }

  await supabase.from("activity").insert({
    id: createEntityId("LOG"),
    type: "signup",
    username: newUsername,
    at: Date.now()
  });

  signupError.textContent = "";
  signupForm.reset();
  resetPasswordVisibility(signupPasswordInput);
  resetPasswordVisibility(signupConfirmInput);
  document.getElementById("signup-pw-strength-fill").style.width = "0%";
  document.getElementById("signup-pw-strength-label").textContent = "Enter a password";

  showLoginCard();
  loginEmailInput.value = newEmail;
  loginSuccess.textContent = "Account created! Log in below to enter the shop.";
  loginSuccess.classList.remove("hidden");
  passwordInput.focus();
});

// ===================== FIX #9: Password reset flow =====================
const forgotForm = document.getElementById("forgot-form");
const forgotEmailInput = document.getElementById("forgot-email");
const forgotError = document.getElementById("forgot-error");
const forgotSuccess = document.getElementById("forgot-success");

if (forgotForm) {
  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isHoneypotTripped("forgot-hp")) return;

    const email = forgotEmailInput.value.trim();
    forgotError.textContent = "";
    forgotSuccess.classList.add("hidden");

    if (!email) { forgotError.textContent = "Please enter your email address."; return; }

    const submitBtn = forgotForm.querySelector("button[type='submit']");
    submitBtn.disabled = true;

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/"
    });

    submitBtn.disabled = false;

    if (error) console.error("[Dagoldol] resetPasswordForEmail error:", error);
    forgotSuccess.textContent = "If that email has an account, a reset link is on its way. Check your inbox (and spam folder).";
    forgotSuccess.classList.remove("hidden");
    forgotForm.reset();
  });
}

const resetCard = document.getElementById("reset-card");
const resetForm = document.getElementById("reset-form");
const resetPasswordInput = document.getElementById("reset-password");
const resetConfirmInput = document.getElementById("reset-confirm");
const resetError = document.getElementById("reset-error");

if (resetForm) {
  resetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = resetPasswordInput.value;
    const confirm = resetConfirmInput.value;
    resetError.textContent = "";

    if (pw.length < MIN_PASSWORD_LENGTH) {
      resetError.textContent = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
      return;
    }
    if (pw !== confirm) {
      resetError.textContent = "Passwords don't match. Try again.";
      return;
    }

    const submitBtn = resetForm.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    const { error } = await supabase.auth.updateUser({ password: pw });
    submitBtn.disabled = false;

    if (error) {
      resetError.textContent = error.message || "Could not update your password. The reset link may have expired — request a new one.";
      return;
    }

    resetCard.classList.add("hidden");
    showLoginCard();
    loginSuccess.textContent = "Password updated! Log in with your new password.";
    loginSuccess.classList.remove("hidden");
  });
}

supabase.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    hideCustomerRouteScreens();
    loginScreen.classList.remove("hidden");
    shopScreen.classList.add("hidden");
    adminScreen.classList.add("hidden");
    navigateAppPath(APP_ROUTES.SHOP, { replace: true });
    loginCard.classList.add("hidden");
    signupCard.classList.add("hidden");
    const forgotCardEl = document.getElementById("forgot-card");
    if (forgotCardEl) forgotCardEl.classList.add("hidden");
    if (resetCard) resetCard.classList.remove("hidden");
    if (resetPasswordInput) resetPasswordInput.focus();
  }
});

initSession();


})();
