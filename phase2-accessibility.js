import { getNextTabIndex } from './phase2-core.js';

const MODAL_SELECTOR = '.modal-overlay:not(.hidden), #image-lightbox-overlay';
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]'
].join(',');

const previousInertState = new Map();
let currentTopOverlay = null;
let lastZoomTrigger = null;

function isElementVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden || element.classList.contains('hidden')) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function getFocusableElements(container) {
  if (!(container instanceof Element)) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.hasAttribute('disabled')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    return isElementVisible(element);
  });
}

function ensureUniqueId(element, fallback) {
  if (element.id) return element.id;
  let candidate = fallback;
  let index = 2;
  while (document.getElementById(candidate)) {
    candidate = `${fallback}-${index}`;
    index += 1;
  }
  element.id = candidate;
  return candidate;
}

function ensureDialogSemantics(overlay) {
  if (!(overlay instanceof HTMLElement)) return;

  const panel = overlay.id === 'image-lightbox-overlay'
    ? overlay.querySelector('.image-lightbox-content')
    : overlay.querySelector('.modal-panel');

  if (!(panel instanceof HTMLElement)) return;

  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');

  const heading = panel.querySelector('h1, h2, h3, .modal-item-name');
  if (heading instanceof HTMLElement) {
    const overlayName = overlay.id || 'dagoldol-dialog';
    const headingId = ensureUniqueId(heading, `${overlayName}-title`);
    panel.setAttribute('aria-labelledby', headingId);
    panel.removeAttribute('aria-label');
  } else if (!panel.hasAttribute('aria-label')) {
    panel.setAttribute('aria-label', overlay.id === 'image-lightbox-overlay' ? 'Image preview' : 'Dialog');
  }

  overlay.setAttribute('aria-hidden', overlay.classList.contains('hidden') ? 'true' : 'false');
}

function getOpenOverlays() {
  return Array.from(document.querySelectorAll(MODAL_SELECTOR)).filter((overlay) => {
    return overlay instanceof HTMLElement && !overlay.classList.contains('hidden') && isElementVisible(overlay);
  });
}

function restoreBackgroundInertness() {
  for (const [element, wasInert] of previousInertState.entries()) {
    if (element.isConnected) element.inert = wasInert;
  }
  previousInertState.clear();
}

function applyBackgroundInertness(topOverlay) {
  restoreBackgroundInertness();

  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.tagName === 'SCRIPT') continue;
    if (child === topOverlay || child.id === 'toast-container') continue;

    previousInertState.set(child, child.inert);
    child.inert = true;
  }
}

function updateModalEnvironment() {
  const openOverlays = getOpenOverlays();
  currentTopOverlay = openOverlays.length ? openOverlays[openOverlays.length - 1] : null;

  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    if (!(overlay instanceof HTMLElement)) return;
    ensureDialogSemantics(overlay);
    overlay.setAttribute('aria-hidden', overlay.classList.contains('hidden') ? 'true' : 'false');
  });

  if (currentTopOverlay) {
    document.body.classList.add('modal-open');
    applyBackgroundInertness(currentTopOverlay);
  } else {
    document.body.classList.remove('modal-open');
    restoreBackgroundInertness();
  }
}

function trapTopModalKeydown(event) {
  if (!currentTopOverlay) return;

  if (event.key === 'Escape') {
    const closeButton = currentTopOverlay.querySelector(
      '.modal-close, .image-lightbox-close, [id$="-modal-close"], [aria-label="Close"]'
    );
    if (closeButton instanceof HTMLElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeButton.click();
    }
    return;
  }

  if (event.key !== 'Tab') return;

  const scope = currentTopOverlay.id === 'image-lightbox-overlay'
    ? currentTopOverlay.querySelector('.image-lightbox-content') || currentTopOverlay
    : currentTopOverlay.querySelector('.modal-panel') || currentTopOverlay;

  const focusable = getFocusableElements(scope);
  event.stopImmediatePropagation();

  if (!focusable.length) {
    event.preventDefault();
    if (scope instanceof HTMLElement) scope.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !scope.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function enhanceStaticModals() {
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    if (overlay instanceof HTMLElement) ensureDialogSemantics(overlay);
  });
}

function enhanceSizeSelector(root = document) {
  const group = root.querySelector?.('#size-options');
  if (group instanceof HTMLElement) {
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Available sizes');
  }
}

