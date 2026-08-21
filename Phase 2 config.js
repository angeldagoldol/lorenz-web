/**
 * DAGOLDOL CONFIGURATION BOOTSTRAP
 * Phase 2 Performance + Accessibility Integration
 *
 * IMPORTANT:
 * - Supabase variables remain owned by script.js
 * - This file only loads Phase 2 enhancements
 */

window.DAGOLDOL_CONFIG = Object.freeze({
    PHASE2_ENABLED: true,
    VERSION: "2.0.0"
});


(function initializePhase2(){

    if (!window.DAGOLDOL_CONFIG.PHASE2_ENABLED) {
        return;
    }


    function loadCSS(href){

        if (document.querySelector(`link[href="${href}"]`)) {
            return;
        }

        const link = document.createElement("link");

        link.rel = "stylesheet";
        link.href = href;

        document.head.appendChild(link);
    }



    function loadModule(src){

        if (document.querySelector(`script[src="${src}"]`)) {
            return;
        }

        const script = document.createElement("script");

        script.type = "module";
        script.src = src;

        document.head.appendChild(script);
    }



    loadCSS("./phase2-fixes.css");

    loadModule("./phase2-accessibility.js");


})();