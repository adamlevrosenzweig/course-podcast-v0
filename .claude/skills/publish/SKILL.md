---
name: publish
description: Publish a draft episode of The Overhang. Pass an episode ID, or leave blank to publish the most recent draft that has audio ready.
disable-model-invocation: true
---

Publish a draft episode of The Overhang podcast.

**Auth:** !`security find-generic-password -a "podcast-admin" -s "course-podcast-v0" -w`
**Base URL:** https://course-podcast-v0-production.up.railway.app

**Current episode queue:**
!`PASSWORD=$(security find-generic-password -a "podcast-admin" -s "course-podcast-v0" -w) && curl -s "https://course-podcast-v0-production.up.railway.app/api/episodes" -H "x-api-key: $PASSWORD" | python3 -c "
import sys, json
eps = json.load(sys.stdin)
for e in eps:
    audio = '✓ audio' if e.get('audio_filename') else '✗ no audio'
    print(f'ID {e[\"id\"]:>3} | {e[\"status\"]:>10} | {audio} | {e.get(\"title\",\"Untitled\")[:60]}')
"`

**Arguments:** $ARGUMENTS
(Optional: episode ID. If blank, publish the most recent draft with audio.)

**Steps:**

1. From the episode list above, identify the target:
   - If ARGUMENTS is a number, use that episode ID
   - Otherwise, find the most recent episode with status=draft and audio present
   - If no draft has audio, report that and stop

2. State the episode title and ID you're about to publish and proceed.

3. Run: `curl -s -X PATCH https://course-podcast-v0-production.up.railway.app/api/episodes/{id}/status -H "x-api-key: {AUTH}" -H "Content-Type: application/json" -d '{"status":"published"}'`

4. Confirm success. Note that WebSub automatically pings Apple Podcasts — the episode should appear within minutes.
