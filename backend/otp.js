// ── Email OTP: signup verification and password reset ─────────────────────────
//
// Codes are never stored in plaintext. A bare SHA-256 of a 6-digit code would be
// reversible from a leaked database (only 1e6 candidates), so the digest is HMAC'd
// with a server-side pepper that lives in .env and never in the database.
//
// Every failure mode returns a generic message to the caller, so these endpoints
// cannot be used to discover which emails have accounts.
const crypto = require('crypto');
const { query, run } = require('./mysql');

const PURPOSE = Object.freeze({ SIGNUP: 'signup', RESET: 'reset' });

const CODE_TTL_MINUTES  = Number(process.env.OTP_TTL_MINUTES || 10);
const MAX_ATTEMPTS      = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const RESEND_COOLDOWN_S = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);
const MAX_SENDS_PER_HOUR = Number(process.env.OTP_MAX_SENDS_PER_HOUR || 5);

const PEPPER = process.env.OTP_PEPPER || process.env.JWT_SECRET;
if (!PEPPER) {
  throw new Error('OTP_PEPPER (or JWT_SECRET) must be set — OTP codes cannot be hashed without a server-side pepper.');
}

function hashCode(email, code) {
  return crypto.createHmac('sha256', PEPPER).update(`${email.toLowerCase()}:${code}`).digest('hex');
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Cryptographically uniform in [0, 1e6), so a leading zero is possible and the
// user must be able to type it.
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

async function clearCodes(email, purpose) {
  await run('DELETE FROM otp_codes WHERE email = ? AND purpose = ?', [email.toLowerCase(), purpose]);
}

async function sendCode({ email, purpose, userName }) {
  const mail = email.toLowerCase();

  const recent = await query(
    'SELECT created_at FROM otp_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    [mail, purpose]
  );
  if (recent.length) {
    const ageSeconds = (Date.now() - new Date(recent[0].created_at).getTime()) / 1000;
    if (ageSeconds < RESEND_COOLDOWN_S)
      return { ok: false, retryAfter: Math.ceil(RESEND_COOLDOWN_S - ageSeconds), reason: 'cooldown' };
  }

  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const sent = await query(
    'SELECT COUNT(*) c FROM otp_codes WHERE email = ? AND purpose = ? AND created_at >= ?',
    [mail, purpose, windowStart]
  );
  if (Number(sent[0].c) >= MAX_SENDS_PER_HOUR)
    return { ok: false, retryAfter: 3600, reason: 'hourly_limit' };

  const code = generateCode();
  await run(
    'INSERT INTO otp_codes (email, purpose, code_hash, expires_at, attempts) VALUES (?,?,?,DATE_ADD(NOW(), INTERVAL ? MINUTE),0)',
    [mail, purpose, hashCode(mail, code), CODE_TTL_MINUTES]
  );

  await deliverMail({ to: mail, code, purpose, userName });
  return { ok: true, code };
}

// Throws if mail is not configured — never reports success for a mail that was
// not actually sent, which is what made the old implementation misleading.
async function deliverMail({ to, code, purpose, userName }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in backend/.env.');
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT || 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const isReset = purpose === PURPOSE.RESET;
  const subject = isReset ? 'SupplyIQ password reset code' : 'Verify your SupplyIQ account';
  const intro = isReset
    ? `We received a request to reset the password for your SupplyIQ account${userName ? ` (${userName})` : ''}.`
    : `Welcome to SupplyIQ${userName ? `, ${userName}` : ''}. Confirm this code to finish creating your account.`;

  await transporter.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to,
    subject,
    text: `${intro}\n\nYour verification code is: ${code}\n\nIt expires in ${CODE_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.`,
    html: `<div style="font-family:Segoe UI,Roboto,Arial,sans-serif;max-width:520px">
  <h2 style="margin:0 0 16px">${subject}</h2>
  <p style="color:#444">${intro}</p>
  <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:24px 0">${code}</p>
  <p style="color:#666;font-size:13px">This code expires in ${CODE_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.</p>
</div>`,
  });
}

// Returns { ok, verified, reason }. The caller must not reveal which reason it was
// when the caller is deciding whether an account exists.
async function verifyCode({ email, code, purpose }) {
  const mail = email.toLowerCase();
  const rows = await query(
    'SELECT id, code_hash, expires_at, attempts FROM otp_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    [mail, purpose]
  );
  if (!rows.length) return { ok: false, verified: false, reason: 'invalid' };

  const row = rows[0];
  if (row.attempts >= MAX_ATTEMPTS) {
    await run('DELETE FROM otp_codes WHERE email = ? AND purpose = ?', [mail, purpose]);
    return { ok: false, verified: false, reason: 'locked' };
  }
  if (new Date(row.expires_at).getTime() < Date.now())
    return { ok: false, verified: false, reason: 'expired' };

  if (!timingSafeEqual(hashCode(mail, code), row.code_hash)) {
    await run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    return { ok: false, verified: false, reason: 'invalid' };
  }

  // Single use: consume the code the moment it verifies.
  await run('DELETE FROM otp_codes WHERE email = ? AND purpose = ?', [mail, purpose]);
  return { ok: true, verified: true };
}

module.exports = { PURPOSE, sendCode, verifyCode, clearCodes, generateCode };