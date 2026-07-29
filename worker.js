/*!
 * PDL Analytics — Cloudflare Worker backend (scaffold)
 * -----------------------------------------------------------------------
 * Two routes:
 *   POST /collect      - receives events from analytics.js, writes to D1
 *   GET  /api/summary   - returns aggregated stats for the dashboard
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

// Minimal hand-rolled UA parser — good enough for coarse os/browser/device
// buckets without pulling in a dependency. Not exhaustive.
function parseUA(ua) {
  ua = ua || '';
  var os = 'Unknown';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Linux/i.test(ua)) os = 'Linux';

  var browser = 'Unknown';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/CriOS\//i.test(ua)) browser = 'Chrome (iOS)';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  var deviceType = 'desktop';
  if (/iPad|Tablet/i.test(ua)) deviceType = 'tablet';
  else if (/Mobi|iPhone|Android/i.test(ua)) deviceType = 'mobile';

  return { os: os, browser: browser, deviceType: deviceType };
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

  var cf = request.cf || {};
  var ua = parseUA(request.headers.get('User-Agent'));

  try {
    await env.DB.prepare(
      'INSERT INTO events ' +
      '(event_type, site, page_url, referrer, link_url, link_text, visitor_id, ' +
      'country, region, city, timezone, isp, os, browser, device_type, screen_w, screen_h, language) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      String(body.event_type).slice(0, 64),
      String(body.site).slice(0, 200),
      String(body.page_url || '').slice(0, 2000),
      String(body.referrer || '').slice(0, 2000),
      String(body.link_url || '').slice(0, 2000),
      String(body.link_text || '').slice(0, 500),
      String(body.visitor_id).slice(0, 64),
      cf.country || null,
      cf.region || null,
      cf.city || null,
      body.timezone || cf.timezone || null,
      cf.asOrganization || null,
      ua.os,
      ua.browser,
      ua.deviceType,
      Number(body.screen_w) || null,
      Number(body.screen_h) || null,
      String(body.language || '').slice(0, 32)
    ).run();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'db error' }), { status: 500, headers: headers });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: headers });
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

  var [byCountry, byBrowser, byOs, topLinks, recent, totals] = await Promise.all([
    env.DB.prepare(
      'SELECT country, COUNT(*) as n FROM events WHERE site=? AND event_type=\'pageview\' AND created_at >= ' + since +
      ' GROUP BY country ORDER BY n DESC LIMIT 20'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT browser, COUNT(*) as n FROM events WHERE site=? AND created_at >= ' + since +
      ' GROUP BY browser ORDER BY n DESC LIMIT 10'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT os, COUNT(*) as n FROM events WHERE site=? AND created_at >= ' + since +
      ' GROUP BY os ORDER BY n DESC LIMIT 10'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT link_url, link_text, COUNT(*) as n FROM events WHERE site=? AND event_type=\'click\' AND created_at >= ' + since +
      ' GROUP BY link_url ORDER BY n DESC LIMIT 20'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT event_type, page_url, link_url, country, browser, os, created_at FROM events WHERE site=? ' +
      'ORDER BY created_at DESC LIMIT 50'
    ).bind(site).all(),
    env.DB.prepare(
      'SELECT ' +
      "SUM(CASE WHEN event_type='pageview' THEN 1 ELSE 0 END) as pageviews, " +
      "SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) as clicks, " +
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

    return new Response('Not found', { status: 404 });
  }
};
