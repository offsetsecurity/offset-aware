const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Checks the files of real course packs before they are zipped and published:
// every course has its video, subtitles, a valid quiz and a summary, and every
// job lists only courses that exist. The packs are large and live outside the
// repository, so this runs only when AWARE_PACK_DIR points at a folder of them:
//   AWARE_PACK_DIR="D:\...\course packs" npx playwright test 07-course-pack-files
const dir = process.env.AWARE_PACK_DIR;

test.describe('course pack files', () => {
    test.skip(!dir, 'Set AWARE_PACK_DIR to a folder of unpacked course packs to check them.');

    const files = dir ? fs.readdirSync(dir) : [];
    const courses = files.filter((f) => f.endsWith('.quiz.json')).map((f) => f.slice(0, -'.quiz.json'.length));

    test('every course has its video, subtitles, quiz and summary', () => {
        expect(courses.length).toBeGreaterThan(0);
        for (const id of courses) {
            for (const ext of ['.mp4', '.vtt', '.summary.html']) {
                const file = path.join(dir, id + ext);
                expect(fs.existsSync(file), `${id}${ext}`).toBe(true);
                expect(fs.statSync(file).size, `${id}${ext} is empty`).toBeGreaterThan(0);
            }
            expect(fs.readFileSync(path.join(dir, id + '.vtt'), 'utf8').startsWith('WEBVTT'), `${id}.vtt is WebVTT`).toBe(true);
        }
    });

    test('every quiz is valid', () => {
        for (const id of courses) {
            const q = JSON.parse(fs.readFileSync(path.join(dir, id + '.quiz.json'), 'utf8'));
            expect(q.title, `${id}: title`).toBeTruthy();
            expect(q.framework, `${id}: framework`).toBeTruthy();
            expect(['all', 'role', 'some'], `${id}: audience`).toContain(q.audience);
            expect(q.questions.length, `${id}: questions`).toBeGreaterThanOrEqual(5);
            for (const [i, x] of q.questions.entries()) {
                const where = `${id} question ${i + 1}`;
                expect(x.q, where).toBeTruthy();
                expect(x.opts.length, `${where}: 4 answers`).toBe(4);
                expect(new Set(x.opts).size, `${where}: answers differ`).toBe(4);
                expect(Number.isInteger(x.a) && x.a >= 0 && x.a < x.opts.length, `${where}: right answer`).toBe(true);
                expect(x.why, `${where}: why`).toBeTruthy();
            }
        }
    });

    test('every job lists only real courses', () => {
        const known = new Set(courses);
        for (const f of files.filter((n) => n.endsWith('.jobs.json'))) {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            expect(j.framework, f).toBeTruthy();
            for (const job of j.jobs) {
                expect(job.modules.length, `${f}: ${job.id}`).toBeGreaterThan(0);
                for (const m of job.modules) expect(known.has(m), `${f}: ${job.id} lists ${m}`).toBe(true);
            }
        }
    });
});
