const { test, expect, request: pwRequest } = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

test.describe.configure({ mode: 'serial' });
test.use({ storageState: process.env.AWARE_ADMIN_STATE });

// Who is asked to do what: a framework applies to everyone, to chosen people
// or to nobody, and a person can be given a framework, a job or one course -
// when they are added, later, or many people at once.

const dir = process.env.AWARE_TEST_TRAINING;
const FW = 'Assign pack';
const files = [];

function course(id, audience) {
    for (const [ext, body] of [['.mp4', 'not really a video'], ['.quiz.json', JSON.stringify({
        title: 'Course ' + id, framework: FW, audience, order: 1, pass_percent: 80,
        questions: [{ q: 'Which is right?', opts: ['Wrong', 'Right'], a: 1, why: 'Because.' }]
    })]]) {
        fs.writeFileSync(path.join(dir, id + ext), body);
        files.push(id + ext);
    }
}

const requiredOf = async (request) => {
    const out = {};
    for (const u of await (await request.get('/api/admin/records')).json()) out[u.emp_id] = u.required.filter((m) => m.startsWith('assign-'));
    return out;
};
const add = (request, emp_id, extra = {}) =>
    request.post('/api/admin/users', { data: { emp_id, name: 'Person ' + emp_id, email: emp_id.toLowerCase() + '@example.test', ...extra } });
const scope = (request, value, framework = FW) =>
    request.post('/api/admin/frameworks/scope', { data: { framework, scope: value } });

test.beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    course('assign-all', 'all');
    course('assign-role', 'role');
    course('assign-extra', 'role');
    fs.writeFileSync(path.join(dir, 'assign.jobs.json'), JSON.stringify({
        framework: FW, jobs: [{ id: 'assign-job', title: 'Assign job', modules: ['assign-role'] }]
    }));
    files.push('assign.jobs.json');
});

test.afterAll(async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: process.env.AWARE_ADMIN_STATE });
    for (const id of ['AS1', 'AS2', 'AS3', 'AS4', 'AS5', 'AS6', 'AS7', 'AS8']) await api.delete('/api/admin/users/' + id);
    await api.dispose();
    for (const f of files) fs.rmSync(path.join(dir, f), { force: true });
});

test('a pack that has just been added is given to nobody', async ({ request }) => {
    expect((await add(request, 'AS1')).status()).toBe(200);
    const list = await (await request.get('/api/admin/modules')).json();
    expect(list.frameworks.find((f) => f.name === FW)).toMatchObject({ scope: 'some', people: 0 });
    expect((await requiredOf(request)).AS1).toEqual([]);
});

test('training is chosen when a person is added: a framework, a job, or one course', async ({ request }) => {
    await add(request, 'AS2', { frameworks: [FW, 'No such framework'] });
    await add(request, 'AS3', { jobs: ['assign-job'] });
    await add(request, 'AS4', { modules: ['assign-extra', 'no-such-course'] });
    const required = await requiredOf(request);
    expect(required.AS2, 'the framework brings its all-staff course').toEqual(['assign-all']);
    expect(required.AS3.sort(), 'a job brings its course, and the framework with it').toEqual(['assign-all', 'assign-role']);
    expect(required.AS4, 'one course is one course').toEqual(['assign-extra']);
    const records = await (await request.get('/api/admin/records')).json();
    expect(records.find((u) => u.emp_id === 'AS2').frameworks, 'an unknown framework is ignored').toEqual([FW]);
    expect(records.find((u) => u.emp_id === 'AS4').assigned, 'an unknown course is ignored').toEqual(['assign-extra']);
});

