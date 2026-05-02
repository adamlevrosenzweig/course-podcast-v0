# course-podcast-v0

A daily AI-generated podcast briefing app for Adam Rosenzweig's UC Berkeley Haas courses.

## What it does

Searches the web for recent news relevant to two courses, writes a podcast script, generates audio via ElevenLabs TTS, and serves everything via a React single-page app. Episodes can be dialogue (two voices: Adam + Megan) or monologue (Megan only).

## Tech stack

- **Backend**: Node.js + Express, SQLite (node:sqlite built-in), node-cron, music-metadata (MP3 duration parsing)
- **Frontend**: React (CDN, Babel standalone) — single file at `public/index.html`
- **AI**: Anthropic SDK (claude-opus-4-7) with web_search tool for source discovery
- **TTS**: ElevenLabs — dialogue uses `/v1/text-to-dialogue`, monologue uses `/v1/text-to-speech`
- **Deployment**: Railway, auto-deploys from GitHub main branch

## Courses

1. **Intimate Technology** (undergrad) — tech, intimacy, surveillance, AI companions, haptics
2. **Social Impact Strategy in Commercial Tech** (MBA 290T) — ESG, algorithmic harm, ethical product design

## Key files

- `server.js` — all backend routes and logic
- `public/index.html` — entire frontend (React, single file)
- `database.js` — SQLite schema and initialization
- `push-to-railway.js` — CLI tool to push draft episodes (largely superseded by UI import form)

## Environment variables (set in Railway)

- `ANTHROPIC_API_KEY` — for episode generation
- `ELEVENLABS_API_KEY` — for audio
- `ELEVENLABS_VOICE_ID` — Megan's voice ID
- `ELEVENLABS_ADAM_VOICE_ID` — Adam's cloned voice ID
- `ADMIN_PASSWORD` — used for x-api-key auth on admin endpoints
- `SESSION_SECRET` — for cookie sessions
- `AUDIO_DIR` — path for storing MP3 files (Railway volume)
- `BASE_URL` — for RSS feed links

## Authentication

Two methods — both check in `requireAuth` middleware:
1. Cookie session (browser login via `/api/login`)
2. `x-api-key` header — pass `ADMIN_PASSWORD` value directly (used by CLI tools and Claude Code studio console)

**Local Claude Code auth:** `ADMIN_PASSWORD` is stored in macOS Keychain:
```bash
# Read (used by Claude Code each session)
security find-generic-password -a "podcast-admin" -s "course-podcast-v0" -w
# Write (one-time setup)
security add-generic-password -a "podcast-admin" -s "course-podcast-v0" -w
```

Public routes (no auth): `/feed.xml`, `/audio/*`, `/episodes/:id/transcript`, static images.

## API endpoints (key ones)

- `POST /api/episodes/generate` — starts async generation; accepts `episode_type` and optional `topic`
- `GET /api/episodes/generate/status` — poll generation progress
- `DELETE /api/episodes/:id` — delete a draft episode (drafts only; cascades to sources)
- `POST /api/episodes/:id/audio` — starts async audio generation
- `GET /api/episodes/:id/audio/status` — poll audio progress
- `PATCH /api/episodes/:id/status` — update status, publish_at
- `PATCH /api/episodes/:id/script` — update script and/or title
- `POST /api/episodes/:id/summarize` — run Haiku summarization, save episode_summary
- `POST /api/episodes/:id/steelman` — generate devil's advocate analysis, save steelman_notes
- `POST /api/episodes/:id/sources/discover` — retroactively find sources for an episode
- `DELETE /api/sources/:id` — remove an individual source from an episode
- `GET /api/settings` — returns show_active, last_published, days_since_published
- `POST /api/settings/active` — pause/resume the show (affects cron)
- `POST /api/episodes/import` — import a pre-written script as a draft
- `GET /episodes/:id/transcript` — public; returns published episode script as `text/html`
- `POST /api/contributed` — add URL, pasted text, or file to source queue
- `POST /api/admin/migrate/resync-summaries` — re-summarize all episodes + regenerate show notes
- `POST /api/admin/migrate/resync-durations` — backfill accurate audio durations from MP3 metadata
- `POST /api/admin/migrate/restrip-audio` — strip ID3v2 headers from all existing MP3s (fixes Apple Podcasts in-player timer showing wrong duration)

## Studio console (Claude Code as primary interface)

Adam manages the podcast primarily through conversation with Claude Code, which calls the Railway API directly. The web UI is the production dashboard for reviewing drafts, editing scripts, and listening to audio.

