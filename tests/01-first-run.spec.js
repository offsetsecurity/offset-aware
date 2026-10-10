const { test, expect } = require('@playwright/test');
const { ADMIN } = require('./support');

test.describe.configure({ mode: 'serial' });

test('a new install offers to create the administrator, and signs them in', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create the administrator account' }).click();
    await page.locator('#create-admin-id').fill(ADMIN.emp_id);
    await page.locator('#create-admin-name').fill(ADMIN.name);
    await page.locator('#create-admin-email').fill(ADMIN.email);
    await page.locator('#create-admin-password').fill(ADMIN.password);
    await page.locator('#create-admin-confirm').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Create administrator' }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#side-name')).toHaveText(ADMIN.name);
    await page.context().storageState({ path: process.env.AWARE_ADMIN_STATE });
});

test('once an administrator exists, nobody else can become one', async ({ request }) => {
    const status = await (await request.get('/api/setup/status')).json();
    expect(status.needsAdmin).toBe(false);
    const res = await request.post('/api/setup/admin', { data: { emp_id: 'intruder', name: 'X', email: 'x@example.test', password: 'intruder-password' } });
    expect(res.status()).toBe(409);
});

test('a wrong password is refused', async ({ page }) => {
    await page.goto('/');
    await page.locator('#login-id').fill(ADMIN.emp_id);
    await page.locator('#login-password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#login-error')).toBeVisible();
});

test('the sidebar leads with Offset Aware, and credits Offset Security at the foot', async ({ browser }) => {
    const context = await browser.newContext({ storageState: process.env.AWARE_ADMIN_STATE, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('.brand.side')).toContainText('Offset Aware');
    await expect(page.locator('.brand.side svg.pmark')).toBeVisible();
    await expect(page.locator('.sidebar-foot')).toContainText('Developed by Offset Security');
    await expect(page.locator('.sidebar-foot')).toContainText('Contact: info@offsetsecurity.net');
    await context.close();
});

test('the version is on the Help page, not in the menu foot', async ({ browser }) => {
    const context = await browser.newContext({ storageState: process.env.AWARE_ADMIN_STATE, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('.sidebar-foot')).not.toContainText('Version');
    await page.locator('.sidebar a[data-key="help"]').click();
    await expect(page.locator('#side-version')).toHaveText(/^Offset Aware, version [0-9]+[.][0-9]+[.][0-9]+$/);
    await context.close();
});

test('the page carries a security policy that keeps out outside scripts and framing, and API answers are not cached', async ({ request }) => {
    const page = await request.get('/');
    const csp = page.headers()['content-security-policy'] || '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*https?:/);
    const api = await request.get('/api/setup/status');
    expect(api.headers()['cache-control']).toBe('no-store');
});