function restoreSizeRadioFocus(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (!input.matches('#size-options input[type="radio"][name="size-feet"]')) return;

  const selectedValue = input.value;
  requestAnimationFrame(() => {
    const replacement = Array.from(
      document.querySelectorAll('#size-options input[type="radio"][name="size-feet"]')
    ).find((candidate) => candidate instanceof HTMLInputElement && candidate.value === selectedValue);

    if (replacement instanceof HTMLElement && !replacement.hasAttribute('disabled')) {
      replacement.focus({ preventScroll: true });
    }
  });
}

function getQuantityLabel(input) {
  if (input.id === 'size-modal-qty') return 'Quantity for selected size';

  const productCard = input.closest('.product-card');
  const productName = productCard?.querySelector('.product-name')?.textContent?.trim();
  if (productName) return `Quantity for ${productName}`;

  const bundleCard = input.closest('.bundle-card');
  const bundleName = bundleCard?.querySelector('.bundle-name')?.textContent?.trim();
  if (bundleName) return `Quantity for ${bundleName}`;

  const rateOrOrderName = input.closest('.cart-line, .order-card')?.querySelector('.cart-line-name, .order-id')?.textContent?.trim();
  if (rateOrOrderName) return `Quantity for ${rateOrOrderName}`;

  return 'Quantity';
}

function enhanceInputLabels(root = document) {
  root.querySelectorAll?.('.qty-input').forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.hasAttribute('aria-label') && !input.hasAttribute('aria-labelledby')) {
      input.setAttribute('aria-label', getQuantityLabel(input));
    }
  });

  const chatUsername = document.getElementById('chat-new-username');
  if (chatUsername instanceof HTMLInputElement && !chatUsername.hasAttribute('aria-label')) {
    chatUsername.setAttribute('aria-label', 'Start a chat with username');
  }

  const dmInput = document.getElementById('dm-input');
  if (dmInput instanceof HTMLInputElement && !dmInput.hasAttribute('aria-label')) {
    dmInput.setAttribute('aria-label', 'Message');
  }
}

function enhanceStatusMessages(root = document) {
  const statusSelectors = [
    '#delivery-distance-status',
    '#promo-status',
    '.avatar-upload-status',
    '[id$="-upload-status"]'
  ];

  root.querySelectorAll?.(statusSelectors.join(',')).forEach((element) => {
    if (!(element instanceof HTMLElement)) return;
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-atomic', 'true');
  });

  const chatError = document.getElementById('chat-new-error');
  if (chatError instanceof HTMLElement) {
    chatError.setAttribute('role', 'alert');
    chatError.setAttribute('aria-atomic', 'true');
  }

  const toastContainer = document.getElementById('toast-container');
  if (toastContainer instanceof HTMLElement) {
    toastContainer.setAttribute('role', 'status');
    toastContainer.setAttribute('aria-live', 'polite');
    toastContainer.setAttribute('aria-atomic', 'false');

    toastContainer.querySelectorAll('.toast').forEach((toast) => {
      toast.removeAttribute('role');
      toast.removeAttribute('aria-live');
    });
  }
}

function isRequiredControlInvalid(control) {
  if (!(control instanceof HTMLElement)) return false;
  if (!control.hasAttribute('required') || control.hasAttribute('disabled')) return false;

  if (control instanceof HTMLInputElement) {
    if (control.type === 'checkbox') return !control.checked;
    if (control.type === 'radio') {
      if (!control.name) return !control.checked;
      const form = control.form;
      return !Array.from((form || document).querySelectorAll('input[type="radio"]'))
        .some((radio) => radio instanceof HTMLInputElement && radio.name === control.name && radio.checked);
    }
    return !control.value.trim();
  }

  if (control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
    return !control.value.trim();
  }

  return false;
}

function getFormErrorElement(form) {
  if (!(form instanceof HTMLFormElement)) return null;
  return form.querySelector('.error-message[id], [role="alert"][id]');
}

function markRequiredFields(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  const requiredControls = Array.from(form.querySelectorAll('[required]'));
  const invalidControls = [];
  const errorElement = getFormErrorElement(form);

  for (const control of requiredControls) {
    if (!(control instanceof HTMLElement)) continue;
    const invalid = isRequiredControlInvalid(control);
    control.setAttribute('aria-invalid', String(invalid));

    if (invalid) {
      invalidControls.push(control);
      if (errorElement?.id) control.setAttribute('aria-describedby', errorElement.id);
    } else if (control.getAttribute('aria-describedby') === errorElement?.id) {
      control.removeAttribute('aria-describedby');
    }
  }

  if (invalidControls.length) {
    requestAnimationFrame(() => {
      const first = invalidControls.find((control) => control.isConnected && !control.hasAttribute('disabled'));
      first?.focus({ preventScroll: false });
    });
  }
}

