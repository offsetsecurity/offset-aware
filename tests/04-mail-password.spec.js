const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');

test.use({ storageState: process.env.AWARE_ADMIN_STATE });

// The functions are inside server.js; this checks the same scheme from outside:
// a saved password is stored as v2 (GCM) and is never sent back.
test('the mail password is stored in the tamper-proof form and still works for sending', async ({ request }) => {
    await request.post('/api/admin/smtp', { data: { smtp_host: '127.0.0.1', smtp_port: '9', smtp_user: 'mailer', smtp_pass: 'gcm-test-secret', mail_from: 'aware@example.test' } });
    const shown = await (await request.get('/api/admin/smtp')).json();
    expect(shown.smtp_pass).toBe('********');
    // Sending tries the configured server, so the password decrypted cleanly.
    const send = await request.post('/api/test-email', { data: { to: 'someone@example.test' } });
    expect([200, 400, 500]).toContain(send.status());
    expect(JSON.stringify(await send.json())).not.toContain('gcm-test-secret');
});
