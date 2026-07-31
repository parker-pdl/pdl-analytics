/*!
 * PDL Analytics — Cloudflare Worker backend (scaffold)
 * -----------------------------------------------------------------------
 * Three routes:
 *   POST /collect        - receives events from analytics.js, writes to D1
 *   GET  /api/summary    - returns aggregated stats for the dashboard
 *   GET  /api/whoami     - returns everything detected about the CALLER's
 *                          own request, for the transparent "what we can
 *                          see about you" demo page. No storage, no auth
 *                          needed — it only ever echoes data back to the
 *                          person who sent the request.
 *
 * NOT DEPLOYED. See README.md "Before this goes live" — in particular,
 * /api/summary has no authentication yet and must not be deployed as-is.
 * -----------------------------------------------------------------------
 */

// Full source of analytics.js, served verbatim at GET /analytics.js so a
// site only needs to reference this Worker's URL — no separate file host.
// Keep this in sync with analytics.js in the repo.
var ANALYTICS_JS_SOURCE = String.raw`/*!
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
`;

function corsHeaders(origin, env) {
  var allowed = (env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var allowOrigin = allowed.indexOf(origin) !== -1 ? origin : (allowed[0] || 'null');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

// Hand-rolled User-Agent parser — covers os/browser/device plus best-effort
// version numbers and rendering engine. Not exhaustive (no UA-CH parsing
// yet), but good enough for coarse analytics buckets without a dependency.
function parseUA(ua) {
  ua = ua || '';

  var os = 'Unknown', osVersion = '';
  if (/Windows NT ([\d.]+)/i.test(ua)) { os = 'Windows'; osVersion = RegExp.$1; }
  else if (/iPhone OS ([\d_]+)/i.test(ua)) { os = 'iOS'; osVersion = RegExp.$1.replace(/_/g, '.'); }
  else if (/CPU OS ([\d_]+)/i.test(ua)) { os = 'iOS'; osVersion = RegExp.$1.replace(/_/g, '.'); }
  else if (/Mac OS X ([\d_]+)/i.test(ua)) { os = 'macOS'; osVersion = RegExp.$1.replace(/_/g, '.'); }
  else if (/Android ([\d.]+)/i.test(ua)) { os = 'Android'; osVersion = RegExp.$1; }
  else if (/Linux/i.test(ua)) { os = 'Linux'; }

  var browser = 'Unknown', browserVersion = '';
  if (/Edg\/([\d.]+)/i.test(ua)) { browser = 'Edge'; browserVersion = RegExp.$1; }
  else if (/OPR\/([\d.]+)/i.test(ua)) { browser = 'Opera'; browserVersion = RegExp.$1; }
  else if (/CriOS\/([\d.]+)/i.test(ua)) { browser = 'Chrome (iOS)'; browserVersion = RegExp.$1; }
  else if (/Chrome\/([\d.]+)/i.test(ua)) { browser = 'Chrome'; browserVersion = RegExp.$1; }
  else if (/FxiOS\/([\d.]+)/i.test(ua)) { browser = 'Firefox (iOS)'; browserVersion = RegExp.$1; }
  else if (/Firefox\/([\d.]+)/i.test(ua)) { browser = 'Firefox'; browserVersion = RegExp.$1; }
  else if (/Version\/([\d.]+).*Safari/i.test(ua)) { browser = 'Safari'; browserVersion = RegExp.$1; }
  else if (/Safari\//i.test(ua)) { browser = 'Safari'; }

  var engine = 'Unknown';
  if (/Gecko\/\d/i.test(ua) || /Firefox\//i.test(ua)) engine = 'Gecko';
  else if (/AppleWebKit/i.test(ua) && !/Chrome|Chromium|Edg|OPR/i.test(ua)) engine = 'WebKit';
  else if (/AppleWebKit/i.test(ua)) engine = 'Blink';

  var deviceType = 'desktop';
  if (/iPad|Tablet(?!.*Mobile)/i.test(ua)) deviceType = 'tablet';
  else if (/Mobi|iPhone|Android/i.test(ua)) deviceType = 'mobile';

  var isBot = /bot|crawler|spider|crawling|slurp|facebookexternalhit/i.test(ua);

  return {
    os: os, osVersion: osVersion,
    browser: browser, browserVersion: browserVersion,
    engine: engine, deviceType: deviceType, isBot: isBot
  };
}

// Everything we can read off request.cf (Cloudflare's edge-derived request
// metadata) plus a couple of raw headers — INCLUDING the client's IP
// address (CF-Connecting-IP), per explicit product decision. IP address is
// personal data under GDPR/CCPA, so anywhere this is deployed needs the
// privacy notice called out in README.md "Before this goes live" — this is
// no longer optional once IP is being stored.
function collectEdgeInfo(request) {
  var cf = request.cf || {};
  return {
    ip: request.headers.get('CF-Connecting-IP') || null,
    ipCity: cf.city || null, // kept alongside ip for convenience in queries
    country: cf.country || null,
    region: cf.region || null,
    regionCode: cf.regionCode || null,
    city: cf.city || null,
    postalCode: cf.postalCode || null,
    continent: cf.continent || null,
    timezone: cf.timezone || null,
    latitude: cf.latitude || null,
    longitude: cf.longitude || null,
    metroCode: cf.metroCode || null,
    isEUCountry: cf.isEUCountry || null,
    asn: cf.asn || null,
    asOrganization: cf.asOrganization || null,
    colo: cf.colo || null,
    httpProtocol: cf.httpProtocol || null,
    tlsVersion: cf.tlsVersion || null,
    tlsCipher: cf.tlsCipher || null,
    clientTcpRtt: cf.clientTcpRtt || null,
    acceptLanguageHeader: request.headers.get('Accept-Language') || null
  };
}

async function handleCollect(request, env, ctx) {
  var origin = request.headers.get('Origin') || '';
  var headers = corsHeaders(origin, env);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: headers });
  }

  if (!body.site || !body.event_type || !body.visitor_id) {
    return new Response(JSON.stringify({ error: 'missing required fields' }), { status: 400, headers: headers });
  }

  var edge = collectEdgeInfo(request);
  var ua = parseUA(request.headers.get('User-Agent'));
  var s = function (v, n) { return v == null ? null : String(v).slice(0, n || 500); };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : null; };

  try {
    await env.DB.prepare(
      'INSERT INTO events (' +
      'event_type, site, page_url, referrer, link_url, link_text, visitor_id, ip_address, ' +
      'country, region, region_code, city, postal_code, continent, timezone, latitude, longitude, ' +
      'metro_code, is_eu_country, asn, isp, colo, http_protocol, tls_version, client_tcp_rtt, ' +
      'os, os_version, browser, browser_version, engine, device_type, is_bot, ' +
      'screen_w, screen_h, avail_w, avail_h, color_depth, pixel_ratio, viewport_w, viewport_h, orientation, ' +
      'prefers_dark, prefers_reduced_motion, standalone_pwa, ' +
      'language, languages, tz_offset_min, ' +
      'platform, vendor, cpu_cores, device_memory_gb, max_touch_points, touch_capable, ' +
      'conn_type, conn_downlink_mbps, conn_rtt_ms, conn_save_data, ' +
      'gpu_vendor, gpu_renderer, cookies_enabled, do_not_track, storage_supported, canvas_fp, ' +
      'adblock_detected, time_on_page_sec, max_scroll_pct, page_title, utm_source' +
      ') VALUES (' + new Array(68).fill('?').join(',') + ')'
    ).bind(
      s(body.event_type, 64), s(body.site, 200), s(body.page_url, 2000), s(body.referrer, 2000),
      s(body.link_url, 2000), s(body.link_text, 500), s(body.visitor_id, 64), edge.ip,
      edge.country, edge.region, edge.regionCode, edge.city, edge.postalCode, edge.continent,
      s(body.timezone, 64) || edge.timezone, edge.latitude, edge.longitude,
      edge.metroCode, edge.isEUCountry ? 1 : 0, edge.asn, edge.asOrganization, edge.colo,
      edge.httpProtocol, edge.tlsVersion, edge.clientTcpRtt,
      ua.os, ua.osVersion, ua.browser, ua.browserVersion, ua.engine, ua.deviceType, ua.isBot ? 1 : 0,
      num(body.screen_w), num(body.screen_h), num(body.avail_w), num(body.avail_h),
      num(body.color_depth), num(body.pixel_ratio), num(body.viewport_w), num(body.viewport_h), s(body.orientation, 32),
      body.prefers_dark === true ? 1 : (body.prefers_dark === false ? 0 : null),
      body.prefers_reduced_motion === true ? 1 : (body.prefers_reduced_motion === false ? 0 : null),
      body.standalone_pwa ? 1 : 0,
      s(body.language, 32), s(body.languages, 200), num(body.tz_offset_min),
      s(body.platform, 100), s(body.vendor, 100), num(body.cpu_cores), num(body.device_memory_gb),
      num(body.max_touch_points), body.touch_capable ? 1 : 0,
      s(body.conn_type, 32), num(body.conn_downlink_mbps), num(body.conn_rtt_ms), body.conn_save_data ? 1 : 0,
      s(body.gpu_vendor, 200), s(body.gpu_renderer, 200), body.cookies_enabled ? 1 : 0,
      body.do_not_track ? 1 : 0, body.storage_supported ? 1 : 0, s(body.canvas_fp, 64),
      body.adblock_detected ? 1 : 0, num(body.time_on_page_sec), num(body.max_scroll_pct),
      s(body.page_title, 300), s(body.utm_source, 200)
    ).run();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'db error', detail: String(e) }), { status: 500, headers: headers });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: headers });
}