test('the same training is added to, and taken from, many people at once', async ({ request }) => {
    await add(request, 'AS5');
    const bulk = (data) => request.post('/api/admin/users/bulk-training', { data });
    expect((await bulk({ emp_ids: ['AS1', 'AS5', 'nobody'], action: 'add', frameworks: [FW], modules: ['assign-extra'] })).status()).toBe(200);
    let required = await requiredOf(request);
    expect(required.AS1.sort()).toEqual(['assign-all', 'assign-extra']);
    expect(required.AS5.sort()).toEqual(['assign-all', 'assign-extra']);
    expect(required.AS3.sort(), 'someone who was not ticked keeps what they had').toEqual(['assign-all', 'assign-role']);

    await bulk({ emp_ids: ['AS1'], action: 'remove', frameworks: [FW] });
    required = await requiredOf(request);
    expect(required.AS1, 'only what was ticked is taken away').toEqual(['assign-extra']);

    expect((await bulk({ emp_ids: [], action: 'add', frameworks: [FW] })).status()).toBe(400);
    expect((await bulk({ emp_ids: ['AS1'], action: 'replace', frameworks: [FW] })).status()).toBe(400);
    expect((await bulk({ emp_ids: ['AS1'], action: 'add', frameworks: 'everything' })).status()).toBe(400);
});

test("one person's training is replaced in one go", async ({ request }) => {
    const set = (data) => request.post('/api/admin/users/AS5/training', { data });
    expect((await set({ frameworks: [], jobs: ['assign-job'], modules: [] })).status()).toBe(200);
    expect((await requiredOf(request)).AS5.sort()).toEqual(['assign-all', 'assign-role']);
    expect((await set({ frameworks: [], jobs: [], modules: [] })).status()).toBe(200);
    expect((await requiredOf(request)).AS5).toEqual([]);
    expect((await set({ jobs: 'assign-job' })).status()).toBe(400);
    expect((await request.post('/api/admin/users/no-such-person/training', { data: { jobs: [] } })).status()).toBe(404);
});

test('a framework can apply to everyone, to chosen people, or to nobody', async ({ request }) => {
    expect((await scope(request, 'all')).status()).toBe(200);
    let required = await requiredOf(request);
    expect(required.AS5, 'everyone gets the all-staff course, and only that').toEqual(['assign-all']);
    expect(required.AS4.sort()).toEqual(['assign-all', 'assign-extra']);

    await scope(request, 'none');
    required = await requiredOf(request);
    for (const id of ['AS1', 'AS2', 'AS3', 'AS4', 'AS5']) expect(required[id], id + ' is asked for nothing').toEqual([]);

    await scope(request, 'some');
    expect((await requiredOf(request)).AS2, 'what people were given is still there').toEqual(['assign-all']);

    expect((await scope(request, 'sometimes')).status()).toBe(400);
    expect((await scope(request, 'all', 'No such framework')).status()).toBe(404);
});

test('the people a framework applies to are chosen from a list', async ({ request }) => {
    const res = await request.post('/api/admin/frameworks/people', { data: { framework: FW, emp_ids: ['AS5'] } });
    expect((await res.json()).people).toBe(1);
    const people = await (await request.get('/api/admin/frameworks/people?framework=' + encodeURIComponent(FW))).json();
    expect(people.filter((p) => p.chosen).map((p) => p.emp_id)).toEqual(['AS5']);
    const required = await requiredOf(request);
    expect(required.AS5).toEqual(['assign-all']);
    expect(required.AS2, 'the list replaces who was chosen before').toEqual([]);
    expect(required.AS3.sort(), 'a job still brings the framework with it').toEqual(['assign-all', 'assign-role']);
    expect((await request.get('/api/admin/frameworks/people?framework=Nope')).status()).toBe(404);
});

