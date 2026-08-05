(function(){
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log("[Dagoldol] script.js starting. Supabase client created:", !!supabase);
window.addEventListener("error", (e) => {
  console.error("[Dagoldol] Uncaught script error:", e.message, "at", (e.filename || "?") + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[Dagoldol] Unhandled promise rejection:", e.reason);
});

const OWNER_EMAIL = "angelmclorenzdagoldol@gmail.com";
const DOCUMENT_TITLE_BASE = "DAGOLDOL — Fine Everyday Goods";

const BULK_TIER_1_MIN_QTY = 250;
const BULK_TIER_1_RATE = 0.05;
const BULK_TIER_2_MIN_QTY = 256;
const BULK_TIER_2_RATE = 0.02;

const LOW_STOCK_THRESHOLD = 10;

const DEFAULT_GCASH_NUMBER = "0963 202 0564";
let currentSettings = { gcash_number: DEFAULT_GCASH_NUMBER, gcash_qr_image: null };

async function loadSettings(){
  try {
    const { data, error } = await supabase.from("settings").select("*");
    if (error) { console.error("[Dagoldol] loadSettings error:", error); return; }
    const map = {};
    (data || []).forEach(row => { map[row.key] = row.value; });
    currentSettings = {
      gcash_number: map.gcash_number || DEFAULT_GCASH_NUMBER,
      gcash_qr_image: map.gcash_qr_image || null
    };
  } catch (err) {
    console.error("[Dagoldol] loadSettings threw:", err);
  }
  applySettingsToDom();
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
      placeholderEl.classList.add("hidden");
    } else {
      imgEl.classList.add("hidden");
      placeholderEl.classList.remove("hidden");
    }
  }
}

const SHOP_ORIGIN_ADDRESS = "Davao-Bukidnon Hwy, Sitio Pamuhatan, Marilog District, Davao City, Davao del Sur, 8000, Philippines";
const SHOP_ORIGIN_FALLBACK_COORDS = { lat: 7.2777, lon: 125.3245 };

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

let shopOriginCoords = null;

// NOTE: geocodeAddress() and getRoadDistanceKm() are defined once, later
// in this file (search "FIX #6"), with caching + Nominatim usage-policy
// compliance added. They are intentionally not duplicated here.

async function getShopOriginCoords(){
  if (shopOriginCoords) return shopOriginCoords;
  const geocoded = await geocodeAddress(SHOP_ORIGIN_ADDRESS);
  shopOriginCoords = geocoded || SHOP_ORIGIN_FALLBACK_COORDS;
  return shopOriginCoords;
}

async function calculateDeliveryFee(addressStr){
  const origin = await getShopOriginCoords();
  const destCoords = await geocodeAddress(addressStr);
  if (!destCoords) return { fee: DELIVERY_FALLBACK_FEE, km: null };

  const km = await getRoadDistanceKm(origin, destCoords);
  if (km == null) return { fee: DELIVERY_FALLBACK_FEE, km: null };

  if (km <= DELIVERY_FREE_KM_THRESHOLD) return { fee: 0, km };

  const freeZones = await getFreeZoneCoords();
  for (const fz of freeZones) {
    const fzKm = await getRoadDistanceKm(fz, destCoords);
    if (fzKm != null && fzKm <= DELIVERY_FREE_KM_THRESHOLD) {
      return { fee: 0, km };
    }
  }

  const fee = DELIVERY_RATE_PER_KM * km;
  return { fee, km };
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

let pendingPaymentProofDataUrl = null;

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

function mapChatMessageRow(row){
  return { id: row.id, threadId: row.thread_id, sender: row.sender, senderName: row.sender_name, body: row.body, sentAt: Number(row.sent_at) };
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

console.log("[Dagoldol] loginForm element found:", !!loginForm);

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

// ===================== FIX #7: Supabase Storage image upload helper =====================
// Replaces the old pattern of resizing an image to a base64 data URL and
// stuffing that string directly into a database row/column. Base64 in
// Postgres bloats table size ~33% per image, is slow to transfer on every
// row read (even when the image isn't shown), and has no CDN/caching
// benefit. This resizes client-side exactly as before, then uploads the
// resulting blob to a Supabase Storage bucket and returns just the public
// URL — that's what gets stored in the row instead.
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

// ===================== Account menu (replaces the old 6-button header row) =====================
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
    if (e.target.closest("button")) closeAccountMenu();
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

// ===================== Login gate (guests hit this when an action needs an account) =====================
let pendingLoginIntent = null;

function showLoginGate(message){
  shopScreen.classList.add("hidden");
  adminScreen.classList.add("hidden");
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

function exitLoginScreenToGuestShop(){
  pendingLoginIntent = null;
  loginGateMessageEl.classList.add("hidden");
  loginScreen.classList.add("hidden");
  enterGuestShop();
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

// ===================== Elements: order modal =====================
const orderModal = document.getElementById("order-modal");
const modalClose = document.getElementById("modal-close");
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

const toast = document.getElementById("order-toast");
const toastMessage = document.getElementById("toast-message");

// ===================== Elements: cart =====================
const cartBtn = document.getElementById("cart-btn");
const cartCountBadge = document.getElementById("cart-count");
const cartModal = document.getElementById("cart-modal");
const cartModalClose = document.getElementById("cart-modal-close");
const cartItemsList = document.getElementById("cart-items-list");
const cartTotalEl = document.getElementById("cart-total");
const cartCheckoutBtn = document.getElementById("cart-checkout-btn");
const modalItemsList = document.getElementById("modal-items-list");

// ===================== Elements: orders / tracking =====================
const ordersBtn = document.getElementById("orders-btn");
const ordersModal = document.getElementById("orders-modal");
const ordersModalClose = document.getElementById("orders-modal-close");
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

// ===================== Elements: contact =====================
const contactBtn = document.getElementById("contact-btn");
const contactModal = document.getElementById("contact-modal");
const contactModalClose = document.getElementById("contact-modal-close");
const contactForm = document.getElementById("contact-form");
const contactNameInput = document.getElementById("contact-name");
const contactEmailInput = document.getElementById("contact-email");
const contactMessageInput = document.getElementById("contact-message");
const contactError = document.getElementById("contact-error");

// ===================== Elements: live chat (customer side) =====================
const chatBtn = document.getElementById("chat-btn");
const chatCountBadge = document.getElementById("chat-count");
const chatModal = document.getElementById("chat-modal");
const chatModalClose = document.getElementById("chat-modal-close");
const chatOnlineStatusEl = document.getElementById("chat-online-status");
const chatEnableNotifsBtn = document.getElementById("chat-enable-notifs");
const chatMessagesListEl = document.getElementById("chat-messages-list");
const chatTypingIndicatorEl = document.getElementById("chat-typing-indicator");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let orderItems = [];
let orderItems_isCartCheckout = false;
let pendingAvatarUrl = undefined;

function priceToNumber(priceStr){
  return Number(String(priceStr).replace(/[^0-9.]/g, "")) || 0;
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
  const { data, error } = await supabase.from("flash_sales").select("*");
  if (error) { reportLoadError("Flash sales", error); flashSales = []; return; }
  flashSales = (data || []).map(mapFlashSaleRow);
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
  const { data, error } = await supabase.from("brands").select("*").order("name");
  if (error) { reportLoadError("Brands", error); brands = []; return; }
  brands = (data || []).map(mapBrandRow);
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
  if (!lines.length) return;
  const { error } = await supabase.rpc("restore_stock_for_order", { p_lines: lines });
  if (error) console.error("[Dagoldol] Stock restore failed:", error);
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
  const freshProducts = await loadProducts();
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
  if (error) { reportLoadError("Bundles", error); bundles = []; return; }
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
      requireLogin(() => {
        openOrderModal([buildBundleOrderLine(bundle, qty)]);
      }, "Log in to place your order — we'll bring you right back to checkout.");
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
const TRENDING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

let coOccurrenceMap = {};
let trendingScores = {};

async function loadRecommendationData(){
  const { data, error } = await supabase.from("orders").select("items, placed_at, cancelled").eq("cancelled", false);
  if (error) { console.error("[Dagoldol] loadRecommendationData error:", error); return; }

  const now = Date.now();
  const newCoOcc = {};
  const newTrending = {};

  (data || []).forEach(row => {
    const items = Array.isArray(row.items) ? row.items : [];
    const lines = expandOrderLinesForStock(items);
    const productIdsInOrder = Array.from(new Set(lines.map(l => l.productId)));

    if (row.placed_at && now - row.placed_at <= TRENDING_WINDOW_MS) {
      lines.forEach(l => { newTrending[l.productId] = (newTrending[l.productId] || 0) + l.qty; });
    }

    productIdsInOrder.forEach(a => {
      productIdsInOrder.forEach(b => {
        if (a === b) return;
        if (!newCoOcc[a]) newCoOcc[a] = {};
        newCoOcc[a][b] = (newCoOcc[a][b] || 0) + 1;
      });
    });
  });

  coOccurrenceMap = newCoOcc;
  trendingScores = newTrending;
}

const RECS_MIN_REFRESH_INTERVAL_MS = 30000;
let recommendationsChannel = null;
let recsLastRefreshAt = 0;
let recsRefreshTimer = null;

async function refreshRecommendationsLive(){
  recsLastRefreshAt = Date.now();
  await loadRecommendationData();
  await renderTrendingSection();
  await renderRecommendedSection();
}

function scheduleRecsRefresh(){
  const elapsed = Date.now() - recsLastRefreshAt;
  if (elapsed >= RECS_MIN_REFRESH_INTERVAL_MS) {
    refreshRecommendationsLive();
  } else if (!recsRefreshTimer) {
    recsRefreshTimer = setTimeout(() => {
      recsRefreshTimer = null;
      refreshRecommendationsLive();
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
}

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
        <h3 class="product-name">${escapeHtml(p.name)}</h3>
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
  containerEl.querySelectorAll("[data-action='cart']").forEach(btn => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".product-card");
      const qtyInput = card ? card.querySelector(".qty-input") : null;
      const qty = clampQty(qtyInput ? qtyInput.value : 1);
      if (qtyInput) qtyInput.value = qty;
      openSizeModal(btn.dataset.id, qty, "cart");
    });
  });
  containerEl.querySelectorAll("[data-action='order']").forEach(btn => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".product-card");
      const qtyInput = card ? card.querySelector(".qty-input") : null;
      const qty = clampQty(qtyInput ? qtyInput.value : 1);
      if (qtyInput) qtyInput.value = qty;
      openSizeModal(btn.dataset.id, qty, "order");
    });
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

function resizeImageFile(file, maxSize){
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
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// FIX (regression): resizeImageFile() above returns a data: URL, and the
// original version of uploadImageToStorage() converted that to a Blob via
// fetch(dataUrl). That fetch() is subject to the page's Content-Security-
// Policy connect-src directive, which didn't list the `data:` scheme —
// so the browser silently blocked it, the upload threw, and no photo
// ever got attached (this is what looked like "the Photo button doesn't
// work"). This version resizes straight to a Blob via canvas.toBlob(),
// so there's no fetch() of any kind involved — avoids the CSP issue
// entirely rather than just widening the policy, and is a bit faster/
// lighter than round-tripping through base64 anyway.
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

// ===================== Payment proof upload (order modal) =====================
function resetPaymentProofField(){
  pendingPaymentProofDataUrl = null;
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
      pendingPaymentProofDataUrl = await uploadImageToStorage(file, "payment-proofs", currentUserId || "guest", 700);
      paymentProofPreview.innerHTML = `<img src="${escapeHtml(pendingPaymentProofDataUrl)}" alt="Payment screenshot" loading="lazy" decoding="async">`;
      orderPaymentProofRemoveBtn.classList.remove("hidden");
      orderError.textContent = "";
    } catch (err) {
      orderError.textContent = "Could not upload that screenshot. Try a different photo.";
    } finally {
      if (statusEl) statusEl.classList.add("hidden");
    }
  });
}

if (orderPaymentProofRemoveBtn) {
  orderPaymentProofRemoveBtn.addEventListener("click", () => {
    pendingPaymentProofDataUrl = null;
    paymentProofPreview.innerHTML = "";
    orderPaymentProofInput.value = "";
    orderPaymentProofRemoveBtn.classList.add("hidden");
  });
}

// ===================== Products =====================
async function loadProducts(){
  const { data, error } = await supabase.from("products").select("*").order("name");
  if (error) { reportLoadError("Products", error); return []; }
  return (data || []).map(mapProductRow);
}

function findProduct(productId){
  return products.find(p => p.id === productId);
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
    return `<img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">`;
  }
  return buildProductPhoto(product, index);
}

