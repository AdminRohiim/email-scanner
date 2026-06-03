const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Supports both your existing env names and the v11 package env names.
const TG_TOKEN = process.env.TG_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT || process.env.TELEGRAM_ALLOWED_CHAT_ID;
const GROQ_KEY = process.env.GROQ_KEY;
const UPSTASH_URL = process.env.UPSTASH_URL || process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || process.env.KV_REST_API_TOKEN;
const TASK_SYNC_SECRET = process.env.TASK_SYNC_SECRET || '';

const TASK_KEY = 'pa_voice_tasks';

// ── BASIC CONFIG CHECK ──
function getMissingEnv() {
  const missing = [];
  if (!TG_TOKEN) missing.push('TG_TOKEN or TELEGRAM_BOT_TOKEN');
  if (!TG_CHAT) missing.push('TG_CHAT or TELEGRAM_ALLOWED_CHAT_ID');
  if (!GROQ_KEY) missing.push('GROQ_KEY');
  if (!UPSTASH_URL) missing.push('UPSTASH_URL or KV_REST_API_URL');
  if (!UPSTASH_TOKEN) missing.push('UPSTASH_TOKEN or KV_REST_API_TOKEN');
  return missing;
}

// ── UPSTASH HELPERS ──
async function redisGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
}

async function redisSet(key, value) {
  const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Upstash set failed: ${txt}`);
  }
}

function validateSecret(req, res) {
  if (!TASK_SYNC_SECRET) return true;
  const supplied = req.query.secret || req.body?.secret || req.headers['x-sync-secret'];
  if (supplied !== TASK_SYNC_SECRET) {
    res.status(401).json({ error: 'Invalid sync secret' });
    return false;
  }
  return true;
}

// ── SEND TELEGRAM MESSAGE ──
async function sendTG(chatId, text) {
  if (!TG_TOKEN) return;
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
  form.append('language', 'en');
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

function normaliseDateText(text) {
  const lower = text.toLowerCase();
  const monthRegex = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const monthDate = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${monthRegex}(?:\\s+(\\d{4}))?\\b`, 'i'));
  if (monthDate) {
    const day = monthDate[1];
    const month = monthDate[2];
    const year = monthDate[3] || new Date().getFullYear();
    return `${day} ${month} ${year}`;
  }
  const isoDate = lower.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoDate) return isoDate[0];
  const slashDate = lower.match(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/);
  if (slashDate) return slashDate[0];
  return null;
}

