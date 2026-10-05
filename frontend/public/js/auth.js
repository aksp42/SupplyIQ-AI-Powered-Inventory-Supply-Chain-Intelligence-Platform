/**
 * auth.js — SupplyIQ Auth Module
 *
 * Email/Password  → Our own backend  (http://localhost:4000/api/login)
 * Google / Microsoft → Firebase (popup)
 *
 * Session stored in localStorage as 'siq_session' JSON.
 * Sign-out flag stored in localStorage as 'siq_signed_out' — prevents
 * Firebase onAuthStateChanged from auto-restoring the session.
 */

const API = 'http://localhost:4000/api';

// ── Session helpers ───────────────────────────────────────────────
export function saveSession(data) {
  localStorage.removeItem('siq_signed_out');   // clear sign-out flag on fresh login
  localStorage.setItem('siq_session', JSON.stringify(data));
  localStorage.setItem('siq-store', data.storeId);
}
export function getSession() {
  try { return JSON.parse(localStorage.getItem('siq_session')); }
  catch { return null; }
}
export function clearSession() {
  localStorage.setItem('siq_signed_out', '1'); // mark as intentionally signed out
  localStorage.removeItem('siq_session');
  localStorage.removeItem('siq-store');
}

// The backend rejects unauthenticated requests, so every call must carry the JWT.
export function authHeaders() {
  const session = getSession();
  return session?.token ? { Authorization: `Bearer ${session.token}` } : {};
}

export function isExpired() {
  const session = getSession();
  if (!session?.token) return true;
  try {
    const payload = JSON.parse(atob(session.token.split('.')[1]));
    return Date.now() / 1000 >= payload.exp;
  } catch {
    return true;
  }
}

// ── Firebase providers (Google + Microsoft) ───────────────────────
function getFirebase() {
  if (typeof firebase === 'undefined') return null;
  if (!firebase.apps || firebase.apps.length === 0) return null;
  return firebase;
}

// ── Google Sign In (Firebase) ─────────────────────────────────────
export async function googleSignIn() {
  const fb = getFirebase();
  if (!fb) return { success: false, error: 'Firebase not loaded. Please refresh the page.' };
  try {
    const provider = new fb.auth.GoogleAuthProvider();
    const result   = await fb.auth().signInWithPopup(provider);
    const session  = await syncFirebaseUserToBackend(result.user);
    saveSession(session);
    return { success: true };
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user') return { success: false, error: 'Sign-in popup was closed.' };
    if (err.code === 'auth/cancelled-popup-request') return { success: false, error: 'Sign-in cancelled.' };
    return { success: false, error: err.message || 'Google sign-in failed.' };
  }
}

// ── Microsoft Sign In (Firebase) ──────────────────────────────────
export async function microsoftSignIn() {
  const fb = getFirebase();
  if (!fb) return { success: false, error: 'Firebase not loaded. Please refresh the page.' };
  try {
    const provider = new fb.auth.OAuthProvider('microsoft.com');
    provider.setCustomParameters({ prompt: 'select_account', tenant: 'common' });
    const result  = await fb.auth().signInWithPopup(provider);
    const session = await syncFirebaseUserToBackend(result.user);
    saveSession(session);
    return { success: true };
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user') return { success: false, error: 'Sign-in popup was closed.' };
    if (err.code === 'auth/account-exists-with-different-credential') {
      return { success: false, error: 'Account exists with a different sign-in method. Try email/password instead.' };
    }
    return { success: false, error: err.message || 'Microsoft sign-in failed.' };
  }
}