// ===================== Ratings =====================
let ratingsMap = {};

async function loadRatingsMap(){
  const { data, error } = await supabase.from("ratings").select("product_id, value");
  const map = {};
  if (!error) {
    (data || []).forEach(r => {
      if (!map[r.product_id]) map[r.product_id] = { sum: 0, count: 0 };
      map[r.product_id].sum += r.value;
      map[r.product_id].count += 1;
    });
  } else {
    reportLoadError("Ratings", error);
  }
  ratingsMap = map;
}

function getAverageRating(productId){
  const entry = ratingsMap[productId];
  if (!entry || entry.count === 0) return null;
  return { avg: entry.sum / entry.count, count: entry.count };
}

async function addRating(productId, value){
  await supabase.from("ratings").insert({ product_id: productId, value });
  const entry = ratingsMap[productId] || { sum: 0, count: 0 };
  entry.sum += value;
  entry.count += 1;
  ratingsMap[productId] = entry;
}

function renderRatingLine(productId){
  const rating = getAverageRating(productId);
  if (!rating) return `<p class="product-rating no-rating">No ratings yet</p>`;
  return `<p class="product-rating">★ ${rating.avg.toFixed(1)} <span>(${rating.count} rating${rating.count === 1 ? "" : "s"})</span></p>`;
}

// ===================== FIX #10: search + filter + sort =====================
// ===================== FIX #8: catalogue pagination =====================
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
        <h3 class="product-name">${escapeHtml(p.name)}</h3>
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

function renderCatalogueList(){
  if (products.length === 0) {
    catalogue.innerHTML = `<p class="admin-empty" style="padding:40px 6vw;">The catalogue is empty right now — check back soon.</p>`;
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
    catalogue.innerHTML = `<p class="admin-empty" style="padding:40px 6vw;">No products match your search or filters.</p>`;
    if (catalogueLoadMoreBtn) catalogueLoadMoreBtn.classList.add("hidden");
    return;
  }

  catalogue.innerHTML = visible.map((p, i) => buildFullProductCardHTML(p, i)).join("");

  if (catalogueLoadMoreBtn) {
    catalogueLoadMoreBtn.classList.toggle("hidden", catalogueVisibleCount >= filtered.length);
  }

  catalogue.querySelectorAll("[data-action='cart']").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const qtyInput = document.getElementById(`qty-${id}`);
      const qty = clampQty(qtyInput.value);
      qtyInput.value = qty;
      openSizeModal(id, qty, "cart");
    });
  });

  catalogue.querySelectorAll("[data-action='order']").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const qtyInput = document.getElementById(`qty-${id}`);
      const qty = clampQty(qtyInput.value);
      qtyInput.value = qty;
      openSizeModal(id, qty, "order");
    });
  });
}

