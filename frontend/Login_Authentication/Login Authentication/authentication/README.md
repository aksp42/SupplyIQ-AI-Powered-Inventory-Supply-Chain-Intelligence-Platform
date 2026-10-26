# Professional Authentication Module

A complete, reusable Login & Sign Up authentication system using Firebase Authentication. This module can be integrated into any web project (HTML/CSS/JS, React, React Native, Vue, Angular, etc.).

## Folder Structure

```
authentication/
├── firebase-config.js    # Firebase initialization with placeholders
├── js/
│   └── auth.js           # Core authentication logic (Google/Email/Reset/State)
├── css/
│   └── style.css         # Professional modern UI styles
├── login.html            # Login page
├── signup.html           # Sign Up page
└── dashboard.html        # Sample protected page (profile + logout)
```

## Quick Start

1. **Include Firebase SDK** in your HTML head (before your scripts):
```html
<head>
  <!-- Firebase App (required for all SDKs) -->
  <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>
  <!-- Firebase Auth -->
  <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js"></script>
  <!-- Firebase Firestore -->
  <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js"></script>
</head>
```

2. **Copy your Firebase config** from `firebase-config.js` and replace the placeholders:
```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};
```

3. **Enable Authentication Methods** in Firebase Console:
   - Go to Firebase Console → Authentication → Sign-in method
   - Enable **Google** provider
   - Enable **Email/Password** provider

4. **Configure Authorized Domains**:
   - Go to Firebase Console → Authentication → Settings
   - Add your domain under "Authorized domains"
   - Example: `localhost`, `yourdomain.com`, `127.0.0.1`

5. **Include the module files** in your HTML:
```html
<link rel="stylesheet" href="authentication/css/style.css">
<script type="module" src="authentication/js/auth.js"></script>
<script type="module" src="authentication/firebase-config.js"></script>
```

6. **Use the authentication functions** in your scripts:
```javascript
import { googleSignIn, emailSignIn, emailSignUp, resetPassword, onAuthStateChanged, getCurrentUser } from './auth.js';

// Google Sign In
googleSignIn().then(result => {
  if (result.success) {
    const user = result.user;
    console.log('User logged in:', user.email);
  }
});

// Email Sign In
emailSignIn('user@example.com', 'password').then(result => {
  if (result.success) {
    // User logged in
  } else {
    alert(result.error);
  }
});

// Email Sign Up
emailSignUp('user@example.com', 'password123', 'John Doe').then(result => {
  if (result.success) {
    // User registered and logged in
  }
});

// Password Reset
resetPassword('user@example.com').then(result => {
  if (result.success) {
    alert(result.message);
  }
});

// Auth state listener
onAuthStateChanged((authState) => {
  if (authState.isAuthenticated) {
    // User is logged in
    const user = authState.user;
    // Redirect to dashboard or show user profile
  } else {
    // User is logged out
  }
});
```

## Key Features

### Google OAuth Authentication
- Uses Firebase's `signInWithPopup` for Google authentication
- Forces account selection popup each time (`prompt: 'select_account'`)
- Automatically creates Firebase user if Google account doesn't exist
- Stores user profile (name, email, photo URL) in Firestore

### Email/Password Authentication
- **Sign Up**: Validates email format, password strength (min 6 chars), password confirmation
- **Login**: Validates email/password, handles errors gracefully
- **Auto-login**: After successful registration, user is automatically logged in
- **Email verification**: New users receive verification email

### Password Reset
- Send password reset email via Firebase
- Clear success/error messages
- Client-side validation for email format

### Persistent Authentication State
- `onAuthStateChanged` listener survives browser refresh
- User session stored securely by Firebase
- Automatic redirect to dashboard when logged in

### UI Features
- Professional modern design with white/light background
- Rounded cards and input fields with subtle shadows
- Google-styled sign-in button with official Google colors
- Password visibility toggle (👁 icon)
- Loading states on buttons
- Clear error and success messages
- Hover and focus states
- Fully responsive (works on mobile, tablet, desktop)
- Accessible labels and keyboard navigation

## Security Best Practices

### What's Safe to Embed in Frontend
- `apiKey`: Project identifier, not a secret
- `authDomain`: Your Firebase project domain
- `projectId`: Your Firebase project identifier
- `storageBucket`: Cloud storage bucket name
- `messagingSenderId`: FCM sender ID
- `appId`: Your web app identifier
- `measurementId`: Google Analytics ID

### What Must Remain Private
- **Never share**: Private keys, database secrets, service account credentials
- Firebase Authentication handles security via server-side rules
- User passwords are never stored or transmitted to your backend
- Firebase ID tokens are verified on your backend if needed

