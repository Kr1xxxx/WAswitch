// Run local fixture tests serially with disposable profiles, never the installed app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const tests = process.argv.slice(2);
if (!tests.length) throw new Error('Provide fixture test paths');
for (const test of tests) {
  const file = path.resolve(root, test);
  if (path.dirname(file) !== __dirname || !/^check-[A-Za-z0-9_-]+[.]js$/.test(path.basename(file))) throw new Error('Only local fixture tests are allowed');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-electron-test-'));
  try {
    const result = spawnSync(require('electron'), [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(__dirname, 'check-electron-bootstrap.js'), file], {
      cwd: root, stdio: 'inherit', timeout: 120000, env: { ...process.env, WASWITCH_TEST_PROFILE: profile },
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) { process.exitCode = result.status || 1; break; }
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
