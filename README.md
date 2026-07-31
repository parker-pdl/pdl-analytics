# PDL Analytics

A small, self-hosted analytics tool for parkerdata.link and other sites
Parker owns. It is built so that anyone — including regulators, visitors,
or Parker himself — can read exactly what it collects and why. No black
boxes: every field this tool captures is listed below, field by field.

**Status: scaffold only.** Nothing in this repo is deployed or live. See
"Before this goes live" below for what still needs to happen first.

## What this is

A visitor-analytics stack you can drop into any site you own:

- **`analytics.js`** — a client script that records pageviews, link clicks,
  scroll depth, and time-on-page, and reads a broad set of standard,
  no-permission-prompt browser signals (see the full list below).
- **`worker.js`** — a Cloudflare Worker backend with three routes:
  `POST /collect` (receives events, writes to D1), `GET /api/summary`
  (aggregated stats for the dashboard), and `GET /api/whoami` (echoes back
  everything detected about the *caller's own* request — no storage,
  powers the transparency demo page).
- **`whoami.html`** — a plain-language page a visitor can open to see
  every one of these data points collected about their own browser, live,
  in front of them. This is the "nothing hidden" piece of the project.
- **`schema.sql`** — the Cloudflare D1 (SQLite) schema.
- **`dashboard.html`** — a single-file results dashboard: visits by
  country, browser/OS/device breakdown, GPU breakdown, top clicked links,
  recent activity.

## ⚠️ Important: this version stores IP addresses

By explicit product decision, this build stores the visitor's **raw IP
address** (`ip_address` column, read from Cloudflare's `CF-Connecting-IP`
header). This is a change from an earlier draft of this tool, which
deliberately excluded it.

IP address is legally "personal data" under GDPR and "personal
information" under CCPA — collecting it is completely standard practice
(every web server access log does this by default, and so does Google
Analytics, Cloudflare, and virtually every other analytics tool), **but it
does change what you're required to disclose.** Concretely, before this
runs on any real site:

- A visible, plain-language privacy notice is required (see checklist
  below) — this is no longer optional once IP is stored.
- You should decide a retention window and not keep raw IPs forever. A
  sample cleanup query that nulls out `ip_address` after 90 days while
  keeping the rest of the row for aggregate stats is included at the
  bottom of `schema.sql`.
- If you ever have EU visitors, GDPR's lawful-basis and data-subject-rights
  requirements apply (access, deletion, etc.).

## Everything this tool can collect

Nothing below requires a native permission dialog (no camera, microphone,
or precise GPS prompt). Every field comes from standard web-platform APIs
that any site you visit can already read — this tool just makes that
visible via `whoami.html` instead of leaving it invisible.

**Network / location** (server-derived, from Cloudflare edge + request
headers):
- Raw IP address
- Country, region, city, postal code, continent, latitude/longitude
  (city-level, not GPS-precise), timezone, EU-country flag
- ISP / network organization name, ASN
- Cloudflare edge datacenter that served the request, HTTP protocol, TLS
  version/cipher, estimated client round-trip time
- `Accept-Language` header

**Device & browser** (client-reported):
- Operating system + version, browser + version, rendering engine
  (Blink/Gecko/WebKit), device type (desktop/mobile/tablet), bot heuristic
- CPU core count, approximate device memory, touch capability & max touch
  points
- GPU vendor + renderer string (via WebGL debug info — not a
  permission-gated API)
- A coarse canvas-render fingerprint hash (a rough "same browser+GPU
  combo" signal, used alongside the random visitor ID — not a substitute
  for it, and not precise enough to uniquely identify a person on its own)
- Network quality: effective connection type, downlink speed, RTT,
  data-saver flag (Chrome/Edge/Android only — null elsewhere)

**Display:**
- Screen resolution, available screen size, browser viewport size, color
  depth, device pixel ratio, screen orientation

**Preferences & environment:**
- Dark-mode preference, reduced-motion preference, whether the page is
  running as an installed PWA
- Cookies-enabled flag, "Do Not Track" header, local-storage support
- Browser language + full language list, timezone offset

**Page / engagement:**
- Page URL, page title, referrer, `utm_source` if present
- Time spent on page, max scroll depth reached
- Ad-blocker presence (heuristic bait-element detection)
- For link clicks: destination URL and the link's visible text
- A random anonymous visitor ID, generated client-side and stored in
  `localStorage` (not a cookie, no cross-site tracking, resets if the
  visitor clears site data) to group repeat visits from the same browser

