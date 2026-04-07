require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');

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

  // Check if generation already running
  const running = Object.values(generationJobs).find(j => j.status === 'running');
  if (running) return res.json({ status: 'running', message: 'Generation already in progress' });

  const jobId = Date.now().toString();
  generationJobs[jobId] = { jobId, status: 'running', step: 'Starting...', startedAt: Date.now() };

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

      const discoveryPrompt = `You are a research assistant for a UC Berkeley professor who teaches two courses:

1. **Intimate Technology** (an undergrad business course): Explores how technology mediates human intimacy, vulnerability, and connection. Key themes include AI companions, surveillance capitalism, haptic technology, digital intimacy, consent and data, companion robots, policy and regulation of intimate tech, ethics of consequence-free caregiving, identity performance and networked life.

2. **Social Impact Strategy in Commercial Tech** (MBA 290T): Explores how commercial technology companies navigate social impact. Key themes include corporate responsibility, ESG and tech, algorithmic harm, technology policy, ethical product design, stakeholder capitalism, social entrepreneurship in tech, the tension between growth and social good.

Search the web for the 8–12 most important, recent, high-quality stories and articles published in the last 7 days relevant to these topic themes:

${themeList}${contributedSection}

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

      const scriptPrompt = `You are the host of a daily podcast briefing for a UC Berkeley Haas professor named Adam. Adam teaches two courses:

1. **Intimate Technology** — how technology mediates human intimacy, vulnerability, and connection
2. **Social Impact Strategy in Commercial Tech** — how commercial tech companies navigate social impact, intentionally and otherwise

Both courses share territory: how technology affects vulnerable populations, how business models shape social outcomes, and where ethics and commercial incentives collide.

Write a podcast script for today's briefing (Episode ${episodeNumber}, ${today}) using the following sources. The script should:
- Be 10-50 minutes when read aloud
- Sound like a well-produced, intelligent daily briefing — natural spoken voice, not a list of summaries
- Don't be afraid to be academic in your language - Adam values precision and abhors platitudes
- Have a clear narrative thread that weaves stories together, especially where they span both courses
- Explicitly name the conceptual connections between stories when relevant
- Open with a brief orienting sentence about today's themes, not a generic intro
- Close with a brief forward-looking thought or question to sit with
- Reference sources naturally by name/outlet, not by number
- NOT start with "Welcome" or "Hello" — just open with a quick, clever greeting directly to Adam, then in medias res get on with the content

Sources for today:
${sourcesForScript}

Return only the script text. No stage directions, no metadata.`;

      const scriptResponse = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: scriptPrompt }]
      });
      const script = scriptResponse.content[0].text;
      const wordCount = script.split(/\s+/).length;
      const durationEstimate = Math.round(wordCount / 150);

      // Step 3: Save to DB
      job.step = 'Saving episode...';
      const epResult = db.prepare(
        'INSERT INTO episodes (number, date, script, duration_estimate) VALUES (?, ?, ?, ?)'
      ).run(episodeNumber, today, script, durationEstimate);
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

// ─── AUDIO GENERATION ────────────────────────────────────────────────────────

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

  // Return immediately — client polls /api/episodes/:id/audio/status
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
          timeout: 300000  // 5 min — Railway proxy is bypassed since we returned already
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

// ─── SOURCES ─────────────────────────────────────────────────────────────────

app.get('/api/sources', (req, res) => {
  const { q, course, episode_id } = req.query;
  let query = 'SELECT s.*, e.number as episode_number, e.date as episode_date FROM sources s LEFT JOIN episodes e ON e.id = s.episode_id WHERE 1=1';
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

  query += ' ORDER BY s.created_at DESC';
  const sources = db.prepare(query).all(...params);

  // Parse courses JSON for each source
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
    SELECT * FROM episodes WHERE audio_filename IS NOT NULL ORDER BY number DESC
  `).all();

  const escXml = (str = '') => str
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
      <title>Episode ${ep.number} – ${escXml(ep.date)}</title>
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
    <title>Course Briefing – Adam Rosenzweig</title>
    <description>Daily AI-generated briefings for Intimate Technology and Social Impact Strategy in Commercial Tech at UC Berkeley Haas.</description>
    <link>${BASE_URL}</link>
    <language>en-us</language>
    <itunes:author>Adam Rosenzweig</itunes:author>
    <itunes:email>adam.lev.rosenzweig@gmail.com</itunes:email>
    <itunes:category text="Education"/>
    <itunes:image href="${BASE_URL}/podcast_cover.png"/>
    <image><url>${BASE_URL}/podcast_cover.png</url><title>Course Briefing</title><link>${BASE_URL}</link></image>
    <itunes:explicit>false</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    ${items}
  </channel>
</rss>`;

  res.set('Content-Type', 'application/rss+xml');
  res.send(xml);
});

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Podcast Briefing server running on port ${PORT}`);
});


