/* =====================================================================
   DAGOLDOL — PHASE 2 PERFORMANCE & ACCESSIBILITY OVERRIDES
   ---------------------------------------------------------------------
   Additive override file loaded after style.css and pill-buttons.css.
   It deliberately preserves the existing visual identity while reducing
   repeated backdrop-filter work and fixing verified WCAG 2.1 AA issues.
   ===================================================================== */

:root{
  --phase2-control-border:#626b80;
  --phase2-dark-on-accent:#08110f;
}

/* --------------------- Performance: glass simplification --------------------- */
.product-card{
  background:rgba(23,26,35,0.90);
  backdrop-filter:none;
  -webkit-backdrop-filter:none;
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.04), 0 6px 18px rgba(0,0,0,0.22);
}

.product-card:hover{
  background:rgba(29,33,44,0.94);
  box-shadow:0 10px 24px rgba(0,0,0,0.30);
}

.field input,
.field select,
.field textarea,
.login-gate-message,
.payment-section,
.filter-search-field,
.filter-bar select,
.header-filters select,
.promo-row input,
.chat-input-row input{
  backdrop-filter:none;
  -webkit-backdrop-filter:none;
}

.field input,
.field select,
.field textarea,
.login-gate-message,
.payment-section,
.filter-search-field,
.filter-bar select,
.header-filters select,
.promo-row input,
.chat-input-row input{
  background:rgba(29,33,44,0.90);
}

.shop-header{
  background:rgba(14,16,22,0.90);
  backdrop-filter:blur(8px) saturate(130%);
  -webkit-backdrop-filter:blur(8px) saturate(130%);
}

.login-card,
.modal-panel{
  backdrop-filter:blur(14px) saturate(150%);
  -webkit-backdrop-filter:blur(14px) saturate(150%);
}

/* Keep the compact account popover glass effect because its surface is small. */
.account-menu{
  backdrop-filter:blur(16px) saturate(150%);
  -webkit-backdrop-filter:blur(16px) saturate(150%);
}

/* Avoid broad transition:all declarations on frequently used controls. */
.btn-cart,
.btn-ghost,
.btn-secondary,
.btn-cancel-order,
.admin-status-btn,
.admin-btn-danger,
.admin-btn-edit,
.admin-tab-btn,
.payment-option,
.size-option{
  transition-property:background-color,border-color,color,opacity,transform,box-shadow;
  transition-duration:0.18s;
  transition-timing-function:ease;
}

/* Move the skip link with a compositor-friendly transform instead of top. */
.skip-link{
  top:12px;
  transform:translateY(calc(-100% - 24px));
  transition:transform 0.18s ease;
}

.skip-link:focus{
  top:12px;
  transform:translateY(0);
}

/* --------------------- Accessibility: radio controls --------------------- */
.size-option{
  position:relative;
}

.size-option input{
  display:block;
  position:absolute;
  width:1px;
  height:1px;
  padding:0;
  margin:-1px;
  overflow:hidden;
  clip:rect(0 0 0 0);
  clip-path:inset(50%);
  white-space:nowrap;
  border:0;
}

.size-option:focus-within{
  outline:2px solid #4fe3c1;
  outline-offset:2px;
}

/* --------------------- Accessibility: focus visibility --------------------- */
.filter-search-field:focus-within{
  border-color:#4fe3c1;
  box-shadow:0 0 0 2px #4fe3c1, 0 0 0 4px #0e1016;
}

.chat-bubble-row:hover .chat-react-toggle,
.chat-bubble-row:focus-within .chat-react-toggle,
.chat-react-toggle:focus-visible{
  opacity:1;
}

.zoomable-img[role="button"]:focus-visible,
.zoomable-image-button:focus-visible,
.background-motion-toggle:focus-visible{
  outline:2px solid #4fe3c1;
  outline-offset:3px;
}

