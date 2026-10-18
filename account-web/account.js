import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

const config = await fetch('/firebase-config.json').then(response => response.json());
const app = initializeApp(config);
const auth = getAuth(app);
const removeAccount = httpsCallable(getFunctions(app, 'us-central1'), 'deleteSyncedAccount');
const element = id => document.getElementById(id);
const status = (message, tone = '') => { element('status').textContent = message; element('status').dataset.tone = tone; };
let deleting = false;
onAuthStateChanged(auth, user => {
  element('account').hidden = !user;
  element('sign-in').hidden = Boolean(user);
  element('email').textContent = user?.email || '';
  element('confirm').checked = false;
  element('delete').disabled = true;
});
element('sign-in').addEventListener('click', async () => {
  element('sign-in').disabled = true;
  status('');
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (error) { if (error.code !== 'auth/popup-closed-by-user') status('Couldn’t sign in. Please try again.', 'error'); }
  finally { element('sign-in').disabled = false; }
});
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
