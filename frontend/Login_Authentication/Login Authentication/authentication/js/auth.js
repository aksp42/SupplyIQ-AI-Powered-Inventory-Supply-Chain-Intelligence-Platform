// ============================================================
   // Authentication Module - Firebase Auth Logic
   // ============================================================
   // This file handles all Firebase Authentication operations.
   // It can be imported into any HTML page that includes the
   // firebase-config.js file.
   // ============================================================

   // Check if Firebase is initialized
   if (typeof firebase === 'undefined') {
     console.error('Firebase not initialized. Include firebase-config.js first.');
   }

   export const auth = firebase.auth();
   export const googleProvider = new firebase.auth.GoogleAuthProvider();
   export const microsoftProvider = new firebase.auth.OAuthProvider('microsoft.com');
   export const firestore = firebase.firestore();

   // Scope that keeps sign-in to personal + work/school Microsoft accounts
   // (openid + profile + email are always included by default)
   microsoftProvider.setCustomParameters({
     prompt: 'select_account',
     tenant: 'common'
   });

   // ============================================================
   // Google Sign In
   // ============================================================
   export const googleSignIn = async () => {
     try {
       const result = await auth.signInWithPopup(googleProvider);
       const user = result.user;

       // Store/update user in Firestore
       await upsertUserProfile(user);

       return {
         success: true,
         user: {
           uid: user.uid,
           email: user.email,
           displayName: user.displayName,
           photoURL: user.photoURL,
           isEmailVerified: user.isEmailVerified
         }
       };
} catch (error) {
        if (error.code === 'auth/cancelled-popup') {
          return { success: false, error: 'Google sign-in was cancelled.' };
        }
        if (error.code === 'auth/operation-not-allowed') {
          return { success: false, error: 'Google Sign-In is not enabled in Firebase console.' };
        }
        return { success: false, error: error.message || 'Something went wrong. Please try again.' };
      }
    };

   // ============================================================
   // Microsoft Sign In
   // ============================================================
   export const microsoftSignIn = async () => {
     try {
       const result = await auth.signInWithPopup(microsoftProvider);
       const user = result.user;

       // Store/update user in Firestore
       await upsertUserProfile(user);

       return {
         success: true,
         user: {
           uid: user.uid,
           email: user.email,
           displayName: user.displayName,
           photoURL: user.photoURL,
           isEmailVerified: user.isEmailVerified
         }
       };
     } catch (error) {
       if (error.code === 'auth/cancelled-popup') {
         return { success: false, error: 'Microsoft sign-in was cancelled.' };
       }
       if (error.code === 'auth/operation-not-allowed') {
         return { success: false, error: 'Microsoft Sign-In is not enabled in Firebase console.' };
       }
       if (error.code === 'auth/account-exists-with-different-credential') {
         return {
           success: false,
           error: 'An account already exists with the same email but a different sign-in method. Please log in with the other method first.'
         };
       }
       return { success: false, error: error.message || 'Something went wrong. Please try again.' };
     }
   };

   // ============================================================
   // Email/Password Sign In
   // ============================================================
   export const emailSignIn = async (email, password) => {
     try {
       const result = await auth.signInWithEmailAndPassword(email, password);
       await updateLastLogin(result.user.uid);

       return {
         success: true,
         user: {
           uid: result.user.uid,
           email: result.user.email,
           displayName: result.user.displayName,
           photoURL: result.user.photoURL,
           isEmailVerified: result.user.isEmailVerified
         }
       };
     } catch (error) {
       let errorMessage = 'Something went wrong. Please try again.';
       switch (error.code) {
         case 'auth/wrong-password':
           errorMessage = 'Incorrect email or password.';
           break;
         case 'auth/user-not-found':
           errorMessage = 'This email is not registered.';
           break;
         case 'auth/invalid-email':
           errorMessage = 'Please enter a valid email address.';
           break;
         case 'auth/too-many-requests':
           errorMessage = 'Too many attempts. Please try again later.';
           break;
         case 'auth/user-disabled':
           errorMessage = 'This account has been disabled.';
           break;
         default:
           errorMessage = error.message || 'Something went wrong.';
       }
       return { success: false, error: errorMessage };
     }
   };

   // ============================================================
   // Email/Password Sign Up
   // ============================================================
   export const emailSignUp = async (email, password, name, businessType = '') => {
     try {
       const result = await auth.createUserWithEmailAndPassword(email, password);
       const user = result.user;

       // Update display name
       await user.updateProfile({ displayName: name });

       // Send email verification
       await user.sendEmailVerification();

       // Store user profile in Firestore
       await upsertUserProfile(user, name, businessType);

       // Auto-login after sign up
       await auth.signInWithEmailAndPassword(email, password);

       return {
         success: true,
         user: {
           uid: user.uid,
           email: user.email,
           displayName: user.displayName,
           photoURL: user.photoURL,
           isEmailVerified: user.isEmailVerified
         }
       };
     } catch (error) {
       let errorMessage = 'Something went wrong. Please try again.';
       switch (error.code) {
         case 'auth/email-already-in-use':
           errorMessage = 'This email is already registered. Please use a different email or login.';
           break;
         case 'auth/invalid-email':
           errorMessage = 'Please enter a valid email address.';
           break;
         case 'auth/weak-password':
           errorMessage = 'Password should be at least 6 characters.';
           break;
         default:
           errorMessage = error.message || 'Something went wrong.';
       }
       return { success: false, error: errorMessage };
     }
   };

   // ============================================================
   // Password Reset
   // ============================================================
   export const resetPassword = async (email) => {
     try {
       await auth.sendPasswordResetEmail(email);
       return { success: true, message: 'Password reset email sent. Please check your inbox.' };
     } catch (error) {
       let errorMessage = 'Something went wrong. Please try again.';
       switch (error.code) {
         case 'auth/user-not-found':
           errorMessage = 'This email is not registered.';
           break;
         case 'auth/invalid-email':
           errorMessage = 'Please enter a valid email address.';
           break;
         default:
           errorMessage = error.message || 'Something went wrong.';
       }
       return { success: false, error: errorMessage };
     }
   };

   // ============================================================
   // Sign Out
   // ============================================================
   export const signOut = async () => {
     try {
       await auth.signOut();
       return { success: true };
     } catch (error) {
       return { success: false, error: error.message || 'Sign out failed.' };
     }
   };

   // ============================================================
   // Auth State Observer
   // ============================================================
   export const onAuthStateChanged = (callback) => {
     if (!auth) return;
     return auth.onAuthStateChanged((user) => {
       if (user) {
         callback({
           user: {
             uid: user.uid,
             email: user.email,
             displayName: user.displayName,
             photoURL: user.photoURL,
             isEmailVerified: user.isEmailVerified
           },
           isAuthenticated: true
         });
       } else {
         callback({
           user: null,
           isAuthenticated: false
         });
       }
     });
   };

   // ============================================================
   // Get Current User
   // ============================================================
   export const getCurrentUser = () => {
     const user = auth.currentUser;
     if (user) {
       return {
         uid: user.uid,
         email: user.email,
         displayName: user.displayName,
         photoURL: user.photoURL,
         isEmailVerified: user.isEmailVerified
       };
     }
     return null;
   };

   // ============================================================
   // Helper: Update Last Login Timestamp
   // ============================================================
   const updateLastLogin = async (uid) => {
     try {
       await firestore.collection('users').doc(uid).update({
         lastLogin: firebase.firestore.FieldValue.serverTimestamp()
       });
     } catch (error) {
       console.error('Failed to update last login:', error);
     }
   };

   // ============================================================
   // Helper: Upsert User Profile to Firestore
   // ============================================================
   const upsertUserProfile = async (user, name = user.displayName || '', businessType = '') => {
     try {
       const userRef = firestore.collection('users').doc(user.uid);
       const userSnap = await userRef.get();

       if (userSnap.exists) {
         // Update existing user
         const updateData = {
           lastLogin: firebase.firestore.FieldValue.serverTimestamp(),
           name: name || user.displayName || '',
           email: user.email,
           photoURL: user.photoURL,
           updatedAt: firebase.firestore.FieldValue.serverTimestamp()
         };
         if (businessType) updateData.businessType = businessType;
         await userRef.update(updateData);
       } else {
         // Create new user document
         const docData = {
           uid: user.uid,
           name: name || '',
           email: user.email,
           photoURL: user.photoURL,
           createdAt: firebase.firestore.FieldValue.serverTimestamp(),
           lastLogin: firebase.firestore.FieldValue.serverTimestamp()
         };
         if (businessType) docData.businessType = businessType;
         await userRef.set(docData);
       }
     } catch (error) {
       console.error('Failed to upsert user profile:', error);
     }
   };