test('a spreadsheet can say which training applies to each person', async ({ request }) => {
    const csv = `emp_id,name,email,job,training\nAS6,Six,six@example.test,Assign job,\nAS7,Seven,seven@example.test,,${FW}; No such\nAS8,Eight,eight@example.test,,\n`;
    const res = await request.post('/api/admin/users/import', { multipart: { file: { name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } });
    expect((await res.json()).added).toBe(3);
    const required = await requiredOf(request);
    expect(required.AS6.sort()).toEqual(['assign-all', 'assign-role']);
    expect(required.AS7).toEqual(['assign-all']);
    expect(required.AS8).toEqual([]);
});

test('nobody signed out can change who training applies to, or install a pack', async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });
    for (const [url, data] of [
        ['/api/admin/frameworks/scope', { framework: FW, scope: 'all' }],
        ['/api/admin/frameworks/people', { framework: FW, emp_ids: [] }],
        ['/api/admin/users/bulk-training', { emp_ids: ['AS1'], action: 'add', frameworks: [FW] }],
        ['/api/admin/users/AS1/training', { jobs: [] }],
        ['/api/admin/packs/install', { packs: ['hipaa'] }]
    ]) expect([401, 403], url).toContain((await api.post(url, { data })).status());
    expect([401, 403]).toContain((await api.get('/api/admin/packs')).status());
    await api.dispose();
});

test('the add-person form asks which training applies, and says how many courses that is', async ({ page }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav a[data-key="provision"]').click();
    const picker = page.locator('#new-emp-training');
    // Each set of training is a card with a switch; its jobs are folded away until asked for.
    const card = picker.locator(`.tp-card[data-fw="${FW}"]`);
    await expect(card.getByLabel(FW + ' applies to this person')).toBeVisible();
    const job = picker.locator(`input[data-kind="job"][value="assign-job"]`);
    await expect(job).toBeHidden();
    const before = await page.locator('#new-emp-count').textContent();
    await card.locator('.tp-more').click();
    await picker.locator(`input[data-kind="job"][value="assign-job"]`).check();
    await expect(card).toHaveClass(/(^| )on( |$)/);
    await expect(card.locator('.tp-more-text')).toHaveText('1 chosen');
    await expect(page.locator('#new-emp-count')).not.toHaveText(before);
    await picker.locator(`input[data-kind="job"][value="assign-job"]`).uncheck();
    await expect(page.locator('#new-emp-count')).toHaveText(before);
});

test('people are ticked on the Employees screen and given training together', async ({ page, request }) => {
    await request.post('/api/admin/users/bulk-training', { data: { emp_ids: ['AS1', 'AS8'], action: 'remove', frameworks: [FW], jobs: ['assign-job'], modules: ['assign-extra'] } });
    await page.goto('/');
    await page.locator('.sidebar .nav a[data-key="employees"]').click();
    for (const id of ['AS1', 'AS8']) await page.locator(`#employees-table input.emp-checkbox[value="${id}"]`).check();
    await expect(page.locator('#emp-selected-count')).toHaveText('2 selected');
    await page.getByRole('button', { name: 'Assign training to selected' }).click();
    const dialog = page.locator('#bulk-dialog');
    await expect(dialog).toContainText('Training for 2 people');
    await dialog.locator(`input[data-kind="framework"][value="${FW}"]`).check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#employees-table tr', { hasText: 'AS8' })).toContainText(FW);
    const required = await requiredOf(request);
    expect(required.AS1).toEqual(['assign-all']);
    expect(required.AS8).toEqual(['assign-all']);
});

// —— Course packs, downloaded from Settings ——
// The "download page" is a server on this machine holding one small pack.

/** A zip file, built by hand so the test needs nothing installed. */
function zipOf(entries) {
    const parts = [], central = [];
    let at = 0;
    for (const [name, text] of entries) {
        const raw = Buffer.from(text), packed = zlib.deflateRawSync(raw), label = Buffer.from(name);
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8);
        head.writeUInt32LE(zlib.crc32(raw), 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(raw.length, 22);
        head.writeUInt16LE(label.length, 26);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
        entry.writeUInt32LE(zlib.crc32(raw), 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(raw.length, 24);
        entry.writeUInt16LE(label.length, 28); entry.writeUInt32LE(at, 42);
        parts.push(head, label, packed);
        central.push(entry, label);
        at += 30 + label.length + packed.length;
    }
    const dirSize = central.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dirSize, 12); end.writeUInt32LE(at, 16);
    return Buffer.concat([...parts, ...central, end]);
}

