const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'briefing.db'));

// WAL mode improves concurrent read performance on supported filesystems
try { db.exec(`PRAGMA journal_mode = WAL`); } catch (_) {}
// Migrations
try { db.exec('ALTER TABLE episodes ADD COLUMN title TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE episodes ADD COLUMN episode_type TEXT DEFAULT 'megan_only'"); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`); } catch (_) {}
try { db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('show_active', '1')`); } catch (_) {}
try { db.exec(`UPDATE episodes SET title = '#1 | The intimacy industrial complex | April 7, 2026' WHERE number = 1 AND (title IS NULL OR title = '')`); } catch (_) {}
try { db.exec(`UPDATE episodes SET title = '#2 | Intimacy by algorithm, regulation by lawsuit | April 8, 2026' WHERE number = 2 AND (title IS NULL OR title = '')`); } catch (_) {}
// Staging: status + publish_at
try { db.exec("ALTER TABLE episodes ADD COLUMN status TEXT DEFAULT 'published'"); } catch (_) {}
try { db.exec("ALTER TABLE episodes ADD COLUMN publish_at TEXT"); } catch (_) {}
// Script edit tracking
try { db.exec('ALTER TABLE episodes ADD COLUMN original_script TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE episodes ADD COLUMN edit_summary TEXT'); } catch (_) {}
// Cross-episode narrative memory
try { db.exec('ALTER TABLE episodes ADD COLUMN episode_summary TEXT'); } catch (_) {}
// Actual audio duration (seconds) measured from file after generation
try { db.exec('ALTER TABLE episodes ADD COLUMN audio_duration_seconds INTEGER'); } catch (_) {}
// Editable show notes HTML — QC artifact before publishing to Apple Podcasts
try { db.exec('ALTER TABLE episodes ADD COLUMN show_notes TEXT'); } catch (_) {}
// Timestamp of last audio generation — used as persistent cache-buster in the audio player
try { db.exec('ALTER TABLE episodes ADD COLUMN audio_updated_at TEXT'); } catch (_) {}
// All existing episodes are already live — mark them published
try { db.exec("UPDATE episodes SET status = 'published' WHERE status IS NULL OR status = ''"); } catch (_) {}
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER UNIQUE,
    date TEXT NOT NULL,
    script TEXT,
    audio_filename TEXT,
    duration_estimate INTEGER,
    source_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER REFERENCES episodes(id),
    title TEXT NOT NULL,
    url TEXT,
    summary TEXT,
    published_date TEXT,
    courses TEXT DEFAULT '[]',
    contributed INTEGER DEFAULT 0,
    contributor_note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES sources(id),
    episode_id INTEGER REFERENCES episodes(id),
    note TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    course TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contributed_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    note TEXT,
    used INTEGER DEFAULT 0,
    episode_id INTEGER REFERENCES episodes(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sources_episode ON sources(episode_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_episode ON feedback(episode_id);
`);

// Seed default themes if empty
const themeCount = db.prepare('SELECT COUNT(*) as c FROM themes').get();
if (themeCount.c === 0) {
  const insertTheme = db.prepare('INSERT INTO themes (name, course, active) VALUES (?, ?, 1)');

  const themes = [
    // Intimate Technology
    { name: 'AI companions and social robots', course: 'intimate_tech' },
    { name: 'Haptic technology and digital touch', course: 'intimate_tech' },
    { name: 'Surveillance capitalism and personal data', course: 'intimate_tech' },
    { name: 'Digital intimacy and online relationships', course: 'intimate_tech' },
    { name: 'Consent, data collection, and privacy', course: 'intimate_tech' },
    { name: 'Ethics of care robots and artificial empathy', course: 'intimate_tech' },
    { name: 'Identity performance and social media', course: 'intimate_tech' },
    { name: 'Regulation of intimate technology', course: 'intimate_tech' },
    { name: 'Emotional AI and affective computing', course: 'intimate_tech' },
    { name: 'Mental health apps and digital therapy', course: 'intimate_tech' },

    // Social Impact Strategy
    { name: 'Corporate responsibility in big tech', course: 'social_impact' },
    { name: 'ESG and technology companies', course: 'social_impact' },
    { name: 'Algorithmic harm and accountability', course: 'social_impact' },
    { name: 'Technology policy and antitrust regulation', course: 'social_impact' },
    { name: 'Ethical product design and dark patterns', course: 'social_impact' },
    { name: 'Stakeholder capitalism in tech', course: 'social_impact' },
    { name: 'Social entrepreneurship and impact tech', course: 'social_impact' },
    { name: 'AI bias and fairness in automated systems', course: 'social_impact' },
    { name: 'Platform labor and gig economy ethics', course: 'social_impact' },
    { name: 'Digital divide and technology access equity', course: 'social_impact' },

    // Shared
    { name: 'Technology and vulnerable populations', course: 'shared' },
    { name: 'Business models and social harm', course: 'shared' },
    { name: 'Ethics and commercial incentives in tech', course: 'shared' },
    { name: 'AI regulation and governance', course: 'shared' },
    { name: 'Technology and human autonomy', course: 'shared' },
  ];

  for (const t of themes) insertTheme.run(t.name, t.course);
}

module.exports = db;
