// Run with: firebase emulators:exec --only storage 'node functions/testing/storage-rules.cjs'
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');
const fs = require('node:fs');

(async () => {
  const environment = await initializeTestEnvironment({
    projectId: 'demo-account-sync',
    storage: { rules: fs.readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9299 }
  });
  try {
    const anon = environment.authenticatedContext('anon', { firebase: { sign_in_provider: 'anonymous' } }).storage();
    const other = environment.authenticatedContext('other', { firebase: { sign_in_provider: 'anonymous' } }).storage();
    const signedOut = environment.unauthenticatedContext().storage();
    const png = new Uint8Array([137, 80, 78, 71]);
    const image = { contentType: 'image/png' };
    const path = 'feedback/anon/f1/a1';

    await assertSucceeds(uploadBytes(ref(anon, path), png, image));
    await assertSucceeds(uploadBytes(ref(anon, 'feedback/anon/f1/log'), new TextEncoder().encode('log'), { contentType: 'text/plain' }));
    await assertSucceeds(getBytes(ref(anon, path)));
    // Create only: an existing attachment cannot be overwritten, by its uploader or anyone else.
    await assertFails(uploadBytes(ref(anon, path), png, image));
    await assertFails(uploadBytes(ref(other, path), png, image));
    // Only the uploader's own folder, only signed in, only images and plain text, not empty, at most 5 MB.
    await assertFails(uploadBytes(ref(other, 'feedback/anon/f1/a2'), png, image));
    await assertFails(uploadBytes(ref(signedOut, 'feedback/anon/f1/a3'), png, image));
    await assertFails(uploadBytes(ref(anon, 'feedback/anon/f1/a4'), png, { contentType: 'text/html' }));
    await assertFails(uploadBytes(ref(anon, 'feedback/anon/f1/a5'), new Uint8Array(0), image));
    await assertFails(uploadBytes(ref(anon, 'feedback/anon/f1/a6'), new Uint8Array(5 * 1024 * 1024 + 1), image));
    await assertFails(uploadBytes(ref(anon, 'elsewhere/anon/f1/a7'), png, image));
    await assertFails(getBytes(ref(other, path)));
    await assertFails(deleteObject(ref(other, path)));
    // The app deletes its own partial uploads when a submission fails.
    await assertSucceeds(deleteObject(ref(anon, path)));
    console.log('Storage rules: create-only, owner-scoped, typed and size-limited feedback attachments passed.');
  } finally { await environment.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
