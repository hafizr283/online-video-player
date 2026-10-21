-- Fast Player — Cloudflare D1 schema.
--
-- One row per title, one row per comment, and small append-only logs that make
-- the public rules enforceable without accounts. `sources` is JSON because
-- a title legitimately has several files (480p, 720p, 1080p, a mirror) — a single
-- video_url column would silently delete the quality menu.
--
-- Apply with:
--   npx wrangler d1 execute fast-player --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS titles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  year         INTEGER,
  poster_url   TEXT,
  subtitle_url TEXT,
  duration     INTEGER,
  size         INTEGER,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  views        INTEGER NOT NULL DEFAULT 0,
  categories   TEXT NOT NULL DEFAULT '[]',
  tags         TEXT NOT NULL DEFAULT '[]',
  sources      TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_titles_status ON titles (status, created_at DESC);

CREATE TABLE IF NOT EXISTS categories (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id        TEXT PRIMARY KEY,
  title_id  TEXT NOT NULL,
  parent_id TEXT,
  name      TEXT NOT NULL DEFAULT 'Guest',
  text      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  hidden    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_title ON comments (title_id, at DESC);

-- Dedupe table for views: one row per address per title per window.
CREATE TABLE IF NOT EXISTS view_log (
  ip_hash  TEXT NOT NULL,
  title_id TEXT NOT NULL,
  at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_view_log ON view_log (ip_hash, title_id, at);

-- Comment rate limits.
CREATE TABLE IF NOT EXISTS post_log (
  ip_hash TEXT NOT NULL,
  at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_post_log ON post_log (ip_hash, at);

-- Failed admin-token attempts, so guessing is rate-limited per address.
CREATE TABLE IF NOT EXISTS auth_log (
  ip_hash TEXT NOT NULL,
  at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_log ON auth_log (ip_hash, at);

-- Admin-controlled switches. Public uploads are off until an admin turns them on.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_public_uploads', '0');

-- A public upload gets one short-lived ticket. The Worker builds the Azure URL
-- from the ticket's blob path, so a client cannot point a draft at someone
-- else's file or an arbitrary third-party URL.
CREATE TABLE IF NOT EXISTS upload_tickets (
  id         TEXT PRIMARY KEY,
  blob       TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  ip_hash    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_upload_tickets_expiry ON upload_tickets (expires_at);

-- Public-upload request rate limits, separate from comments and admin auth.
CREATE TABLE IF NOT EXISTS upload_log (
  ip_hash TEXT NOT NULL,
  at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_log ON upload_log (ip_hash, at);

-- One row per file waiting for (or inside) the GitHub Actions transcoder.
CREATE TABLE IF NOT EXISTS transcode_jobs (
  id         TEXT PRIMARY KEY,
  title_id   TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  blob       TEXT NOT NULL,
  name       TEXT NOT NULL,
  quality    INTEGER NOT NULL DEFAULT 720,
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON transcode_jobs (status, created_at);