**Typical Claude Code workflows:**
- "Generate an episode about X" → `POST /api/episodes/generate` with topic + episode_type
- Edit script via conversation → `PATCH /api/episodes/:id/script`
- "Schedule for Thursday" → `PATCH /api/episodes/:id/status` with **both** `status: "scheduled"` and `publish_at: "YYYY-MM-DD"` — the 5 AM publish cron queries `publish_at <= today`, so omitting `publish_at` silently prevents auto-publish
- "What's in the queue?" → `GET /api/episodes`, filter drafts

## Script authoring conventions

### Intros and outros (hardcoded, not generated)
All four constants in `server.js` require the `MEGAN:` speaker prefix.

- **`INTRO_DIALOGUE`**: Brief opener + AI voice disclosure (both voices synthetic — Adam cloned via ElevenLabs, Megan fully synthetic)
- **`INTRO_MEGAN_ONLY`**: Megan intro + voice disclosure (solo episode, fully synthetic)
- **`OUTRO_DIALOGUE`** / **`OUTRO_MEGAN_ONLY`**: Brief accuracy caveat only

### Dialogue format rules (enforced in prompt + post-processing)
- Every line must begin with `MEGAN:` or `ADAM:` — no unlabeled paragraphs
- No markdown formatting — plain text only
- Post-processing strips `**MEGAN**:` → `MEGAN:` and normalizes casing
- Always end the script body with a transitional MEGAN sentence that lands the episode's main point before the hardcoded outro — without it the outro feels abrupt

### Adam's dialogue style and intellectual priors
- Casual register — contractions, sentence fragments, natural profanity
- Sounds like office hours, not a lecture
- Gets excited, goes on tangents, catches himself
- **Core prior:** companies are rational economic actors; harm is structural indifference, not malice — he resists moralizing about intent
- **On correction:** pessimistic — incentives trump conscience; durable fixes require regulation or business model realignment
- **On research:** trusts timeless human-nature findings; skeptical of studies claiming to explain fast-moving tech phenomena
- **Blind spot 1:** defaults to US regulatory/market frame without noticing — Megan catches this regularly
- **Blind spot 2:** assumes his values are universal; doesn't naturally make room for genuine value pluralism
- **Core orientation:** pro-human — gets more serious and precise when the argument touches loneliness, vulnerability, or what it means to feel seen

### Megan's dialogue style and intellectual priors
- Dry wit, warm skepticism. Smart, not smug. Wants the argument to succeed.
- Carries roughly equal dialogue weight — her contributions are substantive, not just one-line redirects
- **Global frame:** naturally non-US — references international precedent because it's how she thinks, not as a rhetorical move
- **Pro-tech bias:** real and self-aware — she's AI, has skin in the game, flags it with humor when called out ("I realize I'm not a neutral party here")
- **Information advantage:** better recall, faster synthesis — she uses it, but it doesn't always mean she's more right about what matters
- **Genuine limit:** no feelings, no intuitive access to human relationships — she can analyze intimacy with precision and miss the point entirely; Adam occasionally names this gap, and when he does she acknowledges it rather than deflecting
- **Core orientation:** pro-tech

### The central dynamic
Adam is pro-human, Megan is pro-tech. Balance comes from their friction, not from pre-baked neutrality in each voice. Recurring patterns: Megan calls out Adam's US-centrism → he concedes or defends specifically; Adam calls out Megan's pro-tech bias → she responds with humor (occasionally pushed past it); Megan out-recalls Adam on research → Adam's response is about what research can't capture.

### The overhang lens
The show's underlying frame is the gap between what technology makes possible and what society has the institutions, norms, and frameworks to handle. This doesn't need to be stated in every episode — it shapes analysis and the questions episodes leave the listener with.

### Title format
Generated titles: `Short Punchy Title · Month DD, YYYY` — auto-appended by server at generation time. No episode numbers in titles.

## Source discovery and show notes

- Generated episodes: Claude returns `used_source_indices` identifying which discovered sources it actually cited. Only those are saved to DB and appear in RSS show notes.
- Imported episodes: no sources (no web search ran — expected)
- Retroactive discovery: `POST /api/episodes/:id/sources/discover`
- Individual source delete: `DELETE /api/sources/:id` (UI: ✕ button in Archive and Today views)

**RSS pre-seeding (added May 2026):** Before Claude's web search runs, the server fetches recent articles from four trusted publications via RSS/Atom and injects them into the discovery prompt as priority candidates. Claude still runs web search to supplement. Feeds: NYT Technology (RSS), The Atlantic (Atom), MIT Technology Review (RSS), Platformer (RSS). Capped at 15 items per feed, 7-day recency filter. Per-feed errors are caught and logged — if all feeds fail, discovery falls back to web-search-only with no behavior change. Feed list is `RSS_FEEDS` constant at top of `server.js`.

## RSS feed

