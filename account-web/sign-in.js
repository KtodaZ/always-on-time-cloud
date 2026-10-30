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
