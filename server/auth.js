import crypto from 'node:crypto';
import { query, isLocal } from './db.js';

const OWNER_COOKIE = 'sl_owner';
const shareCookie = (token) => `sl_share_${token}`;
const OWNER_TTL = 30 * 24 * 3600; // 30 days
const SHARE_TTL = 7 * 24 * 3600; // 7 days

// Locally a random secret is fine (you just log in again after restarting).
const localSecret = crypto.randomBytes(32).toString('hex');

function secret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (isLocal()) return localSecret;
  throw new Error('SESSION_SECRET must be set (at least 32 characters).');
}

export function ownerPassword() {
  if (process.env.OWNER_PASSWORD) return process.env.OWNER_PASSWORD;
  if (isLocal()) return 'admin'; // local development only
  throw new Error('OWNER_PASSWORD must be set.');
}

/* ---------- Signed session tokens ---------- */

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------- Cookies ---------- */

export function readCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(request, name, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export const ownerCookie = (request) =>
  cookie(request, OWNER_COOKIE, sign({ role: 'owner', exp: Date.now() / 1000 + OWNER_TTL }), OWNER_TTL);

export const clearOwnerCookie = (request) => cookie(request, OWNER_COOKIE, '', 0);

export const shareSessionCookie = (request, share) =>
  cookie(
    request,
    shareCookie(share.token),
    sign({ role: 'client', token: share.token, projectId: share.project_id, exp: Date.now() / 1000 + SHARE_TTL }),
    SHARE_TTL
  );

export const isOwner = (request) => verify(readCookies(request)[OWNER_COOKIE])?.role === 'owner';

/**
 * The client session for a share link, if the visitor has entered its password
 * and the link is still live. Returns the share row or null.
 */
export async function shareSession(request, token) {
  if (!token) return null;
  const s = verify(readCookies(request)[shareCookie(token)]);
  if (!s || s.token !== token) return null;
  const share = await getLiveShare(token);
  return share && share.project_id === s.projectId ? share : null;
}

export async function getLiveShare(token) {
  const [share] = await query('select * from shares where token = $1', [token]);
  if (!share || share.revoked) return null;
  if (share.expires_at && Number(share.expires_at) < Date.now()) return null;
  return share;
}

/* ---------- Passwords ---------- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${b64(salt)}$${b64(hash)}`;
}

export function checkPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), 32);
  const want = Buffer.from(hash, 'base64url');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function sameString(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* ---------- Brute-force protection ---------- */

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

/** Throws a 429 error if this key has too many recent failed attempts. */
export async function checkLockout(key) {
  const [row] = await query('select * from login_attempts where key = $1', [key]);
  if (row && Date.now() - Number(row.window_start) < WINDOW_MS && row.failures >= MAX_FAILURES) {
    const err = new Error('Too many wrong passwords. Try again in 15 minutes.');
    err.status = 429;
    throw err;
  }
}

export async function recordFailure(key) {
  const now = Date.now();
  await query(
    `insert into login_attempts (key, failures, window_start) values ($1, 1, $2)
     on conflict (key) do update set
       failures = case when $2 - login_attempts.window_start > $3 then 1 else login_attempts.failures + 1 end,
       window_start = case when $2 - login_attempts.window_start > $3 then $2 else login_attempts.window_start end`,
    [key, now, WINDOW_MS]
  );
}

export const clearFailures = (key) => query('delete from login_attempts where key = $1', [key]);

export const newToken = () => crypto.randomBytes(12).toString('base64url');
