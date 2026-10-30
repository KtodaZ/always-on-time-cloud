import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, OAuthProvider, signInWithPopup, signOut, revokeAccessToken,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { appleProvider, signInError, signedInLabel } from '/sign-in.js';

const config = await fetch('/firebase-config.json').then(response => response.json());
const app = initializeApp(config);
const auth = getAuth(app);
const removeAccount = httpsCallable(getFunctions(app, 'us-central1'), 'deleteSyncedAccount');
const element = id => document.getElementById(id);
const status = (message, tone = '') => { element('status').textContent = message; element('status').dataset.tone = tone; };
let deleting = false;
// The Apple access token from this page's own Sign in with Apple, kept in memory only. Deleting an
// Apple account revokes it first (as the iPhone app does), so Apple stops listing the app.
let appleAccessToken = null;
onAuthStateChanged(auth, user => {
  if (!user) appleAccessToken = null;
  element('account').hidden = !user;
  element('sign-in-options').hidden = Boolean(user);
  element('email').textContent = signedInLabel(user);
  element('confirm').checked = false;
  element('delete').disabled = true;
});
async function signInWith(provider, method) {
  const buttons = [element('sign-in'), element('sign-in-apple')];
  for (const button of buttons) button.disabled = true;
  status('');
  try {
    const result = await signInWithPopup(auth, provider);
    if (method === 'apple') appleAccessToken = OAuthProvider.credentialFromResult(result)?.accessToken ?? null;
  } catch (error) {
    const message = signInError(error, method);
    if (message) status(message, 'error');
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}
element('sign-in').addEventListener('click', () => signInWith(new GoogleAuthProvider(), 'google'));
element('sign-in-apple').addEventListener('click', () => signInWith(appleProvider(OAuthProvider), 'apple'));
element('sign-out').addEventListener('click', () => signOut(auth));
element('confirm').addEventListener('change', () => { element('delete').disabled = !element('confirm').checked || deleting; });
element('delete').addEventListener('click', async () => {
  if (!element('confirm').checked || !auth.currentUser || deleting) return;
  deleting = true;
  element('delete').disabled = true;
  element('sign-out').disabled = true;
  element('delete').setAttribute('aria-busy', 'true');
  status('Deleting your account and synced data…');
  try {
    const { signInProvider } = await auth.currentUser.getIdTokenResult();
    if (signInProvider === 'apple.com') {
      // A session restored from an earlier visit has no Apple token to revoke: sign in again.
      if (!appleAccessToken) {
        await signOut(auth);
        status('Sign in with Apple again, then confirm account deletion.', 'error');
        return;
      }
      // A failed revocation doesn't stop the deletion (as in the iPhone app).
      try { await revokeAccessToken(auth, appleAccessToken); } catch { /* deletion continues */ }
    }
    await removeAccount();
    await signOut(auth);
    status('Your Always On Time account and synced data have been deleted.', 'success');
  } catch (error) {
    if (error.code === 'functions/failed-precondition' || error.code === 'functions/unauthenticated') {
      await signOut(auth);
      status('Please sign in again, then confirm account deletion.', 'error');
    } else status('Couldn’t finish deleting your account. Please try again.', 'error');
  } finally {
    deleting = false;
    element('delete').removeAttribute('aria-busy');
    element('delete').disabled = !element('confirm').checked;
    element('sign-out').disabled = false;
  }
});
