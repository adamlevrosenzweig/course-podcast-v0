require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';

const AUDIO_DIR = process.env.AUDIO_DIR || path.join(__dirname, 'audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(AUDIO_DIR));

// âââ THEMES ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ CONTRIBUTED URLS ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ EPISODES ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ EPISODE GENERATION ââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

  // Check if generation already running
  const running = Object.values(generationJobs).find(j => j.status === 'running');
  if (running) return res.json({ status: 'running', message: 'Generation already in progress' });

  const jobId = Date.now().toString();
  generationJobs[jobId] = { jobId, status: 'running', step: 'Starting...', startedAt: Date.now() };

  // Return immediately â client will poll /api/episodes/generate/status
  res.json({ status: 'started', jobId });

  // Run generation in background (fire and forget â client polls status)
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

Search the web for the 8â12 most important, recent stories and articles published in the last 7 days relevant to these topic themes.

Source quality requirements â strictly apply these:
- PREFER: established news outlets (NYT, Washington Post, The Guardian, The Atlantic, Wired, Bloomberg, Reuters, AP), academic and research publications (Nature, Science, SSRN preprints, university press releases from R1 institutions), and specialist tech/policy outlets (MIT Technology Review, IEEE Spectrum, rest of world, Politico, The Markup, Slate, The Verge for substantive pieces)
- PREFER: articles with a named author or byline
- AVOID: sites without clear author attribution, content farms, SEO aggregators, press-release republishers, sites with excessive advertising, AI-generated content sites
- AVOID: product announcements or marketing copy disguised as news
- AVOID: low-domain-authority blogs or sites you've never heard of
- If a story is only covered by low-quality sources, skip it â wait for a credible outlet to cover it
${themeList}${contributedSection}${feedbackSection}

For each source found, provide a JSON object with:
- title: article/story title
- url: full URL
- summary: 2â3 sentence summary of the key points
- published_date: approximate date (YYYY-MM-DD format if known)
- courses: array of applicable courses â use "intimate_tech", "social_impact", or both
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

      const recentTitles = db.prepare('SELECT title FROM episodes ORDER BY number DESC LIMIT 10').all().map(r => r.title).filter(Boolean);
      const recentTitlesBlock = recentTitles.length ? '\nRecent episode titles (do NOT reuse these themes or framings):\n' + recentTitles.map(t => '- ' + t).join('\n') + '\n' : '';

      const scriptPrompt = `You are the co-host of "The Overhang," a daily podcast on the innovations, policies, and ideas shaping society. The show is co-produced by Adam Rosenzweig — a lecturer at UC Berkeley's Haas School of Business — and Claude, an AI made by Anthropic. Adam curates the sources and shapes the editorial direction; you write the script.

Adam teaches two courses at Haas that inform the show's perspective:
- **Intimate Technology** — how technology mediates human intimacy, vulnerability, and connection
- **Social Impact Strategy in Commercial Tech** — how commercial tech companies navigate social impact, intentionally and otherwise

When a story is directly relevant to one of these courses, you may note the connection briefly and in plain language (e.g., "This speaks to questions Adam explores in his Intimate Technology course..."). Don't assume the listener is enrolled — give enough context that anyone can follow.

Write a podcast script for Episode ${episodeNumber} (${today}) using the following sources. The script should:
- Be 10–50 minutes when read aloud
- Sound like a well-produced, intelligent daily briefing — natural spoken voice, not a list of summaries
- Be rigorous and precise — this audience values intellectual honesty and abhors platitudes
- Have a clear narrative thread that weaves stories together, especially where they intersect
- Explicitly name the conceptual connections between stories when relevant
- Open with a brief orienting sentence about today's themes, not a generic intro
- Close with a brief forward-looking thought or question to sit with
- Reference sources naturally by name/outlet, not by number
- NOT start with "Welcome" or "Hello" — open in medias res with a sharp, engaging hook

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
{"title": "When Convenience Becomes Surveillance", "script": "Three stories this week share an uncomfortable thread..."}`;
      const scriptResponse = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: scriptPrompt }]
      });
      const rawResponse = scriptResponse.content[0].text.trim();
      let script, episodeTitle;
      try {
        // Strip markdown fences if Claude wrapped it anyway
        const jsonText = rawResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        const parsed = JSON.parse(jsonText);
        script = parsed.script || rawResponse;
        episodeTitle = parsed.title || '';
      } catch (_) {
        // Fallback: treat whole response as script
        script = rawResponse;
        episodeTitle = '';
      }

      // Format: "#12 Â· Some Pithy Title Â· April 6, 2026"
      const dateFormatted = new Date(today + 'T12:00:00').toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric'
      });
      const fullTitle = episodeTitle
        ? `#${episodeNumber} Â· ${episodeTitle} Â· ${dateFormatted}`
        : `#${episodeNumber} Â· ${dateFormatted}`;

      const wordCount = script.split(/\s+/).length;
      const durationEstimate = Math.round(wordCount / 150);

      // Step 3: Save to DB
      job.step = 'Saving episode...';
      const epResult = db.prepare(
        'INSERT INTO episodes (number, date, title, script, duration_estimate) VALUES (?, ?, ?, ?, ?)'
      ).run(episodeNumber, today, fullTitle, script, durationEstimate);
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
    } catch (err) {
      console.error('Generation error:', err);
      generationJobs[jobId].status = 'error';
      generationJobs[jobId].error = err.message;
    }
  })();
});