- **Show title:** The Overhang
- **`<description>`**: CDATA-wrapped HTML show notes (summary paragraph + Sources list) — Apple Podcasts reads this, not `<content:encoded>`
- **`<content:encoded>`**: identical to `<description>` — kept for non-Apple podcast apps that prefer it
- **Apple Podcasts caveat:** Apple ignores `<content:encoded>` for show notes; always put HTML in `<description>` or sources won't appear in Apple Podcasts
- **Cover art:** `podcast_cover_megan4.jpg` — `?v=4` for cache busting; bump `?v=N` in all three RSS occurrences to force Apple to re-fetch
- **Explicit:** `true` on channel and each item
- **Transcripts:** `<podcast:transcript>` pointing to `/episodes/:id/transcript` with `type="text/html"`
- **Namespaces:** `xmlns:podcast`, `xmlns:atom`
- **WebSub:** `atom:link rel="hub"` points to `pubsubhubbub.appspot.com`; `pingWebSub()` fires automatically when an episode is published, triggering Apple Podcasts to re-fetch within minutes

## Audio generation

- **Dialogue:** `text-to-dialogue` API (`eleven_v3`), chunked into ≤5000-char groups via `chunkTurns()`. Returns natural multi-speaker audio. Chunk buffers merged into one stream, then passed to `mixWithFfmpeg`.
- **Monologue:** single `text-to-speech` call (`eleven_turbo_v2_5`), passed as single-element array to `mixWithFfmpeg`.
- ffmpeg installed via `ffmpeg-static` npm package (bundles its own binary — no system package needed).
- **Music:** set `MUSIC_FILE` env var (defaults to `sounds/music.mp3` in repo root) to enable music. Single-stream path (both dialogue and monologue): 6s solo sting → music fades under speech over 6s → full speech → 15s music trail → 3s fade out. Omit `MUSIC_FILE` and remove `sounds/music.mp3` to skip music entirely.
- Audio jobs are in-memory; server restart clears them (Railway restarts on deploy)
- New audio POST cancels any running job for that episode
- Episode re-read from DB right before calling ElevenLabs (uses latest saved script)
- Audio served with `Cache-Control: no-cache`; Queue player appends `?v=timestamp` on completion

### Voice settings (text-to-dialogue)
- **Megan voice_settings:** `{ stability: 0.50, similarity_boost: 0.75, style: 0.20, use_speaker_boost: true }`
- **Adam voice_settings:** `{ stability: 0.50, similarity_boost: 0.75, style: 0.30, use_speaker_boost: true }`
- Model: `eleven_v3` (required by text-to-dialogue endpoint) — British Megan voice renders cleanly; do not use non-British/American voices
- **Do not add `language_code`** — `en-IE` was tried and reverted; it degraded quality
- `audio_duration_seconds` calculated as `audioBuffer.length / 16000` (CBR 128 kbps = 16000 bytes/sec) at audio generation time; RSS falls back to same calculation from file size, then `duration_estimate * 60`
- `<itunes:duration>` formatted as `M:SS` or `H:MM:SS` via `toHMS()` helper in the feed route
- Queue UI shows `M:SS` from `audio_duration_seconds` when available; shows nothing for drafts without audio (`duration_estimate` no longer displayed)

## Fallback cron

- Scheduled-episode publish cron: daily at 5:00 AM Pacific — publishes any episode with `status=scheduled` and `publish_at <= today`
- Fallback cron: daily at 9:00 AM Pacific, Sun–Fri
- Fires if no episode published in the last 3 days (drafts don't count)
- Generates a Megan-only episode, waits for audio, then auto-publishes
- Respects kill switch — skips if show is inactive
- Kill switch: `POST /api/settings/active` or the toggle in Settings UI

## Continuous learning loop

1. **Script edit tracking** — `original_script` stores AI draft. Edits summarized by Haiku into `edit_summary`. Last 5 injected into next script prompt.
2. **Listener feedback** — `feedback` table feeds into source discovery and script prompts
3. **Narrative memory** — `episode_summary` (Haiku, max 3 sentences on central arguments, no label prefix). Last 5 injected for continuity. Also used as RSS `<description>`.

## Devil's advocate / steelman

Every generated episode automatically gets a steelman analysis (Sonnet, fire-and-forget, same timing as episode summary). Stored in `steelman_notes` column. Visible in Queue UI under "Devil's advocate" collapsible panel.

- Surfaces the 3 strongest counterarguments to the episode's key claims
- For each, suggests a specific edit or addition to preempt or acknowledge the objection
- Closes with a "biggest vulnerability" — the highest-leverage fix
- On-demand regeneration: `POST /api/episodes/:id/steelman`
- Also available as a standalone CLI skill: `/steelman [script or file path]`
