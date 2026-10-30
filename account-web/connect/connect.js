// Consent page for connecting an AI assistant (docs/ASSISTANT_CONNECTOR.md). The user signs in the
// way they do in the app's Account & sync, with Google or (an account made on an iPhone) Sign in with
// Apple; approving sends the Firebase ID token and the pending request id to /oauth/approve, which
// returns the assistant's redirect with a one-time code.
// A brand-new sign-in whose account isn't set up in the app is deleted again, so it doesn't stay
// behind as an empty account.
// "Sign in with email" exists for the review account the assistant directories test with; the
// server accepts a password sign-in from that account only.
// Only Claude, Claude Code and ChatGPT (by their exact client metadata URLs) are named; any other app shows
// as "Unverified app" with the site its codes go to, and cancelling it shows a page, not a redirect.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, onAuthStateChanged, GoogleAuthProvider, OAuthProvider,
  signInWithPopup, signOut, signInWithEmailAndPassword, connectAuthEmulator, getAdditionalUserInfo, deleteUser, revokeAccessToken,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { appleProvider, notSetUpMessage, signInError, signedInLabel } from '/sign-in.js';

const element = id => document.getElementById(id);
const page = element('page');
const request = new URLSearchParams(location.search).get('request');
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const EXPIRED = ['This request expired', 'Start connecting again from your assistant.'];
const RATE_LIMITED = 'Too many attempts. Wait a few minutes and try again.';
let busy = false;

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error_description || 'Request failed'), { code: data.error, status: response.status });
  return data;
}

/** The status line; tone 'error' colours it. */
function show(message, tone = '') {
  element('status').textContent = message;
  element('status').dataset.tone = tone;
}

/** Ends the flow on a page that only says what happened: state is error, info, approved or cancelled. */
function stop(title, message, state = 'error') {
  for (const id of ['details', 'sign-in-options', 'email-sign-in', 'account', 'not-ready', 'approve', 'cancel']) element(id).hidden = true;
  page.dataset.state = state;
  delete page.dataset.busy;
  element('heading').textContent = title;
  element('intro').textContent = message;
  show('');
}

/** The assistant's monogram, as in the app: Claude "C", ChatGPT "G", a warning sign for an unverified app. */
function showBadge(info) {
  const kind = !info.verified ? 'unverified'
    : info.clientName.startsWith('Claude') ? 'claude'
      : info.clientName === 'ChatGPT' ? 'chatgpt' : 'other';
  element('badge').dataset.kind = kind;
  element('initial').textContent = kind === 'claude' ? 'C' : kind === 'chatgpt' ? 'G' : kind === 'other' ? info.clientName.slice(0, 1) : '';
}

function setBusy(decision) {
  for (const id of ['approve', 'cancel']) {
    element(id).disabled = Boolean(decision);
    if (decision && id === (decision === 'approve' ? 'approve' : 'cancel')) element(id).setAttribute('aria-busy', 'true');
    else element(id).removeAttribute('aria-busy');
  }
  if (decision) page.dataset.busy = decision;
  else delete page.dataset.busy;
}

async function decide(decision, user) {
  if (busy) return;
  busy = true;
  setBusy(decision);
  show(decision === 'approve' ? 'Connecting…' : 'Cancelling…');
  try {
    const idToken = user ? await user.getIdToken() : undefined;
    const { redirect, cancelled } = await post('/oauth/approve', { request, idToken, decision });
    if (cancelled || !redirect) {
      stop('Cancelled', 'Nothing was connected. You can close this page.', 'cancelled');
      return;
    }
    const approved = decision === 'approve';
    stop(approved ? 'Approved' : 'Cancelled', 'Returning to your assistant…', approved ? 'approved' : 'cancelled');
    show(approved ? 'Approved. Returning to your assistant…' : 'Cancelled. Returning to your assistant…');
    location.assign(redirect);
  } catch (error) {
    busy = false;
    setBusy(null);
    if (error.code === 'expired') stop(...EXPIRED);
    else if (error.code === 'account_not_ready') show(error.message, 'error');
    else if (error.status === 429) show(RATE_LIMITED, 'error');
    else show('Couldn’t finish. Please try again.', 'error');
  }
}