/* --------------------- Accessibility: contrast --------------------- */
/* Teal #4FE3C1 + #08110F = 11.93:1. */
.btn-primary:hover,
.btn-primary:focus-visible,
.btn-add:hover,
.btn-add:focus-visible,
.btn-secondary:hover,
.btn-secondary:focus-visible,
.btn-cart:hover,
.btn-cart:focus-visible,
.btn-ghost:hover,
.btn-ghost:focus-visible,
.admin-btn-edit:hover,
.admin-btn-edit:focus-visible,
.admin-status-btn:hover,
.admin-status-btn:focus-visible,
.password-toggle-btn:hover,
.password-toggle-btn:focus-visible,
.promo-apply-btn:hover,
.promo-apply-btn:focus-visible{
  color:var(--phase2-dark-on-accent);
}

/* Coral #FF8A5B + #08110F = 8.24:1. */
.global-error-banner,
.global-error-banner button,
.flash-sale-badge,
.admin-chat-thread-badge,
.btn-cancel-order:hover,
.btn-cancel-order:focus-visible,
.admin-btn-danger:hover,
.admin-btn-danger:focus-visible{
  color:var(--phase2-dark-on-accent);
}

/* Meaningful form/control boundaries: >=3:1 against #171A23/#1D212C. */
.field input,
.field select,
.field textarea,
.promo-row input,
.chat-input-row input,
.filter-search-field,
.filter-bar select,
.header-filters select,
.qty-input,
.size-builder-price,
.size-builder-stock,
.bundle-builder-row select,
.bundle-builder-row input,
.chat-new-row input,
.payment-option,
.chat-conversation,
.admin-chat-conversation,
.admin-chat-thread-list{
  border-color:var(--phase2-control-border);
}

/* --------------------- Accessibility: modal system --------------------- */
body.modal-open{
  overflow:hidden !important;
  overscroll-behavior:none;
}

.modal-panel[role="dialog"]:focus,
.image-lightbox-content[role="dialog"]:focus{
  outline:none;
}

.sr-only{
  position:absolute !important;
  width:1px !important;
  height:1px !important;
  padding:0 !important;
  margin:-1px !important;
  overflow:hidden !important;
  clip:rect(0,0,0,0) !important;
  clip-path:inset(50%) !important;
  white-space:nowrap !important;
  border:0 !important;
}

/* Visible, compact WCAG 2.2.2 pause mechanism for the decorative background. */
.background-motion-toggle{
  position:fixed;
  left:12px;
  bottom:12px;
  z-index:90;
  border:1px solid var(--phase2-control-border);
  border-radius:999px;
  background:rgba(14,16,22,0.94);
  color:#d6dae4;
  padding:8px 12px;
  font:600 0.72rem/1.2 var(--font-body, sans-serif);
  letter-spacing:0.01em;
  box-shadow:0 4px 14px rgba(0,0,0,0.24);
}

.background-motion-toggle:hover{
  border-color:#4fe3c1;
  color:#ffffff;
}

/* --------------------- Tablet bridge: 721px–1024px --------------------- */
@media (min-width:721px) and (max-width:1024px){
  .shop-header{
    padding:16px 24px;
    align-items:flex-start;
  }

  .header-filters{
    order:3;
    flex:1 1 100%;
    min-width:0;
  }

  .header-filters .filter-search-field{
    min-width:180px;
  }

  .admin-tabs{
    padding:0 24px;
  }

  .admin-panel{
    padding:28px 24px 64px;
  }

  .modal-panel-wide{
    max-width:min(720px, calc(100vw - 48px));
  }
}

/* Mobile devices get opaque repeated surfaces and no sticky-header blur. */
@media (max-width:720px){
  .shop-header{
    background:rgba(14,16,22,0.97);
    backdrop-filter:none;
    -webkit-backdrop-filter:none;
  }

  .login-card,
  .modal-panel{
    background:rgba(23,26,35,0.97);
    backdrop-filter:none;
    -webkit-backdrop-filter:none;
  }

  .background-motion-toggle{
    left:8px;
    bottom:8px;
    padding:7px 10px;
    font-size:0.68rem;
  }
}

/* Stop all decorative transitions/animations when reduced motion is requested. */
@media (prefers-reduced-motion:reduce){
  .skeleton{
    animation:none !important;
    background:var(--charcoal-800, #1d212c) !important;
  }

  .background-motion-toggle{
    display:none;
  }
}
