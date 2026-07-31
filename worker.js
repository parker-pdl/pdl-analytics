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

  // TODO before going live: require authentication here (e.g. a shared
  // secret header, or Cloudflare Access) — right now anyone who finds this
  // URL can read the aggregated stats for `site`.

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

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
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
