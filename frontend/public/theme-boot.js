/*
 * Luma theme boot. Runs before the app loads (a plain blocking script in <head>), so a
 * student who picked Dark or Automatic never sees a flash of the light page.
 *
 * It only reads this device's saved copy (localStorage "luma.theme:<account id>") for the
 * account this tab uses, and only while that account is signed in. The log in, sign up and
 * other account pages stay light. The home page "/" is painted too: a signed-in student is
 * sent on to the dashboard from there, and a signed-out visitor has no signed-in account, so
 * the landing page stays light (src/App.tsx also clears the theme once it knows nobody is
 * signed in). Any problem means: do nothing.
 *
 * The same rules live in src/ui/theme.ts; src/ui/theme.test.ts runs one case table on both,
 * and checks the storage key names against src/accounts.ts.
 */
(function () {
  var AUTH_KEY = "luma.auth";
  var TAB_ACCOUNT_KEY = "luma.tabAccount";
  var THEME_CACHE_PREFIX = "luma.theme:";
  var AUTO_LIGHT_START = 7;
  var AUTO_DARK_START = 19;
  var BAR_COLORS = { light: "#fbf6ec", dark: "#15140f" };
  var PUBLIC_PATH = /^\/(login|signup|verify-email|account-deleted|forgot-password|reset-password)\/?$/;
  var HEX_COLOR = /^#[0-9a-f]{6}$/i;

  try {
    if (PUBLIC_PATH.test(location.pathname)) return;

    var book = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    if (!book || typeof book !== "object" || !book.accounts || typeof book.accounts !== "object") return;

    var id = null;
    try {
      id = sessionStorage.getItem(TAB_ACCOUNT_KEY);
    } catch (error) {
      id = null;
    }
    if (!id) id = typeof book.lastActiveId === "string" ? book.lastActiveId : null;
    if (!id) return;
    var account = book.accounts[id];
    if (!account || account.status !== "signed_in") return;

    var cache = JSON.parse(localStorage.getItem(THEME_CACHE_PREFIX + id) || "null");
    if (!cache || typeof cache !== "object") return;
    var mode = cache.mode;
    if (mode !== "light" && mode !== "dark" && mode !== "auto") return;

    var theme = mode;
    if (mode === "auto") {
      var hour = new Date().getHours();
      theme = hour >= AUTO_LIGHT_START && hour < AUTO_DARK_START ? "light" : "dark";
    }

    var root = document.documentElement;
    root.setAttribute("data-theme", theme);
    if (typeof cache.accent === "string" && HEX_COLOR.test(cache.accent)) {
      root.style.setProperty("--accent", cache.accent);
    }
    if (typeof cache.onAccent === "string" && HEX_COLOR.test(cache.onAccent)) {
      root.style.setProperty("--on-accent", cache.onAccent);
    }
    var bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.setAttribute("content", BAR_COLORS[theme]);
  } catch (error) {
    // Storage blocked or broken data: the app sorts the theme out once it loads.
  }
})();
