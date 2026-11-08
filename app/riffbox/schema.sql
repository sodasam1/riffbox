PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS recordings (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  filename      TEXT NOT NULL UNIQUE,      -- name on disk inside the audio dir
  orig_filename TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  duration_s    REAL,
  peaks         TEXT,                      -- JSON array, filled in by the browser later
  recorded_at   TEXT NOT NULL,             -- ISO 8601 UTC
  uploaded_at   TEXT NOT NULL,             -- ISO 8601 UTC
  status        TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','tagged')),
  tempo         TEXT CHECK (tempo IN ('slow','medium','fast')),
  bpm           INTEGER,
  key_root      TEXT,
  key_mode      TEXT CHECK (key_mode IN ('major','minor')),
  notes         TEXT NOT NULL DEFAULT '',
  rating        TEXT CHECK (rating IN ('heart','check','x')),
  used_in       TEXT,
  last_played_at TEXT,
  deleted_at    TEXT,
  -- Playback copy (added in phase 3.5; databases created earlier get these via migrate() in __init__)
  codec         TEXT,                      -- 'alac','aac', other sample-entry name, 'unknown' or 'n/a'; NULL = not examined yet
  play_status   TEXT,                      -- NULL = original plays as is; 'pending','ready','failed'
  play_filename TEXT,                      -- FLAC copy on disk when play_status = 'ready'
  play_error    TEXT                       -- last conversion error (server log use only; never sent to the UI)
);
CREATE INDEX IF NOT EXISTS idx_recordings_sha256 ON recordings(sha256);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status, deleted_at);

CREATE TABLE IF NOT EXISTS tags (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS recording_tags (
  recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  tag          TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (recording_id, tag)
);

INSERT OR IGNORE INTO tags(name) VALUES
  ('bass'),('drums'),('keys'),('guitar'),('harmony'),
  ('vocal'),('melody'),('rhythmic idea'),('full song');
