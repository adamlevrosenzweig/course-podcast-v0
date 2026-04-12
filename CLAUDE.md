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

Public routes (no auth required): `/feed.xml`, `/audio/*`, `/episodes/:id/transcript`, and all static image files (jpg, png, svg, etc.). The auth guard must explicitly exempt these — `express.static` runs AFTER the guard.

## API endpoints (key ones)

- `POST /api/episodes/generate` — starts async episode generation job
- `GET /api/episodes/generate/status` — poll generation progress
- `POST /api/episodes/:id/audio` — starts async audio generation; cancels any running job for that episode first
- `GET /api/episodes/:id/audio/status` — poll audio progress
- `GET /episodes/:id/transcript` — public; returns published episode script as `text/html`
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

### Intros and outros (hardcoded, not generated)
All four constants require the `MEGAN:` speaker prefix.

- **`INTRO_DIALOGUE`**: Brief opener only — "Hey, I'm Megan, co-host of The Overhang. Let's get into it." No voice disclosure here.
- **`INTRO_MEGAN_ONLY`**: Megan intro + voice disclosure (she's the only voice, so it belongs here).
- **`OUTRO_DIALOGUE`** / **`OUTRO_MEGAN_ONLY`**: Brief accuracy caveat only. No voice disclosure in the outro.

### Voice disclosure in dialogue episodes
The generated script body (not the hardcoded intro) must include a natural disclosure in the first 1–2 exchanges that both voices are AI-generated — Adam's is a clone (ElevenLabs), Megan's is fully synthetic (ElevenLabs). This is a prompt requirement, not hardcoded. It should sound like something Adam would actually say, not a legal disclaimer.

### Adam's dialogue style
- Casual register — contractions, sentence fragments, natural profanity ("shit," "fucking," "damn")
- Sounds like office hours, not a lecture. No formal transitions or academic hedging.
- Gets excited, goes on tangents, occasionally disappears into the weeds before catching himself.

### Megan's dialogue style
- The straight voice — clear, grounded, always the listener's advocate
- Warm with listeners; dry wit with Adam
- When Adam goes off-rails, she reels him in patiently with light humor ("You're spiraling a little — bring it back.")
- Does not moralize or editorialize. Smart, not smug.

### Other conventions
- **Title format:** `#N - Title - Month DD, YYYY` — generated at episode creation time, not at publish time.
- **Imported episodes** (via `push-to-railway.js`) have no sources in the DB — that's expected, no web search ran.

## RSS feed

- **Show title:** The Overhang
- **Description:** "The overhang is the space between what technology can do and what society can handle. Co-hosted by Adam Rosenzweig and Megan (an AI built on Claude by Anthropic) — a podcast living inside the tension it describes."
- **Cover art:** `podcast_cover_megan4.jpg` — 3000×3000 JPEG (Apple requires min 1400×1400)
- **Explicit:** `true` on both channel and each episode item
- **Show notes:** `<content:encoded>` contains episode_summary (or script excerpt) + HTML source list. Sources filtered to real HTTP/HTTPS URLs only — no pseudo-URLs.
- **`<description>` tag:** Uses `episode_summary` if available, otherwise script excerpt.
- **Transcripts:** `<podcast:transcript>` tag on each episode pointing to `/episodes/:id/transcript` with `type="text/html"`. Apple does not support `text/plain`.
- **Episode art:** `<itunes:image>` on every item (same cover as show).
- **Namespace:** `xmlns:podcast="https://podcastindex.org/namespace/1.0"` required for transcript tags.
- **Cache-busting:** Image URL includes `?v=N` — increment when replacing the image file to force Apple to re-fetch.

## Audio generation

- Multi-chunk dialogue audio concatenated from ElevenLabs API calls; ID3v2 headers stripped from chunks after the first (prevents browser from reading only the first chunk's duration).
- Audio jobs are in-memory (`audioJobs` object); server restart clears them (Railway restarts on every deploy).
- When a new audio POST arrives, any running job for that episode is **cancelled** — new job always starts fresh. The async job checks for cancellation before writing output.
- Episode is **re-read from DB** inside the async job body right before calling ElevenLabs — not captured at request time. This ensures regenerated audio always uses the latest saved script.
- Audio files served with `Cache-Control: no-cache`.
- Queue page appends `?v={timestamp}` to audio src when a job completes, forcing browser to fetch the new file.
- Queue tab reconnects to in-progress audio jobs on mount — navigating away and back resumes status polling.

## Fallback cron

- Runs daily at 9:00 AM Pacific, Sun–Fri
- Fires if no episode has been **published** in the last 3 days (drafts don't count)
- Generates a Megan-only episode, waits for audio, then **auto-publishes**
- Guarantees a maximum ~4-day gap between published episodes
- Respects the kill switch — skips silently if the show is inactive

## Continuous learning loop

The app improves its own output over time using three feedback mechanisms, all injected into the script generation prompt:

1. **Script edit tracking** — `original_script` stores the AI-generated draft (never overwritten). When Adam saves edits, a Haiku call summarizes what changed and stores it in `edit_summary`. Last 5 edit summaries are injected into the next script prompt.
2. **Listener feedback → script writing** — the `feedback` table feeds into both the source discovery prompt and the script writing prompt.
3. **Cross-episode narrative memory** — after each episode is generated, a Haiku call writes a 2-3 sentence `episode_summary` of the episode's central arguments. Last 5 summaries are injected into the next script prompt for narrative continuity.