test('a course pack is downloaded, checked and unpacked from Settings', async ({ request }) => {
    const quiz = JSON.stringify({ title: 'Downloaded course', framework: 'SAMA (finance companies)', audience: 'all', order: 1,
        questions: [{ q: 'Which is right?', opts: ['Wrong', 'Right'], a: 1 }] });
    const pack = zipOf([
        ['sama-fc-01.mp4', 'a video, as far as the server knows '.repeat(400)],
        ['sama-fc-01.quiz.json', quiz],
        // None of these belong in the training folder, and none may land there or anywhere else.
        ['../escaped.mp4', 'outside the folder'],
        ['folder/inside.mp4', 'in a folder'],
        ['run-me.js', 'not a course file']
    ]);
    let sum = crypto.createHash('sha256').update(pack).digest('hex');
    const server = http.createServer((req, res) => {
        if (req.url === '/SHA256SUMS.txt') return res.end(`${sum}  pack-sama-finance.zip\n`);
        if (req.url === '/pack-sama-finance.zip') { res.setHeader('Content-Length', pack.length); return res.end(pack); }
        res.statusCode = 404; res.end();
    });
    await new Promise((ready) => server.listen(Number(process.env.AWARE_TEST_PACKS_PORT), '127.0.0.1', ready));
    const installed = ['sama-fc-01.mp4', 'sama-fc-01.quiz.json'];
    const finished = async () => {
        for (let i = 0; i < 60; i++) {
            const { job } = await (await request.get('/api/admin/packs')).json();
            if (job.state !== 'working') return job;
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error('the install did not finish');
    };
    try {
        expect((await request.post('/api/admin/packs/install', { data: { packs: [] } })).status()).toBe(400);
        expect((await request.post('/api/admin/packs/install', { data: { packs: ['no-such-pack'] } })).status()).toBe(400);

        // A pack that does not match its published checksum is not installed.
        const good = sum;
        sum = 'f'.repeat(64);
        expect((await request.post('/api/admin/packs/install', { data: { packs: ['sama-finance'] } })).status()).toBe(200);
        let job = await finished();
        expect(job.state).toBe('failed');
        expect(job.error).toMatch(/did not arrive intact/);
        expect(fs.existsSync(path.join(dir, 'sama-fc-01.mp4'))).toBe(false);

        sum = good;
        await request.post('/api/admin/packs/install', { data: { packs: ['sama-finance'] } });
        job = await finished();
        expect(job, JSON.stringify(job)).toMatchObject({ state: 'done', done: ['sama-finance'] });
        expect(fs.readFileSync(path.join(dir, 'sama-fc-01.quiz.json'), 'utf8')).toBe(quiz);
        expect(fs.statSync(path.join(dir, 'sama-fc-01.mp4')).size).toBe('a video, as far as the server knows '.repeat(400).length);
        expect(fs.existsSync(path.join(dir, '..', 'escaped.mp4')), 'nothing is written outside the folder').toBe(false);
        expect(fs.readdirSync(dir).filter((f) => /escaped|inside|run-me|\.part$/.test(f)), 'nothing else is left behind').toEqual([]);
        expect(fs.existsSync(path.join(dir, 'folder'))).toBe(false);

        const { packs } = await (await request.get('/api/admin/packs')).json();
        expect(packs.find((p) => p.id === 'sama-finance').installed).toBe(1);
        const list = await (await request.get('/api/admin/modules')).json();
        expect(list.frameworks.find((f) => f.name === 'SAMA (finance companies)').scope, 'and it applies to nobody yet').toBe('some');
    } finally {
        await new Promise((closed) => server.close(closed));
        for (const f of installed) fs.rmSync(path.join(dir, f), { force: true });
    }
});

test('Settings lists the course packs and who each set of training applies to', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.locator('.sidebar a[data-key="settings"]').click();
    // Settings has tabs of its own; the first is Password reset.
    await expect(page.locator('#settings-tabs button.on')).toHaveText('Password reset');
    await expect(page.locator('#packs-card')).toBeHidden();
    await page.locator('#settings-tabs button', { hasText: 'Course packs' }).click();
    await expect(page.locator('#packs-table .pk-card')).toHaveCount(4);
    await expect(page.locator('#packs-table')).toContainText('ISO 27001');
    await expect(page.locator('#reset-card')).toBeHidden();

    // On the Training tab, three buttons say who a set of training applies to.
    await page.locator('#settings-tabs button', { hasText: 'Training' }).click();
    const applies = (scope) => page.locator(`#modules-table [data-framework-scope="${FW}"] button[data-scope="${scope}"]`);
    await expect(applies('some')).toHaveClass(/(^| )on( |$)/);
    await applies('all').click();
    await expect(applies('all')).toHaveClass(/(^| )on( |$)/);
    await applies('some').click();
    await expect(applies('some')).toHaveClass(/(^| )on( |$)/);

    // A link from elsewhere lands on the right tab.
    await page.locator('.sidebar a[data-key="employees"]').click();
    await page.evaluate(() => openSettings('email'));
    await expect(page.locator('#page-title')).toHaveText('Settings');
    await expect(page.locator('#settings-tabs button.on')).toHaveText('Email');
    await expect(page.locator('#smtp-host')).toBeVisible();
    expect(errors).toEqual([]);
});

