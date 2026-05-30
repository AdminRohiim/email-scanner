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
      console.log('Received emails:', emails.length);

      const emailList = emails.map((e, i) =>
        `${i+1}. From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`
      ).join('\n\n');

      console.log('Full email list:\n', emailList);

      const payload = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Find emails requiring Mohammad to take action. Return ONLY a JSON array.

Examples of tasks: submitting work, marking papers, replying to colleagues, paying bills.
Ignore: GitHub alerts, Netlify alerts, bank transaction receipts, promotions, flight prices.

Format: [{"task":"description","priority":"p1","due":"when","from":"who"}]
If none: []

Emails:
${emailList}`
        }]
      });

      const result = await httpsPost('api.anthropic.com', '/v1/messages', {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }, payload);

      console.log('Anthropic status:', result.status);
      const aiData = JSON.parse(result.body);
      console.log('AI raw response:', result.body.substring(0, 500));

      const text = aiData.content?.[0]?.text || '[]';
      let suggestions = [];
      try {
        suggestions = JSON.parse(text.trim().replace(/```json|```/g, '').trim());
      } catch(e) {
        console.error('Parse error:', e.message, 'text:', text);
      }

      console.log('Suggestions:', JSON.stringify(suggestions));
      res.writeHead(200);
      res.end(JSON.stringify({ suggestions }));
    } catch(err) {
      console.error('Error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message, suggestions: [] }));
    }
  });
}).listen(process.env.PORT || 3000, () => console.log('Email scanner running'));