function clearCorrectedInvalidState(event) {
  const control = event.target;
  if (!(control instanceof HTMLElement)) return;
  if (!control.matches('input[required], select[required], textarea[required]')) return;
  if (!isRequiredControlInvalid(control)) control.setAttribute('aria-invalid', 'false');
}

function enhanceAdminTabs() {
  const tabList = document.querySelector('.admin-tabs');
  if (!(tabList instanceof HTMLElement)) return;

  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Administration sections');

  const tabs = Array.from(tabList.querySelectorAll('.admin-tab-btn'));
  tabs.forEach((tab, index) => {
    if (!(tab instanceof HTMLButtonElement)) return;
    const name = tab.dataset.tab || `section-${index + 1}`;
    const panel = document.getElementById(`admin-tab-${name}`);
    const tabId = ensureUniqueId(tab, `admin-tab-button-${name}`);

    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
    tab.tabIndex = tab.classList.contains('active') ? 0 : -1;

    if (panel instanceof HTMLElement) {
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tabId);
      panel.tabIndex = 0;
    }
  });
}

function syncAdminTabs() {
  const tabs = Array.from(document.querySelectorAll('.admin-tabs .admin-tab-btn'));
  tabs.forEach((tab) => {
    if (!(tab instanceof HTMLButtonElement)) return;
    const selected = tab.classList.contains('active');
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
  });
}

function handleAdminTabKeydown(event) {
  const tab = event.target.closest?.('.admin-tab-btn');
  if (!(tab instanceof HTMLButtonElement)) return;

  const tabs = Array.from(tab.closest('.admin-tabs')?.querySelectorAll('.admin-tab-btn') || [])
    .filter((candidate) => candidate instanceof HTMLButtonElement);
  if (!tabs.length) return;

  const nextIndex = getNextTabIndex(tabs.indexOf(tab), event.key, tabs.length);
  const navigationKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key);
  if (!navigationKey || nextIndex < 0) return;

  event.preventDefault();
  const next = tabs[nextIndex];
  tabs.forEach((item) => { item.tabIndex = -1; });
  next.tabIndex = 0;
  next.focus();
}

function enhanceZoomableImage(image) {
  if (!(image instanceof HTMLImageElement)) return;
  if (!image.classList.contains('zoomable-img')) return;

  const interactiveAncestor = image.closest('button, a[href]');
  if (!interactiveAncestor) {
    image.setAttribute('role', 'button');
    image.tabIndex = 0;
    const alt = image.alt?.trim() || 'image';
    image.setAttribute('aria-label', `Open ${alt} full size`);
  }

  const qrBox = image.closest('#gcash-qr-box');
  if (qrBox instanceof HTMLElement && qrBox.getAttribute('aria-hidden') === 'true') {
    qrBox.removeAttribute('aria-hidden');
  }
}

function enhanceZoomableImages(root = document) {
  root.querySelectorAll?.('img.zoomable-img').forEach(enhanceZoomableImage);
}

function handleZoomKeyboard(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  if (!image.classList.contains('zoomable-img') || image.closest('button, a[href]')) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;

  event.preventDefault();
  lastZoomTrigger = image;
  image.click();
}

function trackZoomActivation(event) {
  const image = event.target.closest?.('img.zoomable-img');
  if (image instanceof HTMLImageElement) lastZoomTrigger = image;
}

function enhanceDynamicLightbox(overlay) {
  if (!(overlay instanceof HTMLElement) || overlay.id !== 'image-lightbox-overlay') return;

  ensureDialogSemantics(overlay);
  const panel = overlay.querySelector('.image-lightbox-content');
  const closeButton = overlay.querySelector('.image-lightbox-close');

  if (panel instanceof HTMLElement) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Image preview');
    panel.setAttribute('tabindex', '-1');
  }

  requestAnimationFrame(() => {
    if (closeButton instanceof HTMLElement) closeButton.focus({ preventScroll: true });
    else if (panel instanceof HTMLElement) panel.focus({ preventScroll: true });
  });
}