// ── Sync Firebase user → MySQL via /api/auth/firebase ────────────────────────
// The Firebase ID token is what the backend verifies — the email is never sent
// on its own, so this cannot be used to impersonate another account.
async function syncFirebaseUserToBackend(user) {
  const idToken = await user.getIdToken();
  const res = await fetch(`${API}/auth/firebase`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ idToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not verify your Google account.');
  return data;
}

// ── Email / Password Login → OWN BACKEND ─────────────────────────
export async function emailSignIn(email, password) {
  try {
    const res  = await fetch(`${API}/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error || 'Login failed.' };
    saveSession(data);
    return { success: true };
  } catch {
    return { success: false, error: 'Cannot reach server. Make sure the backend is running (start.bat).' };
  }
}

// ── Email / Password Sign Up → OWN BACKEND ───────────────────────
export async function emailSignUp(name, email, password, businessType = '', code = '') {
  try {
    const res  = await fetch(`${API}/signup`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, password, businessType, code }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error || 'Signup failed.' };
    saveSession(data);
    return { success: true };
  } catch {
    return { success: false, error: 'Cannot reach server. Make sure the backend is running (start.bat).' };
  }
}

// ── Email OTP (SupplyIQ's own mailer, not Firebase) ───────────────────
export async function sendOtp(email, purpose) {
  try {
    const res  = await fetch(`${API}/otp/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, purpose }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error || 'Could not send the code.' };
    // devCode is only present when the server has no SMTP configured (dev only).
    return { success: true, message: data.message, devCode: data.devCode };
  } catch {
    return { success: false, error: 'Cannot reach server. Make sure the backend is running (start.bat).' };
  }
}

export async function verifyOtp(email, code, purpose) {
  try {
    const res  = await fetch(`${API}/otp/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, code, purpose }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error || 'That code is not correct.' };
    return { success: true };
  } catch {
    return { success: false, error: 'Cannot reach server. Make sure the backend is running (start.bat).' };
  }
}

export async function resetPasswordWithOtp(email, code, newPassword) {
  try {
    const res  = await fetch(`${API}/password/reset`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, code, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error || 'Could not update the password.' };
    return { success: true, message: data.message };
  } catch {
    return { success: false, error: 'Cannot reach server. Make sure the backend is running (start.bat).' };
  }
}

// ── Sign Out ──────────────────────────────────────────────────────
export async function signOut() {
  clearSession();                               // sets siq_signed_out flag first
  // Also sign out of Firebase so its token is revoked
  try {
    const fb = getFirebase();
    if (fb) await fb.auth().signOut();
  } catch { /* ignore */ }
  return { success: true };
}

// ── Auth State ────────────────────────────────────────────────────
export function onAuthStateChanged(callback) {
  // If user explicitly signed out — never auto-login
  if (localStorage.getItem('siq_signed_out') === '1') {
    callback({ isAuthenticated: false, user: null });
    return;
  }

  // Check our own session first
  const session = getSession();
  if (session && session.token && !isExpired()) {
    callback({ isAuthenticated: true, user: session });
    return;
  }

  // Also check Firebase state (for Google/Microsoft users)
  // But only if NOT signed out intentionally
  const fb = getFirebase();
  if (fb) {
    fb.auth().onAuthStateChanged(async (user) => {
      // Re-check sign-out flag (may have been set async)
      if (localStorage.getItem('siq_signed_out') === '1') {
        callback({ isAuthenticated: false, user: null });
        return;
      }
      if (user) {
        // Exchange the Firebase session for a backend JWT — a Firebase UID alone
        // is not a valid API credential.
        try {
          const sess = await syncFirebaseUserToBackend(user);
          saveSession(sess);
          callback({ isAuthenticated: true, user: sess });
        } catch {
          clearSession();
          callback({ isAuthenticated: false, user: null });
        }
      } else {
        callback({ isAuthenticated: false, user: null });
      }
    });
  } else {
    callback({ isAuthenticated: false, user: null });
  }
}

// Password reset runs on SupplyIQ's own OTP — see sendOtp and
// resetPasswordWithOtp above. Firebase is deliberately not used: MySQL-only
// email/password accounts have no Firebase user, so sendPasswordResetEmail
// could never succeed for them.
