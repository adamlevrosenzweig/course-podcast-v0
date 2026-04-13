---
name: generate
description: Generate a new episode of The Overhang podcast. Accepts an optional topic and --megan flag for Megan-only episodes. Polls until complete and surfaces the draft.
disable-model-invocation: true
---

Generate a new episode of The Overhang podcast.

**Auth:** !`security find-generic-password -a "podcast-admin" -s "course-podcast-v0" -w`
**Base URL:** https://course-podcast-v0-production.up.railway.app

**Arguments:** $ARGUMENTS
Format: `[topic]` for dialogue, `[topic] --megan` for Megan-only. Topic is optional.

**Steps:**

1. Parse ARGUMENTS:
   - If `--megan` is present, episode_type = `megan_only`, strip `--megan` from topic
   - Otherwise episode_type = `dialogue`
   - Remaining text is the topic (omit the field if blank)

2. Start generation:
   ```
   curl -s -X POST {BASE_URL}/api/episodes/generate \
     -H "x-api-key: {AUTH}" \
     -H "Content-Type: application/json" \
     -d '{"episode_type":"{type}","topic":"{topic}"}'
   ```
   Report the episode ID returned.

3. Poll `GET /api/episodes/generate/status` with x-api-key every 15 seconds.
   Print each status step as it comes in so the user can follow progress.
   Stop when status is `complete` or `error`. (Timeout after 10 minutes.)

4. On `complete`: fetch `GET /api/episodes/{id}` and show:
   - Title
   - Episode type
   - Source count
   - First 300 characters of the script
   - Prompt to review in the Queue UI or ask for edits here

5. On `error`: report the error message clearly.
