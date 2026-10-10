const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { EMPLOYEE, takeQuiz } = require('./support');

test.describe.configure({ mode: 'serial' });
test.use({ storageState: process.env.AWARE_ADMIN_STATE });

const NEW_PASSWORD = 'my-own-new-password';

test('the administrator adds an employee', async ({ request }) => {
    // Mail goes to a closed local port, so a test run never sends anything.
    await request.post('/api/admin/smtp', { data: { smtp_host: '127.0.0.1', smtp_port: '9', smtp_user: '', smtp_pass: '', mail_from: 'aware@example.test' } });
    const res = await request.post('/api/admin/users', { data: EMPLOYEE });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);
    const again = await request.post('/api/admin/users', { data: EMPLOYEE });
    expect(again.status(), 'the same employee ID twice is refused').toBe(400);
});

test('the new employee is listed on the Employees screen', async ({ page }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav a[data-key="employees"]').click();
    await expect(page.locator('#admin-view')).toContainText(EMPLOYEE.name);
});

test("the employee's first sign-in makes them choose their own password", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('#login-id').fill(EMPLOYEE.emp_id);
    await page.locator('#login-password').fill(EMPLOYEE.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#force-password-view')).toBeVisible();
    await page.locator('#force-password').fill(NEW_PASSWORD);
    await page.locator('#force-password-confirm').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.locator('#employee-view')).toBeVisible();
    await expect(page.locator('#side-name')).toHaveText(EMPLOYEE.name);
    // An employee sees only their own training, not the administrator's menu.
    await expect(page.locator('.sidebar .nav a[data-key="employees"]')).toHaveCount(0);
    await context.storageState({ path: `${process.env.AWARE_TEST_DATA}/employee-state.json` });
    await context.close();
});

test('an employee cannot reach anything an administrator can', async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: `${process.env.AWARE_TEST_DATA}/employee-state.json` });
    for (const path of ['/api/admin/records', '/api/admin/modules', '/api/admin/smtp', '/api/admin/completions.csv']) {
        expect([401, 403], path).toContain((await api.get(path)).status());
    }
    expect([401, 403]).toContain((await api.post('/api/admin/users', { data: { emp_id: 'x', name: 'x', password: 'xxxxxxxxxx' } })).status());
    await api.dispose();
});

test('nobody signed out can reach anything', async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });
    expect((await api.get('/api/me')).status()).toBe(401);
    expect([401, 403]).toContain((await api.get('/api/admin/records')).status());
    await api.dispose();
});

test('a failed quiz is recorded, and does not complete the module', async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: `${process.env.AWARE_TEST_DATA}/employee-state.json` });
    const res = await (await takeQuiz(api, 'infosec', 2)).json();
    expect(res.passed).toBe(false);
    expect(res.correct).toBe(2);
    expect(res.failed_in_a_row).toBe(1);
    const half = await api.post('/api/training/quiz/infosec', { data: { answers: [{ i: 0, k: 1 }], acknowledged: true } });
    expect(half.status(), 'a quiz with questions left out is refused').toBe(400);
    // A score the browser claims counts for nothing: the old routes are gone.
    expect((await api.post('/api/training/quiz-attempt', { data: { module_id: 'infosec', correct: 10, total: 10 } })).status()).toBe(404);
    expect((await api.post('/api/training/quiz', { data: { module_id: 'infosec', acknowledged: true } })).status()).toBe(404);
    const me = await (await api.get('/api/me')).json();
    expect(me.records.some(r => r.module_id === 'infosec' && r.status === 'completed')).toBe(false);
    await api.dispose();
});

test('watching the video and passing the quiz completes the module', async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: `${process.env.AWARE_TEST_DATA}/employee-state.json` });
    expect((await (await api.post('/api/training/video-complete', { data: { module_id: 'infosec' } })).json()).success).toBe(true);
    // Without the acknowledgement the pass isn't accepted.
    expect((await takeQuiz(api, 'infosec', 8, {})).status()).toBe(400);
    const done = await (await takeQuiz(api, 'infosec', 7)).json();
    expect(done.passed, '7 of 8 is 88%, over the pass mark').toBe(true);
    expect(done.status).toBe('completed');
    await api.dispose();
});