// —— A hundred people from a spreadsheet ——

test('uploading a list again gives training to people already here, and adds nobody twice', async ({ request }) => {
    const upload = async (csv) => (await request.post('/api/admin/users/import', {
        multipart: { file: { name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } })).json();
    await request.post('/api/admin/users/AS8/training', { data: { frameworks: [FW], jobs: [], modules: [] } });
    await request.post('/api/admin/users/AS7/training', { data: { frameworks: [FW], jobs: [], modules: [] } });

    const body = await upload(`emp_id,name,email,job,training\nAS8,Renamed,changed@example.test,Assign job,\nAS7,Seven,seven@example.test,,\nAS6,Six,six@example.test,No such job,${FW}; Nor this\n`);
    expect(body.added).toBe(0);
    expect(body.updated, 'the two rows that say something').toBe(2);
    expect(body.skipped, 'the row that says nothing').toBe(1);
    expect(body.message).toMatch(/Training updated: 2/);
    expect(body.unknown.sort(), 'a mistyped name is reported, not swallowed').toEqual(['No such job', 'Nor this']);
    expect(body.accounts, 'nobody already here is given a new password').toEqual([]);

    const records = await (await request.get('/api/admin/records')).json();
    const of = (id) => records.find((u) => u.emp_id === id);
    expect(of('AS8').name, 'their name is not touched').toBe('Eight');
    expect(of('AS8').jobs).toEqual(['assign-job']);
    expect(of('AS8').frameworks, 'an empty cell leaves what they had').toEqual([FW]);
    expect(of('AS7').frameworks, 'a row with nothing in it changes nothing').toEqual([FW]);
    expect(of('AS6').frameworks).toEqual([FW]);
});

test('a job with a comma in its name is read from a quoted cell', async ({ request }) => {
    // Removed first: the server looks again when the folder changes, and
    // writing over a file does not change its folder.
    fs.rmSync(path.join(dir, 'assign.jobs.json'), { force: true });
    fs.writeFileSync(path.join(dir, 'assign.jobs.json'), JSON.stringify({
        framework: FW, jobs: [
            { id: 'assign-job', title: 'Assign job', modules: ['assign-role'] },
            { id: 'assign-comma', title: 'Branch, call centre and "collections"', modules: ['assign-extra'] }
        ]
    }));
    const csv = `emp_id,name,email,job,training\nAS5,Five,five@example.test,"Branch, call centre and ""collections""; Assign job",\n`;
    const res = await request.post('/api/admin/users/import', { multipart: { file: { name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } });
    const body = await res.json();
    expect(body.unknown).toEqual([]);
    const records = await (await request.get('/api/admin/records')).json();
    expect(records.find((u) => u.emp_id === 'AS5').jobs.sort()).toEqual(['assign-comma', 'assign-job']);
});

test('the Employees list is searched and filtered, and the top box ticks only the people shown', async ({ page, request }) => {
    await request.post('/api/admin/users/AS1/training', { data: { frameworks: [], jobs: [], modules: [] } });
    await request.post('/api/admin/frameworks/scope', { data: { framework: 'Security awareness basics', scope: 'none' } });
    await page.goto('/');
    await page.locator('.sidebar .nav a[data-key="employees"]').click();
    const rows = page.locator('#employees-table tbody tr');
    const shown = page.locator('#employees-table tbody tr:visible');
    await expect(rows.first()).toBeVisible();
    const total = await rows.count();
    await expect(page.locator('#emp-shown-count')).toHaveText('');

    await page.locator('#emp-search').fill('assign job');
    await expect(shown).not.toHaveCount(total);
    for (const text of await shown.allTextContents()) expect(text.toLowerCase()).toContain('assign job');
    const matching = await shown.count();
    await expect(page.locator('#emp-shown-count')).toHaveText(`Showing ${matching} of ${total}`);

    // The top box ticks what is shown; a new search keeps those ticks.
    await page.locator('#select-all-emps').check();
    await expect(page.locator('#emp-selected-count')).toHaveText(`${matching} selected`);
    await page.locator('#emp-search').fill('AS1');
    await expect(shown).toHaveCount(1);
    await page.locator('#employees-table input.emp-checkbox[value="AS1"]').check();
    await expect(page.locator('#emp-selected-count')).toHaveText(`${matching + 1} selected`);

    // "Show them", on the note about people with nothing to do.
    await page.locator('#emp-search').fill('');
    await page.locator('#unassigned-note .nav-link', { hasText: 'Show them' }).click();
    await expect(page.locator('#emp-filter')).toHaveValue('none');
    await expect(page.locator('#employees-table tbody tr:visible', { hasText: 'AS1' })).toHaveCount(1);
    for (const text of await shown.allTextContents()) expect(text).toContain('Nothing assigned');
    await request.post('/api/admin/frameworks/scope', { data: { framework: 'Security awareness basics', scope: 'some' } });
});

// —— Reset password: one screen, by Employee ID and email together ——

test("a password is reset only when the Employee ID and the email both match", async ({ request }) => {
    const reset = (data) => request.post('/api/admin/users/reset-password', { data });
    expect((await reset({ emp_id: '', email: 'as1@example.test' })).status(), 'no ID').toBe(400);
    expect((await reset({ emp_id: 'AS1', email: 'someone-else@example.test' })).status(), 'the wrong email').toBe(404);
    expect((await reset({ emp_id: 'AS1', email: '' })).status(), 'no email, for someone who has one').toBe(404);
    expect((await reset({ emp_id: 'no-such-person', email: 'as1@example.test' })).status(), 'the wrong ID').toBe(404);
    expect((await reset({ emp_id: 'test-admin', email: 'admin@example.test' })).status(), 'not the administrator').toBe(404);

    // Capitals and stray spaces do not matter.
    const res = await reset({ emp_id: ' as1 ', email: 'AS1@Example.Test ' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, emp_id: 'AS1', name: 'Person AS1' });
    expect(body.startingPassword, 'a password of its own, made by the server').toMatch(/^[A-Za-z0-9]{12}$/);
    const again = await (await reset({ emp_id: 'AS1', email: 'as1@example.test' })).json();
    expect(again.startingPassword, 'a different one each time').not.toBe(body.startingPassword);
});

test('nobody signed out can reset a password', async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });
    expect([401, 403]).toContain((await api.post('/api/admin/users/reset-password', { data: { emp_id: 'AS1', email: 'as1@example.test' } })).status());
    await api.dispose();
});