// âââ AUDIO GENERATION ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// In-memory job store for audio generation (same pattern as episode generation)
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

  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'Episode not found' });
  if (!episode.script) return res.status(400).json({ error: 'Episode has no script' });

  // If already running for this episode, return current job
  const running = Object.values(audioJobs).find(j => j.episodeId === req.params.id && j.status === 'running');
  if (running) return res.json({ status: 'running', jobId: running.jobId });

  const jobId = Date.now().toString();
  audioJobs[jobId] = { jobId, episodeId: req.params.id, status: 'running', step: 'Connecting to ElevenLabs...', startedAt: Date.now() };

  // Return immediately â client polls /api/episodes/:id/audio/status
  res.json({ status: 'started', jobId });

  (async () => {
    const job = audioJobs[jobId];
    try {
      const audioFilename = `episode-${episode.number}-${episode.date}.mp3`;
      const audioPath = path.join(AUDIO_DIR, audioFilename);

      job.step = 'Generating audio with ElevenLabs...';
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
          timeout: 300000  // 5 min â Railway proxy is bypassed since we returned already
        }
      );

      job.step = 'Saving audio file...';
      fs.writeFileSync(audioPath, response.data);
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

// âââ SOURCES âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

  // Parse courses JSON for each source
  const parsed = sources.map(s => ({ ...s, courses: JSON.parse(s.courses || '[]') }));
  res.json(parsed);
});

// âââ FEEDBACK ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ VOICES (ElevenLabs) âââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ RSS FEED (Apple Podcasts compatible) ââââââââââââââââââââââââââââââââââââ

