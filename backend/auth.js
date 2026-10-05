// ── Auth: password hashing, JWT, and route guards ──────────────────────────────
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { queryOne } = require('./mysql');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const ISSUER        = 'supplyiq';

// Without a configured secret every restart would invalidate all sessions, so we
// fall back to a random per-boot secret instead of ever using a hardcoded one.
let _secret = process.env.JWT_SECRET;
if (!_secret) {
  _secret = crypto.randomBytes(48).toString('hex');
  console.warn('\x1b[33m⚠  JWT_SECRET not set in .env — generated a temporary one.\x1b[0m');
  console.warn('   All tokens will be rejected after a restart. Add JWT_SECRET to backend/.env\n');
}
const SECRET = _secret;

const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// ── Passwords ─────────────────────────────────────────────────────────────────
function hashPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

async function verifyPassword(plain, storedHash) {
  if (!storedHash) return false;
  try {
    return await bcrypt.compare(String(plain), storedHash);
  } catch {
    return false;
  }
}

function needsRehash(storedHash) {
  return !storedHash || bcrypt.getRounds(storedHash) !== BCRYPT_ROUNDS;
}

// ── Tokens ────────────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    {
      sub:      String(user.id),
      email:    user.email,
      storeId:  user.store_id,
      provider: user.provider || 'email',
    },
    SECRET,
    { expiresIn: EXPIRES_IN, issuer: ISSUER }
  );
}

function verifyToken(token) {
  return jwt.verify(token, SECRET, { issuer: ISSUER });
}

function sessionPayload(user, store) {
  const userName = user.name || store?.owner_name || '';
  return {
    success:   true,
    token:     signToken(user),
    storeId:   user.store_id,
    storeName: store?.name       || user.store_id,
    // userName is the account that just logged in; ownerName is who the store
    // belongs to. They differ for staff accounts, so the UI needs both.
    userName,
    ownerName: store?.owner_name || userName,
    email:     user.email,
    theme:     store?.theme      || 'green',
  };
}

// ── Guards ────────────────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Not authenticated.' });

  let claims;
  try {
    claims = verifyToken(header.slice(7));
  } catch (err) {
    const error = err.name === 'TokenExpiredError'
      ? 'Session expired. Please log in again.'
      : 'Invalid session.';
    return res.status(401).json({ error });
  }

  const user = await queryOne(
    'SELECT id, email, name, store_id, provider FROM users WHERE id = ?',
    [claims.sub]
  );
  if (!user) return res.status(401).json({ error: 'Account no longer exists.' });

  req.user = user;
  next();
}

// The store is taken from the token, never from client input. A mismatched
// storeId is rejected instead of silently falling back.
function requireStore(req, res, next) {
  const requested = req.body?.storeId ?? req.query?.storeId;

  if (!requested)
    return res.status(400).json({ error: 'storeId is required' });
  if (requested !== req.user.store_id)
    return res.status(403).json({ error: 'You do not have access to this store.' });

  req.storeId = req.user.store_id;
  next();
}

// ── Login throttling (in-memory, per email + per IP) ──────────────────────────
const WINDOW_MS   = 15 * 60 * 1000;
const MAX_ATTEMPT = 8;
const attempts    = new Map();

function attemptKey(email, ip) {
  return `${String(email || '').toLowerCase()}|${ip}`;
}

function isThrottled(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPT;
}

function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS)
    attempts.set(key, { count: 1, first: Date.now() });
  else
    entry.count += 1;
}

function clearFailures(key) {
  attempts.delete(key);
}

function throttleLogin(req, res, next) {
  const key = attemptKey(req.body?.email, req.ip);
  if (!isThrottled(key)) return next();
  res.status(429).json({
    error: 'Too many failed sign-in attempts. Please try again in a few minutes.',
  });
}

// ── Firebase (Google / Microsoft) ─────────────────────────────────────────────
// The public web API key identifies the Firebase project; it is not a secret.
// Verifying the ID token this way means we do not need a service account.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || '';

async function verifyFirebaseIdToken(idToken) {
  if (!idToken) return null;
  if (!FIREBASE_API_KEY)
    throw new Error('FIREBASE_API_KEY is not set. Google/Microsoft sign-in is unavailable.');

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ idToken }),
    }
  );
  if (!res.ok) return null;

  const data = await res.json();
  const user = data.users && data.users[0];
  if (!user || !user.email) return null;

  // `emailVerified` comes from Google/Microsoft, not from the request body.
  // Account linking below relies on it: an address that the IdP has not verified
  // must never be allowed to claim an existing MySQL account, or anyone could
  // register a lookalike unverified address and take over that account.
  const emailVerified = user.emailVerified === true
    || (Array.isArray(user.providerData) && user.providerData.some(p => p.emailVerified === true));

  return {
    uid:            user.localId,
    email:          user.email,
    name:           user.displayName || user.email,
    provider:       (user.providerData && user.providerData[0]?.providerId) || 'google',
    email_verified: emailVerified,
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  needsRehash,
  signToken,
  verifyToken,
  sessionPayload,
  requireAuth,
  requireStore,
  throttleLogin,
  recordFailure,
  clearFailures,
  attemptKey,
  verifyFirebaseIdToken,
};
