-- PDL Analytics — Cloudflare D1 schema (scaffold)
-- Run with: wrangler d1 execute pdl-analytics --file=schema.sql

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type    TEXT    NOT NULL,        -- 'pageview' | 'click' | custom event name
  site          TEXT    NOT NULL,        -- e.g. 'parkerdata.link'
  page_url      TEXT    NOT NULL,
  referrer      TEXT,
  link_url      TEXT,                    -- populated for 'click' events
  link_text     TEXT,                    -- populated for 'click' events
  visitor_id    TEXT    NOT NULL,        -- random id, stored client-side in localStorage

  -- Derived from Cloudflare's edge request metadata (request.cf). No raw IP is stored.
  country       TEXT,
  region        TEXT,
  city          TEXT,
  timezone      TEXT,
  isp           TEXT,

  -- Parsed from the User-Agent header.
  os            TEXT,
  browser       TEXT,
  device_type   TEXT,                    -- 'desktop' | 'mobile' | 'tablet' | 'unknown'

  screen_w      INTEGER,
  screen_h      INTEGER,
  language      TEXT,

  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_site_created ON events (site, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events (visitor_id);
