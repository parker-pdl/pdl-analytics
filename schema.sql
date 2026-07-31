-- PDL Analytics — Cloudflare D1 schema (scaffold)
-- Run with: wrangler d1 execute pdl-analytics --file=schema.sql
--
-- NOTE: this schema stores the visitor's IP address (ip_address) by
-- explicit product decision. IP address is personal data under GDPR/CCPA —
-- before this is deployed anywhere real, publish the privacy notice
-- described in README.md "Before this goes live" and decide a retention
-- window (see the cleanup query at the bottom of this file).

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type    TEXT    NOT NULL,        -- 'pageview' | 'click' | 'engagement' | custom event name
  site          TEXT    NOT NULL,        -- e.g. 'parkerdata.link'
  page_url      TEXT    NOT NULL,
  referrer      TEXT,
  link_url      TEXT,                    -- populated for 'click' events
  link_text     TEXT,                    -- populated for 'click' events
  visitor_id    TEXT    NOT NULL,        -- random id, stored client-side in localStorage

  -- Network identity.
  ip_address    TEXT,                    -- raw client IP (CF-Connecting-IP). Personal data — see note above.

  -- Derived from Cloudflare's edge request metadata (request.cf).
  country       TEXT,
  region        TEXT,
  region_code   TEXT,
  city          TEXT,
  postal_code   TEXT,
  continent     TEXT,
  timezone      TEXT,
  latitude      TEXT,
  longitude     TEXT,
  metro_code    TEXT,
  is_eu_country INTEGER,                 -- 0/1
  asn           INTEGER,
  isp           TEXT,                    -- request.cf.asOrganization
  colo          TEXT,                    -- Cloudflare datacenter that served the request
  http_protocol TEXT,
  tls_version   TEXT,
  client_tcp_rtt INTEGER,

  -- Parsed from the User-Agent header.
  os              TEXT,
  os_version      TEXT,
  browser         TEXT,
  browser_version TEXT,
  engine          TEXT,                  -- Blink | Gecko | WebKit | Unknown
  device_type     TEXT,                  -- 'desktop' | 'mobile' | 'tablet' | 'unknown'
  is_bot          INTEGER,               -- 0/1, heuristic UA match

  -- Display.
  screen_w      INTEGER,
  screen_h      INTEGER,
  avail_w       INTEGER,
  avail_h       INTEGER,
  color_depth   INTEGER,
  pixel_ratio   REAL,
  viewport_w    INTEGER,
  viewport_h    INTEGER,
  orientation   TEXT,
  prefers_dark  INTEGER,                 -- 0/1/NULL
  prefers_reduced_motion INTEGER,        -- 0/1/NULL
  standalone_pwa INTEGER,                -- 0/1

  -- Locale / time.
  language      TEXT,
  languages     TEXT,                    -- comma-separated navigator.languages
  tz_offset_min INTEGER,

  -- Hardware / platform (all standard, no-permission-prompt browser APIs).
  platform          TEXT,
  vendor            TEXT,
  cpu_cores         INTEGER,
  device_memory_gb  REAL,
  max_touch_points  INTEGER,
  touch_capable     INTEGER,             -- 0/1

  -- Network quality (Chrome/Edge/Android only — NULL elsewhere).
  conn_type            TEXT,             -- '4g' | '3g' | 'wifi' etc (effectiveType)
  conn_downlink_mbps   REAL,
  conn_rtt_ms          INTEGER,
  conn_save_data       INTEGER,          -- 0/1

  -- GPU (read via WebGL debug info — not a permission-gated API).
  gpu_vendor    TEXT,
  gpu_renderer  TEXT,

  -- Misc environment flags.
  cookies_enabled     INTEGER,           -- 0/1
  do_not_track        INTEGER,           -- 0/1
  storage_supported    INTEGER,          -- 0/1
  canvas_fp            TEXT,             -- coarse canvas-render hash, browser+GPU fingerprint aid

  -- Engagement.
  adblock_detected    INTEGER,           -- 0/1, heuristic
  time_on_page_sec    INTEGER,
  max_scroll_pct      INTEGER,
  page_title          TEXT,
  utm_source          TEXT,

  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_site_created ON events (site, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events (visitor_id);
CREATE INDEX IF NOT EXISTS idx_events_ip ON events (ip_address);

-- Optional voluntary-profile table — only ever populated when a visitor
-- fills out an explicit, disclosed form (e.g. an age-range dropdown on a
-- newsletter signup). Never auto-filled from browser signals.
CREATE TABLE IF NOT EXISTS visitor_profiles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id    TEXT    NOT NULL,
  site          TEXT    NOT NULL,
  age_range     TEXT,                    -- e.g. '18-24', '25-34', ... — self-selected, never inferred
  gender        TEXT,                    -- self-selected, optional, free text or dropdown
  interests     TEXT,                    -- comma-separated tags, self-selected
  submitted_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_profiles_visitor ON visitor_profiles (visitor_id);

-- Suggested retention cleanup (run periodically, e.g. via a Cron Trigger)
-- once a retention window is decided — IP address in particular should not
-- be kept indefinitely. Example: delete raw IP after 90 days but keep the
-- rest of the row for aggregate stats.
--
-- UPDATE events SET ip_address = NULL
--   WHERE created_at < datetime('now', '-90 days') AND ip_address IS NOT NULL;
