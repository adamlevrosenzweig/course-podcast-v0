# Course Podcast Briefing

A daily AI-generated podcast briefing for two UC Berkeley Haas courses:
- **Intimate Technology** (UGBA [TBD]) — how technology mediates human intimacy, vulnerability, and connection
- **Social Impact Strategy in Commercial Tech** (MBA 290T) — how commercial tech companies navigate social impact

## What it does

Each day, the app:
1. Searches the web for relevant news and articles (via Anthropic + web search)
2. Synthesizes a 5–10 minute podcast script with a narrative thread across both courses
3. Generates audio using ElevenLabs (voice: Megan – Light and Clear)

You can also contribute specific URLs to include in the next episode.

## Tech stack

- **Backend**: Node.js / Express
- **Database**: SQLite (Node 22 built-in `node:sqlite`)
- **AI**: Anthropic API (`claude-sonnet-4-20250514`) with `web_search_20250305` tool
- **Audio**: ElevenLabs text-to-speech API
- **Frontend**: React (CDN), Tailwind (CDN) — no build step
- **Hosting**: Railway (with persistent volume for DB + audio files)

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
PORT=3000
```

### Local development

```bash
git clone https://github.com/adamlevrosenzweig/course-podcast-v0
cd course-podcast-v0
npm install
cp .env.example .env   # fill in your API keys
node --no-warnings server.js
```

Requires Node 22.5+.

## Making changes

**To edit the frontend** (`public/index.html`): edit the file in GitHub → Railway redeploys automatically in ~1 min.

**To add API routes** (`server.js`): same — edit in GitHub, auto-redeploy.

**To add themes**: use the Themes page in the app, or POST to `/api/themes`.

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/episodes` | List all episodes |
| POST | `/api/episodes/generate` | Generate today's episode (Anthropic + web search) |
| POST | `/api/episodes/:id/audio` | Generate audio for an episode (ElevenLabs) |
| GET | `/api/sources` | Search all sources |
| GET/POST | `/api/themes` | List or add themes |
| POST | `/api/contributed` | Submit a URL |
| GET | `/api/voices` | List ElevenLabs voices |
| GET | `/api/config` | Check API key status |
