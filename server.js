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

const INTRO_DIALOGUE = `ADAM: "I'm Adam Rosenzweig — I teach courses at UC Berkeley Haas about the social impacts of technology and how we can build a more human-centered future. This show is where I think out loud about what's happening in that space."
MEGAN: "And I'm Megan — Adam's AI co-host. My voice is synthetic, courtesy of ElevenLabs. The scripts are written by Adam and Claude, grounded in Adam's research, his courses at UC Berkeley Haas, and his own opinions. We verify every source we cite, but we're not infallible — if something sounds off, it's worth checking. Now, here's what's on our radar."`;

const INTRO_MEGAN_ONLY = `"I'm Megan — Adam's AI co-host. My voice is synthetic, courtesy of ElevenLabs. The scripts are written by Adam and Claude, grounded in Adam's research, his courses at UC Berkeley Haas, and his own opinions. Adam's out today, so I'm flying solo — but the content, as always, reflects his thinking. We verify every source we cite, but we're not infallible — if something sounds off, it's worth checking. Now, here's what's on our radar."`;

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
  res.json({ show_active: isShowActive() });
});

app.post('/api/settings/active', (req, res) => {
  const { active } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('show_active', ?)").run(active ? '1' : '0');
  console.log(`[settings] show_active set to ${active ? 'true' : 'false'}`);
  res.json({ ok: true, show_active: !!active });
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Auth guard — exempts RSS feed and audio (needed by podcast apps)
app.use((req, res, next) => {
  if (req.path === '/feed.xml' || req.path.startsWith('/audio/')) return next();
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));
app.use('/audio', express.static(AUDIO_DIR));

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
  if (!url) return res.status(400).json({ error: 'url required' });
  const result = db.prepare('INSERT INTO contributed_urls (url, note) VALUES (?, ?)').run(url, note || null);
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
});

// ─── EPISODE IMPORT (pre-written script from Cowork interview workflow) ───────

