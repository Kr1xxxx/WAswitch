// Test-only app entry for check-login-lock.js and the checks that start logged in (fixtures/cloud-team.js):
// isolated profile + a fake keyring.
// xvfb on CI has no system keyring, and the login token must be stored encrypted, so the
// test swaps safeStorage for a reversible fake. Never used by the real app.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const profile = process.env.WASWITCH_TEST_PROFILE;
if (!profile || !fs.existsSync(profile)) throw new Error('Missing isolated login-lock profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
safeStorage.isEncryptionAvailable = () => true;
safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
safeStorage.encryptString = (t) => Buffer.from(`fake:${t}`);
safeStorage.decryptString = (b) => Buffer.from(b).toString().replace(/^fake:/, '');
require('../../src/main');
