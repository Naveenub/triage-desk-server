// A stand-in for api.anthropic.com so tests never spend real tokens.
import http from 'node:http';

export function startMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const text = body.messages[0].content.find((c) => c.type === 'text').text;
      requests.push({ model: body.model, text, max_tokens: body.max_tokens, key: req.headers['x-api-key'] });
      const one = {
        category: 'Bug', secondary: null, priority: 'P2', mood: 'Concerned', language: 'English', sarcasm: false,
        summary: 'Mock summary', workaround: 'Unknown', workaround_steps: '', signals: ['blocked'],
        reply: 'Mock reply', notes: ['n1', 'n2', 'n3'], kb_used: [], kb_gap: false, visible: '',
      };
      const bulk = text.includes('JSON array of tickets');
      const n = (text.match(/"ticket":/g) || []).length;
      const out = bulk ? Array.from({ length: n }, (_, i) => ({ id: i, ...one })) : one;
      const reply = '```json\n' + JSON.stringify(out) + '\n```'; // fenced on purpose: the server must cope
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        content: [{ type: 'text', text: reply }], stop_reason: 'end_turn',
        usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: 300 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() });
  }));
}
