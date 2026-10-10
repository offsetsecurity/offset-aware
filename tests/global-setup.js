// Signs the administrator in once and keeps the session. The server allows ten
// sign-ins per address every fifteen minutes, so tests reuse this one.
const { request } = require('@playwright/test');
const path = require('node:path');
const { ADMIN } = require('./support');

module.exports = async (config) => {
    const { baseURL } = config.projects[0].use;
    const api = await request.newContext({ baseURL, ignoreHTTPSErrors: true });
    // The first test checks the first-run screen, so the administrator is made by the
    // browser there; this only makes it when that test is skipped or run out of order.
    const status = await (await api.get('/api/setup/status')).json();
    process.env.AWARE_FRESH_INSTALL = status.needsAdmin ? '1' : '0';
    await api.dispose();
};