async function start() {
  if (!request) {
    stop('Connect an assistant', 'This page opens from your assistant when you connect Always On Time. Start from Claude or ChatGPT’s connector settings.', 'info');
    return;
  }
  let info;
  try {
    info = await post('/oauth/consent', { request });
  } catch (error) {
    if (error.code === 'expired') stop(...EXPIRED);
    else if (error.status === 429) stop('Too many attempts', 'Wait a few minutes, then try again from your assistant.');
    else stop('Something went wrong', 'Couldn’t load this connection request. Please try again from your assistant.');
    return;
  }
  const scopes = Array.isArray(info.scopes) ? info.scopes : [];
  showBadge(info);
  // An unverified client's name is the generic "Unverified app"; phrase it as a description, not a name.
  element('heading').textContent = info.verified ? `Connect ${info.clientName}` : 'Connect an unverified app';
  element('client').textContent = info.verified ? info.clientName : 'An unverified app';
  element('redirect-host').textContent = info.clientHost;
  element('unverified').hidden = info.verified;
  element('unverified-host').textContent = info.clientHost;
  element('started-from').textContent = info.verified ? info.clientName : `the app at ${info.clientHost}`;
  // An empty scope list means both; a read-only request says it can change nothing.
  element('scope-write').hidden = scopes.length > 0 && !scopes.includes('alarms.write');
  element('scope-read-only').hidden = !element('scope-write').hidden;
  element('intro').textContent = 'Sign in to review and approve this connection.';
  element('details').hidden = false;
  element('cancel').hidden = false;
  page.dataset.state = 'consent';

  const config = await fetch('/firebase-config.json').then(response => response.json());
  // Local testing runs against the Auth emulator and the emulators' demo project.
  const app = initializeApp(local ? { ...config, projectId: 'demo-account-sync' } : config);
  // Kept in memory only: a sign-in from another visit or tab never carries over, so whoever opens
  // this link signs in here themselves before anything can be approved.
  const auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  if (local) connectAuthEmulator(auth, 'http://127.0.0.1:9199', { disableWarnings: true });
  let currentUser = null;
  // Why the last account was signed out, kept across the sign-out's own state change.
  let notice = '';
  // The popup sign-in in progress, set before it opens: the only way this page gains a user apart
  // from the email form, which clears it.
  let popup = null;

  /**
   * Removes a brand-new Google or Apple sign-in whose account isn't set up in the app, so it doesn't
   * stay behind as an empty account (say, someone whose account signs in with Google trying Sign in
   * with Apple). The app makes a fresh one if they set it up later. Returns whether it did; an
   * existing sign-in is left alone, since a phone may be signed in with it.
   */
  async function removedNewSignIn(user) {
    const pending = popup;
    const result = await pending?.promise.catch(() => null);
    if (!result || result.user.uid !== user.uid || !getAdditionalUserInfo(result)?.isNewUser) return false;
    try {
      // While the user still exists: revoke a new Apple sign-in so Apple stops listing the app.
      const accessToken = pending.method === 'apple' ? OAuthProvider.credentialFromResult(result)?.accessToken : null;
      if (accessToken) await revokeAccessToken(auth, accessToken).catch(() => {});
      notice = notSetUpMessage(pending.method);
      await deleteUser(user); // also signs out, which shows the notice
      return true;
    } catch {
      notice = '';
      return false;
    }
  }

  onAuthStateChanged(auth, async user => {
    currentUser = user;
    element('sign-in-options').hidden = Boolean(user);
    element('email-sign-in').hidden = Boolean(user);
    element('account').hidden = !user;
    element('approve').hidden = true;
    element('not-ready').hidden = true;
    show(notice, notice ? 'error' : '');
    notice = '';
    if (!user) {
      element('intro').textContent = 'Sign in to review and approve this connection.';
      return;
    }
    element('email').textContent = signedInLabel(user);
    // An Apple account was made on an iPhone, so the Google Play link doesn't apply.
    element('get-app').hidden = user.providerData.some(profile => profile.providerId === 'apple.com');
    try {
      const status = await post('/oauth/consent', { request, idToken: await user.getIdToken() });
      if (status.account !== 'ready' && await removedNewSignIn(user)) return;
      element('intro').textContent = status.account === 'ready'
        ? `Approve to let ${info.verified ? info.clientName : 'this app'} manage alarms for this account.`
        : 'One more step before connecting.';
      element('not-ready').hidden = status.account === 'ready';
      element('approve').hidden = status.account !== 'ready';
    } catch (error) {
      if (error.code === 'expired') stop(...EXPIRED);
      else if (error.code === 'login_required') { notice = 'Sign in with Google or Apple.'; await signOut(auth); }
      else if (error.status === 429) show(RATE_LIMITED, 'error');
      else show('Couldn’t check this account. Please try again.', 'error');
    }
  });
  const signInWith = async (provider, method) => {
    const buttons = [element('sign-in'), element('sign-in-apple')];
    for (const button of buttons) button.disabled = true;
    show('');
    popup = { method, promise: signInWithPopup(auth, provider) };
    try { await popup.promise; }
    catch (error) { const message = signInError(error, method); if (message) show(message, 'error'); }
    finally { for (const button of buttons) button.disabled = false; }
  };
  element('sign-in').addEventListener('click', () => signInWith(new GoogleAuthProvider(), 'google'));
  element('sign-in-apple').addEventListener('click', () => signInWith(appleProvider(OAuthProvider), 'apple'));
  element('email-toggle').addEventListener('click', () => {
    const open = element('email-form').hidden;
    element('email-form').hidden = !open;
    element('email-toggle').setAttribute('aria-expanded', String(open));
    if (open) element('email-address').focus();
  });
  element('email-form').addEventListener('submit', async event => {
    event.preventDefault();
    element('email-submit').disabled = true;
    show('');
    popup = null;
    try {
      await signInWithEmailAndPassword(auth, element('email-address').value.trim(), element('email-password').value);
      element('email-password').value = '';
    } catch (error) {
      show(error.code === 'auth/too-many-requests' ? RATE_LIMITED : 'Couldn’t sign in. Check the email and password.', 'error');
    } finally {
      element('email-submit').disabled = false;
    }
  });
  element('sign-out').addEventListener('click', () => signOut(auth));
  element('approve').addEventListener('click', () => decide('approve', currentUser));
  element('cancel').addEventListener('click', () => decide('deny', null));
}

start();
