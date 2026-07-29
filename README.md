# PDL Analytics

A small, self-hosted, fully-transparent analytics tool for parkerdata.link and
other sites Parker owns. It is built so that anyone (including regulators,
users, or Parker himself) can read exactly what it collects and why — no
black boxes.

**Status: scaffold only.** Nothing in this repo is deployed or live. See
"Before this goes live" below for what still needs to happen first.

## What this is

A lightweight visitor-analytics stack you can drop into any site you own:

- A small client script (`analytics.js`) that records pageviews and link
  clicks and sends them to your own backend.
- A Cloudflare Worker (`worker.js`) that receives those events, enriches
  them with edge-provided geography info, and stores them in a Cloudflare
  D1 (SQLite) database.
- A single-file dashboard (`dashboard.html`) to view aggregated results —
  visits by country, browser/OS breakdown, top clicked links, recent
  activity.

## What it collects

Per pageview / click event:

- Which site + page URL the event happened on, and the referrer.
- A random anonymous visitor ID generated client-side and stored in
  `localStorage` on the visitor's device (not a cookie, no cross-site
  tracking, resets if the visitor clears site data).
- Coarse geography (country / region / city / timezone) and network
  provider name, derived from Cloudflare's edge request metadata — this is
  the same IP-derived geolocation nearly every analytics platform
  (Google Analytics, Plausible, Fathom, etc.) provides. The raw IP address
  itself is never stored.
- Browser, operating system, and device type, parsed from the User-Agent
  string sent by the browser on every request anyway.
- Screen size and browser language.
- For link clicks specifically: the destination URL and the link's visible
  text, so you can see which links on a page people actually click.

## What it deliberately does NOT collect

- No raw IP addresses are stored (only the derived coarse location).
- No age, gender, name, email, or any other personal identifier — unless a
  visitor voluntarily submits it through a separate form you build (age in
  particular cannot be reliably inferred from device/network signals, and
  this tool does not attempt to).
- No cross-site or third-party cookies. No fingerprinting techniques
  beyond the basic UA/screen info any web request already exposes.
- No account linking, no sale of data to third parties.

## Before this goes live

This scaffold is intentionally not wired into any real site yet. Before it
is:

1. Publish a plain-language privacy notice on any site that runs this
   (what's collected, why, how long it's kept, how to opt out) and link to
   it from the page footer.
2. Decide whether you need a cookie/consent banner for your audience — even
   though this tool avoids cookies, some jurisdictions still expect a
   notice for any client-side tracking script.
3. Add real authentication to the `/api/summary` endpoint in `worker.js`
   (it currently has a `TODO` — right now anyone who finds the URL could
   read the aggregated stats).
4. Replace the placeholder `database_id` in `wrangler.toml` with a real
   Cloudflare D1 database id (`wrangler d1 create pdl-analytics`), and run
   `schema.sql` against it.
5. Set `ALLOWED_ORIGINS` in `wrangler.toml` to the real list of sites that
   are allowed to send events (currently a placeholder).
6. Only after 1–4 are done: `wrangler deploy`, then add the `analytics.js`
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

## Deploy steps (when ready — not done yet)

1. `npm install -g wrangler` (Cloudflare's CLI), then `wrangler login`.
2. `wrangler d1 create pdl-analytics` → copy the returned database id into
   `wrangler.toml`.
3. `wrangler d1 execute pdl-analytics --file=schema.sql`.
4. Set `ALLOWED_ORIGINS` in `wrangler.toml` to your real site origins.
5. Add real auth to `/api/summary` in `worker.js`.
6. `wrangler deploy`.
7. Add this snippet before `</body>` on any site you want to track:
   ```html
   <script src="https://YOUR-WORKER-URL/analytics.js"
           data-site="parkerdata.link"></script>
   ```
   (or self-host `analytics.js` and call `PDLAnalytics.init(...)` manually —
   see the comments at the top of `analytics.js`).
8. Open `dashboard.html`, point it at your Worker URL and site name.

## Google Play app (future)

Parker's longer-term goal is to package this as a standalone product other
site owners could use, including a Google Play Store app. That would be a
separate client (native or wrapped web view) hitting the same
`/collect` and `/api/summary` Worker endpoints — nothing here needs to
change architecturally to support that later; it's just a new client on
top of the same backend.
