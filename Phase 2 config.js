/* =====================================================================
   DAGOLDOL — PHASE 3 SEO / UX / INFORMATION ARCHITECTURE OVERRIDES
   ---------------------------------------------------------------------
   Additive styles only. This file is loaded after phase2-fixes.css.
   ===================================================================== */

/* Public homepage now has the principal document heading. */
.hero .hero-title{
  font-family:var(--font-display);
  font-weight:600;
  font-size:clamp(2rem, 4.5vw, 3.2rem);
  line-height:1.12;
  margin:10px 0 16px;
  color:var(--cream);
  letter-spacing:-0.01em;
}

/* Crawlable product-detail links without taking away quick-add controls. */
.product-detail-link{
  color:inherit;
  text-decoration:none;
  text-decoration-thickness:1px;
  text-underline-offset:3px;
}

.product-detail-link:hover,
.product-detail-link:focus-visible{
  color:var(--brass-bright);
  text-decoration:underline;
}

/* Public information architecture lives in the footer, not the account menu. */
.shop-footer{
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:16px;
}

.shop-footer-nav{
  display:flex;
  flex-wrap:wrap;
  justify-content:center;
  gap:8px 18px;
  max-width:900px;
}

.shop-footer-nav a{
  color:var(--cream-dim);
  text-decoration:underline;
  text-decoration-color:transparent;
  text-underline-offset:3px;
}

.shop-footer-nav a:hover,
.shop-footer-nav a:focus-visible{
  color:var(--brass-bright);
  text-decoration-color:currentColor;
}

/* --------------------- Routed transactional workspaces --------------------- */
.route-screen{
  min-height:100vh;
  background:
    radial-gradient(circle at 12% 10%, rgba(255,138,91,0.05), transparent 34%),
    radial-gradient(circle at 88% 8%, rgba(79,227,193,0.06), transparent 32%);
}

.route-screen-header{
  position:sticky;
  top:0;
  z-index:45;
  min-height:72px;
  padding:14px clamp(16px, 5vw, 64px);
  display:grid;
  grid-template-columns:minmax(130px, 1fr) auto minmax(130px, 1fr);
  align-items:center;
  gap:16px;
  background:rgba(14,16,22,0.97);
  border-bottom:1px solid var(--line);
}

.route-screen-header .brand-mark{
  justify-self:center;
}

.route-back-btn{
  justify-self:start;
  min-height:44px;
  border:1px solid var(--phase2-control-border, #626b80);
  border-radius:8px;
  padding:8px 14px;
  background:rgba(29,33,44,0.92);
  color:var(--cream);
  font:600 0.82rem/1.2 var(--font-body);
}

.route-back-btn:hover,
.route-back-btn:focus-visible{
  border-color:var(--brass);
  color:var(--brass-bright);
}

.route-screen-kicker{
  justify-self:end;
  color:var(--cream-dim);
  font-size:0.76rem;
  letter-spacing:0.08em;
  text-transform:uppercase;
}

.route-screen-main{
  width:100%;
  max-width:1120px;
  margin:0 auto;
  padding:42px clamp(16px, 5vw, 64px) 72px;
}

.route-panel{
  width:min(100%, 760px);
  margin:0 auto;
  padding:32px;
  border:1px solid var(--line);
  border-radius:18px;
  background:rgba(23,26,35,0.96);
  box-shadow:0 18px 44px rgba(0,0,0,0.28);
}

.route-panel-wide{
  width:min(100%, 940px);
}

.route-screen-title{
  margin:6px 0 22px;
  font-family:var(--font-display);
  font-size:clamp(1.55rem, 3vw, 2.1rem);
  line-height:1.2;
  color:var(--cream);
}

.checkout-route-panel .modal-items-list{
  max-height:none;
  margin-bottom:22px;
}

.checkout-route-panel .payment-section{
  background:rgba(29,33,44,0.92);
}

#orders-screen .orders-list{
  margin-top:18px;
}

#orders-screen .load-more-row{
  margin:24px 0 0;
}

/* --------------------- Tablet header information hierarchy --------------------- */
@media (min-width:721px) and (max-width:1024px){
  #shop-screen .shop-header{
    display:grid;
    grid-template-columns:auto minmax(0, 1fr) auto auto;
    align-items:center;
    gap:12px;
    padding:14px 24px 16px;
  }

  #shop-screen .brand-mark{
    grid-column:1;
    grid-row:1;
  }

  #shop-screen .header-actions{
    display:contents;
  }

  #shop-screen #cart-btn{
    grid-column:3;
    grid-row:1;
    min-height:44px;
  }

  #shop-screen .account-menu-wrap{
    grid-column:4;
    grid-row:1;
  }

  #shop-screen #account-menu-toggle{
    min-height:44px;
  }

  #shop-screen .header-filters{
    grid-column:1 / -1;
    grid-row:2;
    width:100%;
    min-width:0;
    margin-top:2px;
    display:grid;
    grid-template-columns:repeat(4, minmax(0, 1fr));
    gap:8px;
  }

  #shop-screen .header-filters .filter-search-field{
    grid-column:1 / -1;
    width:100%;
    min-width:0;
    min-height:44px;
  }

  #shop-screen .header-filters select,
  #shop-screen .header-filters #catalogue-filter-clear{
    min-width:0;
    min-height:44px;
  }

  #shop-screen .header-filters #catalogue-filter-clear{
    display:inline-flex;
    align-items:center;
    justify-content:center;
    padding:8px 12px;
    border:1px solid var(--phase2-control-border, #626b80);
    border-radius:8px;
    text-decoration:none;
    background:rgba(29,33,44,0.90);
  }
}