function restoreTrackedZoomFocus() {
  requestAnimationFrame(() => {
    if (lastZoomTrigger instanceof HTMLElement && lastZoomTrigger.isConnected) {
      lastZoomTrigger.focus({ preventScroll: true });
    }
    lastZoomTrigger = null;
  });
}

function restoreLightboxFocus(removedNode) {
  if (!(removedNode instanceof HTMLElement)) return;
  const removedLightbox = removedNode.id === 'image-lightbox-overlay'
    ? removedNode
    : removedNode.querySelector?.('#image-lightbox-overlay');
  if (!removedLightbox) return;
  restoreTrackedZoomFocus();
}

function cleanToastNode(node) {
  if (!(node instanceof HTMLElement)) return;
  const toasts = [];
  if (node.classList.contains('toast')) toasts.push(node);
  node.querySelectorAll?.('.toast').forEach((toast) => toasts.push(toast));
  toasts.forEach((toast) => {
    toast.removeAttribute('role');
    toast.removeAttribute('aria-live');
  });
}

function enhanceNode(node) {
  if (!(node instanceof Element)) return;
  enhanceSizeSelector(node);
  enhanceInputLabels(node);
  enhanceStatusMessages(node);
  enhanceZoomableImages(node);
  cleanToastNode(node);

  if (node.id === 'image-lightbox-overlay') enhanceDynamicLightbox(node);
  node.querySelectorAll?.('#image-lightbox-overlay').forEach(enhanceDynamicLightbox);
}

function installMutationObserver() {
  const observer = new MutationObserver((mutations) => {
    let modalStateMayHaveChanged = false;
    let tabsMayHaveChanged = false;

    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        if (mutation.target instanceof HTMLElement && mutation.target.classList.contains('modal-overlay')) {
          modalStateMayHaveChanged = true;
        }
        if (mutation.target instanceof HTMLElement && mutation.target.id === 'image-lightbox-overlay') {
          modalStateMayHaveChanged = true;
          if (mutation.target.classList.contains('hidden')) restoreTrackedZoomFocus();
        }
        if (mutation.target instanceof HTMLElement && mutation.target.classList.contains('admin-tab-btn')) {
          tabsMayHaveChanged = true;
        }
      }

      for (const node of mutation.addedNodes) {
        enhanceNode(node);
        if (node instanceof Element && (node.matches('.modal-overlay, #image-lightbox-overlay') || node.querySelector?.('.modal-overlay, #image-lightbox-overlay'))) {
          modalStateMayHaveChanged = true;
        }
        if (node instanceof Element && (node.matches('.admin-tab-btn, .admin-tab-panel') || node.querySelector?.('.admin-tab-btn, .admin-tab-panel'))) {
          tabsMayHaveChanged = true;
        }
      }

      for (const node of mutation.removedNodes) {
        restoreLightboxFocus(node);
        if (node instanceof Element && (node.id === 'image-lightbox-overlay' || node.querySelector?.('#image-lightbox-overlay'))) {
          modalStateMayHaveChanged = true;
        }
      }
    }

    if (tabsMayHaveChanged) {
      enhanceAdminTabs();
      syncAdminTabs();
    }
    if (modalStateMayHaveChanged) updateModalEnvironment();
  });

  observer.observe(document.body, {
    subtree:true,
    childList:true,
    attributes:true,
    attributeFilter:['class']
  });
}

export function installPhase2Accessibility() {
  if (window.__dagoldolPhase2AccessibilityInstalled) return;
  window.__dagoldolPhase2AccessibilityInstalled = true;

  enhanceStaticModals();
  enhanceSizeSelector();
  enhanceInputLabels();
  enhanceStatusMessages();
  enhanceAdminTabs();
  enhanceZoomableImages();
  updateModalEnvironment();

  document.addEventListener('keydown', trapTopModalKeydown, true);
  document.addEventListener('keydown', handleAdminTabKeydown, true);
  document.addEventListener('keydown', handleZoomKeyboard, true);
  document.addEventListener('change', restoreSizeRadioFocus, true);
  document.addEventListener('submit', markRequiredFields, true);
  document.addEventListener('input', clearCorrectedInvalidState, true);
  document.addEventListener('change', clearCorrectedInvalidState, true);
  document.addEventListener('click', trackZoomActivation, true);
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('.admin-tab-btn')) queueMicrotask(syncAdminTabs);
  }, true);

  installMutationObserver();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installPhase2Accessibility, { once:true });
  } else {
    installPhase2Accessibility();
  }
}