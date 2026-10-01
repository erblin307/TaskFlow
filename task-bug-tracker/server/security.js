'use strict';

const { createHash, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyPassword(password, storedHash) {
  try {
    const [scheme, encodedSalt, encodedHash] = String(storedHash).split('$');
    if (scheme !== 'scrypt' || !encodedSalt || !encodedHash) return false;
    const expected = Buffer.from(encodedHash, 'base64url');
    const actual = scryptSync(password, Buffer.from(encodedSalt, 'base64url'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function sessionCookie(token, production) {
  const attributes = [`taskflow_session=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (production) attributes.push('Secure');
  return attributes.join('; ');
}

function clearSessionCookie(production) {
  return `taskflow_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production ? '; Secure' : ''}`;
}

function securityHeaders(production) {
  const headers = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };
  if (production) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function createRateLimiter({ windowMs, max }) {
  const attempts = new Map();
  return function consume(key) {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    entry.count += 1;
    if (entry.count <= max) return { allowed: true, retryAfter: 0 };
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  };
}

module.exports = {
  SESSION_TTL_MS,
  clearSessionCookie,
  createRateLimiter,
  hashPassword,
  hashToken,
  parseCookies,
  randomToken,
  securityHeaders,
  sessionCookie,
  verifyPassword
};