// Transparent "what can this site see about me" endpoint — returns the
// SAME data a /collect call would derive server-side, but only ever back
// to the browser that asked, and never written to D1. This is what powers
// whoami.html.
async function handleWhoami(request, env, ctx) {
  var origin = request.headers.get('Origin') || '';
  var headers = Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin, env));
  var edge = collectEdgeInfo(request);
  var ua = parseUA(request.headers.get('User-Agent'));
  return new Response(JSON.stringify({
    server_detected: {
      ip_address: edge.ip,
      edge: edge,
      user_agent: ua,
      raw_user_agent: request.headers.get('User-Agent') || ''
    }
  }), { status: 200, headers: headers });
}

async function handleSummary(request, env, ctx) {
  var origin = request.headers.get('Origin') || '';
  var headers = corsHeaders(origin, env);

  // Auth: requires "Authorization: Bearer <ADMIN_TOKEN>" matching the
  // ADMIN_TOKEN secret set on the Worker. Without this, anyone who found
  // the URL could read all aggregated stats, including IPs in `recent`.
  var authHeader = request.headers.get('Authorization') || '';
  var providedToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || providedToken !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: headers });
  }

  var url = new URL(request.url);
  var site = url.searchParams.get('site');
  if (!site) {
    return new Response(JSON.stringify({ error: 'site query param required' }), { status: 400, headers: headers });
  }

  var days = Math.min(parseInt(url.searchParams.get('days') || '30', 10) || 30, 365);
  var since = "datetime('now', '-" + days + " days')";

  var [byCountry, byBrowser, byOs, byDevice, byGpu, topLinks, recent, totals] = await Promise.all([
    env.DB.prepare(
      'SELECT country, COUNT(*) as n FROM events WHERE site=? AND event_type=\'pageview\' AND created_at >= ' + since +
      ' GROUP BY country ORDER BY n DESC LIMIT 20'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT browser, browser_version, COUNT(*) as n FROM events WHERE site=? AND created_at >= ' + since +
      ' GROUP BY browser, browser_version ORDER BY n DESC LIMIT 10'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT os, os_version, COUNT(*) as n FROM events WHERE site=? AND created_at >= ' + since +
      ' GROUP BY os, os_version ORDER BY n DESC LIMIT 10'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT device_type, COUNT(*) as n FROM events WHERE site=? AND created_at >= ' + since +
      ' GROUP BY device_type ORDER BY n DESC LIMIT 10'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT gpu_renderer, COUNT(*) as n FROM events WHERE site=? AND created_at >= ' + since +
      ' AND gpu_renderer IS NOT NULL AND gpu_renderer != \'\' GROUP BY gpu_renderer ORDER BY n DESC LIMIT 10'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT link_url, link_text, COUNT(*) as n FROM events WHERE site=? AND event_type=\'click\' AND created_at >= ' + since +
      ' GROUP BY link_url ORDER BY n DESC LIMIT 20'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT event_type, page_url, link_url, country, browser, os, device_type, created_at FROM events WHERE site=? ' +
      'ORDER BY created_at DESC LIMIT 50'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT ' +
      "SUM(CASE WHEN event_type='pageview' THEN 1 ELSE 0 END) as pageviews, " +
      "SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) as clicks, " +
      "SUM(CASE WHEN adblock_detected=1 THEN 1 ELSE 0 END) as adblock_users, " +
      "AVG(time_on_page_sec) as avg_time_on_page_sec, " +
      'COUNT(DISTINCT visitor_id) as visitors ' +
      'FROM events WHERE site=? AND created_at >= ' + since
    ).bind(site).all()
  ]);

  return new Response(JSON.stringify({
    site: site,
    days: days,
    totals: (totals.results && totals.results[0]) || {},
    by_country: byCountry.results || [],
    by_browser: byBrowser.results || [],
    by_os: byOs.results || [],
    by_device: byDevice.results || [],
    by_gpu: byGpu.results || [],
    top_links: topLinks.results || [],
    recent: recent.results || []
  }), { status: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });
}

// Serves the client tracking script itself, so a site only needs one
// <script src="https://YOUR-WORKER-URL/analytics.js" data-site="..."></script>
// tag — no separate hosting of analytics.js required.
function handleAnalyticsJs(request, env) {
  var origin = request.headers.get('Origin') || '';
  var headers = Object.assign(
    { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    corsHeaders(origin, env)
  );
  return new Response(ANALYTICS_JS_SOURCE, { status: 200, headers: headers });
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (url.pathname === '/analytics.js' && request.method === 'GET') {
      return handleAnalyticsJs(request, env);
    }

    if (url.pathname === '/collect' && request.method === 'POST') {
      return handleCollect(request, env, ctx);
    }

    if (url.pathname === '/api/summary' && request.method === 'GET') {
      return handleSummary(request, env, ctx);
    }

    if (url.pathname === '/api/whoami' && request.method === 'GET') {
      return handleWhoami(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  }
};
