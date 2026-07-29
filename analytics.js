/*!
 * PDL Analytics — client tracking script (scaffold)
 * -----------------------------------------------------------------------
 * Self-hosted, transparent visitor analytics. See README.md in this repo
 * for exactly what is and isn't collected.
 *
 * Usage (manual):
 *   <script src="./analytics.js"></script>
 *   <script>
 *     PDLAnalytics.init({ endpoint: 'https://your-worker-url', site: 'parkerdata.link' });
 *   </script>
 *
 * Usage (data attributes, once this script is hosted on the Worker itself):
 *   <script src="https://your-worker-url/analytics.js" data-site="parkerdata.link"></script>
 *
 * No cookies are used. A random anonymous id is stored in localStorage so
 * repeat visits from the same browser can be grouped together; it carries
 * no personal information and resets if the visitor clears site data.
 * -----------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var VID_KEY = 'pdl_vid';
  var cfg = null;

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    // Fallback for older browsers: RFC4122-ish v4 using Math.random.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function visitorId() {
    try {
      var existing = global.localStorage.getItem(VID_KEY);
      if (existing) return existing;
      var id = uuid();
      global.localStorage.setItem(VID_KEY, id);
      return id;
    } catch (e) {
      // localStorage unavailable (private browsing, etc.) — fall back to a
      // per-pageload id rather than failing.
      return uuid();
    }
  }

  function send(event) {
    if (!cfg) return;

    var payload = {
      event_type: event.type,
      site: cfg.site,
      page_url: global.location.href,
      referrer: document.referrer || '',
      link_url: event.linkUrl || '',
      link_text: event.linkText || '',
      visitor_id: visitorId(),
      timezone: Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
      language: navigator.language || '',
      screen_w: global.screen ? global.screen.width : 0,
      screen_h: global.screen ? global.screen.height : 0,
      ts: new Date().toISOString()
    };

    var url = cfg.endpoint.replace(/\/$/, '') + '/collect';
    var body = JSON.stringify(payload);

    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        var ok = navigator.sendBeacon(url, blob);
        if (ok) return;
      }
    } catch (e) {
      /* fall through to fetch */
    }

    // Fallback for browsers without sendBeacon, or if it failed to queue.
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) {
      /* give up silently — analytics must never break the host page */
    }
  }

  function trackClicks() {
    document.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el.tagName !== 'A') el = el.parentElement;
      if (!el || !el.href) return;
      send({
        type: 'click',
        linkUrl: el.href,
        linkText: (el.textContent || '').trim().slice(0, 200)
      });
    }, true);
  }

  global.PDLAnalytics = {
    /**
     * @param {Object} opts
     * @param {string} opts.endpoint - Base URL of the deployed Worker, e.g. "https://analytics.example.workers.dev"
     * @param {string} opts.site - A short identifier for this site, e.g. "parkerdata.link"
     */
    init: function (opts) {
      if (!opts || !opts.endpoint || !opts.site) {
        console.warn('[PDLAnalytics] init() requires { endpoint, site }');
        return;
      }
      cfg = opts;
      send({ type: 'pageview' });
      trackClicks();
    },

    /** Fire a custom named event, e.g. PDLAnalytics.track('signup_clicked'). */
    track: function (name) {
      send({ type: name });
    }
  };

  // Auto-init if loaded via <script data-site="..." data-endpoint="...">.
  var thisScript = document.currentScript;
  if (thisScript && thisScript.getAttribute('data-site')) {
    global.PDLAnalytics.init({
      endpoint: thisScript.getAttribute('data-endpoint') || (thisScript.src || '').replace(/\/analytics\.js.*$/, ''),
      site: thisScript.getAttribute('data-site')
    });
  }
})(window);
