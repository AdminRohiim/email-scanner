const https = require('https');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

require('http').createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method !== 'POST' || req.url !== '/scan-emails') {
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { emailList } = JSON.parse(body);
      const payload = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are a task detector. Your ONLY job is to find emails that require Mohammad to DO something.

ALWAYS flag these as tasks:
- Any email with "submit", "please", "need you to", "reminder", "due", "by tomorrow", "action needed"
- Emails from the user to themselves (self-reminders)
- Requests from colleagues or managers

IGNORE: bank alerts, invoices, flight prices, newsletters, system notifications

Return ONLY a JSON array. No text, no markdown, no explanation. Just the array.
Example: [{"task":"Submit weekly workday requirement","priority":"p1","due":"Tomorrow","from":"Self"}]
If nothing actionable: []

Emails to check:
${emailList}`
        }]
      });

      const result = await httpsPost('api.anthropic.com', '/v1/messages', {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }, payload);

      const aiData = JSON.parse(result.body);
      const text = aiData.content?.[0]?.text || '[]';
      let suggestions = [];
      try {
        const clean = text.trim().replace(/```json|```/g, '').trim();
        suggestions = JSON.parse(clean);
      } catch(e) { suggestions = []; }

      res.writeHead(200);
      res.end(JSON.stringify({ suggestions }));
    } catch(err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}).listen(process.env.PORT || 3000, () => console.log('Email scanner running'));
