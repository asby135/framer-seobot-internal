-- Keywords discovered from GSC (+ Keyword Planner in v2)
CREATE TABLE IF NOT EXISTS keywords (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'gsc', -- 'gsc' or 'keyword_planner'
  impressions INTEGER,
  clicks INTEGER,
  ctr REAL,
  position REAL,
  search_volume INTEGER,
  competition TEXT,
  cpc REAL,
  opportunity_score REAL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected, generated
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generated articles
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  keyword_id TEXT REFERENCES keywords(id),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  category TEXT,
  summary TEXT,
  content TEXT, -- HTML body
  status TEXT NOT NULL DEFAULT 'draft', -- draft, review, published, archived, generation_failed
  flags TEXT, -- JSON for partial-failure metadata, e.g. {"thumbnail_missing": true}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);

-- Asset storage references (thumbnails, screenshots in R2)
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id),
  type TEXT NOT NULL, -- 'thumbnail', 'screenshot'
  url TEXT NOT NULL,
  alt_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generation and sync history
CREATE TABLE IF NOT EXISTS sync_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL, -- 'research', 'generate', 'sync'
  items_count INTEGER,
  status TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API key storage (single active key)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Article translations for localization
CREATE TABLE IF NOT EXISTS article_translations (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id),
  locale TEXT NOT NULL, -- 'ru', 'ua', 'fr'
  title TEXT NOT NULL,
  slug TEXT,
  summary TEXT,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(article_id, locale)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords(status);
CREATE INDEX IF NOT EXISTS idx_keywords_score ON keywords(opportunity_score DESC);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_keyword ON articles(keyword_id);
CREATE INDEX IF NOT EXISTS idx_assets_article ON assets(article_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_action ON sync_log(action);
CREATE INDEX IF NOT EXISTS idx_translations_article ON article_translations(article_id);
