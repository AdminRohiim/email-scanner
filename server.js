const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
app.use(cors());
app.use(express.json());

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const GROQ_KEY = process.env.GROQ_KEY;
const UPSTASH_URL = process.env.UPSTASH_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;

// ── UPSTASH HELPERS ──
async function redisGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(key, value) {
  await fetch(`${UPSTASH_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
}

// ── SEND TELEGRAM MESSAGE ──
async function sendTG(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// ── TRANSCRIBE WITH GROQ WHISPER ──
async function transcribeAudio(fileBuffer, mimeType) {
  const form = new FormData();
  form.append('file', fileBuffer, { filename: 'audio.ogg', contentType: mimeType || 'audio/ogg' });
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'json');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}`, ...form.getHeaders() },
    body: form
  });
  const data = await res.json();
  if (!data.text) throw new Error(data.error?.message || 'Transcription failed');
  return data.text.trim();
}

// ── PARSE TASK FROM TRANSCRIPT ──
function parseTask(transcript) {
  const lower = transcript.toLowerCase();

  // Priority detection
  let priority = 'p2';
  if (lower.includes('urgent') || lower.includes('asap') || lower.includes('immediately') || lower.includes('p1')) priority = 'p1';
  else if (lower.includes('low priority') || lower.includes('whenever') || lower.includes('no rush') || lower.includes('p3')) priority = 'p3';
  else if (lower.includes('backlog') || lower.includes('someday') || lower.includes('p4')) priority = 'p4';

  // Due date detection
  let due = 'No deadline';
  if (lower.includes('today')) due = 'Today';
  else if (lower.includes('tomorrow')) due = 'Tomorrow';
  else if (lower.includes('this week') || lower.includes('end of week')) due = 'This week';
  else if (lower.includes('monday')) due = 'Monday';
  else if (lower.includes('tuesday')) due = 'Tuesday';
  else if (lower.includes('wednesday')) due = 'Wednesday';
  else if (lower.includes('thursday')) due = 'Thursday';
  else if (lower.includes('friday')) due = 'Friday';
  else if (lower.includes('next week')) due = 'Next week';

  // Clean up task name — strip filler words
  let name = transcript
    .replace(/^(add|create|new|remind me to|remind me|task|remember to|note|i need to|i want to|please|can you|could you)\s+/i, '')
    .replace(/\s+(as a task|to my tasks|to my list|to my dashboard)$/i, '')
    .trim();

  // Capitalise first letter
  name = name.charAt(0).toUpperCase() + name.slice(1);

  return { name, priority, due };
}

// ── TELEGRAM WEBHOOK ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Ack Telegram immediately

  const message = req.body?.message;
  if (!message) return;

  const chatId = message.chat?.id;
  const voice = message.voice || message.audio;

  // Only handle voice/audio from your own chat
  if (String(chatId) !== String(TG_CHAT)) {
    await sendTG(chatId, '⛔ Unauthorised.');
    return;
  }

  if (!voice) {
    // Text message — check if it's a /tasks command
    const text = message.text || '';
    if (text === '/tasks') {
      const tasks = await redisGet('pa_voice_tasks') || [];
      const pending = tasks.filter(t => !t.done);
      if (pending.length === 0) {
        await sendTG(chatId, '✅ No pending voice tasks!');
      } else {
        const lines = pending.map(t => `• [${t.priority.toUpperCase()}] ${t.name} — ${t.due}`).join('\n');
        await sendTG(chatId, `🎙️ <b>Voice tasks pending (${pending.length}):</b>\n${lines}`);
      }
    } else {
      await sendTG(chatId, '🎙️ Send me a voice note and I\'ll add it as a task to your dashboard!\n\nExample: <i>"Add a meeting with the design team for tomorrow"</i>\n\nCommands:\n/tasks — list pending voice tasks');
    }
    return;
  }

  try {
    await sendTG(chatId, '🎙️ Got your voice note — transcribing...');

    // Get file from Telegram
    const fileRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${voice.file_id}`);
    const fileData = await fileRes.json();
    const filePath = fileData.result?.file_path;
    if (!filePath) throw new Error('Could not get file path from Telegram');

    const audioRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Transcribe
    const transcript = await transcribeAudio(audioBuffer, voice.mime_type || 'audio/ogg');
    await sendTG(chatId, `📝 Heard: "<i>${transcript}</i>"\n\nParsing as task...`);

    // Parse
    const task = parseTask(transcript);

    // Save to Upstash
    const existing = await redisGet('pa_voice_tasks') || [];
    const newTask = {
      id: `voice_${Date.now()}`,
      name: task.name,
      priority: task.priority,
      due: task.due,
      done: false,
      source: 'voice',
      createdAt: new Date().toISOString()
    };
    existing.push(newTask);
    await redisSet('pa_voice_tasks', existing);

    const priorityEmoji = { p1: '🔴', p2: '🟡', p3: '🟢', p4: '⚪' }[task.priority] || '🟡';
    await sendTG(chatId,
      `✅ <b>Task added to your dashboard!</b>\n\n` +
      `📌 ${task.name}\n` +
      `${priorityEmoji} Priority: ${task.priority.toUpperCase()}\n` +
      `📅 Due: ${task.due}`
    );

  } catch (err) {
    console.error('Voice task error:', err);
    await sendTG(chatId, `❌ Sorry, something went wrong: ${err.message}`);
  }
});

// ── REST ENDPOINT: Dashboard polls this ──
app.get('/voice-tasks', async (req, res) => {
  try {
    const tasks = await redisGet('pa_voice_tasks') || [];
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── REST ENDPOINT: Dashboard syncs task state back ──
app.post('/voice-tasks/sync', async (req, res) => {
  try {
    const { tasks } = req.body;
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be array' });
    await redisSet('pa_voice_tasks', tasks);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'ok', service: 'PA Voice Backend' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PA backend running on port ${PORT}`));