async function renderCatalogue(){
  products = await loadProducts();
  await Promise.all([loadRatingsMap(), loadBrands(), loadFlashSales(), loadBundles()]);
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
      const product = findProduct(sizeModalState.productId);
      renderSizeOptions(product);
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
    sizeModalPhoto.innerHTML = `<img src="${escapeHtml(entry.image)}" alt="${escapeHtml(product.name)}, ${escapeHtml(formatUnitValue(product.unitType, entry.feet))}" loading="lazy" decoding="async">`;
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
    requireLogin(() => {
      openOrderModal([{
        productId: product.id,
        feet,
        name: `${product.name} (${formatUnitValue(product.unitType, feet)})`,
        price: eff.price,
        qty
      }]);
    }, "Log in to place your order — we'll bring you right back to checkout.");
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
    cartItemsList.innerHTML = `<p class="cart-empty">Your cart is empty. Go add something nice.</p>`;
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
  requireLogin(() => {
    openOrderModal(items, true);
  }, "Log in to check out — your cart will be right here waiting.");
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
// Nominatim's usage policy asks for a descriptive User-Agent header and
// caching to avoid repeat lookups. Browsers refuse to let JS set the
// real `User-Agent` header on a fetch() (it's a "forbidden header name"
// enforced by the browser itself, not something this code can bypass) —
// so instead we identify the app via a `Referer`-visible origin (the
// browser sends this automatically) plus an explicit `email`/app-name
// query parameter as Nominatim's own docs suggest as the practical
// alternative for browser-based apps, and we lean hard on the caching
// side, which is the part actually within our control and the part that
// matters most for not hammering their free service.
const NOMINATIM_APP_IDENTIFIER = "dagoldol-trading-co-shop";
const GEOCODE_CACHE_KEY = "dagoldol_geocode_cache_v1";
const GEOCODE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

  if (!address || !city) {
    deliveryStatusEl.textContent = "Enter your address to calculate the delivery fee.";
    deliveryStatusEl.classList.remove("delivery-status-error");
    currentDeliveryFee = DELIVERY_FALLBACK_FEE;
    currentDeliveryKm = null;
    updateOrderCostBreakdown();
    return;
  }

  const fullAddress = `${address}, ${city}${postal ? ", " + postal : ""}, Philippines`;
  const myToken = ++deliveryRecalcToken;

  deliveryStatusEl.textContent = "Calculating delivery distance…";
  deliveryStatusEl.classList.remove("delivery-status-error");

  const result = await calculateDeliveryFee(fullAddress);

  if (myToken !== deliveryRecalcToken) return;

  currentDeliveryFee = result.fee;
  currentDeliveryKm = result.km;

  if (result.km != null) {
    if (result.fee === 0) {
      deliveryStatusEl.textContent = `${result.km.toFixed(1)} km from the shop · Free delivery`;
    } else {
      deliveryStatusEl.textContent = `${result.km.toFixed(1)} km from the shop · ${formatPrice(result.fee)} delivery fee`;
    }
    deliveryStatusEl.classList.remove("delivery-status-error");
  } else {
    deliveryStatusEl.textContent = `Couldn't pinpoint that address — using the standard delivery fee of ${formatPrice(DELIVERY_FALLBACK_FEE)}.`;
    deliveryStatusEl.classList.add("delivery-status-error");
  }

  updateOrderCostBreakdown();
}

function scheduleDeliveryRecalc(){
  clearTimeout(deliveryDebounceTimer);
  deliveryDebounceTimer = setTimeout(recalcDeliveryFee, 700);
}

[orderAddressInput, orderCityInput, orderPostalInput].forEach(input => {
  input.addEventListener("input", scheduleDeliveryRecalc);
});

// ===================== Order modal =====================
function openOrderModal(items, isCartCheckout){
  orderItems = items;
  orderItems_isCartCheckout = !!isCartCheckout;
  orderError.textContent = "";
  resetPaymentProofField();
  resetPromoField();

  modalItemsList.innerHTML = items.map(item => `
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

  currentDeliveryFee = DELIVERY_FALLBACK_FEE;
  currentDeliveryKm = null;
  updateOrderCostBreakdown();

  if (saved && saved.address && saved.city) {
    recalcDeliveryFee();
  } else {
    deliveryStatusEl.textContent = "Enter your address to calculate the delivery fee.";
    deliveryStatusEl.classList.remove("delivery-status-error");
  }

  openModalAccessible(orderModal, orderNameInput);
}

function closeOrderModal(){
  closeModalAccessible(orderModal);
  orderForm.reset();
  orderItems = [];
  resetPaymentProofField();
  resetPromoField();
}

modalClose.addEventListener("click", closeOrderModal);
orderModal.addEventListener("click", (e) => {
  if (e.target === orderModal) closeOrderModal();
});

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

    if (orderSaveCheckbox.checked) {
      const newAddress = { name, phone, address, city, postal, landmark };
      currentUserProfile.address = newAddress;
      await supabase.from("profiles").update({ address: newAddress }).eq("id", currentUserId);
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
    const deliveryDays = 3 + Math.floor(Math.random() * 4);
    const placedAt = Date.now();

    const row = {
      id: "ORD-" + Date.now().toString(36).toUpperCase(),
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
      payment_proof: pendingPaymentProofDataUrl || null,
      half_payment: halfPayment,
      amount_due_now: amountDueNow,
      amount_due_later: amountDueLater,
      address: { name, phone, address, city, postal, landmark },
      placed_at: placedAt,
      delivery_days: deliveryDays,
      status_override: null,
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

    const eta = new Date(placedAt + deliveryDays * 24 * 60 * 60 * 1000);
    const label = orderItems.length === 1 ? orderItems[0].name : `${orderItems.length} items`;
    const kmNote = currentDeliveryKm != null ? ` (${currentDeliveryKm.toFixed(1)} km delivery)` : "";
    const halfNote = halfPayment ? ` · Pay ${formatPrice(amountDueNow)} now, ${formatPrice(amountDueLater)} on delivery` : "";
    const promoNote = appliedPromo ? ` · Code ${appliedPromo.row.code} saved ${formatPrice(promoDiscount)}` : "";
    showToast(`Order placed for ${label} · ${paymentMethodLabel(paymentMethod)} · Total ${formatPrice(total)}${halfNote}${promoNote}${kmNote}. Estimated delivery ${formatDate(eta)}.`);

    if (orderItems_isCartCheckout) {
      await saveCart([]);
      updateCartBadge();
    }

    closeOrderModal();
    await renderCatalogue();
    updateCartBadge();
  } finally {
    isSubmittingOrder = false;
    submitBtn.disabled = false;
  }
});

function showToast(message){
  toastMessage.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 4600);
}

// ===================== Orders / Tracking / Ratings =====================
const TRACKER_STEPS = ["Order Placed", "Processing", "Shipped", "Out for Delivery", "Delivered"];
const MY_ORDERS_PAGE_SIZE = 8;
let myOrdersVisibleCount = MY_ORDERS_PAGE_SIZE;

function getOrderStatus(order){
  if (order.statusOverride !== null && order.statusOverride !== undefined) {
    const stepIndex = order.statusOverride;
    const eta = new Date(order.placedAt + order.deliveryDays * 24 * 60 * 60 * 1000);
    return { stepIndex, eta, delivered: stepIndex === 4 };
  }

  const now = Date.now();
  const totalMs = order.deliveryDays * 24 * 60 * 60 * 1000;
  const elapsedMs = now - order.placedAt;
  const fraction = Math.min(Math.max(elapsedMs / totalMs, 0), 1);

  let stepIndex;
  if (fraction >= 1) stepIndex = 4;
  else if (fraction >= 0.75) stepIndex = 3;
  else if (fraction >= 0.45) stepIndex = 2;
  else if (fraction >= 0.15) stepIndex = 1;
  else stepIndex = 0;

  const eta = new Date(order.placedAt + totalMs);
  return { stepIndex, eta, delivered: stepIndex === 4 };
}

function isOrderCancellable(order){
  if (order.cancelled) return false;
  const status = getOrderStatus(order);
  return status.stepIndex < 2;
}

// FIX #8: fetchMyOrders now accepts limit/offset for pagination. Callers
// that just want "all of them" (recommendation engine) pass a high limit.
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

  const { error } = await supabase.from("orders").update({ cancelled: true }).eq("id", orderId).eq("user_id", currentUserId);
  if (error) { console.error(error); return; }

  await restoreStockForLines(expandOrderLinesForStock(order.items));

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
    ? `Delivered on ${formatDate(status.eta)}`
    : `Estimated delivery: ${formatDate(status.eta)}`;

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
  myOrdersCache = await fetchMyOrders(myOrdersVisibleCount, 0);

  if (myOrdersCache.length === 0) {
    ordersList.innerHTML = `<p class="order-empty">You haven't placed any orders yet.</p>`;
    if (ordersLoadMoreBtn) ordersLoadMoreBtn.classList.add("hidden");
    return;
  }

  ordersList.innerHTML = myOrdersCache.map(renderOrderCard).join("");

  if (ordersLoadMoreBtn) {
    // We fetched exactly myOrdersVisibleCount rows; if we got a full page,
    // assume more might exist and offer "load more" (a lightweight
    // approach — avoids an extra COUNT query on every render).
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

  order.rated[productId] = value;
  const { error } = await supabase.from("orders").update({ rated: order.rated }).eq("id", orderId).eq("user_id", currentUserId);
  if (error) { console.error(error); return; }

  await addRating(productId, value);

  await renderOrdersModal();
  renderCatalogueList();
  updateCartBadge();
}

async function openOrdersModal(){
  myOrdersVisibleCount = MY_ORDERS_PAGE_SIZE;
  await renderOrdersModal();
  openModalAccessible(ordersModal, ordersModalClose);
}
function closeOrdersModal(){
  closeModalAccessible(ordersModal);
}

ordersBtn.addEventListener("click", () => requireLogin(openOrdersModal, "Log in to view your orders."));
ordersModalClose.addEventListener("click", closeOrdersModal);
ordersModal.addEventListener("click", (e) => {
  if (e.target === ordersModal) closeOrdersModal();
});

// ===================== Profile =====================
function openProfileModal(){
  const profile = (currentUserProfile && currentUserProfile.profile) || {};
  pendingAvatarUrl = undefined;

  profileUsernameDisplay.value = currentUser;
  profileNameInput.value = profile.name || "";
  profileEmailInput.value = profile.email || "";
  profilePhoneInput.value = profile.phone || "";
  profileBioInput.value = profile.bio || "";
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

  const existingAvatar = (currentUserProfile.profile && currentUserProfile.profile.avatar) || null;
  const avatar = pendingAvatarUrl === undefined ? existingAvatar : pendingAvatarUrl;

  const newProfile = { name, email, phone, bio, avatar };
  const { error } = await supabase.from("profiles").update({ profile: newProfile }).eq("id", currentUserId);

  if (error) {
    profileError.textContent = "Could not save your profile. Please try again.";
    return;
  }

  currentUserProfile.profile = newProfile;
  accountMenuLabel.textContent = name || currentUser;
  renderAvatar(headerAvatar, avatar, currentUser);
  profileError.textContent = "";
  profileSuccess.textContent = "Profile saved.";
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

  // SECURITY FIX #5: honeypot check — silently no-op for bots.
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
    id: "MSG-" + Date.now().toString(36).toUpperCase(),
    name, email, message,
    sent_at: Date.now()
  });
  if (error) console.error("Could not save message:", error);

  const subject = encodeURIComponent(`New message from ${name} — Dagoldol Shop`);
  const body = encodeURIComponent(`From: ${name} <${email}>\n\n${message}`);
  window.open(`mailto:${OWNER_EMAIL}?subject=${subject}&body=${body}`, "_blank");

  closeContactModal();
  showToast("Message sent! It's saved to the shop and your email app should open to send it to the owner.");
});

