// ============================================================
// Firebase Configuration
// ============================================================
// Paste your Firebase web app configuration below and save.
//
// IMPORTANT (security):
// The values in this object are SAFE to keep in frontend code.
// They are public project identifiers, NOT secrets. Firebase
// enforces real security through its server-side security rules.
// Never place private keys or service-account JSON in this file.
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyACtxjNhaDOfxM_HDeCQli05vx_nBwbLwg",
  authDomain: "my-login-system-9a207.firebaseapp.com",
  projectId: "my-login-system-9a207",
  storageBucket: "my-login-system-9a207.firebasestorage.app",
  messagingSenderId: "571192814263",
  appId: "1:571192814263:web:104e425a43035c6960bb32",
  measurementId: "G-8PPD6D8S82"
};

// Initialize Firebase (only once, guard against double init)
// ============================================================
// This file must be loaded AFTER the Firebase SDK scripts and
// BEFORE the module that uses Firebase (js/auth.js).
// ============================================================
if (typeof firebase !== 'undefined') {
  if (firebase.apps.length === 0) {
    firebase.initializeApp(firebaseConfig);
  }
  window.firebaseReady = true;
} else {
  console.error(
    'Firebase SDK not found. Load the Firebase scripts from the README before firebase-config.js.'
  );
}