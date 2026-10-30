// Shared by the consent (connect/) and delete-account pages: the Sign in with Apple provider and the
// messages for a sign-in. Kept free of Firebase imports so scripts/test can load it in Node.

/** Sign in with Apple, asking for the email only, as the iPhone app does (no name is shown). */
export function appleProvider(OAuthProvider) {
  const provider = new OAuthProvider('apple.com');
  provider.addScope('email');
  return provider;
}

/**
 * The message for a failed sign-in with `method` ('google' or 'apple'), or '' when the user just
 * closed the window. Firebase keeps one account per email, so an email whose account signs in the
 * other way is refused; say which button to use, as the iPhone app does.
 */
export function signInError(error, method) {
  if (error?.code === 'auth/popup-closed-by-user' || error?.code === 'auth/cancelled-popup-request') return '';
  if (error?.code === 'auth/account-exists-with-different-credential') {
    return method === 'apple'
      ? 'This email already has an account that signs in with Google. Use Sign in with Google instead.'
      : 'This email already has an account that signs in with Apple. Use Sign in with Apple instead.';
  }
  if (error?.code === 'auth/popup-blocked') return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
  return 'Couldn’t sign in. Please try again.';
}

/** Who is signed in: the email, or for an Apple account that shared none, "your Apple Account". */
export function signedInLabel(user) {
  if (user?.email) return user.email;
  return user?.providerData?.some(profile => profile.providerId === 'apple.com') ? 'your Apple Account' : '';
}

const providerName = method => (method === 'apple' ? 'Apple' : 'Google');

/**
 * The delete page's message when no Always On Time account uses the sign-in, such as Apple's Hide My
 * Email used by someone whose account signs in with Google. The page has removed that sign-in.
 */
export function noAccountMessage(method) {
  const other = method === 'apple' ? 'Google' : 'Apple';
  return `No Always On Time account uses this ${providerName(method)} sign-in, so there’s nothing to delete. `
    + `If you use the app with a different account or with Sign in with ${other}, sign in with that instead.`;
}

/** The consent page's message after it removes a brand-new sign-in that isn't set up in the app. */
export function notSetUpMessage(method) {
  return `No Always On Time account uses this ${providerName(method)} sign-in yet. Sign in with the account you use in the app, `
    + 'or install Always On Time and sign in under Settings › Account & sync first.';
}

/**
 * Before the delete page deletes an Apple account: 'revoke' this visit's Apple token, or 'sign-in-again'
 * for a session restored from an earlier visit, which has no token to revoke. A fresh sign-in that
 * returned no token goes ahead ('delete'): a failed revocation must not block deletion.
 */
export function appleDeletionStep({ freshSignIn, accessToken }) {
  if (!freshSignIn) return 'sign-in-again';
  return accessToken ? 'revoke' : 'delete';
}