// =====================================================================
// ===================== LIVE CHAT (customer <-> seller) ===============
// =====================================================================
const CHAT_PRESENCE_CHANNEL_NAME = "dagoldol-presence";
let presenceChannel = null;
let presenceState = {};
let myPresenceRole = null;

let chatMessagesChannel = null;
let chatThreadsChannel = null;

let myChatThreadId = null;
let currentChatThreadRow = null;
let chatMessagesCache = [];

let unreadChatCount = 0;
let adminChatThreadsCache = [];
let adminActiveChatThreadUserId = null;

let chatTypingDebounce = null;
let adminChatTypingDebounce = null;

// FIX #8: admin thread list pagination
const ADMIN_CHAT_THREADS_PAGE_SIZE = 20;
let adminChatThreadsVisibleCount = ADMIN_CHAT_THREADS_PAGE_SIZE;

function initPresence(role, key, extra){
  myPresenceRole = role;
  if (presenceChannel) supabase.removeChannel(presenceChannel);
  presenceChannel = supabase.channel(CHAT_PRESENCE_CHANNEL_NAME, { config: { presence: { key } } });

  presenceChannel.on("presence", { event: "sync" }, () => {
    presenceState = presenceChannel.presenceState();
    refreshPresenceUI();
  });

  presenceChannel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      await presenceChannel.track({ role, typing: false, activeThread: null, ...extra });
    }
  });
}

function setTyping(threadId, typing){
  if (!presenceChannel || !myPresenceRole) return;
  presenceChannel.track({ role: myPresenceRole, typing, activeThread: threadId });
}

function isSellerOnline(){
  return Object.values(presenceState).some(entries => entries.some(p => p.role === "admin"));
}

function isCustomerOnline(customerId){
  const entries = presenceState[customerId] || [];
  return entries.some(p => p.role === "customer");
}

function isSellerTypingInThread(threadId){
  return Object.values(presenceState).some(entries => entries.some(p => p.role === "admin" && p.typing && p.activeThread === threadId));
}

function isCustomerTypingInThread(customerId){
  const entries = presenceState[customerId] || [];
  return entries.some(p => p.role === "customer" && p.typing && p.activeThread === customerId);
}

function refreshPresenceUI(){
  if (chatOnlineStatusEl && myPresenceRole === "customer") {
    const online = isSellerOnline();
    chatOnlineStatusEl.innerHTML = `<span class="${online ? "online-dot" : "offline-dot"}"></span> ${online ? "The seller is online" : "The seller is offline"}`;
  }
  if (chatTypingIndicatorEl && myChatThreadId) {
    chatTypingIndicatorEl.classList.toggle("hidden", !isSellerTypingInThread(myChatThreadId));
  }

  if (myPresenceRole === "admin") {
    renderAdminChatThreadList();
    if (adminActiveChatThreadUserId) {
      const typingEl = document.getElementById("admin-chat-typing-indicator");
      if (typingEl) typingEl.classList.toggle("hidden", !isCustomerTypingInThread(adminActiveChatThreadUserId));
      const headerDot = document.getElementById("admin-chat-conversation-online-dot");
      if (headerDot) {
        const online = isCustomerOnline(adminActiveChatThreadUserId);
        headerDot.className = online ? "online-dot" : "offline-dot";
      }
    }
  }
}

function requestChatNotificationPermission(){
  if (typeof Notification === "undefined") {
    showToast("This browser doesn't support notifications.");
    return;
  }
  Notification.requestPermission().then(() => {
    if (Notification.permission === "granted") showToast("Notifications enabled for new messages.");
  });
}

function showChatNotification(title, body){
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted" && document.hidden) {
    try { new Notification(title, { body }); } catch (err) { /* ignore */ }
  }
}

function updateDocumentTitleUnread(count){
  document.title = count > 0 ? `(${count}) ${DOCUMENT_TITLE_BASE}` : DOCUMENT_TITLE_BASE;
}

let lastChatError = null;

function chatSetupErrorMessage(error){
  if (!error) return "";
  const msg = error.message || String(error);
  if (/relation .* does not exist/i.test(msg) || /could not find the table/i.test(msg)) {
    return `Chat tables aren't set up yet in Supabase (${msg}). Create the "chat_threads" and "chat_messages" tables — see the setup notes.`;
  }
  if (/row-level security|permission denied|rls/i.test(msg)) {
    return `Supabase is blocking chat access with Row Level Security (${msg}). Run supabase_rls.sql, which includes working chat policies.`;
  }
  return `Chat error: ${msg}`;
}

async function ensureChatThread(userId, username){
  const { data, error } = await supabase.from("chat_threads").select("*").eq("id", userId).maybeSingle();
  if (error) { console.error("[Dagoldol] ensureChatThread error:", error); lastChatError = error; return null; }
  if (data) { lastChatError = null; return data; }

  const now = Date.now();
  const newThread = {
    id: userId, username, created_at: now, last_message_at: null, last_message_preview: "",
    customer_last_read_at: now, admin_last_read_at: now
  };
  const { error: insertError } = await supabase.from("chat_threads").insert(newThread);
  if (insertError) { console.error("[Dagoldol] Could not create chat thread:", insertError); lastChatError = insertError; return null; }
  lastChatError = null;
  return newThread;
}

async function fetchChatMessages(threadId){
  const { data, error } = await supabase.from("chat_messages").select("*").eq("thread_id", threadId).order("sent_at", { ascending: true });
  if (error) { console.error(error); lastChatError = error; return []; }
  return (data || []).map(mapChatMessageRow);
}

async function sendChatMessage(threadId, sender, senderName, body){
  const sentAt = Date.now();
  const row = { id: "msg-" + Date.now().toString(36) + Math.floor(Math.random() * 1000), thread_id: threadId, sender, sender_name: senderName, body, sent_at: sentAt };
  const { error } = await supabase.from("chat_messages").insert(row);
  if (error) { console.error("[Dagoldol] sendChatMessage error:", error); return null; }
  await supabase.from("chat_threads").update({ last_message_at: sentAt, last_message_preview: body.slice(0, 80) }).eq("id", threadId);
  return row;
}

async function markThreadRead(threadId, role){
  const field = role === "admin" ? "admin_last_read_at" : "customer_last_read_at";
  const now = Date.now();
  await supabase.from("chat_threads").update({ [field]: now }).eq("id", threadId);
  if (currentChatThreadRow && currentChatThreadRow.id === threadId) currentChatThreadRow[field] = now;
}

async function computeCustomerUnreadCount(threadId, lastReadAt){
  const { count, error } = await supabase
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId)
    .eq("sender", "admin")
    .gt("sent_at", lastReadAt || 0);
  if (error) { console.error(error); return 0; }
  return count || 0;
}

