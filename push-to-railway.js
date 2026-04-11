#!/usr/bin/env node
// Push a locally approved episode script to the Railway production server.
// This imports the script as a draft, triggers audio generation, then optionally
// schedules or immediately publishes it.
//
// Usage:
//   node push-to-railway.js --episode episodes/2026-04-11-what-is-this-podcast.txt
//   node push-to-railway.js --episode episodes/2026-04-11-what-is-this-podcast.txt --publish
//   node push-to-railway.js --episode episodes/2026-04-11-what-is-this-podcast.txt --date 2026-04-12
//   node push-to-railway.js --episode episodes/2026-04-11-what-is-this-podcast.txt --date 2026-04-12 --title "My Title"

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://course-podcast-v0-production.up.railway.app';

// ─── ARGS ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const episodePath = get('--episode');
const publishDate = get('--date');
const customTitle = get('--title');
const publishNow  = args.includes('--publish');

if (!episodePath) {
  console.log('\nUsage:');
  console.log('  node push-to-railway.js --episode <path> [--date YYYY-MM-DD] [--title "..."] [--publish]\n');
  console.log('  --date     Schedule for a future date (auto-publishes at midnight Pacific)');
  console.log('  --publish  Publish immediately after audio generates');
  console.log('  (no flag)  Import as draft — manage from Queue tab in the web UI\n');
  process.exit(1);
}

if (!fs.existsSync(episodePath)) {
  console.error(`❌ File not found: ${episodePath}`);
  process.exit(1);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function inferTitle(filePath) {
  const base = filePath.split('/').pop().replace('.txt', '');
  return base.replace(/-/g, ' ').replace(/^\d{4} \d{2} \d{2} /, '').trim();
}

async function poll(url, interval, timeout, check) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    const { data } = await axios.get(url);
    const result = check(data);
    if (result !== null) return result;
  }
  throw new Error('Timed out');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  const script = fs.readFileSync(episodePath, 'utf8').trim();
  const title = customTitle || inferTitle(episodePath);
  const wordCount = script.split(/\s+/).length;

  console.log(`\n📤 Pushing to Railway: ${RAILWAY_URL}`);
  console.log(`   File:  ${episodePath}`);
  console.log(`   Title: ${title}`);
  console.log(`   ~${Math.round(wordCount / 150)} min (${wordCount} words)\n`);

  // Step 1: Import as draft
  process.stdout.write('1. Importing script as draft... ');
  const { data: episode } = await axios.post(`${RAILWAY_URL}/api/episodes/import`, {
    script,
    title,
    episode_type: 'dialogue'
  });
  console.log(`✓ (Episode #${episode.number}, id=${episode.id})`);

  // Step 2: Generate audio on Railway
  process.stdout.write('2. Triggering audio generation... ');
  await axios.post(`${RAILWAY_URL}/api/episodes/${episode.id}/audio`);
  console.log('✓ (started)');

  process.stdout.write('   Waiting for audio');
  const audioResult = await poll(
    `${RAILWAY_URL}/api/episodes/${episode.id}/audio/status`,
    10000, 15 * 60 * 1000,
    (data) => {
      process.stdout.write('.');
      if (data.status === 'complete') return data;
      if (data.status === 'error') throw new Error(`Audio failed: ${data.error}`);
      return null;
    }
  );
  console.log(` ✓ (${audioResult.filename})`);

  // Step 3: Set status
  if (publishNow) {
    process.stdout.write('3. Publishing... ');
    await axios.patch(`${RAILWAY_URL}/api/episodes/${episode.id}/status`, { status: 'published' });
    console.log('✓ Live in RSS feed.');
  } else if (publishDate) {
    process.stdout.write(`3. Scheduling for ${publishDate}... `);
    await axios.patch(`${RAILWAY_URL}/api/episodes/${episode.id}/status`, {
      status: 'scheduled',
      publish_at: publishDate
    });
    console.log('✓ Will auto-publish at midnight Pacific.');
  } else {
    console.log('3. Left as draft. Manage from Queue tab in the web UI.');
    console.log(`   ${RAILWAY_URL}  →  Queue tab`);
  }

  console.log(`\n✅ Done. Episode #${episode.number} is on Railway.\n`);
})().catch(err => {
  const msg = err.response?.data?.error || err.message;
  console.error('\n❌ Error:', msg);
  process.exit(1);
});
