import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, OAuthProvider, signInWithPopup, signOut, revokeAccessToken,
  getAdditionalUserInfo,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { appleDeletionStep, appleProvider, noAccountMessage, signInError, signedInLabel } from '/sign-in.js';

const config = await fetch('/firebase-config.json').then(response => response.json());
const app = initializeApp(config);
const auth = getAuth(app);
const removeAccount = httpsCallable(getFunctions(app, 'us-central1'), 'deleteSyncedAccount');
const element = id => document.getElementById(id);
const status = (message, tone = '') => { element('status').textContent = message; element('status').dataset.tone = tone; };
let deleting = false;
// While a new sign-in is checked, the account isn't shown, so nothing can be deleted before the check.
let checking = false;
// This visit's own sign-in, kept in memory only: whether there was one (a session restored from an
// earlier visit has none), and Sign in with Apple's access token. Deleting an Apple account revokes
// that token first (as the iPhone app does), so Apple stops listing the app.
let session = { fresh: false, appleAccessToken: null };

function render(user) {
  const signedIn = Boolean(user) && !checking;
  element('account').hidden = !signedIn;
  element('sign-in-options').hidden = signedIn;
  element('email').textContent = signedInLabel(user);
  element('confirm').checked = false;
  element('delete').disabled = true;
}
onAuthStateChanged(auth, user => {
  if (!user) session = { fresh: false, appleAccessToken: null };
  render(user);
});

/**
 * Removes a sign-in that no Always On Time account uses, so the page doesn't "delete" an empty account
 * it just made (say, Apple's Hide My Email by someone whose account signs in with Google). The server
 * deletes it only if no account uses it. A brand-new Apple sign-in is revoked first, while the user
 * still exists. Returns whether the sign-in was removed; on any failure the account is shown as usual.
 */
async function removedUnusedSignIn(result, appleAccessToken) {
  try {
    if (appleAccessToken && getAdditionalUserInfo(result)?.isNewUser) {
      try { await revokeAccessToken(auth, appleAccessToken); } catch { /* removal continues */ }
    }
    const { data } = await removeAccount({ onlyIfUnused: true });
    if (!data?.deleted) return false;
    await signOut(auth);
    return true;
  } catch {
    return false;
  }
}

async function signInWith(provider, method) {
  const buttons = [element('sign-in'), element('sign-in-apple')];
  for (const button of buttons) button.disabled = true;
  status('');
  checking = true;
  try {
    const result = await signInWithPopup(auth, provider);
    const appleAccessToken = method === 'apple' ? OAuthProvider.credentialFromResult(result)?.accessToken ?? null : null;
    session = { fresh: true, appleAccessToken };
    status('Checking your account…');
    status(await removedUnusedSignIn(result, appleAccessToken) ? noAccountMessage(method) : '');
  } catch (error) {
    const message = signInError(error, method);
    if (message) status(message, 'error');
  } finally {
    checking = false;
    render(auth.currentUser);
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
      const step = appleDeletionStep({ freshSignIn: session.fresh, accessToken: session.appleAccessToken });
      if (step === 'sign-in-again') {
        await signOut(auth);
        status('Sign in with Apple again, then confirm account deletion.', 'error');
        return;
      }
      // A failed revocation doesn't stop the deletion (as in the iPhone app).
      if (step === 'revoke') {
        try { await revokeAccessToken(auth, session.appleAccessToken); } catch { /* deletion continues */ }
      }
    }
    const { data } = await removeAccount();
    await signOut(auth);
    if (data?.hadAccount === false) status(noAccountMessage(signInProvider === 'apple.com' ? 'apple' : 'google'));
    else status('Your Always On Time account and synced data have been deleted.', 'success');
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
