import { loadConfig } from '../../config.js';
import { openDb } from '../../db.js';
import { createApp } from '../../app.js';
import { startMock } from '../../test/mock-anthropic.js';
const mock = await startMock();
const config = loadConfig({}, { apiKey: 'k', anthropicBaseUrl: mock.url, cookieSecure: false, dbPath: ':memory:' });
const db = openDb(':memory:');
createApp({ config, db }).listen(Number(process.env.E2E_PORT||3456), () => console.log('ready'));