test('Settings resets a password from an ID and an email, and shows the new one once', async ({ page }) => {
    await page.goto('/');
    // It is in Settings, not a screen of its own in the menu.
    await expect(page.locator('.sidebar a[data-key="settings"]')).toBeVisible();
    await expect(page.locator('.sidebar a[data-key="reset"]')).toHaveCount(0);
    await page.locator('.sidebar a[data-key="settings"]').click();
    await expect(page.locator('#reset-card')).toContainText("Reset someone's password");
    await page.locator('#reset-emp-id').fill('AS2');
    await page.locator('#reset-emp-email').fill('wrong@example.test');
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.locator('#reset-result')).toContainText('Nobody here has that Employee ID with that email');
    await page.locator('#reset-emp-email').fill('as2@example.test');
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.locator('#reset-result')).toContainText('Person AS2');
    await expect(page.locator('#reset-new-password')).toHaveText(/^[A-Za-z0-9]{12}$/);
    await expect(page.locator('#reset-emp-id')).toHaveValue('');

    // The button on every row of the Employees list is gone.
    await page.locator('.sidebar .nav a[data-key="employees"]').click();
    await expect(page.locator('#employees-table tbody tr').first()).toBeVisible();
    await expect(page.locator('#employees-table').getByRole('button', { name: 'Reset password' })).toHaveCount(0);
});