function renderChatMessages(containerEl, messages, viewerRole, threadRow){
  if (!containerEl) return;
  containerEl.innerHTML = messages.map(m => {
    const mine = m.sender === viewerRole;
    const readAt = viewerRole === "customer" ? (threadRow && threadRow.admin_last_read_at) : (threadRow && threadRow.customer_last_read_at);
    const isRead = mine && readAt && m.sentAt <= readAt;
    const ticks = mine ? `<span class="chat-read-ticks ${isRead ? "chat-read-ticks-read" : ""}">${isRead ? "✓✓" : "✓"}</span>` : "";
    return `
      <div class="chat-bubble ${mine ? "chat-bubble-mine" : "chat-bubble-theirs"}">
        <p class="chat-bubble-text">${escapeHtml(m.body)}</p>
        <p class="chat-bubble-meta">${formatChatTime(m.sentAt)} ${ticks}</p>
      </div>
    `;
  }).join("");
  containerEl.scrollTop = containerEl.scrollHeight;
}

function updateChatBadge(){
  if (!chatCountBadge) return;
  chatCountBadge.textContent = unreadChatCount;
  chatCountBadge.classList.toggle("hidden", unreadChatCount === 0);
}

async function openChatModal(){
  if (!currentUserId) return;
  myChatThreadId = currentUserId;
  currentChatThreadRow = await ensureChatThread(currentUserId, currentUser);
  if (!currentChatThreadRow) {
    openModalAccessible(chatModal, chatInput);
    chatMessagesListEl.innerHTML = `<p class="admin-empty">${escapeHtml(chatSetupErrorMessage(lastChatError) || "Chat isn't available right now. Please try again later.")}</p>`;
    return;
  }
  chatMessagesCache = await fetchChatMessages(myChatThreadId);
  renderChatMessages(chatMessagesListEl, chatMessagesCache, "customer", currentChatThreadRow);
  await markThreadRead(myChatThreadId, "customer");
  unreadChatCount = 0;
  updateChatBadge();
  updateDocumentTitleUnread(0);
  refreshPresenceUI();
  openModalAccessible(chatModal, chatInput);
}

function closeChatModal(){
  closeModalAccessible(chatModal);
  if (myChatThreadId) setTyping(myChatThreadId, false);
}

if (chatBtn) chatBtn.addEventListener("click", () => requireLogin(openChatModal, "Log in to chat with the seller."));
if (chatModalClose) chatModalClose.addEventListener("click", closeChatModal);
if (chatModal) chatModal.addEventListener("click", (e) => { if (e.target === chatModal) closeChatModal(); });
if (chatEnableNotifsBtn) chatEnableNotifsBtn.addEventListener("click", requestChatNotificationPermission);

if (chatForm) {
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = chatInput.value.trim();
    if (!body || !myChatThreadId) return;
    chatInput.value = "";
    setTyping(myChatThreadId, false);
    const row = await sendChatMessage(myChatThreadId, "customer", currentUser, body);
    if (row) {
      chatMessagesCache.push(mapChatMessageRow(row));
      renderChatMessages(chatMessagesListEl, chatMessagesCache, "customer", currentChatThreadRow);
    }
  });
}

if (chatInput) {
  chatInput.addEventListener("input", () => {
    if (!myChatThreadId) return;
    setTyping(myChatThreadId, true);
    clearTimeout(chatTypingDebounce);
    chatTypingDebounce = setTimeout(() => setTyping(myChatThreadId, false), 2000);
  });
}

async function refreshAdminChatThreadsList(){
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .order("last_message_at", { ascending: false })
    .range(0, adminChatThreadsVisibleCount - 1);
  if (error) reportLoadError("Chat threads", error);
  lastChatError = error || null;
  adminChatThreadsCache = error ? [] : (data || []);
  updateAdminChatTabBadge();
  renderAdminChatThreadList();
}

function updateAdminChatTabBadge(){
  const badge = document.getElementById("admin-chat-tab-badge");
  if (!badge) return;
  const hasUnread = adminChatThreadsCache.some(t => t.last_message_at && (!t.admin_last_read_at || t.last_message_at > t.admin_last_read_at));
  badge.classList.toggle("hidden", !hasUnread);
}

function renderAdminChatThreadList(){
  const listEl = document.getElementById("admin-chat-thread-list");
  if (!listEl) return;

  const emptyMessage = lastChatError
    ? `<p class="admin-empty" style="color:var(--rust);">${escapeHtml(chatSetupErrorMessage(lastChatError))}</p>`
    : `<p class="admin-empty">No conversations yet — they'll appear here once a customer opens Chat.</p>`;

  listEl.innerHTML = adminChatThreadsCache.map(t => {
    const unread = t.last_message_at && (!t.admin_last_read_at || t.last_message_at > t.admin_last_read_at);
    const online = isCustomerOnline(t.id);
    const active = adminActiveChatThreadUserId === t.id;
    return `
      <button type="button" class="admin-chat-thread-item ${active ? "active" : ""}" data-thread="${t.id}">
        <span class="${online ? "online-dot" : "offline-dot"}"></span>
        <span class="admin-chat-thread-name">${escapeHtml(t.username)}</span>
        ${unread ? `<span class="admin-chat-thread-badge">•</span>` : ""}
        <span class="admin-chat-thread-preview">${escapeHtml((t.last_message_preview || "").slice(0, 40))}</span>
      </button>
    `;
  }).join("") || emptyMessage;

  // FIX #8: load-more affordance under the thread list
  if (adminChatThreadsCache.length >= adminChatThreadsVisibleCount) {
    listEl.insertAdjacentHTML("beforeend", `<div class="admin-chat-load-more"><button type="button" class="link-btn" id="admin-chat-load-more-btn">Load more conversations</button></div>`);
    const moreBtn = document.getElementById("admin-chat-load-more-btn");
    if (moreBtn) moreBtn.addEventListener("click", () => {
      adminChatThreadsVisibleCount += ADMIN_CHAT_THREADS_PAGE_SIZE;
      refreshAdminChatThreadsList();
    });
  }

  listEl.querySelectorAll("[data-thread]").forEach(btn => {
    btn.addEventListener("click", () => openAdminChatThread(btn.dataset.thread));
  });
}

async function openAdminChatThread(threadId){
  adminActiveChatThreadUserId = threadId;
  currentChatThreadRow = adminChatThreadsCache.find(t => t.id === threadId) || null;
  chatMessagesCache = await fetchChatMessages(threadId);
  renderAdminChatConversation();
  renderChatMessages(document.getElementById("admin-chat-messages-list"), chatMessagesCache, "admin", currentChatThreadRow);
  await markThreadRead(threadId, "admin");
  await refreshAdminChatThreadsList();
}

function renderAdminChatConversation(){
  const convoEl = document.getElementById("admin-chat-conversation");
  if (!convoEl) return;

  if (!adminActiveChatThreadUserId) {
    convoEl.innerHTML = `<p class="admin-empty">Select a conversation from the left.</p>`;
    return;
  }

  const thread = adminChatThreadsCache.find(t => t.id === adminActiveChatThreadUserId);
  const online = isCustomerOnline(adminActiveChatThreadUserId);

  convoEl.innerHTML = `
    <div class="chat-conversation-header">
      <span id="admin-chat-conversation-online-dot" class="${online ? "online-dot" : "offline-dot"}"></span>
      <span>${thread ? escapeHtml(thread.username) : "Customer"}</span>
    </div>
    <div class="chat-messages-list" id="admin-chat-messages-list"></div>
    <p class="chat-typing-indicator hidden" id="admin-chat-typing-indicator">Customer is typing…</p>
    <form class="chat-input-row" id="admin-chat-form">
      <input type="text" id="admin-chat-input" placeholder="Type a message…" autocomplete="off" maxlength="2000">
      <button type="submit" class="btn-primary" style="width:auto;">Send</button>
    </form>
  `;

  const adminChatForm = document.getElementById("admin-chat-form");
  const adminChatInput = document.getElementById("admin-chat-input");

  adminChatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = adminChatInput.value.trim();
    if (!body) return;
    adminChatInput.value = "";
    setTyping(adminActiveChatThreadUserId, false);
    const row = await sendChatMessage(adminActiveChatThreadUserId, "admin", currentUser, body);
    if (row) {
      chatMessagesCache.push(mapChatMessageRow(row));
      renderChatMessages(document.getElementById("admin-chat-messages-list"), chatMessagesCache, "admin", currentChatThreadRow);
    }
  });

  adminChatInput.addEventListener("input", () => {
    setTyping(adminActiveChatThreadUserId, true);
    clearTimeout(adminChatTypingDebounce);
    adminChatTypingDebounce = setTimeout(() => setTyping(adminActiveChatThreadUserId, false), 2000);
  });
}

