/* Theme + material boot (ADR-0043; reduce-transparency fallback per T4/M8).
   Loaded as a classic script in <head> — the CSP has no 'unsafe-inline', so
   this cannot live inline in index.html. Stamps a RESOLVED
   data-theme="light"|"dark" on <html> before first paint; the CSS
   (packages/glass) keys its single dark block on that attribute. While the
   stored preference is "system" (key absent), OS flips re-stamp live; the
   in-app theme chip (lib/theme.ts) writes the same key and re-stamps on
   cycle. Also stamps data-reduce-transparency (the opaque-material fallback):
   set when the stored override "maxprice-reduce-transparency" is "1" OR the
   OS asks via prefers-reduced-transparency — live on Chromium/WebView2;
   WebKit never matches the query, so on macOS the desktop Settings switch
   (lib/transparency.ts) is the only driver. Kept byte-identical with
   apps/hub-desktop/public/theme-boot.js. */
(function () {
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  function stamp() {
    var pref = null;
    try {
      pref = localStorage.getItem("maxprice-theme");
    } catch {
      /* storage denied — fall through to the system preference */
    }
    var resolved = pref === "light" || pref === "dark" ? pref : mq.matches ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
  }
  stamp();
  mq.addEventListener("change", stamp);

  var rtMq = window.matchMedia("(prefers-reduced-transparency: reduce)");
  function stampTransparency() {
    var override = null;
    try {
      override = localStorage.getItem("maxprice-reduce-transparency");
    } catch {
      /* storage denied — fall through to the OS signal */
    }
    if (override === "1" || rtMq.matches) {
      document.documentElement.setAttribute("data-reduce-transparency", "");
    } else {
      document.documentElement.removeAttribute("data-reduce-transparency");
    }
  }
  stampTransparency();
  rtMq.addEventListener("change", stampTransparency);
})();
