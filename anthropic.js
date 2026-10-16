export class UpstreamError extends Error {
  constructor(status, detail) {
    super(`upstream ${status}`);
    this.status = status;
    this.detail = detail; // logged server-side only, never sent to the browser
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callModel({ config, model, prompt, images = [], maxTokens }) {
  const content = [
    ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.type, data: i.data } })),
    { type: 'text', text: prompt },
  ];
  const body = JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] });
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': config.anthropicVersion,
        },
        body,
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      last = new UpstreamError(0, String(e && e.message));
      await sleep(600);
      continue;
    }
    if (res.ok) {
      const j = await res.json();
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { text, usage: j.usage || {}, stopReason: j.stop_reason };
    }
    const detail = await res.text().catch(() => '');
    last = new UpstreamError(res.status, detail.slice(0, 500));
    if (res.status !== 429 && res.status < 500) break; // do not retry client errors
    await sleep(800);
  }
  throw last;
}

// The model is told to return only JSON, but may wrap it in a fence or add a sentence.
export function extractJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.search(/[[{]/);
  if (a < 0) return null;
  const close = t[a] === '[' ? ']' : '}';
  const b = t.lastIndexOf(close);
  if (b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
