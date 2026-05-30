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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
      const parsed = JSON.parse(body);
      const emails = parsed.emails || [];
      
      console.log('Received', emails.length, 'emails');
      emails.forEach((e, i) => console.log(`Email ${i+1}: ${e.subject} | ${e.from}`));

      if (!emails.length) {
        res.writeHead(200);
        res.end(JSON.stringify({ suggestions: [] }));
        return;
      }

      // Send ALL emails to AI, let it decide
      const emailList = emails.map((e, i) => 
        `${i+1}. From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`
      ).join('\n\n');

      const prompt = `You are reviewing emails for Mohammad Rohiim. Find ONLY emails that require Mohammad to personally take action.

Flag these as tasks:
- "submit", "submission", "please send", "need you to", "reminder", "due", "by tomorrow", "mark these papers", "review"
- Emails sent from Mohammad to himself as reminders
- Personal requests from real people

Do NOT flag: GitHub security alerts, Netlify service emails, bank transaction receipts, promotional emails, automated system notifications, flight price alerts

Return ONLY a valid JSON array, nothing else:
[{"task":"task description","priority":"p1 or p2 or p3","due":"when","from":"sender name"}]

If nothing actionable, return exactly: []

Emails:
${emailList}`;

      console.log('Sending', emails.length, 'emails to Anthropic');

      const payload = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      });

      const result = await httpsPost('api.anthropic.com', '/v1/messages', {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }, payload);

      console.log('Anthropic status:', result.status);

      const aiData = JSON.parse(result.body);

      if (aiData.error) {
        console.error('Anthropic error:', JSON.stringify(aiData.error));
        res.writeHead(500);
        res.end(JSON.stringify({ error: aiData.error.message, suggestions: [] }));
        return;
      }

      const text = aiData.content?.[0]?.text || '[]';
      console.log('AI response:', text);

      let suggestions = [];
      try {
        const clean = text.trim().replace(/```json|```/g, '').trim();
        suggestions = JSON.parse(clean);
      } catch(e) {
        console.error('Parse error:', e.message);
        suggestions = [];
      }

      console.log('Suggestions:', suggestions.length);
      res.writeHead(200);
      res.end(JSON.stringify({ suggestions }));
    } catch(err) {
      console.error('Server error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message, suggestions: [] }));
    }
  });
}).listen(process.env.PORT || 3000, () => console.log('Email scanner running'));
