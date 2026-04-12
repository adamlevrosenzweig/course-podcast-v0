# Course Podcast — Operational Reference

Live URL: https://course-podcast-v0-production.up.railway.app  
GitHub: https://github.com/adamlevrosenzweig/course-podcast-v0  
Railway: https://railway.com/project/e0557607  
RSS Feed: https://course-podcast-v0-production.up.railway.app/feed.xml

---

## Kill Switch

To pause the show (no new episodes generate, existing episodes stay in the feed):

```
Tell Claude: "kill the podcast"
```

Claude calls `POST /api/settings/active` with `{ "active": false }`. All generation and audio endpoints immediately return 403. The fallback cron skips silently.

To resume:

```
Tell Claude: "restart the podcast"
```

---

## Nuclear Option — Full Takedown Sequence

Use this if you want to wipe the show from the internet entirely. Do these in order.

### Step 1 — Kill the show
Tell Claude "kill the podcast" (or call `POST /api/settings/active { active: false }` directly). This stops any new episodes from generating while you complete the rest of the steps.

### Step 2 — Remove from Apple Podcasts
1. Go to [podcastsconnect.apple.com](https://podcastsconnect.apple.com)
2. Find **The Overhang**
3. Click the podcast → **My Podcasts** → select it → bottom of page → **Remove from Apple Podcasts**
4. Apple will delist it within a few days. For faster removal, submit a request via [Apple Podcasts Support](https://podcastsupport.apple.com).

> Note: Apple caches aggressively. Expect 3–7 days for full removal from search and directory listings even after you submit.

### Step 3 — Remove from Spotify (if submitted)
1. Go to [podcasters.spotify.com](https://podcasters.spotify.com)
2. Find the show → **Settings** → **Distribution** → **Remove from Spotify**

### Step 4 — Remove from other directories
If the RSS feed was submitted to Google Podcasts, Pocket Casts, Overcast, or others, each has its own removal process — typically a "Remove podcast" option in their respective dashboard or a support request with your RSS URL.

### Step 5 — Delete the Railway service
1. Go to [railway.com/project/e0557607](https://railway.com/project/e0557607)
2. Click the service → **Settings** → **Delete Service**
3. This takes down the app, the RSS feed, and all audio URLs immediately. Any podcast app that tries to fetch the feed will get a 404.

> Do this AFTER removing from Apple/Spotify — if the feed 404s before Apple processes the removal, it can complicate the delisting.

### Step 6 — Delete the GitHub repo
1. Go to [github.com/adamlevrosenzweig/course-podcast-v0](https://github.com/adamlevrosenzweig/course-podcast-v0)
2. **Settings** → scroll to bottom → **Delete this repository**
3. Type the repo name to confirm

### Step 7 — Verify
Wait 1 week, then search Apple Podcasts and Spotify for "Course Briefing Adam Rosenzweig" to confirm delisting is complete. If still showing, follow up with Apple/Spotify support directly.

---

## Episode Workflow (Coming Soon)

The full Cowork-based episode workflow — topic briefing, Adam interview, script review, and push — will be documented here once implemented.

---

## Cron Behavior

The server runs a daily check at 9:00 AM Pacific. It generates a Megan-only episode automatically if no episode has been **published** in the last 3 days (drafts don't count). The generated episode is auto-published once audio is ready. This guarantees a maximum ~4-day gap between published episodes.

The cron respects the kill switch — it skips silently if the show is inactive.

---

## Authentication (added April 2026)

The website is protected by password + TOTP (MFA). The RSS feed and audio files remain public for Apple Podcasts.

- **Login URL:** https://course-podcast-v0-production.up.railway.app/login
- **Credentials:** `APP_PASSWORD` env var + TOTP code from Authy
- **TOTP manual key (Authy backup):** `EAURM6QGIUMD6KIK`
- **Library:** `otplib@12.0.1` (pinned exact — v13 is ESM-only and breaks CommonJS)
- **Setup URL** (already used, one-time): `/setup`

### Security changes summary
- All routes require auth except `/feed.xml`, `/audio/*`, `/episodes/:id/transcript`, and static image files (jpg, png, svg, etc.)
- CORS locked to `BASE_URL` env var
- Rate limiting on generation endpoints: 5 requests/hour/IP
- `/api/config` removed (was exposing env var names)
- URL validation on `/api/contributed`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | Megan's voice ID (default: `E393dkE75hqtz1LO2aEJ`) |
| `BASE_URL` | Public deployment URL |
| `PORT` | Server port (default: 3000) |
| `DATA_DIR` | SQLite + audio storage path (must be on persistent volume) |
| `AUDIO_DIR` | Audio file storage path |
| `SESSION_SECRET` | Secret for express-session (set in Railway) |
| `ADMIN_PASSWORD` | Website login password (set in Railway) |
