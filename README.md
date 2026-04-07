# Course Podcast Briefing

A daily AI-generated podcast briefing for two UC Berkeley Haas courses:
- **Intimate Technology** (UGBA [TBD]) — how technology mediates human intimacy, vulnerability, and connection
- **Social Impact Strategy in Commercial Tech** (MBA 290T) — how commercial tech companies navigate social impact

## What it does

Each day, the app:
1. Searches the web for relevant news and articles (via Anthropic + web search)
2. Synthesizes a podcast script with a narrative thread across both courses
3. Generates audio using ElevenLabs (voice: Megan – Light and Clear)

You can also contribute specific URLs to include in the next episode.

## Tech stack

- **Backend**: Node.js / Express
- **Database**: SQLite (Node 22 built-in `node:sqlite`)
- **AI**: Anthropic API (`claude-sonnet-4-20250514`) with `web_search_20250305` tool
- **Audio**: ElevenLabs text-to-speech API
- **Frontend**: React (CDN), Tailwind (CDN) — no build step
- **Hosting**: Railway

## Pages

| Page | Description |
|------|-------------|
| Today | Generate today's episode, play/download audio |
| Archive | Browse all past episodes |
| Sources | Searchable repository of all articles used |
| Contribute | Submit URLs to include in the next episode |
| Themes | Manage active topic themes per course |
| Settings | Configure voice, view API status |

## Deployment

Hosted on Railway at: `https://course-podcast-v0-production.up.railway.app`

### Environment variables (set in Railway dashboard)

```
ANTHROPIC_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=E393dkE75hqtz1LO2aEJ
BASE_URL=https://course-podcast-v0-production.up.railway.app
PORT=3000
DATA_DIR=/data
AUDIO_DIR=/data/audio
```

### Persistent storage (required — do this once)

By default Railway's filesystem resets on every deploy, wiping the database and audio files. To make data persist, you need to add a **Railway Volume**:

1. Go to [railway.app](https://railway.app) → your project → your service
2. Click **+ Add Volume** (in the service settings, under the "Volumes" section)
3. Set **Mount Path** to `/data`
4. Click **Add**
5. In the service **Variables** tab, add (or confirm):
   - `DATA_DIR` = `/data`
   - `AUDIO_DIR` = `/data/audio`
6. Railway will redeploy. After this, episodes and audio survive restarts and redeploys.

### Local development

```bash
git clone https://github.com/adamlevrosenzweig/course-podcast-v0
cd course-podcast-v0
npm install
cp .env.example .env   # fill in API keys; leave DATA_DIR/AUDIO_DIR unset for local defaults
node --no-warnings server.js
```

Requires Node 22.5+.

## How generation works (important)

Both episode generation and audio generation are **long-running tasks** — too long for a normal HTTP request. Railway's proxy cuts connections after 60 seconds, and a full episode cycle (web search + script + audio) takes 3–5 minutes.

The fix: both operations use a **background job + polling** pattern:

1. Clicking "Generate today's episode" or "Generate Audio" triggers a POST that returns immediately with a job ID
2. The actual work runs in the background on the server
3. The UI polls for status every 3 seconds and shows live progress ("Searching for sources…", "Generating audio with ElevenLabs…")
4. When the job completes, the UI updates automatically

## Editing the app over time

All logic lives in two files: `server.js` (backend) and `public/index.html` (frontend). You can edit either directly in GitHub — no local setup needed. Railway picks up the change and redeploys automatically in about 60 seconds.

**To edit a file in GitHub:**
1. Open the file on GitHub (e.g. `server.js`)
2. Click the pencil icon (Edit this file) in the top right
3. Make your changes
4. Click **Commit changes** → add a short message → **Commit directly to main**
5. Railway redeploys automatically — check the Railway dashboard to confirm

---

### Changing episode length or style

The episode script is controlled by `scriptPrompt` in `server.js`. Find the block that starts with `const scriptPrompt = \`...`.

Examples of what you can change:

| Goal | What to edit |
|------|-------------|
| Longer episodes | Change the word/minute target in the prompt |
| More academic tone | Add: `Use a more analytical, lecture-style tone suitable for MBA students.` |
| Focus on one course | Remove the other course from the prompt |
| Add a recurring segment | Add: `End every episode with a "Question of the Day" for class discussion.` |

---

### Changing the courses covered

The course descriptions are embedded in `discoveryPrompt` and `scriptPrompt` inside `server.js`. Search for "Intimate Technology" to find the right spots and edit the course names and descriptions there.

---

### Changing the voice

Go to **Settings** in the app and select a different ElevenLabs voice, or update `ELEVENLABS_VOICE_ID` in the Railway environment variables dashboard directly.

---

### Changing what the frontend looks like

`public/index.html` contains all the React UI. The layout, colors (Tailwind classes), tab names, and copy are all in that file. Edit and commit — changes appear after Railway redeploys.

---

### Apple Podcasts / RSS feed

The app exposes a podcast RSS feed at:

```
https://course-podcast-v0-production.up.railway.app/feed.xml
```

To add it to Apple Podcasts: **File → Follow a Podcast… → paste the URL.**

---

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/episodes` | List all episodes |
| POST | `/api/episodes/generate` | Start background episode generation |
| GET | `/api/episodes/generate/status` | Poll episode generation job status |
| POST | `/api/episodes/:id/audio` | Start background audio generation (ElevenLabs) |
| GET | `/api/episodes/:id/audio/status` | Poll audio generation job status |
| GET | `/api/sources` | Search all sources |
| GET/POST | `/api/themes` | List or add themes |
| POST | `/api/contributed` | Submit a URL |
| GET | `/api/voices` | List ElevenLabs voices |
| GET | `/api/config` | Check API key status |
| GET | `/feed.xml` | Apple Podcasts–compatible RSS feed |
