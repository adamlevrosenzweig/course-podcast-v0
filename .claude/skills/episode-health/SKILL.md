---
name: episode-health
description: Scan all episodes of The Overhang and flag any with missing summaries, audio durations, show notes, or sources. Run at the start of a session to catch issues early.
---

Run a health check on all episodes of The Overhang podcast.

**All episodes:**
!`PASSWORD=$(security find-generic-password -a "podcast-admin" -s "course-podcast-v0" -w) && curl -s "https://course-podcast-v0-production.up.railway.app/api/episodes?limit=100" -H "x-api-key: $PASSWORD"`

**Check each episode for the following issues:**

| Flag | Condition |
|------|-----------|
| ✗ no summary | `episode_summary` is null or empty |
| ✗ no duration | has `audio_filename` but `audio_duration_seconds` is null/0 |
| ✗ no show notes | has `audio_filename` but `show_notes` is null or empty |
| ✗ no sources | `source_count` is 0 (published episodes only) |
| ✗ no audio | `status = published` but `audio_filename` is null |

**Output format:**

Print a table:
```
ID  | Title                        | Status    | Issues
----|------------------------------|-----------|--------
  1 | Short title · Apr 7, 2026    | published | ✓ healthy
  2 | Short title · Apr 8, 2026    | published | ✗ no duration
  6 | Short title · Apr 13, 2026   | draft     | ✗ no summary, ✗ no show notes
```

After the table, list available fixes for any issues found:
- Resync all summaries + show notes: `POST /api/admin/migrate/resync-summaries`
- Resync all durations: `POST /api/admin/migrate/resync-durations`
- Re-summarize one episode: `POST /api/episodes/{id}/summarize`
- Regenerate show notes: `POST /api/episodes/{id}/show-notes/generate`

If all episodes are healthy, say so clearly.