async function renderAdminChat(){
  adminChatThreadsVisibleCount = ADMIN_CHAT_THREADS_PAGE_SIZE;
  await refreshAdminChatThreadsList();
  renderAdminChatTab();
}

function renderAdminChatTab(){
  const panel = adminTabPanels.chat;
  if (!panel) return;
  panel.innerHTML = `
    <h2 class="admin-section-title">Live Chat (Seller Chat)</h2>
    <div class="admin-chat-layout">
      <div class="admin-chat-thread-list" id="admin-chat-thread-list"></div>
      <div class="admin-chat-conversation" id="admin-chat-conversation">
        <p class="admin-empty">Select a conversation from the left.</p>
      </div>
    </div>
  `;
  renderAdminChatThreadList();
  if (adminActiveChatThreadUserId) renderAdminChatConversation();
}

function subscribeChatRealtime(){
  if (chatMessagesChannel) supabase.removeChannel(chatMessagesChannel);
  chatMessagesChannel = supabase
    .channel("chat-messages-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, async (payload) => {
      const msg = mapChatMessageRow(payload.new);
      const alreadyHave = chatMessagesCache.some(m => m.id === msg.id);

      if (currentUserProfile && currentUserProfile.role === "admin") {
        await refreshAdminChatThreadsList();
        if (adminActiveChatThreadUserId === msg.threadId) {
          if (!alreadyHave) chatMessagesCache.push(msg);
          renderChatMessages(document.getElementById("admin-chat-messages-list"), chatMessagesCache, "admin", currentChatThreadRow);
          if (msg.sender === "customer") await markThreadRead(msg.threadId, "admin");
        } else if (msg.sender === "customer") {
          showChatNotification("New customer message", `${msg.senderName}: ${msg.body}`);
          showToast(`New message from ${msg.senderName}: ${msg.body}`);
        }
      } else if (currentUserId && msg.threadId === myChatThreadId) {
        if (!chatModal.classList.contains("hidden")) {
          if (!alreadyHave) chatMessagesCache.push(msg);
          renderChatMessages(chatMessagesListEl, chatMessagesCache, "customer", currentChatThreadRow);
          if (msg.sender === "admin") await markThreadRead(msg.threadId, "customer");
        } else if (msg.sender === "admin") {
          unreadChatCount += 1;
          updateChatBadge();
          updateDocumentTitleUnread(unreadChatCount);
          showChatNotification("Dagoldol", msg.body);
          showToast(`New message from the shop: ${msg.body}`);
        }
      }
    })
    .subscribe();

  if (chatThreadsChannel) supabase.removeChannel(chatThreadsChannel);
  chatThreadsChannel = supabase
    .channel("chat-threads-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_threads" }, (payload) => {
      if (!payload.new) return;
      if (currentUserProfile && currentUserProfile.role === "admin") {
        refreshAdminChatThreadsList();
        if (adminActiveChatThreadUserId === payload.new.id) {
          currentChatThreadRow = payload.new;
          renderChatMessages(document.getElementById("admin-chat-messages-list"), chatMessagesCache, "admin", currentChatThreadRow);
        }
      } else if (payload.new.id === currentUserId) {
        currentChatThreadRow = payload.new;
        if (!chatModal.classList.contains("hidden")) {
          renderChatMessages(chatMessagesListEl, chatMessagesCache, "customer", currentChatThreadRow);
        }
      }
    })
    .subscribe();
}

function teardownChatRealtime(){
  if (presenceChannel) { supabase.removeChannel(presenceChannel); presenceChannel = null; }
  if (chatMessagesChannel) { supabase.removeChannel(chatMessagesChannel); chatMessagesChannel = null; }
  if (chatThreadsChannel) { supabase.removeChannel(chatThreadsChannel); chatThreadsChannel = null; }
  presenceState = {};
  myPresenceRole = null;
  myChatThreadId = null;
  currentChatThreadRow = null;
  chatMessagesCache = [];
  adminActiveChatThreadUserId = null;
  unreadChatCount = 0;
  updateDocumentTitleUnread(0);
}

// ===================== Modal accessibility: focus trap + Escape =====================
let lastFocusedBeforeModal = null;
let activeModalEl = null;

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
  lastFocusedBeforeModal = document.activeElement;
  modalEl.classList.remove("hidden");
  activeModalEl = modalEl;
  document.addEventListener("keydown", trapFocusKeydown);
  const toFocus = (preferredFocusEl && !preferredFocusEl.disabled) ? preferredFocusEl : getFocusableEls(modalEl)[0];
  if (toFocus) toFocus.focus();
}

function closeModalAccessible(modalEl){
  modalEl.classList.add("hidden");
  if (activeModalEl === modalEl) {
    activeModalEl = null;
    document.removeEventListener("keydown", trapFocusKeydown);
  }
  if (lastFocusedBeforeModal && document.body.contains(lastFocusedBeforeModal)) {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

function closeTopModal(){
  if (!activeModalEl) return;
  const map = {
    "size-modal": closeSizeModal,
    "profile-modal": closeProfileModal,
    "cart-modal": closeCartModal,
    "order-modal": closeOrderModal,
    "orders-modal": closeOrdersModal,
    "contact-modal": closeContactModal,
    "chat-modal": closeChatModal
  };
  const fn = map[activeModalEl.id];
  if (fn) fn();
  else closeModalAccessible(activeModalEl);
}

// ===================== Enter the shop (or the admin dashboard) =====================
async function enterShop(){
  const account = currentUserProfile;

  errorMessage.textContent = "";
  loginScreen.classList.add("hidden");
  loginGateMessageEl.classList.add("hidden");
  loginForm.reset();
  signupForm.reset();

  if (account.role === "admin") {
    shopScreen.classList.add("hidden");
    adminWelcomeName.textContent = currentUser;
    adminScreen.classList.remove("hidden");
    await Promise.all([
      renderAdminOrders(),
      renderAdminProducts(),
      renderAdminBundles(),
      renderAdminBrands(),
      renderAdminFlashSales(),
      renderAdminPromos(),
      renderAdminChat(),
      renderAdminMessages(),
      renderAdminActivity(),
      renderAdminAnalytics(),
      renderAdminSettings()
    ]);
    await renderAdminAccounts();

    initPresence("admin", "admin", { username: currentUser });
    subscribeChatRealtime();
  } else {
    adminScreen.classList.add("hidden");
    const profile = account.profile || {};
    await mergeGuestCartIntoProfile();
    setHeaderCustomerState(profile.name || currentUser, profile.avatar || null);
    shopScreen.classList.remove("hidden");
    await renderCatalogue();
    updateCartBadge();

    initPresence("customer", currentUserId, { username: currentUser });
    subscribeChatRealtime();

    recsLastRefreshAt = Date.now();
    subscribeRecommendationsRealtime();

    myChatThreadId = currentUserId;
    currentChatThreadRow = await ensureChatThread(currentUserId, currentUser);
    unreadChatCount = await computeCustomerUnreadCount(currentUserId, currentChatThreadRow ? currentChatThreadRow.customer_last_read_at : 0);
    updateChatBadge();
    updateDocumentTitleUnread(unreadChatCount);
  }

  if (account.role !== "admin" && pendingLoginIntent) {
    const intent = pendingLoginIntent;
    pendingLoginIntent = null;
    intent();
  }
}

async function enterGuestShop(){
  errorMessage.textContent = "";
  loginScreen.classList.add("hidden");
  loginGateMessageEl.classList.add("hidden");
  adminScreen.classList.add("hidden");
  shopScreen.classList.remove("hidden");
  setHeaderGuestState();
  await renderCatalogue();
  updateCartBadge();
}

async function backToLogin(){
  await supabase.auth.signOut();
  teardownChatRealtime();
  teardownRecommendationsRealtime();
  currentUser = null;
  currentUserId = null;
  currentUserProfile = null;
  closeAccountMenu();
  adminScreen.classList.add("hidden");
  await enterGuestShop();
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
  console.log("[Dagoldol] Login form submitted.");

  // SECURITY FIX #5: honeypot check.
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
    errorMessage.textContent = "Could not reach the server. Check your connection and try again.";
    return;
  }

  console.log("[Dagoldol] signInWithPassword result:", { data, error });

  if (error || !data.user) {
    submitBtn.disabled = false;
    errorMessage.textContent = "Incorrect email or password. Try again.";
    errorMessage.classList.remove("shake");
    void errorMessage.offsetWidth;
    errorMessage.classList.add("shake");
    passwordInput.value = "";
    passwordInput.focus();
    return;
  }

  const profile = await fetchProfile(data.user.id);
  submitBtn.disabled = false;

  console.log("[Dagoldol] fetched profile:", profile);

  if (!profile) {
    errorMessage.textContent = "Your account isn't fully set up yet. Please contact the shop owner.";
    await supabase.auth.signOut();
    return;
  }

  currentUserId = data.user.id;
  currentUser = profile.username;
  currentUserProfile = profile;

  await supabase.from("activity").insert({
    id: "LOG-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000),
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

// FIX #9: forgot-password card
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

  // SECURITY FIX #5: honeypot check.
  if (isHoneypotTripped("signup-hp")) return;

  const newEmail = signupEmailInput.value.trim();
  const newUsername = signupUsernameInput.value.trim();
  const newPassword = signupPasswordInput.value;
  const confirmPassword = signupConfirmInput.value;

  if (!newEmail || !newUsername || !newPassword) {
    signupError.textContent = "Please fill in every field.";
    return;
  }
  // FIX #4: minimum length raised from 4 to 8, plus a nudge toward mixing
  // character types (not hard-enforced, since arbitrary composition rules
  // often just push people toward "Passw0rd!" patterns — length matters
  // more; the strength meter above gives the additional feedback).
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

  const { data, error } = await supabase.auth.signUp({ email: newEmail, password: newPassword });
  console.log("[Dagoldol] signUp result:", { data, error });

  if (error) {
    submitBtn.disabled = false;
    signupError.textContent = error.message || "Could not create that account.";
    return;
  }

  if (!data.user) {
    submitBtn.disabled = false;
    signupError.textContent = "Check your email to confirm your account, then log in.";
    return;
  }

  // SECURITY FIX #3: role is no longer trusted from a value the client
  // could tamper with anywhere else in this flow — it's hardcoded here,
  // AND (belt-and-suspenders) the RLS insert policy in supabase_rls.sql
  // rejects the insert outright if role isn't exactly 'customer'.
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
    id: "LOG-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000),
    type: "signup",
    username: newUsername,
    at: Date.now()
  });

  signupError.textContent = "";
  signupForm.reset();
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
      redirectTo: window.location.origin + window.location.pathname
    });

    submitBtn.disabled = false;

    // Deliberately show the same success message whether or not the email
    // exists — confirming/denying account existence here would leak which
    // emails are registered.
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

