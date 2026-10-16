import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = await scrypt(pw, Buffer.from(saltB64, 'base64'), key.length, SCRYPT);
  return crypto.timingSafeEqual(key, test);
}

// Compared against when the email does not exist, so response time does not reveal which emails have accounts.
export const DUMMY_HASH = await hashPassword('not-a-real-password');

export const newId = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Sliding-window limiter, in memory. Fine for one server process; use Redis if you run several.
export class Limiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  // Returns true if the action is allowed (and records it).
  take(key, max = this.max) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
  count(key) {
    const now = Date.now();
    return (this.hits.get(key) || []).filter((t) => now - t < this.windowMs).length;
  }
  clear(key) {
    this.hits.delete(key);
  }
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) {
      const f = v.filter((t) => now - t < this.windowMs);
      if (f.length) this.hits.set(k, f);
      else this.hits.delete(k);
    }
  }
}
