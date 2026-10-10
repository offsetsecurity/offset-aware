const { test, expect, request: pwRequest } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });
test.use({ storageState: process.env.AWARE_ADMIN_STATE });

test('training validity: only the listed periods are accepted, and the choice is kept', async ({ request }) => {
    expect((await request.post('/api/admin/training-settings', { data: { validMonths: 7 } })).status()).toBe(400);
    expect((await request.post('/api/admin/training-settings', { data: { validMonths: 24 } })).status()).toBe(200);
    expect((await (await request.get('/api/admin/training-settings')).json()).validMonths).toBe(24);
    await request.post('/api/admin/training-settings', { data: { validMonths: 12 } });
});

test('escalation: a bad email or a bad number of days is refused, and a good chain is kept', async ({ request }) => {
    const chain = [
        { name: 'Line manager', email: 'manager@example.test', days: 3 },
        { name: 'Head of department', email: 'head@example.test', days: 7 },
        { name: 'CISO', email: 'ciso@example.test', days: 14 },
        { name: 'CEO', email: '', days: 30 },
    ];
    expect((await request.post('/api/admin/reminder-settings', { data: { enabled: true, hour: 24, chain } })).status()).toBe(400);
    expect((await request.post('/api/admin/reminder-settings', { data: { enabled: true, hour: 9, chain: [{ ...chain[0], email: 'not-an-email' }, ...chain.slice(1)] } })).status()).toBe(400);
    expect((await request.post('/api/admin/reminder-settings', { data: { enabled: true, hour: 9, chain: [{ ...chain[0], days: 0 }, ...chain.slice(1)] } })).status()).toBe(400);
    expect((await request.post('/api/admin/reminder-settings', { data: { enabled: true, hour: 8, chain } })).status()).toBe(200);
    const saved = await (await request.get('/api/admin/reminder-settings')).json();
    expect(saved.enabled).toBe(true);
    expect(saved.hour).toBe(8);
    expect(saved.chain.map((l) => l.email)).toEqual(['manager@example.test', 'head@example.test', 'ciso@example.test', '']);
});

test('sending reminders now runs, and the reminder log can be read', async ({ request }) => {
    const run = await request.post('/api/admin/reminders/run', { data: {} });
    expect(run.status()).toBe(200);
    const body = await run.json();
    expect(body.success).toBe(true);
    for (const k of ['staff', 'chain', 'failed']) expect(typeof body[k]).toBe('number');
    const log = await request.get('/api/admin/reminder-log');
    expect(log.status()).toBe(200);
    expect(Array.isArray(await log.json())).toBe(true);
});

test('the mail password is never shown back, and saving without retyping it keeps it', async ({ request }) => {
    await request.post('/api/admin/smtp', { data: { smtp_host: '127.0.0.1', smtp_port: '9', smtp_user: 'mailer', smtp_pass: 'a-real-secret', mail_from: 'aware@example.test' } });
    const shown = await (await request.get('/api/admin/smtp')).json();
    expect(shown.smtp_pass).toBe('********');
    expect(JSON.stringify(shown)).not.toContain('a-real-secret');
    await request.post('/api/admin/smtp', { data: { smtp_host: '127.0.0.1', smtp_port: '9', smtp_user: 'mailer', smtp_pass: '********', mail_from: 'aware@example.test' } });
    expect((await (await request.get('/api/admin/smtp')).json()).smtp_pass).toBe('********');
});

test('a spreadsheet of people is imported; bad rows and duplicates are skipped', async ({ request }) => {
    const csv = 'emp_id,name,email\nIMP001,Ravi Menon,ravi@example.test\nIMP002,Sara Ali,sara@example.test\nonly-two,columns\nIMP001,Ravi Again,ravi2@example.test\n';
    const res = await request.post('/api/admin/users/import', { multipart: { file: { name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/Added: 2, Skipped\/Duplicates: 2/);
    expect(body.accounts.map((a) => a.emp_id)).toEqual(['IMP001', 'IMP002']);
    process.env.AWARE_IMP002_PASSWORD = body.accounts[1].password;
    const records = JSON.stringify(await (await request.get('/api/admin/records')).json());
    expect(records).toContain('IMP001');
    expect(records).toContain('IMP002');
});

test('each imported person gets a starting password of their own, never "test"', async ({ request }) => {
    const csv = 'emp_id,name,email\nIMP101,A One,a1@example.test\nIMP102,B Two,b2@example.test\nIMP103,C Three,c3@example.test\n';
    const { accounts } = await (await request.post('/api/admin/users/import', { multipart: { file: { name: 'more.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } })).json();
    const passwords = accounts.map((a) => a.password);
    expect(new Set(passwords).size, 'all different').toBe(3);
    for (const p of passwords) {
        expect(p).not.toBe('test');
        expect(p).toMatch(/^[A-Za-z0-9]{12}$/);
    }
});

test('an imported person signs in with their own starting password and must choose a new one; "test" does not work', async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });
    expect((await api.post('/api/login', { data: { emp_id: 'IMP002', password: 'test' } })).status()).toBe(401);
    const login = await (await api.post('/api/login', { data: { emp_id: 'IMP002', password: process.env.AWARE_IMP002_PASSWORD } })).json();
    expect(login.requirePasswordChange).toBe(true);
    expect((await api.get('/api/me')).status()).toBe(401);
    await api.dispose();
});

test('adding one person without a password gives them their own, shown once', async ({ request }) => {
    const res = await (await request.post('/api/admin/users', { data: { emp_id: 'ONE001', name: 'Single Person', email: 'single@example.test' } })).json();
    expect(res.success).toBe(true);
    expect(res.startingPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    const typed = await (await request.post('/api/admin/users', { data: { emp_id: 'ONE002', name: 'Typed Person', email: 'typed@example.test', password: 'chosen-by-admin-1' } })).json();
    expect(typed.startingPassword, 'not echoed when the administrator chose it').toBeUndefined();
});

test('the import screen shows each starting password once, with a download', async ({ page }) => {
    await page.goto('/');
    await page.locator('.sidebar a[data-key="provision"]').click();
    await page.locator('#bulk-import-file').setInputFiles({ name: 'screen.csv', mimeType: 'text/csv', buffer: Buffer.from('emp_id,name,email\nSCR001,Screen Import,scr@example.test\n') });
    await expect(page.locator('#bulk-drop')).toContainText('screen.csv is ready');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.locator('#bulk-import-msg')).toContainText('1added');
    const box = page.locator('#bulk-import-accounts');
    await expect(box).toContainText('SCR001');
    await expect(box.locator('code')).toHaveText(/^[A-Za-z0-9]{12}$/);
    await expect(box.getByRole('link', { name: 'Download the list' })).toBeVisible();
});

test('the Settings and Escalation screens open and show what was saved', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.locator('.sidebar a[data-key="escalation"]').click();
    await expect.poll(() => page.locator('#admin-view input').evaluateAll((is) => is.map((i) => i.value)))
        .toContain('manager@example.test');
    await page.locator('.sidebar a[data-key="settings"]').click();
    await expect(page.locator('#page-title')).toHaveText('Settings');
    expect(errors).toEqual([]);
});