app.get('/feed.xml', (req, res) => {
  const BASE_URL = process.env.BASE_URL || `https://${req.headers.host}`;
  const episodes = db.prepare(`
    SELECT * FROM episodes WHERE audio_filename IS NOT NULL ORDER BY number DESC
  `).all();

  const fixEncoding = (str = '') => str
    .replace(/Â·/g, '·')
    .replace(/â€™/g, '\u2019')
    .replace(/â€œ/g, '\u201C')
    .replace(/â€\u009D/g, '\u201D')
    .replace(/â€"/g, '\u2013')
    .replace(/â€"/g, '\u2014');

  const escXml = (str = '') => fixEncoding(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const items = episodes.map(ep => {
    const audioUrl = `${BASE_URL}/audio/${ep.audio_filename}`;
    const audioPath = path.join(AUDIO_DIR, ep.audio_filename);
    const audioSize = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
    const pubDate = new Date(ep.date).toUTCString();
    const duration = ep.duration_estimate ? `${ep.duration_estimate}:00` : '0:00';
    const description = escXml(ep.script ? ep.script.substring(0, 300) + '...' : `Episode ${ep.number}`);
    return `
    <item>
      <title>${escXml(ep.title || `Episode ${ep.number} â ${ep.date}`)}</title>
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
    <title>The Overhang</title>
<description>Daily AI-generated briefings on the state of intimate technology and social impact strategy for commercial tech companies.</description>    <link>${BASE_URL}</link>
    <language>en-us</language>
    <itunes:author>Adam Rosenzweig</itunes:author>
    <itunes:email>adam.lev.rosenzweig@gmail.com</itunes:email>
    <itunes:category text="Education"/>
    <itunes:image href="${BASE_URL}/podcast_cover_overhang1.png"/>
    <image><url>${BASE_URL}/podcast_cover_overhang1.png</url><title>Course Briefing</title><link>${BASE_URL}</link></image>
    <itunes:explicit>false</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    ${items}
  </channel>
</rss>`;

  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
});

// âââ CATCH-ALL âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('*', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8'); res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// âââ DAILY AUTO-GENERATION âââââââââââââââââââââââââââââââââââââââââââââââââââ
// Runs every day at 7:00 AM Pacific time (UTC-7 in PDT, UTC-8 in PST).
// node-cron schedules in server local time (UTC on Railway), so we use UTC hours:
//   7 AM PT (PDT, UTC-7) = 14:00 UTC  |  7 AM PT (PST, UTC-8) = 15:00 UTC
// To handle both, check the TZ env var or just pick a UTC hour.
// Railway runs in UTC. To change the time, update CRON_SCHEDULE in env vars.
// Default: "0 14 * * *"  = 7 AM PDT (summer).  Use "0 15 * * *" in winter.

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 14 * * *';

cron.schedule(CRON_SCHEDULE, async () => {
  console.log('[cron] Starting scheduled daily generation at', new Date().toISOString());

  // Skip if already generated today
  const today = new Date().toISOString().split('T')[0];
  const existing = db.prepare('SELECT id FROM episodes WHERE date = ?').get(today);
  if (existing) {
    console.log('[cron] Episode already exists for today, skipping.');
    return;
  }

  // Reuse the same generation logic as the POST endpoint
  // by making an internal HTTP request to ourselves
  const port = process.env.PORT || 3000;
  const base = `http://localhost:${port}`;

  try {
    // Step 1: trigger generation
    await axios.post(`${base}/api/episodes/generate`, {});
    console.log('[cron] Generation started, polling for completion...');

    // Step 2: poll until done (10 min timeout)
    let episodeId = null;
    const genDeadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < genDeadline) {
      await new Promise(r => setTimeout(r, 15000));
      const { data } = await axios.get(`${base}/api/episodes/generate/status`);
      console.log('[cron] Generation status:', data.status, data.step || '');
      if (data.status === 'error') {
        console.error('[cron] Generation failed:', data.error);
        return;
      }
      if (data.status === 'complete') {
        episodeId = data.episodeId;
        break;
      }
    }
    if (!episodeId) {
      console.error('[cron] Generation timed out after 10 minutes.');
      return;
    }

    // Step 3: trigger audio generation
    console.log('[cron] Script complete, triggering audio for episode', episodeId);
    await axios.post(`${base}/api/episodes/${episodeId}/audio`, {});

    // Step 4: poll until audio is ready (5 min timeout)
    const audioDeadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < audioDeadline) {
      await new Promise(r => setTimeout(r, 20000));
      const { data } = await axios.get(`${base}/api/episodes/${episodeId}`);
      if (data.audio_filename) {
        console.log('[cron] Audio ready:', data.audio_filename);
        return;
      }
    }
    console.error('[cron] Audio generation timed out after 5 minutes.');
  } catch (err) {
    console.error('[cron] Cron job failed:', err.message);
  }}, {
  timezone: 'America/Los_Angeles'  // handles DST automatically
});

console.log(`[cron] Daily generation scheduled: ${CRON_SCHEDULE} (America/Los_Angeles)`);

app.listen(PORT, () => {
  console.log(`Podcast Briefing server running on port ${PORT}`);
});


