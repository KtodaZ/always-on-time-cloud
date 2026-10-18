// Consent page for connecting an AI assistant (docs/ASSISTANT_CONNECTOR.md). The user signs in with
// the Google account they use in the app; approving sends the Firebase ID token and the pending
// request id to /oauth/approve, which returns the assistant's redirect with a one-time code.
// Only Claude, Claude Code and ChatGPT (by their exact client metadata URLs) are named; any other app shows
// as "Unverified app" with the site its codes go to, and cancelling it shows a page, not a redirect.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
  connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const element = id => document.getElementById(id);
const request = new URLSearchParams(location.search).get('request');
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
let busy = false;

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error_description || 'Request failed'), { code: data.error, status: response.status });
  return data;
}

function show(message) {
  element('status').textContent = message;
}

function stop(message) {
  for (const id of ['details', 'sign-in', 'account', 'approve', 'cancel']) element(id).hidden = true;
  element('intro').textContent = message;
}

async function decide(decision, user) {
  if (busy) return;
  busy = true;
  element('approve').disabled = true;
  element('cancel').disabled = true;
  show(decision === 'approve' ? 'Connecting…' : 'Cancelling…');
  try {
    const idToken = user ? await user.getIdToken() : undefined;
    const { redirect, cancelled } = await post('/oauth/approve', { request, idToken, decision });
    if (cancelled || !redirect) {
      stop('Cancelled. Nothing was connected. You can close this page.');
      show('');
      return;
    }
    show(decision === 'approve' ? 'Approved. Returning to your assistant…' : 'Cancelled. Returning to your assistant…');
    location.assign(redirect);
  } catch (error) {
    busy = false;
    element('approve').disabled = false;
    element('cancel').disabled = false;
    if (error.code === 'expired') stop('This connection request expired. Start connecting again from your assistant.');
    else if (error.code === 'account_not_ready') show(error.message);
    else show('Couldn’t finish. Please try again.');
  }
}

async function start() {
  if (!request) {
    stop('This page opens from your assistant when you connect Always On Time. Start from Claude or ChatGPT’s connector settings.');
    return;
  }
  let info;
  try {
    info = await post('/oauth/consent', { request });
  } catch (error) {
    stop(error.code === 'expired' ? 'This connection request expired. Start connecting again from your assistant.' : 'Couldn’t load this connection request. Please try again from your assistant.');
    return;
  }
  element('heading').textContent = `Connect ${info.clientName}`;
  element('client').textContent = info.clientName;
  element('redirect-host').textContent = info.clientHost;
  element('unverified').hidden = info.verified;
  element('unverified-host').textContent = info.clientHost;
  element('started-from').textContent = info.verified ? info.clientName : `the app at ${info.clientHost}`;
  element('intro').textContent = 'Sign in to review and approve this connection.';
  element('details').hidden = false;
  element('cancel').hidden = false;

  const config = await fetch('/firebase-config.json').then(response => response.json());
  // Local testing runs against the Auth emulator and the emulators' demo project.
  const app = initializeApp(local ? { ...config, projectId: 'demo-account-sync' } : config);
  // Kept in memory only: a sign-in from another visit or tab never carries over, so whoever opens
  // this link signs in here themselves before anything can be approved.
  const auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  if (local) connectAuthEmulator(auth, 'http://127.0.0.1:9199', { disableWarnings: true });
  let currentUser = null;

  onAuthStateChanged(auth, async user => {
    currentUser = user;
    element('sign-in').hidden = Boolean(user);
    element('account').hidden = !user;
    element('approve').hidden = true;
    element('not-ready').hidden = true;
    show('');
    if (!user) return;
    element('email').textContent = user.email || '';
    try {
      const status = await post('/oauth/consent', { request, idToken: await user.getIdToken() });
      element('intro').textContent = status.account === 'ready'
        ? `Approve to let ${info.clientName} manage alarms for this account.`
        : 'One more step before connecting.';
      element('not-ready').hidden = status.account === 'ready';
      element('approve').hidden = status.account !== 'ready';
    } catch (error) {
      if (error.code === 'expired') stop('This connection request expired. Start connecting again from your assistant.');
      else if (error.code === 'login_required') { show('Sign in with a Google account.'); await signOut(auth); }
      else show('Couldn’t check this account. Please try again.');
    }
  });
  element('sign-in').addEventListener('click', async () => {
    element('sign-in').disabled = true;
    show('');
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (error) { if (error.code !== 'auth/popup-closed-by-user') show('Couldn’t sign in. Please try again.'); }
    finally { element('sign-in').disabled = false; }
  });
  element('sign-out').addEventListener('click', () => signOut(auth));
  element('approve').addEventListener('click', () => decide('approve', currentUser));
  element('cancel').addEventListener('click', () => decide('deny', null));
}

start();