### Firebase Security Rules (Recommended)
```javascript
// Firestore rules - protect user data
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## Integration with Other Projects

### HTML/CSS/JS Projects
Just include the files as shown in the Quick Start section above.

### React Projects
```jsx
import { useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// Your Firebase config
const firebaseConfig = { /* ... */ };
initializeApp(firebaseConfig);
const auth = getAuth();

// In your component
useEffect(() => {
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    if (user) {
      // User is logged in
      setUser(user);
    } else {
      // User is logged out
    }
  });
  return () => unsubscribe();
}, []);
```

### Java/Servlet Projects
- Use Firebase Admin SDK on your server
- Verify ID tokens from frontend: `FirebaseAuth.verifyIdToken(token)`
- Create custom auth endpoints that delegate to Firebase

### Flask/Node.js Projects
- Same as Java/Servlet - use Firebase Admin SDK
- Verify ID tokens: `admin.auth().verifyIdToken(idToken)`
- Create protected routes that check authentication

## Customization

### Change Redirect URLs
Edit the `window.location.href` in `login.html` and `signup.html`:
- `'/dashboard.html'` - Your dashboard page
- `'/home.html'` - Your home page
- `'/welcome'` - Any route in your application

### Add More User Fields
In `auth.js`, the `upsertUserProfile` function stores user data in Firestore. Add more fields like:
- `phoneNumber`
- `address`
- `bio`
- `lastLogin` (already included)

### Modify UI Colors
Update the CSS `:root` variables in `css/style.css`:
```css
:root {
  --primary-color: #your-color;
  --secondary-color: #your-color;
  --text-primary: #your-color;
  --background: #your-color;
}
```

## Testing

### Test Google Login
1. Open `login.html` in a browser
2. Click "Continue with Google"
3. Select a Google account
4. You should be logged in and redirected

### Test Email/Password
1. Open `signup.html`
2. Fill in name, email, password (min 6 chars), confirm password
3. Click "Create Account"
4. User should be registered and automatically logged in
5. Test login with the same credentials in `login.html`

### Test Password Reset
1. Click "Forgot Password?" in either page
2. Enter a registered email
3. Check that success message appears

### Test Auth State Persistence
1. Login, then refresh the page
2. User should remain logged in
3. Check that `onAuthStateChanged` fires with user data

### Test Logout & Session
1. Login, then click "Log Out" on the dashboard
2. You should be sent back to the login page
3. Try opening `dashboard.html` directly while logged out — it should redirect to login (protected page)

## Deploying to AWS (do this AFTER testing locally)

This module is AWS-ready with **zero code changes**. Before going live on AWS, complete two configuration steps:

### Before deployment on AWS
- Set the Google OAuth consent screen to **Production** (publish it)
- Make sure your OAuth **Test users** list includes anyone who must log in during testing
- Create a **Firestore database** in the Firebase console (left sidebar → **Firestore Database** → **Create database** → choose production or test mode and a location). The module stores user profiles there. If Firestore is not created, authentication still works but profiles/last-login are not saved.

### On the day you deploy
When you have your real AWS domain (from S3 + CloudFront, EC2, Elastic Beanstalk, Amplify, etc.):

2. **Firebase Console → Authentication → Settings → Authorized domains**
   - Click **Add domain** and add your exact AWS domain (e.g. `app.mydomain.com`)
   - Keep `localhost` as well so local dev still works
3. **Google Cloud Console → APIs & Services → Credentials → your web OAuth client**
   - Add `https://your-aws-domain` to **Authorized JavaScript origins** (and `http://localhost` if missing)
   - Add `https://YOUR_PROJECT_ID.firebaseapp.com/__/auth/handler` to **Authorized redirect URIs** if missing
4. **Google Cloud Console → OAuth consent screen**
   - Update Application home page, Privacy Policy, Terms of Service to your real AWS URLs
   - Click **Publish app**
5. **Upload** the whole `authentication/` folder to your AWS bucket/host unchanged — paths are relative, so it works in any subfolder

### Notes for AWS
- Firebase requires **HTTPS**. AWS (CloudFront, ALB, Amplify) provides this automatically when you add a certificate.
- The module uses `signInWithPopup`, which works from any authorized HTTPS domain — no server needed for auth.
- If your AWS app later needs server-side checks (e.g. to trust user data in your backend), verify Firebase ID tokens on your server using the **Firebase Admin SDK** (`admin.auth().verifyIdToken(token)`). Never trust client-supplied user info alone.

## File Reference

| File | Description |
|------|-------------|
| `firebase-config.js` | Firebase initialization with placeholders |
| `js/auth.js` | All authentication logic (Google, Email, Password, Reset) |
| `css/style.css` | Professional modern UI styles |
| `login.html` | Login page with Google + Email options |
| `signup.html` | Sign Up page with Google + Email options |
| `dashboard.html` | Sample protected page showing user profile + logout |

## Need Help?

- Firebase Documentation: https://firebase.google.com/docs
- Firebase Console: https://console.firebase.google.com/
- This module is designed to be framework-agnostic and work with any web project