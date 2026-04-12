# course-podcast-v0

A daily AI-generated podcast briefing app for Adam Rosenzweig's UC Berkeley Haas courses.

## What it does

Searches the web for recent news relevant to two courses, writes a podcast script, generates audio via ElevenLabs TTS, and serves everything via a React single-page app. Episodes can be dialogue (two voices: Adam + Megan) or monologue (Megan only).

## Tech stack

- **Backend**: Node.js + Express, SQLite (better-sqlite3), node-cron
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
- `compile-scripts.js` — compiles all episode scripts into a running log
- `push-to-railway.js` — CLI tool to push draft episodes

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
2. `x-api-key` header — pass `ADMIN_PASSWORD` value directly, no session needed (used by CLI tools)

## API endpoints (key ones)

- `POST /api/episodes/generate` — starts async episode generation job
- `GET /api/episodes/generate/status` — poll generation progress
- `POST /api/episodes/:id/audio` — starts async audio generation
- `GET /api/episodes/:id/audio/status` — poll audio progress
- `PATCH /api/episodes/:id/script` — update script and/or title
- `PATCH /api/episodes/:id` — update status, publish_at, etc.
- `POST /api/episodes/:id/sources/discover` — run web search to retroactively find sources for an episode (synchronous, ~10–20s)
- `POST /api/contributed` — add URL, pasted text, or file to source queue
- `GET /api/contributed` — list contributed sources

## Contribute endpoint — text/file support

URL field is optional. For text/file contributions, pass no `url` and put content in `note`:
- Paste: `note = "[TITLE: ...]\n{content}\n[CURATOR NOTE: ...]"`
- File: `note = "[FILE: filename]\n{content}\n[CURATOR NOTE: ...]"`

The server assigns a `text://paste-{timestamp}` pseudo-URL so the NOT NULL constraint is satisfied.

## Deployment

Push to `main` → Railway auto-deploys in ~60 seconds.
Live URL: https://course-podcast-v0-production.up.railway.app/

## Script authoring conventions

- **Intros:** Always hardcoded, always Megan-only (even in dialogue episodes). She discloses both voices as AI: hers fully synthetic (ElevenLabs), Adam's a clone of his real voice (also ElevenLabs).
- **Outros:** Always hardcoded, always Megan-only. Appended after the generated episode content. Reminds listeners the show is made with AI and to verify anything that matters.
- **Adam's dialogue style:** Casual register — contractions, sentence fragments, natural profanity ("shit," "fucking," "damn"). Sounds like office hours, not a lecture. No formal transitions or academic hedging.
- **Title format:** `#N - Title - Month DD, YYYY` — generated at episode creation time, not at publish time.
- **Imported episodes** (via `push-to-railway.js`) have no sources in the DB — that's expected, no web search ran.

## RSS feed metadata

- **Show title:** The Overhang
- **Description:** "The overhang is the space between what technology can do and what society can handle. Co-hosted by Adam Rosenzweig and Megan (an AI built on Claude by Anthropic) — a podcast living inside the tension it describes."
- **Cover art:** `podcast_cover_megan4.jpg` (served from `/public/`)
- **Show notes:** Each episode's `<content:encoded>` is an HTML list of sources from the `sources` table. Episodes with no sources get an empty block.

## Continuous learning loop

The app improves its own output over time using three feedback mechanisms, all injected into the script generation prompt:

1. **Script edit tracking** — `original_script` stores the AI-generated draft (never overwritten). When Adam saves edits, a Haiku call summarizes what changed and stores it in `edit_summary`. Last 5 edit summaries are injected into the next script prompt.
2. **Listener feedback → script writing** — the `feedback` table feeds into both the source discovery prompt and the script writing prompt.
3. **Cross-episode narrative memory** — after each episode is generated, a Haiku call writes a 2-3 sentence `episode_summary` of the episode's central arguments. Last 5 summaries are injected into the next script prompt for narrative continuity.

## Recent changes (April 2026)

- Fixed corrupt server.js (null bytes from failed base64 encoding)
- Added x-api-key header support to `requireAuth`
- Contribute tab now accepts URL, pasted text, and file upload
- Queue tab edit-script view: editable title + "Save & regenerate audio" button
- Restored RSS feed title/description to The Overhang branding (had been overwritten)
- Megan-only intros with dual voice disclosure; fixed outros appended to every episode
- Adam's dialogue style prompt updated for casual/vernacular register with natural profanity
- RSS show notes now include sources via `<content:encoded>`
- Added continuous learning loop: script edit tracking, feedback routing to writer, cross-episode narrative memory
- Added retroactive source discovery (`POST /api/episodes/:id/sources/discover`) with UI button in Archive and Today views
- Fixed audio player duration: strip ID3v2 headers from concatenated MP3 chunks so browser reports correct total length
- Updated RSS cover art to `podcast_cover_overhang1.png`
