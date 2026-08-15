/**
 * DAGOLDOL CONFIGURATION
 * Phase 3 production bootstrap.
 *
 * Supabase's anon key is intentionally browser-visible. Security must be
 * enforced with Supabase RLS / Storage policies, never by hiding this key.
 */

window.SUPABASE_URL =
  "https://rvrjkfbenramappteuae.supabase.co";

window.SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2cmprZmJlbnJhbWFwcHRldWFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MzQ3MjcsImV4cCI6MjEwMTAxMDcyN30.mLK_9vEMZ6BHsAYwRGohdirpIKKo9JGji7qJORkhmbs";

window.DAGOLDOL_CONFIG = Object.freeze({
  PHASE2_ENABLED: true,
  PHASE3_ENABLED: true,
  VERSION: "3.0.0",
  SITE_URL: "https://lorenz-web-six.vercel.app"
});

(function initializeEnhancements(){
  function loadCSS(href){
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  function loadModule(src){
    if (document.querySelector(`script[src="${src}"]`)) return;
    const script = document.createElement("script");
    script.type = "module";
    script.src = src;
    document.head.appendChild(script);
  }

  if (window.DAGOLDOL_CONFIG.PHASE2_ENABLED) {
    loadCSS("./phase2-fixes.css");
    loadModule("./phase2-accessibility.js");
  }

  if (window.DAGOLDOL_CONFIG.PHASE3_ENABLED) {
    loadCSS("./phase3-fixes.css");
  }
})();