@media (max-width:720px){
  .route-screen-header{
    grid-template-columns:1fr auto;
    padding:10px 14px;
  }

  .route-screen-header .brand-mark{
    justify-self:end;
  }

  .route-screen-kicker{
    display:none;
  }

  .route-screen-main{
    padding:24px 0 0;
  }

  .route-panel,
  .route-panel-wide{
    width:100%;
    border-left:0;
    border-right:0;
    border-bottom:0;
    border-radius:18px 18px 0 0;
    padding:24px 16px 40px;
    min-height:calc(100vh - 96px);
  }

  .shop-footer-nav{
    gap:10px 16px;
    padding:0 8px;
  }
}

@media (max-width:480px){
  .route-back-btn{
    padding:8px 10px;
    font-size:0.76rem;
  }

  .route-screen-header .brand-mark{
    font-size:1rem;
  }
}

/* =====================================================================
   DAGOLDOL — MOBILE FIT ONLY
   ---------------------------------------------------------------------
   Additive phone-only containment. Desktop/tablet layout, catalogue card
   design, images, buttons, routed workflows and application DOM remain the
   original Phase 3 implementation from Pasted text(1).txt.
   ===================================================================== */

.liquid-chrome-bg.liquid-chrome-static{
  background:
    radial-gradient(circle at 14% 12%, rgba(255,138,91,0.08), transparent 36%),
    radial-gradient(circle at 86% 10%, rgba(79,227,193,0.10), transparent 34%),
    #0e1016;
}

.liquid-chrome-bg.liquid-chrome-static canvas{
  display:none !important;
}

@media (max-width:720px){
  html,
  body{
    width:100%;
    max-width:100%;
    overflow-x:hidden;
    -webkit-text-size-adjust:100%;
    text-size-adjust:100%;
  }

  #login-screen,
  #shop-screen,
  #admin-screen,
  .route-screen,
  .shop-header,
  .header-actions,
  .header-filters,
  .hero,
  .catalogue,
  .reco-section,
  .bundles-section,
  .product-card,
  .bundle-card,
  .admin-panel,
  .route-screen-main,
  .route-panel,
  .route-panel-wide,
  .modal-panel,
  .modal-panel-wide,
  .chat-layout,
  .chat-thread-list,
  .chat-conversation{
    min-width:0;
    max-width:100%;
  }

  #shop-screen .header-actions,
  #shop-screen .header-filters{
    width:100%;
    min-width:0;
  }

  #shop-screen .header-filters .filter-search-field,
  #shop-screen .header-filters .filter-search-field input,
  #shop-screen .header-filters select{
    min-width:0;
    max-width:100%;
  }

  .product-card img,
  .product-card svg,
  .size-modal-photo img,
  .size-modal-photo svg,
  .payment-proof-thumb img,
  .admin-payment-proof-thumb img{
    max-width:100%;
  }

  .field-row,
  .product-actions,
  .promo-row,
  .chat-input-row,
  .chat-new-row,
  .cart-line,
  .cost-row{
    min-width:0;
    max-width:100%;
  }

  .promo-row input,
  .chat-input-row input,
  .chat-new-row input,
  .field input,
  .field select,
  .field textarea{
    min-width:0;
    max-width:100%;
  }
}

/* The original CSS stacks the filters below 420px. This closes only the
   intermediate 421–720px gap that could squeeze all filter controls into a
   single row. */
@media (min-width:421px) and (max-width:720px){
  #shop-screen .header-filters{
    display:flex;
    flex-wrap:wrap;
    align-items:stretch;
    gap:8px;
  }

  #shop-screen .header-filters .filter-search-field{
    flex:1 1 100%;
    width:100%;
  }

  #shop-screen .header-filters select{
    flex:1 1 calc(50% - 4px);
    width:calc(50% - 4px);
  }

  #shop-screen .header-filters #catalogue-filter-clear{
    flex:1 1 100%;
    min-height:44px;
    display:inline-flex;
    align-items:center;
    justify-content:center;
    border:1px solid var(--phase2-control-border, #626b80);
    border-radius:8px;
    background:rgba(29,33,44,0.90);
    text-decoration:none;
  }
}

@supports (height:100dvh){
  @media (max-width:720px){
    .route-screen{
      min-height:100dvh;
    }

    .route-panel,
    .route-panel-wide{
      min-height:calc(100dvh - 96px);
    }

    .modal-panel,
    .modal-panel-wide{
      max-height:92dvh;
    }
  }
}
