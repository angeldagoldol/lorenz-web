(function(root){
  "use strict";

  const NETWORK_ERROR_PATTERN = /(failed to fetch|fetch failed|load failed|networkerror|network request failed|network connection was lost|internet connection appears to be offline)/i;

  function isNetworkAuthError(error){
    if (!error) return false;
    const name = String(error.name || "");
    const message = String(error.message || error || "");
    const status = Number(error.status || 0);

    if (name === "AuthRetryableFetchError") return true;
    if (status === 0 && NETWORK_ERROR_PATTERN.test(message)) return true;
    if (name === "TypeError" && NETWORK_ERROR_PATTERN.test(message)) return true;
    return NETWORK_ERROR_PATTERN.test(message);
  }

  function describeAuthError(error, mode){
    const kind = mode === "signup" ? "signup" : "login";
    const code = String(error && error.code || "");
    const status = Number(error && error.status || 0);

    if (isNetworkAuthError(error)) {
      return "The account service could not be reached from this device. Dagoldol will retry through its secure site connection; please try again in a moment.";
    }

    if (code === "invalid_credentials") {
      return "Incorrect email or password. Try again.";
    }

    if (code === "email_not_confirmed") {
      return "Confirm your email address first, then try logging in again.";
    }

    if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || status === 429) {
      return "Too many account attempts were made. Wait a moment, then try again.";
    }

    if (kind === "signup") {
      if (code === "user_already_exists") return "An account already exists for that email. Log in instead or reset the password.";
      return "Could not create the account right now. Please try again.";
    }

    return "Could not sign in right now. Please try again.";
  }

  function requestUrlString(input){
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return String(input || "");
  }

  function createResilientSupabaseFetch({
    nativeFetch,
    supabaseOrigin,
    proxyPrefix = "/api/supabase",
    onFallback = null
  } = {}){
    if (typeof nativeFetch !== "function") {
      throw new TypeError("nativeFetch must be a function");
    }

    const normalizedOrigin = String(supabaseOrigin || "").replace(/\/$/, "");
    const normalizedProxyPrefix = String(proxyPrefix || "/api/supabase").replace(/\/$/, "");

    return async function resilientSupabaseFetch(input, init){
      const originalUrl = requestUrlString(input);

      try {
        return await nativeFetch(input, init);
      } catch (error) {
        if (!isNetworkAuthError(error)) throw error;

        let parsed;
        try {
          parsed = new URL(originalUrl);
        } catch (_) {
          throw error;
        }

        if (!normalizedOrigin || parsed.origin !== normalizedOrigin) {
          throw error;
        }

        const proxyUrl = `${normalizedProxyPrefix}${parsed.pathname}${parsed.search}`;

        if (typeof onFallback === "function") {
          try {
            onFallback({ originalUrl, proxyUrl, error });
          } catch (_) {
            // Diagnostics must never break the request path.
          }
        }

        return nativeFetch(proxyUrl, init);
      }
    };
  }

  root.DAGOLDOL_AUTH_RESILIENCE = Object.freeze({
    createResilientSupabaseFetch,
    describeAuthError,
    isNetworkAuthError
  });
})(typeof window !== "undefined" ? window : globalThis);
