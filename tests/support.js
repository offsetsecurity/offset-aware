const { expect } = require('@playwright/test');
const QUIZZES = require('../quizzes');

const ADMIN = { emp_id: 'test-admin', name: 'Test Admin', email: 'admin@example.test', password: 'admin-test-passphrase' };
const EMPLOYEE = { emp_id: 'EMP100', name: 'Asha Rao', email: 'asha@example.test', password: 'temporary-pass-1' };

/** Signs in through the API, as the form does; makes the administrator on an empty install. */
async function signInAdmin(request) {
    let res = await request.post('/api/login', { data: { emp_id: ADMIN.emp_id, password: ADMIN.password } });
    if (res.status() === 401) {
        await request.post('/api/setup/admin', { data: ADMIN });
        res = await request.post('/api/login', { data: { emp_id: ADMIN.emp_id, password: ADMIN.password } });
    }
    expect(res.status(), 'test administrator can sign in').toBe(200);
    // Mail goes to a closed local port, so nothing is ever sent from a test run.
    await request.post('/api/admin/smtp', { data: { smtp_host: '127.0.0.1', smtp_port: '9', smtp_user: '', smtp_pass: '', mail_from: 'aware@example.test' } });
}

/**
 * Sends in a built-in module's quiz with `right` of its questions answered
 * correctly and the rest wrongly. The tests know the answers the way the server
 * does, from quizzes.js; the page is never told them.
 */
function takeQuiz(api, moduleId, right, extra = { acknowledged: true }) {
    const answers = QUIZZES[moduleId].qs.map((q, i) => ({ i, k: i < right ? q.a : (q.a + 1) % q.opts.length }));
    return api.post('/api/training/quiz/' + moduleId, { data: { answers, ...extra } });
}

module.exports = { ADMIN, EMPLOYEE, signInAdmin, takeQuiz };
