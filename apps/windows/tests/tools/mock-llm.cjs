// OpenAI-compatible stand-in for a test core: streams a Thai answer word by word.
const http = require('node:http');
const port = Number(process.env.MOCK_PORT || 9911);

function lastUserText(body) {
  const messages = body.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  }
  return '';
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-chat', object: 'model', context_length: 64000 }] }));
      }
      if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
      const body = JSON.parse(raw || '{}');
      const said = lastUserText(body).split('<context>')[0].trim().slice(0, 200);
      const answer = `สวัสดีค่ะ นี่คือคำตอบทดสอบจาก **mock LLM** คุณพิมพ์ว่า: "${said}" — ข้อความนี้ส่งมาทีละคำเพื่อทดสอบ streaming ค่ะ`;
      const words = answer.split(/(\s+)/);
      const chunk = (delta, finish, usage) =>
        `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ role: 'assistant', content: '' }, null));
      for (const w of words) {
        res.write(chunk({ content: w }, null));
        await new Promise((r) => setTimeout(r, 60));
      }
      res.write(chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length }));
      res.end('data: [DONE]\n\n');
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`mock LLM on http://127.0.0.1:${port}/v1`));