// —— Reminders: only for people with training left to do ——

test('nobody who has been given no training is listed for a reminder, or sent one', async ({ page, request }) => {
    await request.post('/api/admin/users/AS8/training', { data: { frameworks: [], jobs: [], modules: [] } });
    await request.post('/api/admin/users/AS6/training', { data: { frameworks: [], jobs: ['assign-job'], modules: [] } });
    const required = await requiredOf(request);
    expect(required.AS8).toEqual([]);
    expect(required.AS6.length).toBeGreaterThan(0);

    // Mail goes to a closed port in a test run, so everyone it tries shows up as failed: that is who it tried.
    const sent = await (await request.post('/api/notify/training', { data: {} })).json();
    const tried = [...(sent.failed || []), ...(sent.skipped || [])];
    expect(tried).toContain('AS6');
    expect(tried, 'someone with nothing to do is left alone').not.toContain('AS8');

    await page.goto('/');
    await page.locator('.sidebar .nav a[data-key="email"]').click();
    await expect(page.locator('#rm-list .rm-row', { hasText: 'AS6' })).toHaveCount(1);
    await expect(page.locator('#rm-list .rm-row', { hasText: 'AS8' })).toHaveCount(0);
    await expect(page.locator('#rm-summary')).toContainText('training left to do');
    await page.locator('#rm-search').fill('AS6');
    await expect(page.locator('#rm-list .rm-row:visible')).toHaveCount(1);
});

// —— Help ——

test('Help is searched, and its shortcuts and list lead to the right section', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.locator('.sidebar a[data-key="help"]').click();
    const sections = page.locator('#help-view .help-section');
    await expect(sections).toHaveCount(11);
    await expect(page.locator('#side-version')).toHaveText(/^Offset Aware, version /);

    await page.locator('#help-search').fill('sendgrid');
    await expect(page.locator('#help-view .help-section:visible')).toHaveCount(1);
    await expect(page.locator('#help-email')).toBeVisible();
    await expect(page.locator('#help-quick')).toBeHidden();
    await page.locator('#help-search').fill('zzz-not-in-help');
    await expect(page.locator('#help-none')).toBeVisible();
    await page.locator('#help-search').fill('');
    await expect(page.locator('#help-view .help-section:visible')).toHaveCount(11);

    await page.locator('#help-quick .hp-card', { hasText: 'Reset a password' }).click();
    await expect(page.locator('#help-reset')).toBeInViewport();
    await expect(page.locator('#help-people')).toContainText('Password reset');
    expect(errors).toEqual([]);
});

