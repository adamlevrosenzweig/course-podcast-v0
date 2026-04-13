require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';       // Megan
const ELEVENLABS_ADAM_VOICE_ID = process.env.ELEVENLABS_ADAM_VOICE_ID || ''; // Adam (cloned)

const AUDIO_DIR = process.env.AUDIO_DIR || path.join(__dirname, 'audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signToken(ts) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(ts).digest('hex');
}
function makeSession() {
  const ts = Date.now().toString();
  return `${ts}.${signToken(ts)}`;
}
function isValidSession(raw) {
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return false;
  const ts = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (Date.now() - parseInt(ts, 10) > SESSION_MAX_AGE_MS) return false;
  const expected = signToken(ts);
  try {
    return sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}
function parseCookie(req, name) {
  const header = req.headers.cookie || '';
  const pair = header.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}
function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next(); // no password configured → open access
  if (isValidSession(parseCookie(req, 'session'))) return next();
  // API key auth for CLI tools (push-to-railway.js)
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === ADMIN_PASSWORD) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── Login page ────────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>The Overhang — Sign In</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f0d; color: #e8e6df; font-family: 'Inter', sans-serif;
      display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { width: 100%; max-width: 360px; padding: 48px 40px; background: #1a1a17;
      border: 1px solid #2e2e2a; border-radius: 12px; }
    .logo { font-family: 'Playfair Display', serif; font-size: 22px; color: #c8a96e;
      margin-bottom: 6px; }
    .sub { font-size: 12px; color: #7a7870; letter-spacing: 0.05em; margin-bottom: 36px; }
    label { font-size: 12px; color: #7a7870; letter-spacing: 0.04em; display: block; margin-bottom: 6px; }
    input { width: 100%; background: #0f0f0d; border: 1px solid #2e2e2a; border-radius: 6px;
      padding: 10px 14px; color: #e8e6df; font-size: 15px; outline: none; margin-bottom: 16px; }
    input:focus { border-color: #c8a96e; }
    button { width: 100%; background: #c8a96e; color: #0f0f0d; border: none; border-radius: 6px;
      padding: 11px; font-size: 14px; font-weight: 600; cursor: pointer; letter-spacing: 0.02em; }
    button:hover { background: #d4b87e; }
    .error { color: #c06060; font-size: 13px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">The Overhang</div>
    <div class="sub">RESEARCH PODCAST</div>
    {{ERROR}}
    <form method="POST" action="/login">
      <label>PASSWORD</label>
      <input type="password" name="password" autofocus autocomplete="current-password" />
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;

app.get('/login', (req, res) => {
  if (ADMIN_PASSWORD && isValidSession(parseCookie(req, 'session'))) return res.redirect('/');
  res.send(LOGIN_HTML.replace('{{ERROR}}', ''));
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (!ADMIN_PASSWORD || req.body.password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie',
      `session=${encodeURIComponent(makeSession())}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_MS / 1000}; Path=/`
    );
    return res.redirect('/');
  }
  res.status(401).send(LOGIN_HTML.replace('{{ERROR}}', '<div class="error">Incorrect password.</div>'));
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/');
  res.redirect('/login');
});

// ─── EPISODE INTROS ──────────────────────────────────────────────────────────

const INTRO_DIALOGUE = `MEGAN: Hey — I’m Megan, co-host of The Overhang with Adam Rosenzweig. Quick note on what you’re hearing: both of our voices are AI-generated — Adam’s is cloned from his real voice using ElevenLabs, mine is fully synthetic. Scripts are written by Adam and Claude, grounded in his research and courses. We try to get it right, but check anything that matters. Here’s what we’re looking at.`;

const INTRO_MEGAN_ONLY = `MEGAN: Hey — I’m Megan, host of The Overhang — the podcast from Adam Rosenzweig. Adam’s out today. My voice is fully synthetic, built on ElevenLabs — the scripts are written by Adam and Claude, grounded in his research and courses. We try to get it right, but check anything that matters. Here’s what we’re looking at.`;

const OUTRO_DIALOGUE = `MEGAN: That’s The Overhang for today. We try to get it right, but check anything that matters. See you next time.`;

const OUTRO_MEGAN_ONLY = `MEGAN: That’s The Overhang for today. AI makes mistakes — check anything that matters. See you next time.`;

// ─── DIALOGUE PARSER ─────────────────────────────────────────────────────────
// Splits a dialogue script into { speaker, text } turns for text-to-dialogue API.
// Handles both tagged lines (ADAM: / MEGAN:) and untagged lines (treated as MEGAN).

function parseDialogue(script) {
  const turns = [];
  for (const line of script.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(ADAM|MEGAN):\s*"?(.+?)"?$/);
    if (match) {
      turns.push({ speaker: match[1], text: match[2].trim() });
    } else if (turns.length > 0) {
      // continuation line — append to last turn
      turns[turns.length - 1].text += ' ' + trimmed.replace(/^"|"$/g, '');
    } else {
      turns.push({ speaker: 'MEGAN', text: trimmed.replace(/^"|"$/g, '') });
    }
  }
  return turns.filter(t => t.text.length > 0);
}

// ─── CHUNK TURNS to stay under ElevenLabs 5000-char API limit ────────────────
const DIALOGUE_CHAR_LIMIT = 4800;

function chunkTurns(turns) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const turn of turns) {
    const len = turn.text.length + turn.speaker.length + 2;
    if (current.length > 0 && currentLen + len > DIALOGUE_CHAR_LIMIT) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(turn);
    currentLen += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ─── JEWISH CALENDAR: SHABBAT + HOLIDAY GUARD ────────────────────────────────
// Returns { skip: true, reason: string } on Shabbat or major Jewish holidays
// (Yom Tov and major fasts — Yom Kippur, Tisha B'Av).
// Uses @hebcal/core (ESM) via dynamic import. Diaspora rules apply.

async function isJewishRestDay(date = new Date()) {
  if (date.getDay() === 6) return { skip: true, reason: 'Shabbat' };
  try {
    const { HDate, HebrewCalendar, flags } = await import('@hebcal/core');
    const hdate = new HDate(date);
    const holidays = HebrewCalendar.getHolidaysOnDate(hdate, false); // false = diaspora
    if (holidays) {
      for (const h of holidays) {
        const f = h.getFlags();
        if (f & flags.CHAG || f & flags.MAJOR_FAST) {
          return { skip: true, reason: h.getDesc() };
        }
      }
    }
  } catch (err) {
    console.error('[jewish-calendar] Error checking holidays:', err.message);
  }
  return { skip: false };
}

// ─── KILL SWITCH ─────────────────────────────────────────────────────────────

function isShowActive() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'show_active'").get();
  return !row || row.value === '1';
}

app.get('/api/settings', (req, res) => {
  const lastPub = db.prepare("SELECT MAX(date) as d FROM episodes WHERE status = 'published'").get();
  const daysSince = lastPub?.d
    ? Math.floor((Date.now() - new Date(lastPub.d)) / (1000 * 60 * 60 * 24))
    : null;
  res.json({ show_active: isShowActive(), last_published: lastPub?.d || null, days_since_published: daysSince });
});

app.post('/api/settings/active', (req, res) => {
  const { active } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('show_active', ?)").run(active ? '1' : '0');
  console.log(`[settings] show_active set to ${active ? 'true' : 'false'}`);
  res.json({ ok: true, show_active: !!active });
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Auth guard — exempts RSS feed, audio, transcripts, and static assets (needed by podcast apps)
app.use((req, res, next) => {
  if (
    req.path === '/feed.xml' ||
    req.path.startsWith('/audio/') ||
    /^\/episodes\/\d+\/transcript$/.test(req.path) ||
    /\.(jpg|jpeg|png|gif|svg|ico|webp)$/i.test(req.path)
  ) return next();
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));
app.use('/audio', express.static(AUDIO_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// ─── THEMES ──────────────────────────────────────────────────────────────────

app.get('/api/themes', (req, res) => {
  const themes = db.prepare('SELECT * FROM themes ORDER BY course, name').all();
  res.json(themes);
});

app.post('/api/themes', (req, res) => {
  const { name, course } = req.body;
  if (!name || !course) return res.status(400).json({ error: 'name and course required' });
  const valid = ['intimate_tech', 'social_impact', 'shared'];
  if (!valid.includes(course)) return res.status(400).json({ error: 'course must be intimate_tech, social_impact, or shared' });
  const result = db.prepare('INSERT INTO themes (name, course, active) VALUES (?, ?, 1)').run(name, course);
  res.json(db.prepare('SELECT * FROM themes WHERE id = ?').get(result.lastInsertRowid));
});

app.patch('/api/themes/:id', (req, res) => {
  const { active, name } = req.body;
  const theme = db.prepare('SELECT * FROM themes WHERE id = ?').get(req.params.id);
  if (!theme) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE themes SET active = COALESCE(?, active), name = COALESCE(?, name) WHERE id = ?')
    .run(active !== undefined ? (active ? 1 : 0) : null, name || null, req.params.id);
  res.json(db.prepare('SELECT * FROM themes WHERE id = ?').get(req.params.id));
});

app.delete('/api/themes/:id', (req, res) => {
  db.prepare('DELETE FROM themes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── CONTRIBUTED URLS ────────────────────────────────────────────────────────

app.get('/api/contributed', (req, res) => {
  const urls = db.prepare('SELECT * FROM contributed_urls ORDER BY created_at DESC').all();
  res.json(urls);
});

app.post('/api/contributed', (req, res) => {
  const { url, note } = req.body;
  if (!url && !note) return res.status(400).json({ error: 'url or content required' });
  const effectiveUrl = url || `text://paste-${Date.now()}`;
  const result = db.prepare('INSERT INTO contributed_urls (url, note) VALUES (?, ?)').run(effectiveUrl, note || null);
  res.json(db.prepare('SELECT * FROM contributed_urls WHERE id = ?').get(result.lastInsertRowid));
});

// ─── EPISODES ────────────────────────────────────────────────────────────────

app.get('/api/episodes', (req, res) => {
  const episodes = db.prepare(`
    SELECT e.*, COUNT(s.id) as source_count
    FROM episodes e
    LEFT JOIN sources s ON s.episode_id = e.id
    GROUP BY e.id
    ORDER BY e.number DESC
  `).all();
  res.json(episodes);
});

app.get('/api/episodes/:id', (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Not found' });
  const sources = db.prepare('SELECT * FROM sources WHERE episode_id = ? ORDER BY id').all(req.params.id);
  const feedback = db.prepare('SELECT * FROM feedback WHERE episode_id = ? ORDER BY created_at').all(req.params.id);
  res.json({ ...episode, sources, feedback });
});

// ─── EPISODE STATUS + SCHEDULING ─────────────────────────────────────────────

// PATCH /api/episodes/:id/status
// Body: { status: 'draft' | 'scheduled' | 'published', publish_at: 'YYYY-MM-DD' }
app.patch('/api/episodes/:id/status', (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Not found' });

  const { status, publish_at } = req.body;
  const valid = ['draft', 'scheduled', 'published'];
  if (status && !valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });

  db.prepare('UPDATE episodes SET status = COALESCE(?, status), publish_at = ? WHERE id = ?')
    .run(status || null, publish_at || null, req.params.id);

  console.log(`[status] Episode ${episode.number} → ${status || episode.status}${publish_at ? ` (publish: ${publish_at})` : ''}`);
  if (status === 'published') pingWebSub();
  res.json(db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id));
});

// PATCH /api/episodes/:id/script
// Body: { script: '...', title: '...' }
app.patch('/api/episodes/:id/script', (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Not found' });

  const { script, title } = req.body;
  if (!script && !title) return res.status(400).json({ error: 'script or title required' });

  const wordCount = script ? script.split(/\s+/).length : null;
  const duration = wordCount ? Math.round(wordCount / 150) : null;

  db.prepare('UPDATE episodes SET script = COALESCE(?, script), title = COALESCE(?, title), duration_estimate = COALESCE(?, duration_estimate) WHERE id = ?')
    .run(script || null, title || null, duration, req.params.id);

  console.log(`[script] Episode ${episode.number} script updated`);
  res.json(db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id));

  // Fire-and-forget: summarize what changed vs. original so future episodes can learn
  if (script && episode.original_script && script !== episode.original_script) {
    (async () => {
      try {
        const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `A podcast script was generated by AI and then edited by the host. Summarize in 1-3 sentences what kinds of changes were made — focus on style, tone, structure, and content choices, not specific episode topics. This summary will be used to improve future scripts.

ORIGINAL (AI-generated):
${episode.original_script.substring(0, 3000)}

EDITED (host's version):
${script.substring(0, 3000)}

Write only the summary — no preamble, no headers, no markdown.`
          }]
        });
        const summary = response.content[0].text.trim();
        db.prepare('UPDATE episodes SET edit_summary = ? WHERE id = ?').run(summary, episode.id);
        console.log(`[script] Episode ${episode.number} edit summary saved`);
      } catch (err) {
        console.error('[script] Edit summary generation failed:', err.message);
      }
    })();
  }
});

// ─── EPISODE DELETE ───────────────────────────────────────────────────────────

app.delete('/api/episodes/:id', (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Not found' });
  if (episode.status !== 'draft') return res.status(400).json({ error: 'Only draft episodes can be deleted' });
  db.prepare('DELETE FROM sources WHERE episode_id = ?').run(episode.id);
  db.prepare('DELETE FROM episodes WHERE id = ?').run(episode.id);
  console.log(`[delete] Episode ${episode.number} deleted`);
  res.json({ ok: true });
});

// ─── EPISODE IMPORT (pre-written script from Cowork interview workflow) ───────

app.post('/api/episodes/import', (req, res) => {
  if (!isShowActive()) return res.status(403).json({ error: 'Show is currently inactive.' });

  const { script: rawScript, title, episode_type } = req.body;
  if (!rawScript) return res.status(400).json({ error: 'script required' });

  // Prepend fixed intro and append fixed outro (same as generate flow).
  // .txt files pushed via push-to-railway should contain only the episode body — not the intro/outro.
  const intro = episode_type === 'megan_only' ? INTRO_MEGAN_ONLY : INTRO_DIALOGUE;
  const outro = episode_type === 'megan_only' ? OUTRO_MEGAN_ONLY : OUTRO_DIALOGUE;
  const script = `${intro}\n\n${rawScript}\n\n${outro}`;

  const lastEp = db.prepare('SELECT MAX(number) as n FROM episodes').get();
  const episodeNumber = (lastEp.n || 0) + 1;
  const today = new Date().toISOString().split('T')[0];
  const wordCount = script.split(/\s+/).length;
  const durationEstimate = Math.round(wordCount / 150);

  const result = db.prepare(
    'INSERT INTO episodes (number, date, title, script, duration_estimate, episode_type, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(episodeNumber, today, title || '', script, durationEstimate, episode_type || 'dialogue', 'draft');

  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(result.lastInsertRowid);
  console.log(`[import] Episode ${episodeNumber} imported as draft (${episode_type || 'dialogue'})`);
  res.json(episode);
});

// ─── EPISODE GENERATION ──────────────────────────────────────────────────────

// In-memory job store for async generation
const generationJobs = {};

app.get('/api/episodes/generate/status', (req, res) => {
  const jobs = Object.values(generationJobs);
  const latest = jobs.sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!latest) return res.json({ status: 'idle' });
  res.json(latest);
});

app.post('/api/episodes/generate', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!isShowActive()) return res.status(403).json({ error: 'Show is currently inactive.' });

  const restDay = await isJewishRestDay();
  if (restDay.skip) return res.status(403).json({ error: `No episodes on ${restDay.reason}.` });

  // Check if generation already running
  const running = Object.values(generationJobs).find(j => j.status === 'running');
  if (running) return res.json({ status: 'running', message: 'Generation already in progress' });

  const episodeType = req.body.episode_type || 'megan_only';
  const topic = req.body.topic || null;

  const jobId = Date.now().toString();
  generationJobs[jobId] = { jobId, status: 'running', step: 'Starting...', startedAt: Date.now(), episodeType };

  // Return immediately — client will poll /api/episodes/generate/status
  res.json({ status: 'started', jobId });

  // Run generation in background (fire and forget — client polls status)
  (async () => {
    const job = generationJobs[jobId];
    try {
      const themes = db.prepare('SELECT * FROM themes WHERE active = 1').all();
      if (themes.length === 0) {
        job.status = 'error'; job.error = 'No active themes configured'; return;
      }

      const pendingUrls = db.prepare('SELECT * FROM contributed_urls WHERE used = 0').all();
      const lastEp = db.prepare('SELECT MAX(number) as n FROM episodes').get();
      const episodeNumber = (lastEp.n || 0) + 1;
      const today = new Date().toISOString().split('T')[0];
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

      // Step 1: Discover sources
      job.step = 'Searching for sources...';
      const themeList = themes.map(t => `- ${t.name} (${t.course.replace('_', ' ')})`).join('\n');
      const contributedSection = pendingUrls.length > 0
        ? `\n\nThe following sources have been manually contributed and MUST be included:\n${pendingUrls.map(u => {
            if (u.url.startsWith('text://')) {
              return `- [FULL TEXT PROVIDED — use as a source, do not search for it] ${u.note}`;
            }
            return `- ${u.url}${u.note ? ` (note: ${u.note})` : ''}`;
          }).join('\n')}`
        : '';

      const recentFeedback = db.prepare(`
        SELECT f.note, s.title as source_title, s.url as source_url
        FROM feedback f
        LEFT JOIN sources s ON s.id = f.source_id
        ORDER BY f.created_at DESC
        LIMIT 20
      `).all();
      const feedbackSection = recentFeedback.length > 0
        ? `\n\nRecent listener feedback to inform your source selection:\n${recentFeedback.map(f =>
            f.source_title
              ? `- Re "${f.source_title}" (${f.source_url}): "${f.note}"`
              : `- General note: "${f.note}"`
          ).join('\n')}`
        : '';

      const discoveryPrompt = `You are a research assistant for a UC Berkeley professor who teaches two courses:

1. **Intimate Technology** (an undergrad business course): Explores how technology mediates human intimacy, vulnerability, and connection. Key themes include AI companions, surveillance capitalism, haptic technology, digital intimacy, consent and data, companion robots, policy and regulation of intimate tech, ethics of consequence-free caregiving, identity performance and networked life.

2. **Social Impact Strategy in Commercial Tech** (MBA 290T): Explores how commercial technology companies navigate social impact. Key themes include corporate responsibility, ESG and tech, algorithmic harm, technology policy, ethical product design, stakeholder capitalism, social entrepreneurship in tech, the tension between growth and social good.

Search the web for the 8–12 most important, recent stories and articles published in the last 7 days relevant to these topic themes.

Source quality requirements — strictly apply these:
- PREFER: established news outlets (NYT, Washington Post, The Guardian, The Atlantic, Wired, Bloomberg, Reuters, AP), academic and research publications (Nature, Science, SSRN preprints, university press releases from R1 institutions), and specialist tech/policy outlets (MIT Technology Review, IEEE Spectrum, rest of world, Politico, The Markup, Slate, The Verge for substantive pieces)
- PREFER: articles with a named author or byline
- AVOID: sites without clear author attribution, content farms, SEO aggregators, press-release republishers, sites with excessive advertising, AI-generated content sites
- AVOID: product announcements or marketing copy disguised as news
- AVOID: low-domain-authority blogs or sites you've never heard of
- If a story is only covered by low-quality sources, skip it — wait for a credible outlet to cover it
${themeList}${contributedSection}${feedbackSection}${topic ? `\n\n**Focus area for today:** ${topic}\nPrioritize sources directly relevant to this specific topic. Still apply normal source quality requirements.` : ''}

For each source found, provide a JSON object with:
- title: article/story title
- url: full URL
- summary: 2–3 sentence summary of the key points
- published_date: approximate date (YYYY-MM-DD format if known)
- courses: array of applicable courses — use "intimate_tech", "social_impact", or both
- contributed: boolean (true only if it was in the manually contributed URLs list)

Return ONLY a valid JSON array of source objects. No other text.`;

      let discoveredSources = [];
      try {
        const discoveryResponse = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: discoveryPrompt }]
        });
        let jsonText = '';
        for (const block of discoveryResponse.content) {
          if (block.type === 'text') jsonText += block.text;
        }
        const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
        if (jsonMatch) discoveredSources = JSON.parse(jsonMatch[0]);
      } catch (err) {
        console.error('Discovery error:', err.message);
      }

      if (discoveredSources.length === 0) {
        discoveredSources = pendingUrls.map(u => ({
          title: u.url, url: u.url,
          summary: u.note || 'Manually contributed source.',
          published_date: today,
          courses: ['intimate_tech', 'social_impact'],
          contributed: true
        }));
      }

      // Step 2: Write script
      job.step = `Writing script from ${discoveredSources.length} sources...`;
      const sourcesForScript = discoveredSources.map((s, i) =>
        `[${i + 1}] ${s.title}\nURL: ${s.url}\nSummary: ${s.summary}\nCourses: ${(s.courses || []).join(', ')}`
      ).join('\n\n');

      // Fetch recent titles to avoid repetition
      const recentTitles = db.prepare(
        'SELECT title FROM episodes ORDER BY number DESC LIMIT 10'
      ).all().map(r => r.title).filter(Boolean);
      const recentTitlesBlock = recentTitles.length
        ? `\nRecent episode titles (do NOT reuse these themes or framings — avoid reusing the same nouns, framings, or conceptual hooks):\n${recentTitles.map(t => `- ${t}`).join('\n')}\n`
        : '';

      // Fetch recent episode summaries for narrative continuity
      const recentEpisodeSummaries = db.prepare(
        `SELECT number, title, episode_summary FROM episodes WHERE episode_summary IS NOT NULL ORDER BY number DESC LIMIT 5`
      ).all();
      const narrativeContextBlock = recentEpisodeSummaries.length
        ? `\n\n**Recent episodes (for narrative continuity — build on threads, don't repeat arguments):**\n${recentEpisodeSummaries.reverse().map(e => `- Episode ${e.number} (${e.title}): ${e.episode_summary}`).join('\n')}`
        : '';

      // Fetch edit summaries from past episodes — Adam's edits are signal about his preferences
      const editSummaries = db.prepare(
        `SELECT number, edit_summary FROM episodes WHERE edit_summary IS NOT NULL ORDER BY number DESC LIMIT 5`
      ).all();
      const editLearningBlock = editSummaries.length
        ? `\n\n**What Adam has changed in past AI-generated scripts (apply these lessons):**\n${editSummaries.map(e => `- Episode ${e.number}: ${e.edit_summary}`).join('\n')}`
        : '';

      const scriptPrompt = `You are the host of a daily podcast briefing for a UC Berkeley Haas professor named Adam. Adam teaches two courses:

1. **Intimate Technology** — how technology mediates human intimacy, vulnerability, and connection
2. **Social Impact Strategy in Commercial Tech** — how commercial tech companies navigate social impact, intentionally and otherwise

Both courses share territory: how technology affects vulnerable populations, how business models shape social outcomes, and where ethics and commercial incentives collide.

Write a podcast script for today's briefing (Episode ${episodeNumber}, ${today}) using the following sources.${topic ? ` Today's episode should center on: **${topic}**. Let this be the organizing thread — weave other sources around it, but keep this the focus.` : ''} The script should:
- Be 10–50 minutes when read aloud
- Sound like a well-produced, intelligent daily briefing — natural spoken voice, not a list of summaries
- Don't be afraid to be academic in your language — Adam values precision and abhors platitudes
- Have a clear narrative thread that weaves stories together, especially where they span both courses
- Explicitly name the conceptual connections between stories when relevant
- Open with a brief orienting sentence about today's themes, not a generic intro
- Close with a brief forward-looking thought or question to sit with
- Reference sources naturally by name/outlet, not by number
- Do NOT include any host introduction or show intro — that is handled separately and will be prepended. Begin immediately with the episode content.
- Do NOT include any outro or sign-off — that is handled separately and will be appended. End with your episode-specific closing thought or question only.
- Do NOT start with "Welcome" or "Hello" — open in medias res with a brief orienting sentence about today's themes
- For dialogue episodes, the body MUST begin with ADAM (not MEGAN) — Megan's intro is already prepended, so starting with MEGAN creates two consecutive Megan paragraphs

**Tone and intellectual stance — this is critical:**
- Be neither techno-optimist nor techno-pessimist. Do not editorialize in either direction.
- Treat technology as neither inherently liberating nor inherently harmful — its effects depend on design choices, power structures, incentives, and context.
- When evidence points in multiple directions, say so. Acknowledge genuine uncertainty rather than forcing a clean narrative.
- Hold companies, researchers, and policymakers accountable to the evidence — but do not assume bad faith where incompetence or structural incentives are a sufficient explanation.
- Do not moralize. Present tensions and tradeoffs clearly and let the listener draw their own conclusions.
- The goal is rigorous, intellectually honest analysis — the kind a thoughtful academic would be proud to assign.

**Writing Adam's lines — dialogue episodes:**
- Adam is a professor but he talks like a person. His lines should sound like office hours, not a lecture.
- Use contractions always. Use sentence fragments when natural. Let him interrupt himself or revise mid-thought.
- He swears casually when it fits — "shit," "fucking," "damn" — not for shock value, just because that's how he talks.
- He's direct and sometimes blunt. He doesn't soften things unnecessarily.
- He gets excited and occasionally goes deep into a tangent or a weedy technical detail before catching himself.
- Examples of the register: "Yeah, and that's the part that actually concerns me." / "I mean, shit — if that's the tradeoff they're making..." / "Look, I think they're wrong about this, and here's why." / "Okay wait, I'm getting into the weeds — the point is..."
- Avoid: formal transitions ("Furthermore,"), academic hedging ("One might argue"), and anything that sounds like written prose being read aloud.

**Writing Megan's lines — dialogue episodes:**
- Megan is the straight voice. Clear, grounded, and always the listener's advocate — her job is to ask the question the listener is sitting with and keep the conversation on track.
- With listeners she's warm and direct. They should always feel like she's on their side, not playing a role.
- With Adam she has a dry wit. When he goes off on a tangent, gets too excited, or disappears into the weeds, she reels him back in — patiently, with light humor. Not impatient, not dismissive. Just: "okay, yeah, but..."
- She doesn't moralize or editorialize. She's dry, not earnest. Smart, not smug.
- Examples of the register: "Okay, but what does that actually mean for a normal person?" / "You're spiraling a little — bring it back." / "I love the energy, but you lost me at 'regulatory preemption.'" / "So the short version is...?" / "Right, but the lawsuit part — that's where it gets real."
- Avoid: making Megan a hype machine or a yes-and bot. She pushes back. She clarifies. She's a co-host, not a straight man.

Sources for today:
${sourcesForScript}
${narrativeContextBlock}${editLearningBlock}${feedbackSection}

**Script format rules — strictly required for dialogue episodes:**
- Every line of spoken content must begin with either "MEGAN:" or "ADAM:" — no exceptions
- No unlabeled narrative paragraphs, no stage directions, no markdown formatting
- Use plain text only — no **bold**, no *italics*, no headers
- Speaker labels are plain uppercase with a colon: "MEGAN:" and "ADAM:" — not "**MEGAN**:" or "**Adam**:"
- Example of correct format:
  MEGAN: Here's the situation.
  ADAM: Right, and what's striking is...
  MEGAN: Exactly — so the question becomes...

Return a JSON object with exactly three fields:
- "title": a short, punchy 4–7 word title capturing today's central theme. Must be distinct from any recent episode titles — avoid reusing the same nouns, framings, or conceptual hooks.${recentTitlesBlock}
- "script": the full podcast script text
- "used_source_indices": a JSON array of 0-based indices (into the sources list above) that you actually referenced or drew from in the script. Only include sources that materially informed the episode content. This controls what appears in show notes.

Example format:
{"title": "When Convenience Becomes Surveillance", "script": "ADAM: Quick one today...\nMEGAN: Let's get into it.", "used_source_indices": [0, 2, 4, 5]}`;

      const scriptResponse = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: scriptPrompt }]
      });
      const rawResponse = scriptResponse.content[0].text.trim();
      let script, episodeTitle;
      try {
        const jsonText = rawResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        const parsed = JSON.parse(jsonText);
        script = parsed.script || rawResponse;
        episodeTitle = parsed.title || '';
        if (Array.isArray(parsed.used_source_indices)) {
          const usedSet = new Set(parsed.used_source_indices);
          discoveredSources = discoveredSources.filter((_, i) => usedSet.has(i));
        }
      } catch (_) {
        script = rawResponse;
        episodeTitle = '';
      }

      // Append date to title: "Title · Month DD, YYYY"
      const dateLabel = new Date(today + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      if (episodeTitle) episodeTitle = `${episodeTitle} · ${dateLabel}`;

      // Normalize speaker labels — strip markdown bold and fix common variants
      script = script
        .replace(/\*\*(MEGAN|ADAM)\*\*\s*:/g, '$1:')   // **MEGAN**: → MEGAN:
        .replace(/\*\*(Megan|Adam)\*\*\s*:/g, (_, n) => n.toUpperCase() + ':') // **Megan**: → MEGAN:
        .replace(/^(Megan|Adam)\s*:/gm, (_, n) => n.toUpperCase() + ':');      // Megan: → MEGAN:

      // Prepend fixed intro and append fixed outro
      const intro = episodeType === 'dialogue' ? INTRO_DIALOGUE : INTRO_MEGAN_ONLY;
      const outro = episodeType === 'dialogue' ? OUTRO_DIALOGUE : OUTRO_MEGAN_ONLY;
      script = `${intro}\n\n${script}\n\n${outro}`;

      const wordCount = script.split(/\s+/).length;
      const durationEstimate = Math.round(wordCount / 150);

      // Step 3: Save to DB
      job.step = 'Saving episode...';
      const epResult = db.prepare(
        'INSERT INTO episodes (number, date, title, script, original_script, duration_estimate, episode_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, \'draft\')'
      ).run(episodeNumber, today, episodeTitle, script, script, durationEstimate, episodeType);
      const episodeId = epResult.lastInsertRowid;

      const insertSource = db.prepare(
        'INSERT INTO sources (episode_id, title, url, summary, published_date, courses, contributed) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      db.exec('BEGIN');
      try {
        for (const s of discoveredSources) {
          insertSource.run(episodeId, s.title || 'Untitled', s.url || null,
            s.summary || null, s.published_date || today,
            JSON.stringify(s.courses || []), s.contributed ? 1 : 0);
        }
        db.exec('COMMIT');
      } catch (txErr) { db.exec('ROLLBACK'); throw txErr; }

      if (pendingUrls.length > 0) {
        const markUsed = db.prepare('UPDATE contributed_urls SET used = 1, episode_id = ? WHERE id = ?');
        for (const u of pendingUrls) markUsed.run(episodeId, u.id);
      }
      db.prepare('UPDATE episodes SET source_count = ? WHERE id = ?').run(discoveredSources.length, episodeId); // discoveredSources already filtered to cited-only

      const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
      job.status = 'complete';
      job.step = 'Done';
      job.episodeId = Number(episodeId);
      job.episode = episode;

      // Fire-and-forget: summarize episode content for cross-episode narrative memory
      (async () => {
        try {
          const summaryClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
          const summaryResponse = await summaryClient.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 250,
            messages: [{
              role: 'user',
              content: `Summarize this podcast episode in no more than 3 sentences. Focus on the central arguments, conceptual frames, and thematic territory covered — not the specific news stories. This summary will be used to give future episodes context about what the show has already explored.

SCRIPT:
${script.substring(0, 4000)}

Write only the summary — no preamble, no headers, no markdown. Do not begin with "Summary:" or any label.`
            }]
          });
          let epSummary = summaryResponse.content[0].text.trim().replace(/^#+\s*summary[:\s\-—]*/i, '').replace(/^summary[:\s\-—]*/i, '').trim();
          db.prepare('UPDATE episodes SET episode_summary = ? WHERE id = ?').run(epSummary, episodeId);
          console.log(`[generate] Episode ${episodeNumber} narrative summary saved`);
          // Auto-generate show notes now that summary + sources are both saved
          const show_notes = buildShowNotes(episodeId, epSummary);
          db.prepare('UPDATE episodes SET show_notes = ? WHERE id = ?').run(show_notes, episodeId);
          console.log(`[generate] Episode ${episodeNumber} show notes saved`);
        } catch (err) {
          console.error('[generate] Episode summary generation failed:', err.message);
        }
      })();

      // Compile all scripts into Adam's Context running log
      try {
        const { compileScripts } = require('./compile-scripts');
        compileScripts();
      } catch (compileErr) {
        console.error('[compile-scripts] Error during auto-compile:', compileErr.message);
      }
    } catch (err) {
      console.error('Generation error:', err);
      generationJobs[jobId].status = 'error';
      generationJobs[jobId].error = err.message;
    }
  })();
});

// ─── AUDIO GENERATION ────────────────────────────────────────────────────────

// In-memory job store for audio generation
const audioJobs = {};

app.get('/api/episodes/:id/audio/status', (req, res) => {
  const job = Object.values(audioJobs)
    .filter(j => j.episodeId === req.params.id)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!job) return res.json({ status: 'idle' });
  res.json(job);
});

app.post('/api/episodes/:id/audio', async (req, res) => {
  if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
  if (!ELEVENLABS_VOICE_ID) return res.status(500).json({ error: 'ELEVENLABS_VOICE_ID not configured' });
  if (!isShowActive()) return res.status(403).json({ error: 'Show is currently inactive.' });

  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Episode not found' });
  if (!episode.script) return res.status(400).json({ error: 'Episode has no script' });

  // Cancel any running job for this episode so regeneration always uses the latest script
  Object.values(audioJobs)
    .filter(j => j.episodeId === req.params.id && j.status === 'running')
    .forEach(j => { j.status = 'cancelled'; });

  const jobId = Date.now().toString();
  audioJobs[jobId] = { jobId, episodeId: req.params.id, status: 'running', step: 'Connecting to ElevenLabs...', startedAt: Date.now() };

  // Return immediately — client polls /api/episodes/:id/audio/status
  res.json({ status: 'started', jobId });

  (async () => {
    const job = audioJobs[jobId];
    try {
      // Re-read episode from DB so we always get the latest saved script,
      // not the snapshot captured at request time.
      const freshEpisode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episode.id);
      if (!freshEpisode || !freshEpisode.script) throw new Error('Episode or script not found');

      const audioFilename = `episode-${freshEpisode.number}-${freshEpisode.date}.mp3`;
      const audioPath = path.join(AUDIO_DIR, audioFilename);

      job.step = 'Generating audio with ElevenLabs...';

      let audioData;

      if (freshEpisode.episode_type === 'dialogue' && ELEVENLABS_ADAM_VOICE_ID) {
        // ── Two-speaker dialogue: chunked to stay under 5000-char API limit ──
        const turns = parseDialogue(freshEpisode.script);
        if (turns.length === 0) throw new Error('No dialogue turns found in script');

        const chunks = chunkTurns(turns);
        console.log(`[audio] ${chunks.length} chunk(s) for episode ${freshEpisode.number}`);

        const buffers = [];
        for (let i = 0; i < chunks.length; i++) {
          job.step = `Generating audio chunk ${i + 1}/${chunks.length}...`;
          const response = await axios.post(
            'https://api.elevenlabs.io/v1/text-to-dialogue',
            {
              inputs: chunks[i].map(t => ({
                text: t.text,
                voice_id: t.speaker === 'ADAM' ? ELEVENLABS_ADAM_VOICE_ID : ELEVENLABS_VOICE_ID
              })),
              model_id: 'eleven_v3',
              output_format: 'mp3_44100_128'
            },
            {
              headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
              responseType: 'arraybuffer',
              timeout: 300000
            }
          );
          buffers.push(Buffer.from(response.data));
        }
        // Strip ID3v2 headers from all chunks after the first — otherwise the
        // browser reads only the first chunk's duration from its ID3v2 header.
        function stripId3v2(buf) {
          if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) { // 'ID3'
            const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
                         ((buf[8] & 0x7f) << 7)  |  (buf[9] & 0x7f);
            return buf.slice(10 + size);
          }
          return buf;
        }
        audioData = Buffer.concat([buffers[0], ...buffers.slice(1).map(stripId3v2)]);
      } else {
        // ── Single-voice monologue: use text-to-speech endpoint ──────────────
        const response = await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
          {
            text: freshEpisode.script,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
          },
          {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
            responseType: 'arraybuffer',
            timeout: 300000
          }
        );
        audioData = response.data;
      }

      // Abort if a newer job cancelled this one while ElevenLabs was running
      if (job.status === 'cancelled') {
        console.log(`[audio] Job ${jobId} was cancelled — discarding output.`);
        return;
      }

      job.step = 'Saving audio file...';
      const audioBuffer = Buffer.from(audioData);
      fs.writeFileSync(audioPath, audioBuffer);
      // 128 kbps = 16000 bytes/sec — compute actual duration from buffer length
      const audioDurationSeconds = Math.round(audioBuffer.length / 16000);
      db.prepare('UPDATE episodes SET audio_filename = ?, audio_duration_seconds = ? WHERE id = ?')
        .run(audioFilename, audioDurationSeconds, freshEpisode.id);

      job.status = 'complete';
      job.step = 'Done';
      job.audio_url = `/audio/${audioFilename}`;
      job.filename = audioFilename;
    } catch (err) {
      console.error('Audio generation error:', err.response?.data || err.message);
      job.status = 'error';
      job.error = err.response?.data?.detail?.message || err.message;
    }
  })();
});

// ─── SOURCES ─────────────────────────────────────────────────────────────────

app.get('/api/sources', (req, res) => {
  const { q, course, episode_id, from_date } = req.query;
  let query = `SELECT s.*, e.number as episode_number, e.date as episode_date,
    COUNT(f.id) as note_count,
    GROUP_CONCAT(f.note, '|||') as notes
    FROM sources s
    LEFT JOIN episodes e ON e.id = s.episode_id
    LEFT JOIN feedback f ON f.source_id = s.id
    WHERE 1=1`;
  const params = [];

  if (q) {
    query += ' AND (s.title LIKE ? OR s.summary LIKE ? OR s.url LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (course) {
    query += ' AND s.courses LIKE ?';
    params.push(`%${course}%`);
  }
  if (episode_id) {
    query += ' AND s.episode_id = ?';
    params.push(episode_id);
  }
  if (from_date) {
    query += ' AND s.published_date >= ?';
    params.push(from_date);
  }

  query += ' GROUP BY s.id ORDER BY s.published_date DESC, s.created_at DESC';
  const sources = db.prepare(query).all(...params);

  const parsed = sources.map(s => ({ ...s, courses: JSON.parse(s.courses || '[]') }));
  res.json(parsed);
});

// POST /api/episodes/:id/sources — add a manual source to an episode
app.post('/api/episodes/:id/sources', requireAuth, (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Not found' });
  const { title, url, summary, published_date } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const result = db.prepare(
    'INSERT INTO sources (episode_id, title, url, summary, published_date, courses, contributed) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(episode.id, title || url, url, summary || null, published_date || null, '[]', 0);
  db.prepare('UPDATE episodes SET source_count = source_count + 1 WHERE id = ?').run(episode.id);
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(result.lastInsertRowid);
  res.json(source);
});

// POST /api/episodes/:id/sources/discover
// Runs web search based on episode script and saves discovered sources
app.delete('/api/sources/:id', (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/episodes/:id/summarize', async (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Not found' });
  if (!episode.script) return res.status(400).json({ error: 'No script to summarize' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Summarize this podcast episode in no more than 3 sentences. Focus on the central arguments, conceptual frames, and thematic territory covered — not the specific news stories. This summary will be used as the episode description in podcast apps and to give future episodes context about what the show has already explored.

SCRIPT:
${episode.script.substring(0, 4000)}

Write only the summary — no preamble, no headers, no markdown. Do not begin with "Summary:" or any label.`
      }]
    });
    const summary = response.content[0].text.trim().replace(/^#+\s*summary[:\s\-—]*/i, '').replace(/^summary[:\s\-—]*/i, '').trim();
    db.prepare('UPDATE episodes SET episode_summary = ? WHERE id = ?').run(summary, episode.id);
    console.log(`[summarize] Episode ${episode.number} summary saved`);
    res.json({ ok: true, episode_summary: summary });
  } catch (err) {
    console.error('[summarize]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: notify WebSub hub so Apple Podcasts re-fetches the feed promptly
async function pingWebSub() {
  const feedUrl = `${process.env.BASE_URL}/feed.xml`;
  try {
    await axios.post('https://pubsubhubbub.appspot.com/',
      new URLSearchParams({ 'hub.mode': 'publish', 'hub.url': feedUrl }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    console.log('[websub] Hub pinged successfully');
  } catch (err) {
    console.error('[websub] Ping failed (non-blocking):', err.message);
  }
}

// Helper: assemble show notes HTML from episode_summary + sources
function buildShowNotes(episodeId, episodeSummary) {
  const summaryHtml = episodeSummary
    ? `<p>${episodeSummary.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`
    : '';
  const sources = db.prepare('SELECT title, url FROM sources WHERE episode_id = ? AND url IS NOT NULL ORDER BY id').all(episodeId)
    .filter(s => /^https?:\/\//i.test(s.url));
  const sourcesHtml = sources.length > 0
    ? `<h3>Sources</h3><ul>${sources.map(s => `<li><a href="${s.url.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">${(s.title || s.url).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</a></li>`).join('')}</ul>`
    : '';
  return summaryHtml + (sourcesHtml ? '<br>' + sourcesHtml : '');
}

// POST /api/episodes/:id/show-notes/generate — assemble and save show notes
app.post('/api/episodes/:id/show-notes/generate', requireAuth, (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Not found' });
  const show_notes = buildShowNotes(episode.id, episode.episode_summary);
  db.prepare('UPDATE episodes SET show_notes = ? WHERE id = ?').run(show_notes, episode.id);
  res.json({ ok: true, show_notes });
});

// PATCH /api/episodes/:id/show-notes — save manual edits
app.patch('/api/episodes/:id/show-notes', requireAuth, (req, res) => {
  const episode = db.prepare('SELECT id FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Not found' });
  const { show_notes } = req.body;
  if (typeof show_notes !== 'string') return res.status(400).json({ error: 'show_notes must be a string' });
  db.prepare('UPDATE episodes SET show_notes = ? WHERE id = ?').run(show_notes, episode.id);
  res.json({ ok: true });
});

app.post('/api/episodes/:id/sources/discover', async (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Not found' });
  if (!episode.script) return res.status(400).json({ error: 'Episode has no script' });

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const today = new Date().toISOString().split('T')[0];

    const discoveryPrompt = `You are a research assistant. The following is a podcast script discussing recent news and topics in technology, ethics, and social impact. Your job is to find the actual sources this script is based on, or the most authoritative recent sources covering the same stories.

Search the web to find 6–12 high-quality sources that match what's discussed in this script. For each source found, provide a JSON object with:
- title: article/story title
- url: full URL
- summary: 2–3 sentence summary of the key points
- published_date: approximate date (YYYY-MM-DD format if known, otherwise use "${today}")
- courses: array using "intimate_tech", "social_impact", or both — based on the topics covered

Source quality requirements:
- PREFER: established news outlets (NYT, Washington Post, The Guardian, The Atlantic, Wired, Bloomberg, Reuters, AP), academic and research publications, specialist tech/policy outlets (MIT Technology Review, IEEE Spectrum, rest of world, Politico, The Markup, The Verge for substantive pieces)
- AVOID: content farms, SEO aggregators, press-release republishers, AI-generated content sites

PODCAST SCRIPT:
${episode.script.substring(0, 6000)}

Return ONLY a valid JSON array of source objects. No other text.`;

    const discoveryResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: discoveryPrompt }]
    });

    let jsonText = '';
    for (const block of discoveryResponse.content) {
      if (block.type === 'text') jsonText += block.text;
    }
    const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(500).json({ error: 'Source discovery returned no results' });

    const discovered = JSON.parse(jsonMatch[0]);

    const insertSource = db.prepare(
      'INSERT INTO sources (episode_id, title, url, summary, published_date, courses, contributed) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    db.exec('BEGIN');
    try {
      for (const s of discovered) {
        insertSource.run(episode.id, s.title || 'Untitled', s.url || null,
          s.summary || null, s.published_date || today,
          JSON.stringify(s.courses || []), 0);
      }
      db.exec('COMMIT');
    } catch (txErr) { db.exec('ROLLBACK'); throw txErr; }

    db.prepare('UPDATE episodes SET source_count = source_count + ? WHERE id = ?').run(discovered.length, episode.id);

    const sources = db.prepare('SELECT * FROM sources WHERE episode_id = ? ORDER BY id').all(episode.id);
    res.json({ discovered: discovered.length, sources });
  } catch (err) {
    console.error('[discover sources]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── FEEDBACK ────────────────────────────────────────────────────────────────

app.get('/api/feedback', (req, res) => {
  const { episode_id, source_id } = req.query;
  let query = 'SELECT f.*, s.title as source_title FROM feedback f LEFT JOIN sources s ON s.id = f.source_id WHERE 1=1';
  const params = [];
  if (episode_id) { query += ' AND f.episode_id = ?'; params.push(episode_id); }
  if (source_id) { query += ' AND f.source_id = ?'; params.push(source_id); }
  query += ' ORDER BY f.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/feedback', (req, res) => {
  const { note, source_id, episode_id } = req.body;
  if (!note) return res.status(400).json({ error: 'note required' });
  const result = db.prepare('INSERT INTO feedback (note, source_id, episode_id) VALUES (?, ?, ?)')
    .run(note, source_id || null, episode_id || null);
  res.json(db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid));
});

// ─── VOICES (ElevenLabs) ─────────────────────────────────────────────────────

app.get('/api/voices', async (req, res) => {
  if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
  try {
    const response = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY }
    });
    res.json(response.data.voices.map(v => ({ voice_id: v.voice_id, name: v.name, category: v.category })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    voice_id: ELEVENLABS_VOICE_ID,
    has_anthropic: !!ANTHROPIC_API_KEY,
    has_elevenlabs: !!ELEVENLABS_API_KEY
  });
});

// ─── EPISODE TRANSCRIPT ──────────────────────────────────────────────────────
// Public endpoint — Apple Podcasts fetches this URL from the RSS feed.

app.get('/episodes/:id/transcript', (req, res) => {
  const episode = db.prepare('SELECT script, title FROM episodes WHERE id = ? AND status = ?').get(req.params.id, 'published');
  if (!episode || !episode.script) return res.status(404).send('Not found');

  // Format as HTML — Apple Podcasts requires text/html, text/vtt, or SRT.
  // We have no timestamps so HTML is the only viable option.
  const lines = episode.script.split('\n').filter(l => l.trim());
  const html = lines.map(line => {
    const m = line.match(/^(ADAM|MEGAN):\s*"?(.*?)"?\s*$/s);
    if (m) return `<p><strong>${m[1]}:</strong> ${m[2].replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    return `<p>${line.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
  }).join('\n');

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><body>${html}</body></html>`);
});

// ─── RSS FEED (Apple Podcasts compatible) ────────────────────────────────────

app.get('/feed.xml', (req, res) => {
  const BASE_URL = process.env.BASE_URL || `https://${req.headers.host}`;
  const episodes = db.prepare(`
    SELECT * FROM episodes WHERE audio_filename IS NOT NULL AND status = 'published' ORDER BY number DESC
  `).all();

  // Fix double-encoded UTF-8 characters that can appear in stored strings
  const fixEncoding = (str = '') => str
    .replace(/Â·/g, '·')
    .replace(/â€™/g, '’')
    .replace(/â€œ/g, '“')
    .replace(/â€/g, '”')
    .replace(/â€“/g, '–')
    .replace(/â€”/g, '—');

  const escXml = (str = '') => fixEncoding(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const items = episodes.map(ep => {
    const audioUrl = `${BASE_URL}/audio/${ep.audio_filename}`;
    const audioPath = path.join(AUDIO_DIR, ep.audio_filename);
    const audioSize = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
    const pubDate = new Date(ep.date).toUTCString();
    // Prefer measured duration, then derive from file size (128kbps), then fall back to word-count estimate
    const duration = ep.audio_duration_seconds
      ? ep.audio_duration_seconds
      : audioSize > 0
        ? Math.round(audioSize / 16000)
        : ep.duration_estimate
          ? ep.duration_estimate * 60
          : 0;
    // Use episode_summary if available, otherwise fall back to the episode title.
    // Never use a raw script excerpt — it always starts with hardcoded intro lines.
    const summaryText = ep.episode_summary
      ? fixEncoding(ep.episode_summary)
      : fixEncoding(ep.title || `Episode ${ep.number}`);
    const description = escXml(summaryText);

    // Use stored show_notes if present (editable QC artifact); otherwise assemble dynamically for old episodes
    const showNotesContent = ep.show_notes
      ? fixEncoding(ep.show_notes)
      : buildShowNotes(ep.id, ep.episode_summary ? fixEncoding(ep.episode_summary) : null);
    const showNotes = `<![CDATA[${showNotesContent}]]>`;

    return `
    <item>
      <title>${escXml(ep.title || `Episode ${ep.number}`)}</title>
      <description>${description}</description>
      <content:encoded>${showNotes}</content:encoded>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${audioUrl}" length="${audioSize}" type="audio/mpeg"/>
      <guid isPermaLink="false">${BASE_URL}/episodes/${ep.id}</guid>
      <itunes:duration>${duration}</itunes:duration>
      <itunes:episode>${ep.number}</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>true</itunes:explicit>
      <itunes:image href="${BASE_URL}/podcast_cover_megan4.jpg?v=4"/>
      <podcast:transcript url="${BASE_URL}/episodes/${ep.id}/transcript" type="text/html"/>
    </item>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/modules/content/"
  xmlns:podcast="https://podcastindex.org/namespace/1.0"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <atom:link rel="self" href="${BASE_URL}/feed.xml" type="application/rss+xml"/>
    <atom:link rel="hub" href="https://pubsubhubbub.appspot.com/"/>
    <title>The Overhang</title>
    <description>The overhang is the space between what technology can do and what society can handle. Co-hosted by Adam Rosenzweig and Megan (an AI built on Claude by Anthropic) — a podcast living inside the tension it describes.</description>
    <link>${BASE_URL}</link>
    <language>en-us</language>
    <itunes:author>Adam Rosenzweig</itunes:author>
    <itunes:email>adam.lev.rosenzweig@gmail.com</itunes:email>
    <itunes:category text="Education"/>
    <itunes:image href="${BASE_URL}/podcast_cover_megan4.jpg?v=4"/>
    <image><url>${BASE_URL}/podcast_cover_megan4.jpg?v=4</url><title>The Overhang</title><link>${BASE_URL}</link></image>
    <itunes:explicit>true</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    ${items}
  </channel>
</rss>`;

  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
});

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── AUTO-PUBLISH CRON ───────────────────────────────────────────────────────
// Runs daily at midnight Pacific. Publishes any scheduled episode whose
// publish_at date is today or earlier.

cron.schedule('0 0 * * *', async () => {
  const today = new Date().toISOString().split('T')[0];
  const due = db.prepare(
    "SELECT * FROM episodes WHERE status = 'scheduled' AND publish_at <= ?"
  ).all(today);

  if (due.length === 0) {
    console.log('[auto-publish] No episodes due today.');
    return;
  }

  for (const ep of due) {
    db.prepare("UPDATE episodes SET status = 'published' WHERE id = ?").run(ep.id);
    console.log(`[auto-publish] Episode ${ep.number} published (was scheduled for ${ep.publish_at})`);
  }
}, { timezone: 'America/Los_Angeles' });

console.log('[auto-publish] Midnight publish cron scheduled (Pacific time)');

// ─── MEGAN-ONLY FALLBACK CRON ────────────────────────────────────────────────
// Runs daily at 9:00 AM Pacific. Fires if no episode has been published in
// the last 3 days — guaranteeing a maximum gap of ~4 days between episodes.
// Generates a Megan-only episode, waits for audio, then auto-publishes.

cron.schedule('0 9 * * 0-5', async () => {
  console.log('[cron] Running fallback check at', new Date().toISOString());

  if (!isShowActive()) {
    console.log('[cron] Show inactive, skipping.');
    return;
  }

  const restDay = await isJewishRestDay();
  if (restDay.skip) {
    console.log(`[cron] Skipping — ${restDay.reason}.`);
    return;
  }

  const now = new Date();

  const lastPublished = db.prepare(
    "SELECT MAX(date) as d FROM episodes WHERE status = 'published'"
  ).get();

  const daysSinceAny = lastPublished.d
    ? (now - new Date(lastPublished.d)) / (1000 * 60 * 60 * 24)
    : 999;

  console.log(`[cron] Days since last published episode: ${daysSinceAny.toFixed(1)}`);

  if (daysSinceAny <= 3) {
    console.log('[cron] Fallback not needed, skipping.');
    return;
  }

  console.log('[cron] Fallback triggered — generating Megan-only episode.');

  const port = process.env.PORT || 3000;
  const base = `http://localhost:${port}`;

  try {
    await axios.post(`${base}/api/episodes/generate`, { episode_type: 'megan_only' });
    console.log('[cron] Fallback generation started, polling...');

    let episodeId = null;
    const genDeadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < genDeadline) {
      await new Promise(r => setTimeout(r, 15000));
      const { data } = await axios.get(`${base}/api/episodes/generate/status`);
      console.log('[cron] Generation status:', data.status, data.step || '');
      if (data.status === 'error') { console.error('[cron] Generation failed:', data.error); return; }
      if (data.status === 'complete') { episodeId = data.episodeId; break; }
    }
    if (!episodeId) { console.error('[cron] Generation timed out.'); return; }

    await axios.post(`${base}/api/episodes/${episodeId}/audio`, {});

    const audioDeadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < audioDeadline) {
      await new Promise(r => setTimeout(r, 20000));
      const { data } = await axios.get(`${base}/api/episodes/${episodeId}`);
      if (data.audio_filename) {
        console.log('[cron] Fallback audio ready:', data.audio_filename);
        await axios.patch(`${base}/api/episodes/${episodeId}/status`, { status: 'published' });
        console.log('[cron] Fallback episode published.');
        return;
      }
    }
    console.error('[cron] Audio generation timed out.');
  } catch (err) {
    console.error('[cron] Fallback cron failed:', err.message);
  }
}, {
  timezone: 'America/Los_Angeles'
});

console.log('[cron] Megan-only fallback cron scheduled: 9:00 AM Pacific, Sun–Fri, skipping Jewish holidays');

// One-time migration: re-summarize all episodes + regenerate show notes
app.post('/api/admin/migrate/resync-summaries', requireAuth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const episodes = db.prepare('SELECT * FROM episodes WHERE script IS NOT NULL ORDER BY date ASC').all();
  const results = { updated: 0, errors: [] };
  for (const ep of episodes) {
    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [{
          role: 'user',
          content: `Summarize this podcast episode in no more than 3 sentences. Focus on the central arguments, conceptual frames, and thematic territory covered — not the specific news stories. This summary will be used as the episode description in podcast apps and to give future episodes context about what the show has already explored.

SCRIPT:
${ep.script.substring(0, 4000)}

Write only the summary — no preamble, no headers, no markdown. Do not begin with "Summary:" or any label.`
        }]
      });
      const summary = response.content[0].text.trim().replace(/^#+\s*summary[:\s\-—]*/i, '').replace(/^summary[:\s\-—]*/i, '').trim();
      db.prepare('UPDATE episodes SET episode_summary = ? WHERE id = ?').run(summary, ep.id);
      const show_notes = buildShowNotes(ep.id, summary);
      db.prepare('UPDATE episodes SET show_notes = ? WHERE id = ?').run(show_notes, ep.id);
      results.updated++;
      console.log(`[resync-summaries] Episode ${ep.id} updated`);
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[resync-summaries] Episode ${ep.id} failed:`, err.message);
      results.errors.push({ episode_id: ep.id, error: err.message });
    }
  }
  res.json(results);
});

app.listen(PORT, () => {
  console.log(`Podcast Briefing server running on port ${PORT}`);
});
