// Tests for Offset Aware: the server's rules and the screens, on a throwaway
// database. DB_PATH and UPLOADS_DIR point at a temporary folder, so the real
// database.sqlite and uploads are never touched.
const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.AWARE_TEST_PORT || 8299);
const data = process.env.AWARE_TEST_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'aware-tests-'));
process.env.AWARE_TEST_DATA = data;
process.env.AWARE_ADMIN_STATE = path.join(data, 'admin-state.json');
// Course packs go to a folder of the run's own, never into public/training.
// "Downloads" come from a server a test starts on this machine.
process.env.AWARE_TEST_TRAINING = path.join(data, 'training');
process.env.AWARE_TEST_PACKS_PORT = String(port + 1);

module.exports = defineConfig({
    testDir: './tests',
    globalSetup: require.resolve('./tests/global-setup.js'),
    workers: 1,
    fullyParallel: false,
    timeout: 60000,
    expect: { timeout: 15000 },
    reporter: [['list']],
    use: {
        baseURL: `https://localhost:${port}`,
        ignoreHTTPSErrors: true,
        viewport: { width: 1360, height: 860 },
        ...(process.env.CI ? {} : { channel: 'msedge' }),
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'node server.js',
        url: `https://localhost:${port}/api/setup/status`,
        ignoreHTTPSErrors: true,
        reuseExistingServer: false,
        timeout: 120000,
        env: {
            PORT: String(port),
            NODE_ENV: 'test',
            DB_PATH: path.join(data, 'database.sqlite'),
            UPLOADS_DIR: path.join(data, 'uploads'),
            TRAINING_DIR: path.join(data, 'training'),
            PACKS_URL: `http://127.0.0.1:${port + 1}/`,
            SESSION_SECRET: 'aware-test-session-secret-0123456789',
            // The tests sign in more often in two minutes than an office does in a day.
            LOGIN_ATTEMPTS_PER_15_MIN: '40',
            PORTAL_URL: `https://localhost:${port}`,
        },
    },
});