test("the administrator sees the employee's completion, and it exports to CSV", async ({ request }) => {
    const records = await (await request.get('/api/admin/records')).json();
    expect(JSON.stringify(records)).toContain(EMPLOYEE.emp_id);
    expect(JSON.stringify(records)).toMatch(/infosec[^}]*completed|completed[^}]*infosec/);
    const csv = await request.get('/api/admin/completions.csv');
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain(EMPLOYEE.emp_id);
});

test('every administrator screen opens without an error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    for (const key of ['employees', 'training', 'email', 'escalation', 'provision', 'settings', 'help']) {
        await page.locator(`.sidebar a[data-key="${key}"]`).click();
        await expect(page.locator(`.sidebar a[data-key="${key}"]`)).toHaveClass(/active/);
        await expect(page.locator('#page-title')).not.toBeEmpty();
    }
    expect(errors).toEqual([]);
});

// A course pack is files dropped into the training folder. Two small test
// courses: one for all staff, one for chosen people.
test('a course pack is picked up, and its role course goes to the people chosen for it', async ({ request, baseURL, browser }) => {
    const dir = process.env.AWARE_TEST_TRAINING;
    fs.mkdirSync(dir, { recursive: true });
    const course = (id, audience) => {
        fs.writeFileSync(path.join(dir, id + '.mp4'), 'not really a video');
        fs.writeFileSync(path.join(dir, id + '.quiz.json'), JSON.stringify({
            title: 'Test course ' + id, framework: 'Test pack', audience, order: 1, pass_percent: 80,
            questions: [{ q: 'Which is right?', opts: ['Wrong', 'Right', 'No', 'Never'], a: 1, why: 'Because.' }]
        }));
    };
    const ids = ['test-pack-t01', 'test-pack-r01'];
    try {
        course(ids[0], 'all');
        course(ids[1], 'role');
        const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: `${process.env.AWARE_TEST_DATA}/employee-state.json` });
        let me = await (await api.get('/api/me')).json();
        expect(me.modules.map(m => m.id)).toEqual(expect.arrayContaining(ids));
        // A pack that has just been added applies to nobody: not even its all-staff course.
        let list = await (await request.get('/api/admin/modules')).json();
        expect(list.frameworks.find(f => f.name === 'Test pack').scope).toBe('some');
        expect(me.requiredModules, 'a new pack is given to nobody by itself').not.toContain('test-pack-t01');
        // Once it applies to everyone, its all-staff course is everybody's.
        expect((await request.post('/api/admin/frameworks/scope', { data: { framework: 'Test pack', scope: 'all' } })).status()).toBe(200);
        me = await (await api.get('/api/me')).json();
        expect(me.requiredModules).toContain('test-pack-t01');
        expect(me.requiredModules, 'a role course is for nobody until people are chosen').not.toContain('test-pack-r01');

        // A job brings its role course with it, and taking the job away takes the course away.
        fs.writeFileSync(path.join(dir, 'test-pack.jobs.json'), JSON.stringify({
            framework: 'Test pack', jobs: [{ id: 'test-pack-job', title: 'Test job', modules: ['test-pack-r01'] }]
        }));
        const jobs = await (await request.get('/api/admin/jobs')).json();
        expect(jobs.find(j => j.id === 'test-pack-job').modules.map(m => m.id)).toEqual(['test-pack-r01']);
        const set = await (await request.post(`/api/admin/users/${EMPLOYEE.emp_id}/jobs`, { data: { jobs: ['test-pack-job', 'no-such-job'] } })).json();
        expect(set.jobs, 'an unknown job is ignored').toEqual(['test-pack-job']);
        me = await (await api.get('/api/me')).json();
        expect(me.requiredModules).toContain('test-pack-r01');
        const records = await (await request.get('/api/admin/records')).json();
        expect(records.find(r => r.emp_id === EMPLOYEE.emp_id).jobs).toEqual(['test-pack-job']);
        await request.post(`/api/admin/users/${EMPLOYEE.emp_id}/jobs`, { data: { jobs: [] } });
        me = await (await api.get('/api/me')).json();
        expect(me.requiredModules).not.toContain('test-pack-r01');

        // The People screen shows the job and offers to change it.
        {
            fs.writeFileSync(path.join(dir, 'test-pack.jobs.json'), JSON.stringify({
                framework: 'Test pack', jobs: [{ id: 'test-pack-job', title: 'Test job', modules: ['test-pack-r01'] }]
            }));
            const admin = await browser.newContext({ storageState: process.env.AWARE_ADMIN_STATE, ignoreHTTPSErrors: true });
            const page = await admin.newPage();
            await page.goto('/');
            await page.locator('.sidebar .nav a[data-key="employees"]').click();
            const row = page.locator('#employees-table tr', { hasText: EMPLOYEE.emp_id });
            await row.getByRole('button', { name: 'Training', exact: true }).click();
            await page.locator('#jobs-dialog .tp-card[data-fw="Test pack"] .tp-more').click();
            await page.locator('#jobs-dialog input[value="test-pack-job"]').check();
            await page.locator('#jobs-dialog').getByRole('button', { name: 'Save' }).click();
            await expect(row).toContainText('Test job');
            await admin.close();
            await request.post(`/api/admin/users/${EMPLOYEE.emp_id}/jobs`, { data: { jobs: [] } });
        }

        list = await (await request.get('/api/admin/modules')).json();
        expect(list.modules.find(m => m.id === 'test-pack-r01').audience).toBe('some');
        expect((await request.post('/api/admin/modules/test-pack-r01/people', { data: { emp_ids: [EMPLOYEE.emp_id] } })).status()).toBe(200);
        expect((await request.post('/api/admin/modules/test-pack-t01/audience', { data: { audience: 'none' } })).status()).toBe(200);
        expect((await request.post('/api/admin/modules/test-pack-t01/audience', { data: { audience: 'bogus' } })).status()).toBe(400);
        me = await (await api.get('/api/me')).json();
        expect(me.requiredModules).toContain('test-pack-r01');
        expect(me.requiredModules).not.toContain('test-pack-t01');

        // A pack course's quiz counts like any other.
        const handed = await api.get('/api/training/quiz/test-pack-r01');
        expect(await handed.text(), 'the quiz is handed out without its answers').not.toMatch(/"a"\s*:|"why"\s*:/);
        expect((await (await api.post('/api/training/quiz/test-pack-r01', { data: { answers: [{ i: 0, k: 0 }], acknowledged: true } })).json()).passed).toBe(false);
        expect((await (await api.post('/api/training/quiz/test-pack-r01', { data: { answers: [{ i: 0, k: 1 }], acknowledged: true } })).json()).passed).toBe(true);
        expect((await api.post('/api/training/quiz/no-such-course', { data: { answers: [{ i: 0, k: 1 }], acknowledged: true } })).status()).toBe(400);
        await api.dispose();

        // On the employee's screen it is listed as required, and its quiz loads.
        const context = await browser.newContext({ storageState: `${process.env.AWARE_TEST_DATA}/employee-state.json`, ignoreHTTPSErrors: true });
        const page = await context.newPage();
        await page.goto('/');
        const select = page.locator('#internal-module-select');
        await expect(select.locator('optgroup[label="Required for you"] option[value="test-pack-r01"]')).toHaveCount(1);
        // The modules are tiles; the one for this course opens it.
        const tile = page.locator('#emp-modules .mt-tile[data-mod="test-pack-r01"]');
        await expect(tile).toContainText('Test course test-pack-r01');
        await tile.getByRole('button').first().click();
        await expect(page.locator('#internal-training-card')).toBeVisible();
        await expect(page.locator('#quiz-title')).toHaveText('Test course test-pack-r01');
        await expect(page.locator('#quiz-questions')).toContainText('Which is right?');
        await context.close();
    } finally {
        for (const id of ids) for (const ext of ['.mp4', '.quiz.json']) fs.rmSync(path.join(dir, id + ext), { force: true });
        fs.rmSync(path.join(dir, 'test-pack.jobs.json'), { force: true });
    }
});

test('resetting an employee makes them choose a new password again', async ({ request, baseURL }) => {
    const res = await request.post(`/api/admin/users/${EMPLOYEE.emp_id}/reset`, { data: { password: 'another-temporary-1' } });
    expect(res.status()).toBe(200);
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });
    const login = await (await api.post('/api/login', { data: { emp_id: EMPLOYEE.emp_id, password: 'another-temporary-1' } })).json();
    expect(login.requirePasswordChange).toBe(true);
    await api.dispose();
});

test('removing an employee removes their sign-in', async ({ request, baseURL }) => {
    expect((await request.delete(`/api/admin/users/${EMPLOYEE.emp_id}`)).status()).toBe(200);
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });
    expect((await api.post('/api/login', { data: { emp_id: EMPLOYEE.emp_id, password: 'another-temporary-1' } })).status()).toBe(401);
    await api.dispose();
});
