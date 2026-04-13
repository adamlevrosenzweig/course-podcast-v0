# course-podcast-v0

A daily AI-generated podcast briefing app for Adam Rosenzweig's UC Berkeley Haas courses.

## What it does

Searches the web for recent news relevant to two courses, writes a podcast script, generates audio via ElevenLabs TTS, and serves everything via a React single-page app. Episodes can be dialogue (two voices: Adam + Megan) or monologue (Megan only).

## Tech stack

- **Backend**: Node.js + Express, SQLite (node:sqlite built-in), node-cron
- **Frontend**: React (CDN, Babel standalone) — single file at `public/index.html`
- **AI**: Anthropic SDK (claude-sonnet-4-20250514) with web_search tool for source discovery
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
- `POST /api/episodes/:id/sources/discover` — retroactively find sources for an episode
- `DELETE /api/sources/:id` — remove an individual source from an episode
- `GET /api/settings` — returns show_active, last_published, days_since_published
- `POST /api/settings/active` — pause/resume the show (affects cron)
- `POST /api/episodes/import` — import a pre-written script as a draft
- `GET /episodes/:id/transcript` — public; returns published episode script as `text/html`
- `POST /api/contributed` — add URL, pasted text, or file to source queue

## Studio console (Claude Code as primary interface)

Adam manages the podcast primarily through conversation with Claude Code, which calls the Railway API directly. The web UI is the production dashboard for reviewing drafts, editing scripts, and listening to audio.

**Typical Claude Code workflows:**
- "Generate an episode about X" → `POST /api/episodes/generate` with topic + episode_type
- Edit script via conversation → `PATCH /api/episodes/:id/script`
- "Schedule for Thursday" → `PATCH /api/episodes/:id/status`
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

### Adam's dialogue style
- Casual register — contractions, sentence fragments, natural profanity
- Sounds like office hours, not a lecture
- Gets excited, goes on tangents, catches himself

### Megan's dialogue style
- The straight voice — clear, grounded, always the listener's advocate
- Dry wit with Adam; reels him in when he goes off-rails
- Does not moralize. Smart, not smug.

### Title format
Generated titles: `Short Punchy Title · Month DD, YYYY` — auto-appended by server at generation time. No episode numbers in titles.

## Source discovery and show notes

- Generated episodes: Claude returns `used_source_indices` identifying which discovered sources it actually cited. Only those are saved to DB and appear in RSS show notes.
- Imported episodes: no sources (no web search ran — expected)
- Retroactive discovery: `POST /api/episodes/:id/sources/discover`
- Individual source delete: `DELETE /api/sources/:id` (UI: ✕ button in Archive and Today views)

## RSS feed

- **Show title:** The Overhang
- **`<description>`**: uses `episode_summary` (Haiku-generated 2-3 sentence summary); falls back to title
- **`<content:encoded>`**: episode summary + HTML source list (real HTTP/HTTPS URLs only)
- **Cover art:** `podcast_cover_megan4.jpg` — `?v=4` for cache busting; bump `?v=N` in all three RSS occurrences to force Apple to re-fetch
- **Explicit:** `true` on channel and each item
- **Transcripts:** `<podcast:transcript>` pointing to `/episodes/:id/transcript` with `type="text/html"`
- **Namespace:** `xmlns:podcast="https://podcastindex.org/namespace/1.0"`

## Audio generation

- Multi-chunk dialogue audio concatenated from ElevenLabs API calls; ID3v2 headers stripped after first chunk
- Audio jobs are in-memory; server restart clears them (Railway restarts on deploy)
- New audio POST cancels any running job for that episode
- Episode re-read from DB right before calling ElevenLabs (uses latest saved script)
- Audio served with `Cache-Control: no-cache`; Queue player appends `?v=timestamp` on completion

## Fallback cron

- Runs daily at 9:00 AM Pacific, Sun–Fri
- Fires if no episode published in the last 3 days (drafts don't count)
- Generates a Megan-only episode, waits for audio, then auto-publishes
- Respects kill switch — skips if show is inactive
- Kill switch: `POST /api/settings/active` or the toggle in Settings UI

## Continuous learning loop

1. **Script edit tracking** — `original_script` stores AI draft. Edits summarized by Haiku into `edit_summary`. Last 5 injected into next script prompt.
2. **Listener feedback** — `feedback` table feeds into source discovery and script prompts
3. **Narrative memory** — `episode_summary` (Haiku, 2-3 sentences on central arguments). Last 5 injected for continuity. Also used as RSS `<description>`.