// Supabase appends a recovery session to the URL hash when the person
// arrives via the "reset password" email link. Detect that and show the
// reset-password card instead of the normal login card.
supabase.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    loginScreen.classList.remove("hidden");
    shopScreen.classList.add("hidden");
    adminScreen.classList.add("hidden");
    loginCard.classList.add("hidden");
    signupCard.classList.add("hidden");
    const forgotCardEl = document.getElementById("forgot-card");
    if (forgotCardEl) forgotCardEl.classList.add("hidden");
    if (resetCard) resetCard.classList.remove("hidden");
    if (resetPasswordInput) resetPasswordInput.focus();
  }
});

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
  chat: document.getElementById("admin-tab-chat"),
  messages: document.getElementById("admin-tab-messages"),
  accounts: document.getElementById("admin-tab-accounts"),
  analytics: document.getElementById("admin-tab-analytics"),
  activity: document.getElementById("admin-tab-activity"),
  settings: document.getElementById("admin-tab-settings")
};

adminTabButtons.forEach(btn => {
  btn.addEventListener("click", async () => {
    adminTabButtons.forEach(b => b.classList.toggle("active", b === btn));
    Object.entries(adminTabPanels).forEach(([key, panel]) => {
      panel.classList.toggle("hidden", key !== btn.dataset.tab);
    });
    const tab = btn.dataset.tab;
    if (tab === "orders") await renderAdminOrders();
    else if (tab === "products") await renderAdminProducts();
    else if (tab === "bundles") await renderAdminBundles();
    else if (tab === "brands") await renderAdminBrands();
    else if (tab === "flash-sales") await renderAdminFlashSales();
    else if (tab === "promos") await renderAdminPromos();
    else if (tab === "chat") await renderAdminChat();
    else if (tab === "messages") await renderAdminMessages();
    else if (tab === "accounts") await renderAdminAccounts();
    else if (tab === "analytics") await renderAdminAnalytics();
    else if (tab === "activity") await renderAdminActivity();
    else if (tab === "settings") await renderAdminSettings();
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

async function renderAdminOrders(){
  adminOrdersCache = await fetchAllOrders(adminOrdersVisibleCount);
  renderAdminOrdersTab();
}

function renderAdminOrdersTab(){
  const panel = adminTabPanels.orders;
  const flat = adminOrdersCache;

  if (flat.length === 0) {
    panel.innerHTML = `<h2 class="admin-section-title">Orders</h2><p class="admin-empty">No orders have been placed yet.</p>`;
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
        const proofThumb = order.paymentProof
          ? `<br><span class="admin-payment-proof-thumb"><img src="${escapeHtml(order.paymentProof)}" alt="Payment proof for ${escapeHtml(order.id)}" loading="lazy" decoding="async"></span>`
          : "";
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
        <div class="size-thumb">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(label)} photo" loading="lazy" decoding="async">` : ""}</div>
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

    // FIX: the Photo input used to be `disabled` whenever the row's
    // checkbox wasn't ticked yet, matching Price/Stock — but a disabled
    // <input type="file"> can't be triggered by its wrapping <label> at
    // all, so clicking "Photo" on an unchecked row silently did nothing
    // (the click just fell through to normal text selection instead).
    // Photo is never disabled now — it works regardless of checkbox
    // state, and picking a photo auto-checks the box for you, since
    // adding a photo for a size clearly means you want that size active.
    uploadInput.addEventListener("change", async () => {
      const file = uploadInput.files[0];
      if (!file) return;
      try {
        if (uploadStatus) uploadStatus.classList.remove("hidden");
        const url = await uploadImageToStorage(file, "product-images", "sizes", 500);
        row.dataset.image = url;
        row.querySelector(".size-thumb").innerHTML = `<img src="${escapeHtml(url)}" alt="size photo" loading="lazy" decoding="async">`;
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
                <span class="brand-chip-logo">${b.logo ? `<img src="${escapeHtml(b.logo)}" alt="${escapeHtml(b.name)}" loading="lazy" decoding="async">` : ""}</span>
                ${escapeHtml(b.name)}
              </span>
            </span>
          </div>
          <div class="admin-card-body">${escapeHtml(b.description || "No description.")}</div>
          <div class="admin-card-actions">
            <button type="button" class="admin-btn-danger" data-id="${b.id}" data-action="delete-brand">Delete</button>
          </div>
        </div>
      `).join("") || `<p class="admin-empty">No brands yet — add one above.</p>`}
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
  products = products.length ? products : await loadProducts();
  await loadFlashSales();
  renderAdminFlashSalesTab();
}

function datetimeLocalToMs(value){
  if (!value) return null;
  const t = new Date(value).getTime();
  return isNaN(t) ? null : t;
}
function msToDatetimeLocalValue(ms){
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
      }).join("") || `<p class="admin-empty">No flash sales yet — create one above.</p>`}
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
      }).join("") || `<p class="admin-empty">No vouchers or coupons yet — create one above.</p>`}
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
      }).join("") || `<p class="admin-empty">No bundles yet — create one above.</p>`}
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
  const { data, error } = await supabase.from("messages").select("*").order("sent_at", { ascending: false });
  if (error) reportLoadError("Messages", error);
  adminMessagesCache = error ? [] : (data || []);
  renderAdminMessagesTab();
}

function renderAdminMessagesTab(){
  const panel = adminTabPanels.messages;
  const messages = adminMessagesCache;

  if (messages.length === 0) {
    panel.innerHTML = `<h2 class="admin-section-title">Messages</h2><p class="admin-empty">No contact messages yet.</p>`;
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

async function deleteAuthUserViaEdgeFunction(userId){
  try {
    const { data, error } = await supabase.functions.invoke("delete-auth-user", {
      body: { userId }
    });
    if (error) {
      console.warn("[Dagoldol] delete-auth-user Edge Function call failed (has it been deployed?):", error);
      return false;
    }
    if (data && data.error) {
      console.warn("[Dagoldol] delete-auth-user Edge Function returned an error:", data.error);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Dagoldol] delete-auth-user Edge Function is not deployed yet:", err);
    return false;
  }
}

async function deleteAccount(username, profileId){
  const { error } = await supabase.from("profiles").delete().eq("id", profileId);
  if (error) { console.error(error); showErrorBanner("Could not delete that account. Please try again."); return; }

  const authDeleted = await deleteAuthUserViaEdgeFunction(profileId);
  if (!authDeleted) {
    showToast(`Profile for "${username}" deleted. Their login still exists (Edge Function not deployed — see comment in script.js) so they can sign up again with a new profile using the same email.`);
  } else {
    showToast(`Account "${username}" fully deleted, including their login.`);
  }

  await renderAdminAccounts();
}

async function renderAdminAccounts(){
  const { data, error } = await supabase.from("profiles").select("*").eq("role", "customer");
  if (error) reportLoadError("Accounts", error);
  adminAccountsCache = error ? [] : (data || []);
  renderAdminAccountsTab();
}

function renderAdminAccountsTab(){
  const panel = adminTabPanels.accounts;
  const customers = adminAccountsCache;

  if (customers.length === 0) {
    panel.innerHTML = `<h2 class="admin-section-title">Accounts</h2><p class="admin-empty">No customer accounts yet.</p>`;
    return;
  }

  panel.innerHTML = `
    <h2 class="admin-section-title">Accounts (${customers.length})</h2>
    <div class="admin-card-list">
      ${customers.map(account => {
        const username = account.username;
        const orderCount = adminOrdersCache.filter(o => o.username === username).length;
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
      if (confirm(`Delete the account "${btn.dataset.username}"? This removes their orders and cart, and their Auth login if the delete-auth-user Edge Function is deployed.`)) {
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
  const { data, error } = await supabase.from("activity").select("*").order("at", { ascending: false }).limit(200);
  if (error) reportLoadError("Activity log", error);
  adminActivityCache = error ? [] : (data || []);
  renderAdminActivityTab();
}

function renderAdminActivityTab(){
  const panel = adminTabPanels.activity;
  const log = adminActivityCache;

  if (log.length === 0) {
    panel.innerHTML = `<h2 class="admin-section-title">Activity</h2><p class="admin-empty">No sign-ups or logins recorded yet.</p>`;
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
async function renderAdminAnalytics(){
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
    expandOrderLinesForStock(order.items).forEach(line => {
      const product = findProduct(line.productId);
      const name = product ? product.name : "(removed product)";
      if (!productStats[line.productId]) productStats[line.productId] = { name, qty: 0, revenue: 0 };
      productStats[line.productId].qty += line.qty;
      const priceForLine = product ? priceForFeet(product, line.feet) : 0;
      productStats[line.productId].revenue += priceForLine * line.qty;
    });
  });
  const topProducts = Object.values(productStats).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  const paymentStats = {};
  activeOrders.forEach(o => { paymentStats[o.paymentMethod] = (paymentStats[o.paymentMethod] || 0) + 1; });

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

    <h3 class="analytics-section-title">Top Products by Revenue</h3>
    ${topProducts.length ? `
      <table class="analytics-table">
        <thead><tr><th>Product</th><th>Units Sold</th><th>Revenue</th></tr></thead>
        <tbody>
          ${topProducts.map(p => `<tr><td>${escapeHtml(p.name)}</td><td>${p.qty}</td><td>${formatPrice(p.revenue)}</td></tr>`).join("")}
        </tbody>
      </table>
    ` : `<p class="admin-empty">No sales data yet.</p>`}

    <h3 class="analytics-section-title">Orders by Payment Method</h3>
    ${Object.keys(paymentStats).length ? `
      <table class="analytics-table">
        <thead><tr><th>Method</th><th>Orders</th></tr></thead>
        <tbody>
          ${Object.entries(paymentStats).map(([method, count]) => `<tr><td>${escapeHtml(paymentMethodLabel(method))}</td><td>${count}</td></tr>`).join("")}
        </tbody>
      </table>
    ` : ""}
  `;
}

// ---------- Settings tab: GCash number + real QR code upload ----------
async function renderAdminSettings(){
  await loadSettings();
  renderAdminSettingsTab();
}

function renderAdminSettingsTab(){
  const panel = adminTabPanels.settings;
  pendingQrDataUrl = undefined;

  panel.innerHTML = `
    <h2 class="admin-section-title">Payment Settings</h2>
    <div class="admin-card">
      <p class="admin-form-title">GCash</p>
      <label class="field">
        <span>GCash number shown to customers</span>
        <input type="text" id="admin-gcash-number" value="${escapeHtml(currentSettings.gcash_number)}">
      </label>

      <div class="admin-sizes-field">
        <span class="field-label-standalone">Your real GCash QR code (upload a screenshot from your GCash app — this is exactly what customers will scan)</span>
        <div class="avatar-field" style="align-items:flex-start;">
          <div class="size-thumb" id="admin-qr-preview" style="width:120px; height:120px;">
            ${currentSettings.gcash_qr_image ? `<img src="${escapeHtml(currentSettings.gcash_qr_image)}" alt="GCash QR code" loading="lazy" decoding="async">` : ""}
          </div>
          <div class="avatar-field-controls">
            <label class="link-btn avatar-upload-label" for="admin-qr-input">Choose QR photo</label>
            <input type="file" id="admin-qr-input" accept="image/*" class="hidden">
            <button type="button" class="link-btn avatar-remove-btn" id="admin-qr-remove">Remove QR photo</button>
            <span class="avatar-upload-status hidden" id="admin-qr-upload-status">Uploading…</span>
          </div>
        </div>
      </div>

      <p id="admin-settings-error" class="error-message"></p>
      <p id="admin-settings-success" class="success-message hidden"></p>
      <button type="button" class="btn-primary" id="admin-settings-save" style="width:auto; padding:10px 22px;">Save payment settings</button>
    </div>
  `;

  const qrInput = document.getElementById("admin-qr-input");
  const qrPreview = document.getElementById("admin-qr-preview");
  const qrRemoveBtn = document.getElementById("admin-qr-remove");
  const qrUploadStatus = document.getElementById("admin-qr-upload-status");
  const saveBtn = document.getElementById("admin-settings-save");
  const errEl = document.getElementById("admin-settings-error");
  const successEl = document.getElementById("admin-settings-success");

  qrInput.addEventListener("change", async () => {
    const file = qrInput.files[0];
    if (!file) return;
    try {
      if (qrUploadStatus) qrUploadStatus.classList.remove("hidden");
      pendingQrDataUrl = await uploadImageToStorage(file, "payment-settings", "qr", 600);
      qrPreview.innerHTML = `<img src="${escapeHtml(pendingQrDataUrl)}" alt="GCash QR code" loading="lazy" decoding="async">`;
    } catch (err) {
      errEl.textContent = "Could not upload that image. Try a different photo.";
    } finally {
      if (qrUploadStatus) qrUploadStatus.classList.add("hidden");
    }
  });

  qrRemoveBtn.addEventListener("click", () => {
    pendingQrDataUrl = null;
    qrPreview.innerHTML = "";
  });

  saveBtn.addEventListener("click", async () => {
    const number = document.getElementById("admin-gcash-number").value.trim();
    if (!number) {
      errEl.textContent = "Please enter a GCash number.";
      return;
    }

    saveBtn.disabled = true;
    errEl.textContent = "";
    successEl.classList.add("hidden");

    const qrImage = pendingQrDataUrl === undefined ? currentSettings.gcash_qr_image : pendingQrDataUrl;

    const numberError = await saveSetting("gcash_number", number);
    const qrError = await saveSetting("gcash_qr_image", qrImage || "");

    saveBtn.disabled = false;

    if (numberError || qrError) {
      errEl.textContent = "Could not save settings. Make sure your Supabase project has a \"settings\" table with (key text primary key, value text), and that supabase_rls.sql has been run.";
      return;
    }

    currentSettings = { gcash_number: number, gcash_qr_image: qrImage || null };
    applySettingsToDom();
    successEl.textContent = "Payment settings saved. Customers will see this immediately.";
    successEl.classList.remove("hidden");
  });
}

// ===================== Restore session on page load =====================
async function initSession(){
  await loadSettings();
  updateDocumentTitleUnread(0);

  const { data } = await supabase.auth.getSession();
  const session = data && data.session;
  if (!session) {
    await enterGuestShop();
    return;
  }

  const profile = await fetchProfile(session.user.id);
  if (!profile) {
    await supabase.auth.signOut();
    await enterGuestShop();
    return;
  }

  currentUserId = session.user.id;
  currentUser = profile.username;
  currentUserProfile = profile;
  await enterShop();
}

initSession();

console.log("[Dagoldol] script.js finished loading without errors. All event listeners attached.");

})();
