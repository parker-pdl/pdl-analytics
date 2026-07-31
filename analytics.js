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
 *
 * Everything gathered below comes from standard, no-permission-prompt
 * browser APIs — nothing here triggers a native permission dialog (no
 * camera/mic/precise-geolocation access) and no raw IP address is ever
 * read or stored client-side. See README.md "What this collects" for the
 * full field-by-field breakdown.
 * -----------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var VID_KEY = 'pdl_vid';
  var cfg = null;
  var pageEnterTs = Date.now();
  var maxScrollPct = 0;

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

  // ---- best-effort feature detectors — every one of these is wrapped so a
  // browser that lacks the API just yields null/empty instead of throwing.

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function getWebGLInfo() {
    return safe(function () {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return { vendor: '', renderer: '' };
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (!dbg) return { vendor: '', renderer: '' };
      return {
        vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '',
        renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''
      };
    }, { vendor: '', renderer: '' });
  }

  // Lightweight canvas fingerprint — a hash of a rendered test string.
  // Used only as a coarse "is this the same browser+GPU combo" signal
  // alongside the visitor_id, never as a substitute for it.
  function getCanvasFingerprint() {
    return safe(function () {
      var canvas = document.createElement('canvas');
      canvas.width = 220; canvas.height = 30;
      var ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 220, 30);
      ctx.fillStyle = '#069';
      ctx.fillText('pdl-fingerprint-check', 2, 2);
      var data = canvas.toDataURL();
      var hash = 0;
      for (var i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
      }
      return String(hash);
    }, '');
  }

  function detectAdblock(cb) {
    // Heuristic only: create a bait element named/classed like an ad, see
    // if a blocker hides it. Best-effort, non-blocking, times out fast.
    safe(function () {
      var bait = document.createElement('div');
      bait.className = 'adsbox ad-banner ad-placement';
      bait.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;';
      document.body.appendChild(bait);
      setTimeout(function () {
        var blocked = bait.offsetParent === null || bait.clientHeight === 0;
        try { document.body.removeChild(bait); } catch (e) {}
        cb(blocked);
      }, 100);
    });
  }

  function collectClientInfo() {
    var nav = navigator || {};
    var scr = global.screen || {};
    var conn = nav.connection || nav.mozConnection || nav.webkitConnection || null;
    var webgl = getWebGLInfo();
    var prefersDark = safe(function () { return global.matchMedia('(prefers-color-scheme: dark)').matches; }, null);
    var prefersReducedMotion = safe(function () { return global.matchMedia('(prefers-reduced-motion: reduce)').matches; }, null);
    var standalone = safe(function () { return global.matchMedia('(display-mode: standalone)').matches || nav.standalone === true; }, false);

    return {
      // display
      screen_w: scr.width || 0,
      screen_h: scr.height || 0,
      avail_w: scr.availWidth || 0,
      avail_h: scr.availHeight || 0,
      color_depth: scr.colorDepth || 0,
      pixel_ratio: global.devicePixelRatio || 1,
      viewport_w: global.innerWidth || 0,
      viewport_h: global.innerHeight || 0,
      orientation: safe(function () { return (scr.orientation && scr.orientation.type) || ''; }, ''),
      prefers_dark: prefersDark,
      prefers_reduced_motion: prefersReducedMotion,
      standalone_pwa: standalone,

      // locale / time
      language: nav.language || '',
      languages: (nav.languages && nav.languages.join(',')) || '',
      timezone: Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
      tz_offset_min: new Date().getTimezoneOffset(),

      // hardware / platform
      platform: nav.platform || '',
      vendor: nav.vendor || '',
      cpu_cores: nav.hardwareConcurrency || 0,
      device_memory_gb: nav.deviceMemory || 0,
      max_touch_points: nav.maxTouchPoints || 0,
      touch_capable: !!(('ontouchstart' in global) || (nav.maxTouchPoints > 0)),

      // network (Chrome/Edge/Android only — null elsewhere)
      conn_type: conn ? (conn.effectiveType || '') : '',
      conn_downlink_mbps: conn ? (conn.downlink || 0) : 0,
      conn_rtt_ms: conn ? (conn.rtt || 0) : 0,
      conn_save_data: conn ? !!conn.saveData : false,

      // gpu (from WebGL, not a permission-gated API)
      gpu_vendor: webgl.vendor,
      gpu_renderer: webgl.renderer,

      // misc environment flags
      cookies_enabled: !!nav.cookieEnabled,
      do_not_track: nav.doNotTrack === '1' || global.doNotTrack === '1' || nav.msDoNotTrack === '1',
      storage_supported: safe(function () { global.localStorage.setItem('__pdl_t', '1'); global.localStorage.removeItem('__pdl_t'); return true; }, false),
      canvas_fp: getCanvasFingerprint(),

      // page context
      page_title: document.title || '',
      utm_source: safe(function () { return new URL(global.location.href).searchParams.get('utm_source') || ''; }, '')
    };
  }

  function send(event) {
    if (!cfg) return;

    var client = collectClientInfo();

    var payload = Object.assign({
      event_type: event.type,
      site: cfg.site,
      page_url: global.location.href,
      referrer: document.referrer || '',
      link_url: event.linkUrl || '',
      link_text: event.linkText || '',
      visitor_id: visitorId(),
      time_on_page_sec: event.type === 'pageview' ? 0 : Math.round((Date.now() - pageEnterTs) / 1000),
      max_scroll_pct: maxScrollPct,
      adblock_detected: event.adblock === true,
      ts: new Date().toISOString()
    }, client);

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

  function trackScrollDepth() {
    safe(function () {
      global.addEventListener('scroll', function () {
        var doc = document.documentElement;
        var scrollable = (doc.scrollHeight - doc.clientHeight) || 1;
        var pct = Math.min(100, Math.round((global.scrollY / scrollable) * 100));
        if (pct > maxScrollPct) maxScrollPct = pct;
      }, { passive: true });
    });
  }

  function trackEngagementOnExit() {
    safe(function () {
      global.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') send({ type: 'engagement' });
      });
    });
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
      trackScrollDepth();
      trackEngagementOnExit();
      detectAdblock(function (blocked) {
        send({ type: 'pageview', adblock: blocked });
      });
      trackClicks();
    },

    /** Fire a custom named event, e.g. PDLAnalytics.track('signup_clicked'). */
    track: function (name) {
      send({ type: name });
    },

    /** Returns everything this script can detect about the current browser,
     * without sending it anywhere — used by the "what we can see" demo page. */
    inspect: function () {
      return collectClientInfo();
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
