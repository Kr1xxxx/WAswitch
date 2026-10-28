// Test-only app entry: explicitly isolate data before the main module takes its lock.
const { app } = require('electron');
const fs = require('fs');
const profile = process.env.WASWITCH_TEST_PROFILE;
if (!profile || !fs.existsSync(profile)) throw new Error('Missing isolated view-race profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
require('../../src/main');
