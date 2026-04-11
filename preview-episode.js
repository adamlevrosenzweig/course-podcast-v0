#!/usr/bin/env node
// Preview a podcast episode script as audio using ElevenLabs.
// Usage:
//   node preview-episode.js episodes/2026-04-11-what-is-this-podcast.txt
//   node preview-episode.js episodes/2026-04-11-what-is-this-podcast.txt --list-voices

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_ADAM_VOICE_ID = process.env.ELEVENLABS_ADAM_VOICE_ID;

const CHAR_LIMIT = 4800; // ElevenLabs text-to-dialogue limit is 5000 — stay under

const scriptArg = process.argv[2];
const listVoices = process.argv.includes('--list-voices');

// ─── LIST VOICES ─────────────────────────────────────────────────────────────
async function printVoices() {
  console.log('\nFetching your ElevenLabs voices...\n');
  const res = await axios.get('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });
  res.data.voices.forEach(v => console.log(`  ${v.name.padEnd(35)} ${v.voice_id}`));
  console.log('\nAdd to .env:\n  ELEVENLABS_VOICE_ID=<megan id>\n  ELEVENLABS_ADAM_VOICE_ID=<adam id>\n');
}

// ─── DIALOGUE PARSER ─────────────────────────────────────────────────────────
function parseDialogue(script) {
  const turns = [];
  for (const line of script.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(ADAM|MEGAN):\s*"?(.+?)"?$/);
    if (match) {
      turns.push({ speaker: match[1], text: match[2].trim() });
    } else if (turns.length > 0) {
      turns[turns.length - 1].text += ' ' + trimmed.replace(/^"|"$/g, '');
    } else {
      turns.push({ speaker: 'MEGAN', text: trimmed.replace(/^"|"$/g, '') });
    }
  }
  return turns.filter(t => t.text.length > 0);
}

// ─── CHUNK TURNS to stay under API character limit ───────────────────────────
// Splits an array of dialogue turns into groups where the total character
// count of all turn texts stays below CHAR_LIMIT.
function chunkTurns(turns) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const turn of turns) {
    const len = turn.text.length + turn.speaker.length + 2;
    if (current.length > 0 && currentLen + len > CHAR_LIMIT) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(turn);
    currentLen += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ─── CALL ELEVENLABS for one chunk ───────────────────────────────────────────
async function generateChunk(turns, adamVoiceId, meganVoiceId) {
  const response = await axios.post(
    'https://api.elevenlabs.io/v1/text-to-dialogue',
    {
      inputs: turns.map(t => ({
        text: t.text,
        voice_id: t.speaker === 'ADAM' ? adamVoiceId : meganVoiceId
      })),
      model_id: 'eleven_v3',
      output_format: 'mp3_44100_128'
    },
    {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 300000
    }
  );
  return Buffer.from(response.data);
}

// ─── GENERATE AUDIO ──────────────────────────────────────────────────────────
async function generatePreview(scriptPath) {
  if (!ELEVENLABS_API_KEY) { console.error('❌ ELEVENLABS_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(scriptPath)) { console.error(`❌ Not found: ${scriptPath}`); process.exit(1); }

  const script = fs.readFileSync(scriptPath, 'utf8').trim();
  const turns = parseDialogue(script);
  const wordCount = script.split(/\s+/).length;

  console.log(`\n📄 Script: ${scriptPath}`);
  console.log(`   ${turns.length} dialogue turns | ~${Math.round(wordCount / 150)} min | ${script.length} chars\n`);

  const outputPath = scriptPath.replace(/\.txt$/, '-preview.mp3');

  if (ELEVENLABS_ADAM_VOICE_ID && ELEVENLABS_VOICE_ID) {
    const chunks = chunkTurns(turns);
    console.log(`🎙️  Two-speaker dialogue — ${chunks.length} chunk(s) (${CHAR_LIMIT} char limit each)`);
    console.log(`   Megan: ${ELEVENLABS_VOICE_ID}`);
    console.log(`   Adam:  ${ELEVENLABS_ADAM_VOICE_ID}\n`);

    const buffers = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkCharCount = chunks[i].reduce((s, t) => s + t.text.length, 0);
      process.stdout.write(`   Chunk ${i + 1}/${chunks.length} (${chunkCharCount} chars)... `);
      const buf = await generateChunk(chunks[i], ELEVENLABS_ADAM_VOICE_ID, ELEVENLABS_VOICE_ID);
      buffers.push(buf);
      console.log('✓');
    }

    fs.writeFileSync(outputPath, Buffer.concat(buffers));

  } else if (ELEVENLABS_VOICE_ID) {
    console.log('⚠️  No ELEVENLABS_ADAM_VOICE_ID — using Megan for all turns.\n');
    const fullText = turns.map(t => `${t.speaker}: ${t.text}`).join('\n\n');
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      { text: fullText, model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true } },
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        responseType: 'arraybuffer', timeout: 300000 }
    );
    fs.writeFileSync(outputPath, Buffer.from(response.data));

  } else {
    console.log('⚠️  No voice IDs in .env.\n');
    await printVoices();
    process.exit(0);
  }

  console.log(`\n✅ Saved: ${outputPath}`);
  try { execSync(`open "${outputPath}"`); console.log('🔊 Opening...\n'); }
  catch (_) { console.log(`   Open manually: open "${outputPath}"\n`); }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
(async () => {
  if (!ELEVENLABS_API_KEY) { console.error('❌ ELEVENLABS_API_KEY not set'); process.exit(1); }
  if (listVoices || !scriptArg) {
    await printVoices();
    if (!scriptArg) console.log('Usage: node preview-episode.js <script.txt>\n');
    return;
  }
  await generatePreview(scriptArg);
})().catch(err => {
  const msg = err.response?.data ? Buffer.from(err.response.data).toString() : err.message;
  console.error('❌ Error:', msg);
  process.exit(1);
});
