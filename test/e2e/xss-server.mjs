// Same app as server.mjs, but the mock "AI" turns hostile when the prompt contains EVIL-AI-OUTPUT.
// This models a ticket that prompt-injects the model into returning HTML in its JSON fields.
import { loadConfig } from '../../config.js';
import { openDb } from '../../db.js';
import { createApp } from '../../app.js';
import { startMock } from '../mock-anthropic.js';

// One polyglot that breaks out of element content, double- and single-quoted attributes, and tries to run script.
// <pwn-el> / data-pwn are inert markers: if either appears in the DOM, markup was injected, whether or not a CSP stopped it running.
const X = (v) =>
  `x" data-pwn="${v}"><pwn-el data-pwn="${v}"></pwn-el><img src=x onerror=__pwned.push("${v}")>'<i data-pwn='${v}'>`;

const hostile = () => ({
  category: 'constructor', secondary: X('ai-secondary'), priority: X('ai-priority'), mood: X('ai-mood'),
  language: X('ai-language'), sarcasm: false, summary: X('ai-summary'), workaround: 'Available',
  workaround_steps: X('ai-workaround'), signals: [X('ai-signal')], reply: X('ai-reply'),
  notes: [X('ai-note')], kb_used: [], kb_gap: false, visible: X('ai-visible'),
});

const mock = await startMock({
  override: (text, bulk, n) => {
    if (!text.includes('EVIL-AI-OUTPUT')) return null;
    return bulk ? Array.from({ length: n }, (_, i) => ({ id: i, ...hostile() })) : hostile();
  },
});
const config = loadConfig({}, { apiKey: 'k', anthropicBaseUrl: mock.url, cookieSecure: false, dbPath: ':memory:' });
const db = openDb(':memory:');
createApp({ config, db }).listen(Number(process.env.E2E_PORT || 3457), () => console.log('ready'));