// ── PARSE TASK FROM TRANSCRIPT ──
function parseTask(transcript) {
  const lower = transcript.toLowerCase();

  let priority = 'p2';
  if (lower.includes('urgent') || lower.includes('asap') || lower.includes('immediately') || lower.includes('p1')) priority = 'p1';
  else if (lower.includes('low priority') || lower.includes('whenever') || lower.includes('no rush') || lower.includes('p3')) priority = 'p3';
  else if (lower.includes('backlog') || lower.includes('someday') || lower.includes('p4')) priority = 'p4';

  let due = 'No deadline';
  const specificDate = normaliseDateText(transcript);
  if (specificDate) due = specificDate;
  else if (lower.includes('today')) due = 'Today';
  else if (lower.includes('tomorrow')) due = 'Tomorrow';
  else if (lower.includes('next week')) due = 'Next week';
  else if (lower.includes('this week') || lower.includes('end of week')) due = 'This week';
  else if (lower.includes('monday')) due = 'Monday';
  else if (lower.includes('tuesday')) due = 'Tuesday';
  else if (lower.includes('wednesday')) due = 'Wednesday';
  else if (lower.includes('thursday')) due = 'Thursday';
  else if (lower.includes('friday')) due = 'Friday';
  else if (lower.includes('saturday')) due = 'Saturday';
  else if (lower.includes('sunday')) due = 'Sunday';

  let name = transcript
    .replace(/^(add|create|new|remind me to|remind me|task|remember to|note|i need to|i want to|please|can you|could you)\s+/i, '')
    .replace(/\s+(as a task|to my tasks|to my list|to my dashboard)$/i, '')
    .replace(/\s+\b(today|tomorrow|this week|next week|end of week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/ig, '')
    .replace(/\s+\b(p1|p2|p3|p4|urgent|asap|low priority|no rush|backlog)\b/ig, '')
    .replace(/\s+by\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?/ig, '')
    .trim();

  if (!name) name = transcript.trim();
  name = name.charAt(0).toUpperCase() + name.slice(1);

  return { name, priority, due };
}

async function listQueuedTasks({ includeSynced = false } = {}) {
  const raw = await redisGet(TASK_KEY);
  const tasks = Array.isArray(raw) ? raw : [];
  return includeSynced ? tasks : tasks.filter(t => !t.synced);
}

async function saveQueuedTask(task) {
  const raw = await redisGet(TASK_KEY);
  const existing = Array.isArray(raw) ? raw : [];
  existing.push(task);
  await redisSet(TASK_KEY, existing);
  return existing;
}

// ── TELEGRAM WEBHOOK HANDLER ──
async function handleTelegramWebhook(req, res) {
  res.sendStatus(200); // Ack Telegram immediately

  try {
    console.log('Webhook received:', JSON.stringify(req.body).slice(0, 200));

    const missing = getMissingEnv();
    if (missing.length) {
      console.error('Missing environment variables:', missing.join(', '));
      return;
    }

    const message = req.body?.message;
    if (!message) { console.log('No message in body'); return; }

    const chatId = message.chat?.id;
    const voice = message.voice || message.audio;

    console.log('chatId:', chatId, 'TG_CHAT:', TG_CHAT, 'has voice:', !!voice);

    if (String(chatId) !== String(TG_CHAT)) {
      await sendTG(chatId, '⛔ Unauthorised.');
      return;
    }

    if (!voice) {
      const text = message.text || '';
      if (text === '/tasks') {
        const pending = await listQueuedTasks();
        if (pending.length === 0) {
          await sendTG(chatId, '✅ No pending voice tasks!');
        } else {
          const lines = pending.map(t => `• [${t.priority.toUpperCase()}] ${t.name} — ${t.due}`).join('\n');
          await sendTG(chatId, `🎙️ <b>Voice tasks pending (${pending.length}):</b>\n${lines}`);
        }
      } else {
        await sendTG(chatId, '🎙️ Send me a voice note and I\'ll add it as a task to your dashboard!\n\nExample: <i>"Add submit mock-up by 5 June P1"</i>\n\nCommands:\n/tasks — list pending voice tasks');
      }
      return;
    }

    await sendTG(chatId, '🎙️ Got your voice note — transcribing...');

    const fileRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${voice.file_id}`);
    const fileData = await fileRes.json();
    const filePath = fileData.result?.file_path;
    if (!filePath) throw new Error('Could not get file path from Telegram');

    const audioRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    const transcript = await transcribeAudio(audioBuffer, voice.mime_type || 'audio/ogg');
    await sendTG(chatId, `📝 Heard: "<i>${transcript}</i>"\n\nParsing as task...`);

    const task = parseTask(transcript);
    const newTask = {
      id: `voice_${Date.now()}`,
      name: task.name,
      priority: task.priority,
      due: task.due,
      done: false,
      status: 'not-started',
      source: 'voice',
      synced: false,
      createdAt: new Date().toISOString(),
      transcript
    };

    await saveQueuedTask(newTask);
    console.log('Saved task to Redis:', newTask.name);

    const priorityEmoji = { p1: '🔴', p2: '🟡', p3: '🟢', p4: '⚪' }[task.priority] || '🟡';
    await sendTG(chatId,
      `✅ <b>Task queued for your dashboard!</b>\n\n` +
      `📌 ${task.name}\n` +
      `${priorityEmoji} Priority: ${task.priority.toUpperCase()}\n` +
      `📅 Due: ${task.due}\n\n` +
      `Open your dashboard and click <b>Sync voice tasks</b>.`
    );
  } catch (err) {
    console.error('Voice task error:', err);
    const chatId = req.body?.message?.chat?.id;
    if (chatId) await sendTG(chatId, `❌ Sorry, something went wrong: ${err.message}`);
  }
}

// Telegram can point to either route.
app.post('/webhook', handleTelegramWebhook);
app.post('/api/telegram-webhook', handleTelegramWebhook);

// ── DASHBOARD COMPATIBLE ENDPOINT: v11 dashboard pulls queued voice tasks ──
app.get('/api/tasks', async (req, res) => {
  try {
    if (!validateSecret(req, res)) return;

    const consume = req.query.consume !== '0';
    const raw = await redisGet(TASK_KEY);
    const allTasks = Array.isArray(raw) ? raw : [];
    const pendingTasks = allTasks.filter(t => !t.synced);

    if (consume && pendingTasks.length > 0) {
      const updated = allTasks.map(t =>
        pendingTasks.some(p => p.id === t.id)
          ? { ...t, synced: true, syncedAt: new Date().toISOString() }
          : t
      );
      await redisSet(TASK_KEY, updated);
    }

    res.json({ tasks: pendingTasks });
  } catch (err) {
    console.error('Dashboard task sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── OLD ENDPOINT: Dashboard polls this ──
app.get('/voice-tasks', async (req, res) => {
  try {
    const includeSynced = req.query.all === '1';
    const tasks = await listQueuedTasks({ includeSynced });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OPTIONAL SYNC-BACK ENDPOINTS ──
app.post('/api/tasks/sync', async (req, res) => {
  try {
    if (!validateSecret(req, res)) return;
    const { tasks } = req.body;
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be array' });
    await redisSet(TASK_KEY, tasks);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/voice-tasks/sync', async (req, res) => {
  try {
    const { tasks } = req.body;
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be array' });
    await redisSet(TASK_KEY, tasks);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  const missing = getMissingEnv();
  res.json({
    status: missing.length ? 'missing_config' : 'ok',
    service: 'PA Voice Backend',
    routes: ['/webhook', '/api/telegram-webhook', '/api/tasks', '/voice-tasks'],
    missing
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PA backend running on port ${PORT}`));