**Voluntary only — never auto-collected:**
- Age range, gender, interests — only if a visitor explicitly fills out a
  disclosed form (see `visitor_profiles` table in `schema.sql`). Age in
  particular cannot be reliably inferred from device/network signals and
  this tool does not attempt to; it can only be self-reported.
- Name, email, or any other direct identifier — not collected anywhere in
  this stack.

## What this tool still does NOT do

- No account linking across sites, no data sale to third parties.
- No cross-site or third-party cookies.
- No access to camera, microphone, contacts, precise GPS, clipboard, or
  any other permission-gated browser API.
- No attempt to de-anonymize a visitor beyond what's listed above.

## See it for yourself

Open `whoami.html` in a browser (locally, no server needed) to see every
client-side field listed above, live, filled in with your own browser's
actual values. If you also have a Worker deployed, paste its URL into the
box on that page to see the server-derived fields (IP, ISP, TLS info, etc.)
for your own connection too — that request is never stored, only echoed
back to you.

## Before this goes live

This scaffold is intentionally not wired into any real site yet. Before it
is:

1. **Publish a plain-language privacy notice** on any site that runs this
   (what's collected — including IP address — why, how long it's kept, how
   to request deletion) and link to it from the page footer. This is a
   hard requirement now that IP is stored, not just a nice-to-have.
2. Decide a retention window for `ip_address` and `canvas_fp` specifically
   — don't keep raw IPs indefinitely. A sample cleanup query is at the
   bottom of `schema.sql`.
3. Decide whether you need a cookie/consent banner for your audience — even
   though this tool avoids cookies, some jurisdictions still expect a
   notice for any client-side tracking + IP logging.
4. Add real authentication to the `/api/summary` endpoint in `worker.js`
   (it currently has a `TODO` — right now anyone who finds the URL could
   read the aggregated stats, including any IPs surfaced in `recent`).
5. Replace the placeholder `database_id` in `wrangler.toml` with a real
   Cloudflare D1 database id (`wrangler d1 create pdl-analytics`), and run
   `schema.sql` against it.
6. Set `ALLOWED_ORIGINS` in `wrangler.toml` to the real list of sites that
   are allowed to send events (currently a placeholder).
7. Only after 1–6 are done: `wrangler deploy`, then add the `analytics.js`
   `<script>` snippet to the sites you want to track.

## File structure (current, flat)

GitHub's web upload UI (used to publish this repo) flattens folders, so
everything currently lives at the repo root. The intended structure, for
whenever this gets reorganized with a real `git` client, is noted per file
below.

- `analytics.js` — client tracking script. (intended path: `client/analytics.js`)
- `worker.js` — Cloudflare Worker backend. (intended path: `worker/worker.js`)
- `schema.sql` — D1 database schema. (intended path: `worker/schema.sql`)
- `wrangler.toml` — Worker deploy config. (intended path: `worker/wrangler.toml`)
- `dashboard.html` — single-file results dashboard. (intended path: `dashboard/index.html`)
- `whoami.html` — visitor-facing transparency demo page. (intended path: `demo/whoami.html`)

## Deploy steps (when ready — not done yet)

1. `npm install -g wrangler` (Cloudflare's CLI), then `wrangler login`.
2. `wrangler d1 create pdl-analytics` → copy the returned database id into
   `wrangler.toml`.
3. `wrangler d1 execute pdl-analytics --file=schema.sql`.
4. Set `ALLOWED_ORIGINS` in `wrangler.toml` to your real site origins.
5. Add real auth to `/api/summary` in `worker.js`.
6. Publish the privacy notice (step 1 above) and link it from every site's
   footer before this step.
7. `wrangler deploy`.
8. Add this snippet before `</body>` on any site you want to track:
   ```html
   <script src="https://YOUR-WORKER-URL/analytics.js"
           data-site="parkerdata.link"></script>
   ```
   (or self-host `analytics.js` and call `PDLAnalytics.init(...)` manually —
   see the comments at the top of `analytics.js`).
9. Open `dashboard.html`, point it at your Worker URL and site name.
10. Optionally link `whoami.html` from your site footer so visitors can see
    exactly what's being collected about them, in their own browser.

## Google Play app (future)

Parker's longer-term goal is to package this as a standalone product other
site owners could use, including a Google Play Store app. That would be a
separate client (native or wrapped web view) hitting the same `/collect`,
`/api/summary`, and `/api/whoami` Worker endpoints — nothing here needs to
change architecturally to support that later; it's just a new client on
top of the same backend.