// —— My training, as a member of staff ——

test('My training shows a tile for each module, and a tile opens it', async ({ browser, request }) => {
    await request.post('/api/admin/users/AS6/training', { data: { frameworks: [], jobs: ['assign-job'], modules: [] } });
    const reset = await (await request.post('/api/admin/users/reset-password', { data: { emp_id: 'AS6', email: 'six@example.test' } })).json();
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, ignoreHTTPSErrors: true });
    // Choosing their own password signs them in, as the first sign-in does.
    const changed = await context.request.post('/api/force-change-password', { data: { emp_id: 'AS6', current_password: reset.startingPassword, new_password: 'their-own-password-1' } });
    expect(changed.status()).toBe(200);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.locator('#employee-view')).toBeVisible();
    await expect(page.locator('#emp-hello')).toHaveText('Hello, Six');
    await expect(page.locator('#emp-status-badge')).toHaveText('2 modules to do');
    await expect(page.locator('#emp-ring')).toContainText('0of 2');
    const todo = page.locator('#emp-modules .mt-group', { hasText: 'To do' }).locator('.mt-tile');
    await expect(todo).toHaveCount(2);
    await expect(page.locator('#internal-training-card')).toBeHidden();

    const tile = page.locator('#emp-modules .mt-tile[data-mod="assign-role"]');
    await expect(tile).toContainText('Not started');
    await tile.getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('#internal-training-card')).toBeVisible();
    await expect(page.locator('#quiz-title')).toHaveText('Course assign-role');
    await expect(tile).toHaveClass(/(^| )open( |$)/);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#internal-training-card')).toBeHidden();
    expect(errors).toEqual([]);
    await context.close();
});

// —— Training status ——

test('Training status has a line per person that opens into their modules, and can be filtered and searched', async ({ page, request }) => {
    await request.post('/api/admin/users/AS6/training', { data: { frameworks: [], jobs: ['assign-job'], modules: [] } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.locator('.sidebar .nav a[data-key="training"]').click();
    const people = page.locator('#training-table .ts-person');
    await expect(people.first()).toBeVisible();
    const all = await people.count();
    await expect(page.locator('#ts-summary')).toContainText('required modules are done');
    await expect(page.locator('#ts-filter button.on')).toContainText('Everyone');

    // One line per person; the tiles appear when the line is opened.
    const six = page.locator('#training-table .ts-person[data-emp="AS6"]');
    await expect(six.locator('.ts-strip i')).toHaveCount(2);
    await expect(six.locator('.ts-tile')).toHaveCount(0);
    await six.locator('.ts-line').click();
    await expect(page.locator('#training-table .ts-person[data-emp="AS6"] .ts-tile')).toHaveCount(2);
    await expect(page.locator('#training-table .ts-person[data-emp="AS6"]')).toContainText('Not started');

    await page.locator('#ts-search').fill('AS6');
    await expect(people).toHaveCount(1);
    await expect(page.locator('#training-table .ts-person[data-emp="AS6"] .ts-tile'), 'still open after searching').toHaveCount(2);
    await page.locator('#ts-search').fill('');
    await expect(people).toHaveCount(all);

    await page.locator('#ts-filter button[data-filter="complete"]').click();
    await expect(page.locator('#ts-filter button.on')).toContainText('Fully trained');
    await expect(page.locator('#training-table .ts-person[data-emp="AS6"]')).toHaveCount(0);
    await page.locator('#ts-filter button[data-filter="all"]').click();

    await page.getByRole('button', { name: 'Open all' }).click();
    await expect(page.getByRole('button', { name: 'Close all' })).toBeVisible();
    await page.getByRole('button', { name: 'Close all' }).click();
    await expect(page.locator('#training-table .ts-tile')).toHaveCount(0);
    expect(errors).toEqual([]);
});