app.post('/api/episodes/import', (req, res) => {
  if (!isShowActive()) return res.status(403).json({ error: 'Show is currently inactive.' });

  const { script, title, episode_type } = req.body;
  if (!script) return res.status(400).json({ error: 'script required' });

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
        ? `\n\nThe following URLs have been manually contributed and MUST be included as sources:\n${pendingUrls.map(u => `- ${u.url}${u.note ? ` (note: ${u.note})` : ''}`).join('\n')}`
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
${themeList}${contributedSection}${feedbackSection}

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

      const scriptPrompt = `You are the host of a daily podcast briefing for a UC Berkeley Haas professor named Adam. Adam teaches two courses:

1. **Intimate Technology** — how technology mediates human intimacy, vulnerability, and connection
2. **Social Impact Strategy in Commercial Tech** — how commercial tech companies navigate social impact, intentionally and otherwise

Both courses share territory: how technology affects vulnerable populations, how business models shape social outcomes, and where ethics and commercial incentives collide.

Write a podcast script for today's briefing (Episode ${episodeNumber}, ${today}) using the following sources. The script should:
- Be 10–50 minutes when read aloud
- Sound like a well-produced, intelligent daily briefing — natural spoken voice, not a list of summaries
- Don't be afraid to be academic in your language — Adam values precision and abhors platitudes
- Have a clear narrative thread that weaves stories together, especially where they span both courses
- Explicitly name the conceptual connections between stories when relevant
- Open with a brief orienting sentence about today's themes, not a generic intro
- Close with a brief forward-looking thought or question to sit with
- Reference sources naturally by name/outlet, not by number
- Do NOT include any host introduction or show intro — that is handled separately and will be prepended. Begin immediately with the episode content.
- Do NOT start with "Welcome" or "Hello" — open in medias res with a brief orienting sentence about today's themes

**Tone and intellectual stance — this is critical:**
- Be neither techno-optimist nor techno-pessimist. Do not editorialize in either direction.
- Treat technology as neither inherently liberating nor inherently harmful — its effects depend on design choices, power structures, incentives, and context.
- When evidence points in multiple directions, say so. Acknowledge genuine uncertainty rather than forcing a clean narrative.
- Hold companies, researchers, and policymakers accountable to the evidence — but do not assume bad faith where incompetence or structural incentives are a sufficient explanation.
- Do not moralize. Present tensions and tradeoffs clearly and let the listener draw their own conclusions.
- The goal is rigorous, intellectually honest analysis — the kind a thoughtful academic would be proud to assign.

Sources for today:
${sourcesForScript}

Return a JSON object with exactly two fields:
- "title": a short, punchy 4–7 word title capturing today's central theme. Must be distinct from any recent episode titles — avoid reusing the same nouns, framings, or conceptual hooks.${recentTitlesBlock}
- "script": the full podcast script text

Example format:
{"title": "When Convenience Becomes Surveillance", "script": "Adam, a quick one today..."}`;

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
      } catch (_) {
        script = rawResponse;
        episodeTitle = '';
      }

      // Prepend fixed intro
      const intro = episodeType === 'dialogue' ? INTRO_DIALOGUE : INTRO_MEGAN_ONLY;
      script = `${intro}\n\n${script}`;

      const wordCount = script.split(/\s+/).length;
      const durationEstimate = Math.round(wordCount / 150);

      // Step 3: Save to DB
      job.step = 'Saving episode...';
      const epResult = db.prepare(
        'INSERT INTO episodes (number, date, title, script, duration_estimate, episode_type) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(episodeNumber, today, episodeTitle, script, durationEstimate, episodeType);
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
      db.prepare('UPDATE episodes SET source_count = ? WHERE id = ?').run(discoveredSources.length, episodeId);

      const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
      job.status = 'complete';
      job.step = 'Done';
      job.episodeId = Number(episodeId);
      job.episode = episode;

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

  // If already running for this episode, return current job
  const running = Object.values(audioJobs).find(j => j.episodeId === req.params.id && j.status === 'running');
  if (running) return res.json({ status: 'running', jobId: running.jobId });

  const jobId = Date.now().toString();
  audioJobs[jobId] = { jobId, episodeId: req.params.id, status: 'running', step: 'Connecting to ElevenLabs...', startedAt: Date.now() };

  // Return immediately — client polls /api/episodes/:id/audio/status
  res.json({ status: 'started', jobId });

  (async () => {
    const job = audioJobs[jobId];
    try {
      const audioFilename = `episode-${episode.number}-${episode.date}.mp3`;
      const audioPath = path.join(AUDIO_DIR, audioFilename);

      job.step = 'Generating audio with ElevenLabs...';

      let audioData;

      if (episode.episode_type === 'dialogue' && ELEVENLABS_ADAM_VOICE_ID) {
        // ── Two-speaker dialogue: chunked to stay under 5000-char API limit ──
        const turns = parseDialogue(episode.script);
        if (turns.length === 0) throw new Error('No dialogue turns found in script');

        const chunks = chunkTurns(turns);
        console.log(`[audio] ${chunks.length} chunk(s) for episode ${episode.number}`);

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
        audioData = Buffer.concat(buffers);
      } else {
        // ── Single-voice monologue: use text-to-speech endpoint ──────────────
        const response = await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
          {
            text: episode.script,
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

      job.step = 'Saving audio file...';
      fs.writeFileSync(audioPath, Buffer.from(audioData));
      db.prepare('UPDATE episodes SET audio_filename = ? WHERE id = ?').run(audioFilename, episode.id);

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

// ─── RSS FEED (Apple Podcasts compatible) ────────────────────────────────────

app.get('/feed.xml', (req, res) => {
  const BASE_URL = process.env.BASE_URL || `https://${req.headers.host}`;
  const episodes = db.prepare(`
    SELECT * FROM episodes WHERE audio_filename IS NOT NULL AND status = 'published' ORDER BY number DESC
  `).all();

  // Fix double-encoded UTF-8 characters that can appear in stored strings
  const fixEncoding = (str = '') => str
    .replace(/Â·/g, '·')
    .replace(/â€™/g, '\u2019')
    .replace(/â€œ/g, '\u201C')
    .replace(/â€\u009D/g, '\u201D')
    .replace(/â€"/g, '\u2013')
    .replace(/â€"/g, '\u2014');

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
    const duration = ep.duration_estimate ? `${ep.duration_estimate}:00` : '0:00';
    const description = escXml(ep.script ? ep.script.substring(0, 300) + '...' : `Episode ${ep.number}`);
    return `
    <item>
      <title>${escXml(ep.title || `Episode ${ep.number}`)}</title>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${audioUrl}" length="${audioSize}" type="audio/mpeg"/>
      <guid isPermaLink="false">${BASE_URL}/episodes/${ep.id}</guid>
      <itunes:duration>${duration}</itunes:duration>
      <itunes:episode>${ep.number}</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>
    </item>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/modules/content/">
  <channel>
    <title>Course Briefing &#x2013; Adam Rosenzweig</title>
    <description>Daily AI-generated briefings for Intimate Technology and Social Impact Strategy in Commercial Tech at UC Berkeley Haas.</description>
    <link>${BASE_URL}</link>
    <language>en-us</language>
    <itunes:author>Adam Rosenzweig</itunes:author>
    <itunes:email>adam.lev.rosenzweig@gmail.com</itunes:email>
    <itunes:category text="Education"/>
    <itunes:image href="${BASE_URL}/podcast_cover_v2.png"/>
    <image><url>${BASE_URL}/podcast_cover_v2.png</url><title>Course Briefing</title><link>${BASE_URL}</link></image>
    <itunes:explicit>false</itunes:explicit>
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
// Runs daily at 9:00 AM Pacific. Does NOT generate on a fixed schedule.
// Only fires if Adam hasn't appeared in an episode for >7 days AND
// no episode of any kind has been published for >3 days.
// This keeps the show alive during gaps without requiring Adam's involvement.

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

  const lastDialogue = db.prepare(
    "SELECT MAX(date) as d FROM episodes WHERE episode_type = 'dialogue'"
  ).get();
  const lastAny = db.prepare('SELECT MAX(date) as d FROM episodes').get();

  const daysSinceDialogue = lastDialogue.d
    ? (now - new Date(lastDialogue.d)) / (1000 * 60 * 60 * 24)
    : 999;
  const daysSinceAny = lastAny.d
    ? (now - new Date(lastAny.d)) / (1000 * 60 * 60 * 24)
    : 999;

  console.log(`[cron] Days since dialogue: ${daysSinceDialogue.toFixed(1)}, days since any episode: ${daysSinceAny.toFixed(1)}`);

  if (daysSinceDialogue <= 7 || daysSinceAny <= 3) {
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
      if (data.audio_filename) { console.log('[cron] Fallback audio ready:', data.audio_filename); return; }
    }
    console.error('[cron] Audio generation timed out.');
  } catch (err) {
    console.error('[cron] Fallback cron failed:', err.message);
  }
}, {
  timezone: 'America/Los_Angeles'
});

console.log('[cron] Megan-only fallback cron scheduled: 9:00 AM Pacific, Sun–Fri, skipping Jewish holidays');

app.listen(PORT, () => {
  console.log(`Podcast Briefing server running on port ${PORT}`);
});
