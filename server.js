import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp({ config, db });

if (!config.apiKey) console.warn('ANTHROPIC_API_KEY is not set: AI analysis is off, keyword rules still work.');
if (process.env.NODE_ENV === 'production' && !config.cookieSecure) {
  console.warn('COOKIE_SECURE is false in production. Serve over HTTPS and set COOKIE_SECURE=true.');
}

const server = app.listen(config.port, () => {
  console.log(`Triage Desk listening on http://localhost:${config.port}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
