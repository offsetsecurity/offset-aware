require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const zlib = require('zlib');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { logRuntime, logSmtp } = require('./logger');
const certificates = require('./tls');

const ENCRYPTION_KEY = crypto.scryptSync(process.env.SESSION_SECRET || 'iso-compliance-dev-secret-change-me', 'salt', 32);
const IV_LENGTH = 16;

// The mail password is stored with AES-256-GCM, which also detects tampering.
// Values saved by older versions (AES-256-CBC, "iv:body") are still read, and
// are written back in the new form the next time the settings are saved.
function encryptSmtpPass(text) {
    if (!text) return text;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ['v2', iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join(':');
}

function decryptSmtpPass(text) {
    if (!text) return text;
    try {
        const parts = text.split(':');
        // Saved before encryption existed: still plain text.
        if (parts.length === 1) return text;
        if (parts[0] === 'v2' && parts.length === 4) {
            const tag = Buffer.from(parts[2], 'hex');
            if (tag.length !== 16) return '';
            const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(parts[1], 'hex'), { authTagLength: 16 });
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(Buffer.from(parts[3], 'hex')), decipher.final()]).toString('utf8');
        }
        if (parts.length === 2) {
            const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(parts[0], 'hex'));
            return Buffer.concat([decipher.update(Buffer.from(parts[1], 'hex')), decipher.final()]).toString();
        }
        return '';
    } catch (e) {
        // Altered, or written with a different key: the password is gone, not usable.
        return '';
    }
}

process.on('uncaughtException', (err) => {
    logRuntime('error', 'Uncaught Exception', err);
});
process.on('unhandledRejection', (reason, promise) => {
    logRuntime('error', 'Unhandled Rejection at Promise', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me-to-a-long-random-string')) {
    console.error('FATAL: SESSION_SECRET must be set to a strong value in production. See .env.example.');
    process.exit(1);
}

// Setup storage paths (override via env to point at a persistent volume in prod)
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'));
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, 'database.sqlite'));
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Trust the reverse proxy (Nginx/Caddy/Render) so secure cookies and client
// IP detection (for rate limiting) work behind TLS termination.
app.set('trust proxy', 1);

// One line per request. Line breaks are taken out of the address, so a request
// cannot write lines of its own into the log.
app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${String(req.url).replace(/[\r\n\t]+/g, ' ').slice(0, 300)}`);
    next();
});

// Security headers.
app.use(helmet({
    // The page uses inline scripts and onclick handlers, so those stay allowed;
    // everything else is held to this server: no outside scripts, styles or
    // connections, no plugins, and no framing by other sites.
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            mediaSrc: ["'self'", "blob:"],
            fontSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            workerSrc: ["'self'", "blob:"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
        },
    },
    // Nothing from another site is ever loaded into the page.
    crossOriginEmbedderPolicy: true,
}));

// Aware uses none of the browser's device features, so the page is told it may
// not ask for them - and neither may anything that ever got into it.
app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=()');
    next();
});

// Answers from the API hold personal data and training records: never cached.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// A ceiling on how fast one address can call the API, so nobody can tie the
// server up by asking over and over. Far above what a person, or a whole office
// behind one address, does by hand.
app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.API_RATE_PER_MINUTE) || 1200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a minute and try again.' }
}));

// Middleware
app.use(express.json({ limit: '400kb' }));
app.use(express.urlencoded({ extended: true }));
// Sessions come before the files, because the course files are only for people
// who are signed in.
const SESSION_COOKIE = 'aware.sid';
app.use(session({
    name: SESSION_COOKIE,
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir }),
    secret: process.env.SESSION_SECRET || 'iso-compliance-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,          // Aware only ever answers on HTTPS
        httpOnly: true,        // not readable by client JS
        sameSite: 'lax',
        path: '/',
        maxAge: 1000 * 60 * 60 * 8 // 8 hours
    }
}));

// A session is only as good as the account behind it. Somebody who has been
// removed, has had their password reset, or is no longer an administrator loses
// that on their next request, not when the session runs out hours later.
app.use(['/api', '/training'], (req, res, next) => {
    if (!req.session.userId) return next();
    db.get("SELECT role, require_password_change FROM users WHERE id = ?", [req.session.userId], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user || user.require_password_change) return req.session.regenerate(() => next());
        req.session.role = user.role;
        next();
    });
});

// A change must come from Aware's own pages. The browser says where a request
// was sent from; one sent by another website is refused, whatever cookie it
// carries. Programs that are not browsers send neither header and are let
// through to the sign-in checks as before.
app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const refuse = () => res.status(403).json({ error: 'This request did not come from Offset Aware.' });
    const site = req.get('Sec-Fetch-Site');
    if (site) return (site === 'same-origin' || site === 'none') ? next() : refuse();
    const origin = req.get('Origin');
    if (!origin) return next();
    let host = null;
    try { host = new URL(origin).hostname; } catch { /* not an address: refused below */ }
    return host && host === req.hostname ? next() : refuse();
});

// Course files: the videos, their subtitles and their one-page summaries, and
// only for someone who is signed in. Everything else in the training folder -
// the quiz files, which hold the answers, above all - is never sent to a browser.
const COURSE_FILE = /\.(mp4|vtt|summary\.html)$/i;
app.use('/training', (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    let name = null;
    try { name = decodeURIComponent(req.path); } catch { /* refused below */ }
    if (!name || !COURSE_FILE.test(name)) return res.status(404).end();
    next();
});

app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    maxAge: '0'
}));

// Rate limiter for authentication to slow brute-force attempts.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_ATTEMPTS_PER_15_MIN) || 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again later.' }
});

// And per account, wherever the attempts come from: after ten wrong passwords
// for one ID in fifteen minutes that ID has to wait, so guessing from many
// addresses at once gets nowhere either. A right password does not count.
const accountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.WRONG_PASSWORDS_PER_15_MIN) || 10,
    keyGenerator: (req) => 'id:' + String((req.body && req.body.emp_id) || '').toLowerCase().slice(0, 100),
    skipSuccessfulRequests: true,
    standardHeaders: false,
    legacyHeaders: false,
    message: { error: 'Too many wrong passwords for this ID. Please try again in fifteen minutes.' }
});

// New passwords: twelve characters or more.
const MIN_PASSWORD = 12;

const getSettings = () => new Promise((resolve, reject) => {
    db.all("SELECT key, value FROM settings", [], (err, rows) => {
        if (err) return reject(err);
        const settings = {};
        rows.forEach(r => settings[r.key] = r.value);
        resolve(settings);
    });
});

// Returns an SMTP transporter. Uses configured SMTP if smtp_host is set,
// otherwise an Ethereal test account (console preview link only, no real email).
async function getTransporter() {
    const settings = await getSettings();
    if (settings.smtp_host) {
        return {
            transporter: nodemailer.createTransport({
                host: settings.smtp_host,
                port: Number(settings.smtp_port) || 587,
                secure: settings.smtp_secure === 'true',
                auth: { user: settings.smtp_user, pass: decryptSmtpPass(settings.smtp_pass) },
            }),
            isEthereal: false,
            mailFrom: settings.mail_from || '"Offset Aware" <admin@offset-aware.local>'
        };
    }
    const testAccount = await nodemailer.createTestAccount();
    return {
        transporter: nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: { user: testAccount.user, pass: testAccount.pass },
        }),
        isEthereal: true,
        mailFrom: '"Offset Aware (Simulated)" <test@example.com>'
    };
}

// The one upload Aware takes: the staff list, as a CSV file, from an
// administrator. It is read from memory and never written to disk, so a list of
// names and email addresses is not left lying in a folder afterwards.
const ALLOWED_UPLOAD_TYPES = new Set(['text/csv', 'application/vnd.ms-excel', 'text/plain']);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 5 MB, one file
    fileFilter: (req, file, cb) => {
        if (ALLOWED_UPLOAD_TYPES.has(file.mimetype)) return cb(null, true);
        cb(new Error('Unsupported file type. Upload a CSV file.'));
    }
});
// An upload too garbled to read is the sender's mistake, and is answered as one.
const staffListUpload = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE' || err instanceof multer.MulterError || /^Unsupported file type/.test(err.message || '')) return next(err);
    res.status(400).json({ error: 'That upload could not be read.' });
});

// Setup SQLite Database
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Create Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        emp_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'employee',
        require_password_change BOOLEAN DEFAULT 0
    )`);
    
    // Seamlessly upgrade existing databases
    db.run(`ALTER TABLE users ADD COLUMN require_password_change BOOLEAN DEFAULT 0`, (err) => { /* Ignore if exists */ });
    // Safe add columns if DB already exists
    db.run(`ALTER TABLE users ADD COLUMN email TEXT`, (err) => {});

    // Create Training Records table
    db.run(`CREATE TABLE IF NOT EXISTS training_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        module_id TEXT,
        vendor_name TEXT,
        completion_date TEXT,
        cert_filename TEXT,
        cert_original_name TEXT,
        status TEXT DEFAULT 'pending',
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
    db.run(`ALTER TABLE training_records ADD COLUMN module_id TEXT`, (err) => {});
    // When the person ticked "I confirm..." before submitting the quiz. The
    // videos ask for this acknowledgement, and an auditor asks to see it.
    db.run(`ALTER TABLE training_records ADD COLUMN acknowledged_at TEXT`, (err) => {});
    // The day the module was last finished, video and quiz both. Training
    // runs out a set time after this (Settings, default 12 months).
    db.run(`ALTER TABLE training_records ADD COLUMN completed_at TEXT`, (err) => {
        // Records finished before this column existed: the best date there is.
        db.run(`UPDATE training_records SET completed_at = completion_date
                 WHERE status = 'completed' AND completed_at IS NULL`);
    });

    // The day somebody was added, which is when a module they have never
    // done falls due. Filled in by the reminders for anybody added before this.
    db.run(`ALTER TABLE users ADD COLUMN created_on TEXT`, (err) => {});

    // Every reminder sent, to staff or up the chain, and whether it went.
    db.run(`CREATE TABLE IF NOT EXISTS reminder_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        module_id TEXT NOT NULL,
        due_date TEXT NOT NULL,
        kind TEXT NOT NULL,
        stage TEXT NOT NULL,
        level INTEGER DEFAULT 0,
        to_email TEXT,
        cc TEXT,
        subject TEXT,
        sent_on TEXT NOT NULL,
        ok INTEGER DEFAULT 1,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Every time somebody finishes a module, kept for good. training_records
    // holds only where each person is now; an auditor asks for last year too.
    db.run(`CREATE TABLE IF NOT EXISTS training_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        module_id TEXT NOT NULL,
        completed_on TEXT NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`, () => {
        db.run(`INSERT INTO training_completions (user_id, module_id, completed_on)
                SELECT tr.user_id, tr.module_id, COALESCE(tr.completed_at, tr.completion_date)
                  FROM training_records tr
                 WHERE tr.status = 'completed' AND tr.module_id IS NOT NULL
                   AND COALESCE(tr.completed_at, tr.completion_date) IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM training_completions c
                                    WHERE c.user_id = tr.user_id AND c.module_id = tr.module_id)`);
    });

    // Create Settings table
    // Every quiz attempt, passed or not, as marked by the server.
    db.run(`CREATE TABLE IF NOT EXISTS quiz_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        module_id TEXT NOT NULL,
        correct INTEGER NOT NULL,
        total INTEGER NOT NULL,
        score INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    // Who a role module is for, when it is not for everybody: the IT video
    // for the IT team, and so on. Chosen by the administrator in Settings.
    db.run(`CREATE TABLE IF NOT EXISTS module_assignments (
        user_id INTEGER NOT NULL,
        module_id TEXT NOT NULL,
        PRIMARY KEY (user_id, module_id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Each person's jobs. A job brings its role courses with it: give someone
    // "Branch and call centre" and the branch videos become theirs to do.
    db.run(`CREATE TABLE IF NOT EXISTS user_jobs (
        user_id INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        PRIMARY KEY (user_id, job_id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // The frameworks a person was chosen for, when a framework is for chosen
    // people rather than everybody: HIPAA for the team that handles health
    // data, and nobody else.
    db.run(`CREATE TABLE IF NOT EXISTS user_frameworks (
        user_id INTEGER NOT NULL,
        framework TEXT NOT NULL,
        PRIMARY KEY (user_id, framework),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
});

// Authentication Middleware
const requireAuth = (req, res, next) => {
    if (req.session.userId) return next();
    res.status(401).json({ error: 'Unauthorized' });
};

const requireAdmin = (req, res, next) => {
    if (req.session.userId && req.session.role === 'admin') return next();
    res.status(403).json({ error: 'Forbidden: Admin only' });
};

// —— How long training stays valid ——————————————————————
// A finished module counts for this many months, then the person does it
// again. ISO 27001 A.6.3, SAMA 3.1.6 and HIPAA 164.308(a)(5) all expect
// awareness training to be repeated, and yearly is what auditors expect.
// 0 means it never runs out.
const DEFAULT_VALID_MONTHS = 12;
const VALID_MONTH_CHOICES = [0, 6, 12, 24, 36];

function validMonthsFrom(settings) {
    const raw = settings.training_valid_months;
    if (raw === undefined || raw === null || raw === '') return DEFAULT_VALID_MONTHS;
    const n = Number(raw);
    return VALID_MONTH_CHOICES.includes(n) ? n : DEFAULT_VALID_MONTHS;
}

const todayIso = () => new Date().toISOString().split('T')[0];

/** The day a module finished on `completedOn` runs out, or null if it never does. */
function expiresOn(completedOn, months) {
    if (!completedOn || !months) return null;
    const d = new Date(String(completedOn).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d)) return null;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    // 29 February plus a year is 28 February, not 1 March.
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().split('T')[0];
}

/**
 * Where a record stands today. A module finished longer ago than the
 * validity period is expired: it is still shown, with its date, but it no
 * longer counts and the person is asked to do it again.
 */
function describeRecord(record, months, today = todayIso()) {
    if (!record) return null;
    const completedOn = record.status === 'completed' ? (record.completed_at || record.completion_date || null) : null;
    const expires = completedOn ? expiresOn(completedOn, months) : null;
    const expired = !!(expires && expires <= today);
    return { ...record, completed_on: completedOn, expires_on: expires, expired, valid: record.status === 'completed' && !expired };
}

// Marks a record finished today and keeps the fact in the history.
function markCompleted(row, userId, moduleId, done) {
    const today = todayIso();
    db.run("UPDATE training_records SET status = 'completed', cert_filename = 'INTERNAL_COMPLETED', completed_at = ? WHERE id = ?",
        [today, row.id], (err) => {
            if (err) return done(err);
            db.run("INSERT INTO training_completions (user_id, module_id, completed_on) VALUES (?, ?, ?)",
                [userId, moduleId, today], () => done(null));
        });
}

// --- API ROUTES ---

// Every sign-in starts a session of its own. One that was in the browser
// beforehand - planted there by somebody else, say - is thrown away.
function startSession(req, user, done) {
    req.session.regenerate((err) => {
        if (err) return done(err);
        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.name = user.name;
        done(null);
    });
}

// Checked when the ID is not one Aware knows, so a wrong ID takes as long to
// refuse as a wrong password and the two cannot be told apart by timing.
const NO_SUCH_USER_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

// Login
app.post('/api/login', loginLimiter, accountLimiter, (req, res) => {
    const emp_id = typeof req.body.emp_id === 'string' ? req.body.emp_id : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!emp_id || !password) return res.status(400).json({ error: 'ID and Password required' });

    db.get("SELECT * FROM users WHERE emp_id = ?", [emp_id], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) {
            bcrypt.compareSync(password, NO_SUCH_USER_HASH);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (bcrypt.compareSync(password, user.password)) {
            if (user.require_password_change) {
                return res.json({ success: false, requirePasswordChange: true, emp_id: user.emp_id });
            }
            startSession(req, user, (err) => {
                if (err) return res.status(500).json({ error: 'Could not sign in' });
                res.json({ success: true, role: user.role, name: user.name });
            });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });
});

// First-run setup: while the portal has no administrator, the login page offers
// "Create Admin Account". Once one exists, both routes refuse, so the option can
// never be used to take over a portal that is already running.
app.get('/api/setup/status', (req, res) => {
    db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'", [], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ needsAdmin: row.n === 0 });
    });
});

app.post('/api/setup/admin', loginLimiter, (req, res) => {
    const emp_id = String(req.body.emp_id || '').trim();
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');

    if (!emp_id || !name || !email || !password) return res.status(400).json({ error: 'All fields are required' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });

    const hash = bcrypt.hashSync(password, 10);
    // One statement, so two people submitting at the same moment cannot both
    // become the first administrator.
    db.run(`INSERT INTO users (emp_id, name, email, password, role)
            SELECT ?, ?, ?, ?, 'admin'
            WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
        [emp_id, name, email, hash],
        function(err) {
            if (err) return res.status(400).json({ error: 'That ID is already taken' });
            if (this.changes === 0) return res.status(409).json({ error: 'An administrator already exists. Please sign in.' });

            logRuntime('info', `First administrator created from the login page: ${emp_id}`);
            startSession(req, { id: this.lastID, role: 'admin', name }, (err) => {
                if (err) return res.status(500).json({ error: 'Created. Please sign in.' });
                res.json({ success: true, role: 'admin', name });
            });
        });
});

// Force Password Change
app.post('/api/force-change-password', loginLimiter, accountLimiter, (req, res) => {
    const text = (v) => (typeof v === 'string' ? v : '');
    const emp_id = text(req.body.emp_id), current_password = text(req.body.current_password), new_password = text(req.body.new_password);
    if (!emp_id || !current_password || !new_password) return res.status(400).json({ error: 'All fields required' });
    if (new_password.length < MIN_PASSWORD) return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters` });
    if (new_password === current_password) return res.status(400).json({ error: 'Choose a password different from the temporary one' });

    db.get("SELECT * FROM users WHERE emp_id = ?", [emp_id], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user || !bcrypt.compareSync(current_password, user.password)) {
            return res.status(401).json({ error: 'Invalid current credentials' });
        }
        
        const hash = bcrypt.hashSync(new_password, 10);
        db.run("UPDATE users SET password = ?, require_password_change = 0 WHERE id = ?", [hash, user.id], (err) => {
            if (err) return res.status(500).json({ error: 'Failed to update password' });
            
            // Automatically log them in
            startSession(req, user, (err) => {
                if (err) return res.status(500).json({ error: 'Password changed. Please sign in.' });
                res.json({ success: true, role: user.role, name: user.name });
            });
        });
    });
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie(SESSION_COOKIE, { path: '/' });
        res.json({ success: true });
    });
});

// Current User Profile
app.get('/api/me', requireAuth, (req, res) => {
    db.get("SELECT * FROM users WHERE id = ?", [req.session.userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        
        // Every record, not only the finished ones: the page shows a module
        // that has been watched but not yet passed, and lets that person skip
        // to the quiz instead of watching the video a second time.
        db.all("SELECT * FROM training_records WHERE user_id = ?", [user.id], async (err, records) => {
            const settings = await getSettings();
            const months = validMonthsFrom(settings);
            const reqs = await loadRequirements(settings).catch(() => null);
            res.json({
                user: { emp_id: user.emp_id, name: user.name, role: user.role, company_id: user.company_id },
                records: (records || []).map(r => describeRecord(r, months)),
                validMonths: months,
                installedModules: installedModules(),
                moduleVideos: moduleVideos(),
                requiredModules: reqs ? requiredFor(user.id, reqs) : [],
                // The courses this server has, for the page's list.
                modules: catalog().map((m) => ({
                    id: m.id, title: m.title, framework: m.framework, installed: !!m.file
                })),
                version: installedVersion(),
                smtpConfigured: !!settings.smtp_host
            });
        });
    });
});

// Record Video Completion (Employee)
app.post('/api/training/video-complete', requireAuth, express.json(), (req, res) => {
    const { module_id } = req.body;
    if (!module_id) return res.status(400).json({ error: 'Missing module_id' });
    
    const today = todayIso();

    getSettings().catch(() => ({})).then((settings) => {
    const months = validMonthsFrom(settings);
    db.get("SELECT * FROM training_records WHERE user_id = ? AND module_id = ?", [req.session.userId, module_id], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        
        if (row) {
            const now = describeRecord(row, months);
            if (now.valid) {
                return res.json({ success: true, message: 'Already completed', status: 'completed' });
            }
            // Run out: this is the next round, and it starts again from here.
            if (!now.expired && row.status === 'quiz_completed') {
                return markCompleted(row, req.session.userId, module_id, (err) => {
                    if (err) return res.status(500).json({ error: 'Database error' });
                    res.json({ success: true, status: 'completed' });
                });
            }
            db.run("UPDATE training_records SET status = 'video_completed', cert_filename = 'VIDEO_ONLY', completion_date = ?, completed_at = NULL WHERE id = ?",
                [now.expired ? today : (row.completion_date || today), row.id], function(err) {
                if (err) return res.status(500).json({ error: 'Database error' });
                res.json({ success: true, status: 'video_completed' });
            });
        } else {
            db.run(`INSERT INTO training_records (user_id, module_id, vendor_name, completion_date, cert_filename, cert_original_name, status) 
                    VALUES (?, ?, 'Internal Portal', ?, 'VIDEO_ONLY', 'Video watched', 'video_completed')`, 
                [req.session.userId, module_id, today], 
                function(err) {
                    if (err) return res.status(500).json({ error: 'Database error' });
                    res.json({ success: true, status: 'video_completed' });
            });
        }
    });
    });
});

// The pass mark. The server marks every quiz against it.
const QUIZ_PASS_PERCENT = 80;
// —— Which training modules this server has ——————————————————
// The videos are not in the Windows installer: the administrator chooses which
// modules to download while installing, and that is the only time Offset Aware
// uses the internet. A module counts only if its video is here, so nobody is
// chased for a course they cannot take.
// TRAINING_DIR moves the training folder somewhere else, for example a larger
// disk; it is then served at /training like the built-in one.
// The five original videos stay where they shipped, so moving the folder
// does not lose them.
const BUILT_IN_TRAINING_DIR = path.join(__dirname, 'public', 'training');
const TRAINING_DIR = process.env.TRAINING_DIR || BUILT_IN_TRAINING_DIR;
if (process.env.TRAINING_DIR) {
    try { fs.mkdirSync(TRAINING_DIR, { recursive: true }); } catch { /* Settings then shows nothing installed */ }
    app.use('/training', express.static(TRAINING_DIR, { etag: false, maxAge: '0' }));
}
// The name a video is downloaded under, and the name earlier versions shipped
// it under. Either works, so a file copied in by hand needs no renaming.
const TRAINING_FILES = {
    infosec: ['infosec.mp4', 'Infosec.mp4'],
    phishing: ['phishing.mp4', 'Phising.mp4'],
    privacy: ['privacy.mp4', 'Data Privacy.mp4'],
    incident: ['incident.mp4', 'Incident Reporting.mp4'],
    secure_coding: ['secure-coding.mp4', 'Secure_Coding_(OWASP).mp4']
};
const REQUIRED_MODULES = ['infosec', 'phishing', 'privacy', 'incident'];
const COURSES_URL = 'https://github.com/offsetsecurity/offset-aware/releases/tag/courses-2';

/** The video file this server has for a module, or null. */
function moduleFile(m) {
    for (const dir of new Set([TRAINING_DIR, BUILT_IN_TRAINING_DIR])) {
        for (const name of TRAINING_FILES[m]) {
            try { if (fs.statSync(path.join(dir, name)).size > 0) return name; } catch { /* not this one */ }
        }
    }
    return null;
}

const MODULE_TITLES = {
    infosec: 'Information Security Awareness & AUP',
    phishing: 'Phishing & Social Engineering',
    privacy: 'Data Privacy & Handling',
    incident: 'Incident Reporting',
    secure_coding: 'Secure Coding (OWASP)'
};

// —— Course packs ————————————————————————————————————————
// A course in a pack is up to four files in the training folder, named by its
// id: the video (<id>.mp4), its subtitles (<id>.vtt), its quiz and title
// (<id>.quiz.json) and its one-page summary (<id>.summary.html). Copying the
// files in is all it takes; nothing here lists them. A course counts once
// both its quiz and its video are present.
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
let packCache = { stamp: null, list: [] };

function packModules() {
    // Read again only when the folder changes: adding or removing a file does that.
    let stamp = null;
    try { stamp = fs.statSync(TRAINING_DIR).mtimeMs; } catch { /* no folder yet */ }
    if (stamp !== null && stamp === packCache.stamp) return packCache.list;
    const list = [];
    const jobs = [];
    let names = [];
    try { names = fs.readdirSync(TRAINING_DIR); } catch { /* no folder yet */ }
    for (const name of names) {
        // A pack's jobs: <pack>.jobs.json lists each job and the role courses it brings.
        if (name.endsWith('.jobs.json')) {
            try {
                const j = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, name), 'utf8'));
                for (const job of Array.isArray(j.jobs) ? j.jobs : []) {
                    if (!PACK_ID.test(String(job.id)) || !Array.isArray(job.modules)) continue;
                    jobs.push({
                        id: job.id,
                        title: String(job.title || job.id).slice(0, 120),
                        framework: String(j.framework || 'Other').slice(0, 60),
                        modules: job.modules.map(String).filter((m) => PACK_ID.test(m))
                    });
                }
            } catch { /* a broken jobs file: its jobs are left out */ }
            continue;
        }
        const id = name.endsWith('.quiz.json') ? name.slice(0, -'.quiz.json'.length) : null;
        if (!id || !PACK_ID.test(id) || TRAINING_FILES[id]) continue;
        try {
            const q = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, name), 'utf8'));
            if (!Array.isArray(q.questions) || !q.questions.length) continue;
            let video = null;
            try { if (fs.statSync(path.join(TRAINING_DIR, id + '.mp4')).size > 0) video = id + '.mp4'; } catch { /* not here */ }
            list.push({
                id,
                title: String(q.title || id).slice(0, 200),
                framework: String(q.framework || 'Other').slice(0, 60),
                audience: q.audience === 'all' ? 'all' : 'some',
                order: Number(q.order) || 999,
                file: video
            });
        } catch { /* a broken quiz file: the course is left out */ }
    }
    list.sort((a, b) => a.framework.localeCompare(b.framework) || a.order - b.order || a.id.localeCompare(b.id));
    packCache = { stamp, list, jobs };
    return list;
}

/** The jobs on this server: those with at least one installed course. */
function jobList() {
    packModules();
    const have = new Set(installedModules());
    return (packCache.jobs || [])
        .map((j) => ({ ...j, modules: j.modules.filter((m) => have.has(m)) }))
        .filter((j) => j.modules.length);
}

/** Every module the server knows: the original five, then the packs. */
function catalog() {
    const legacy = Object.keys(TRAINING_FILES).map((id) => ({
        id, title: MODULE_TITLES[id], framework: 'Security awareness basics', order: 0,
        audience: REQUIRED_MODULES.includes(id) ? 'all' : 'none',
        file: moduleFile(id), pack: false
    }));
    return legacy.concat(packModules().map((m) => ({ ...m, pack: true })));
}

const moduleTitle = (id) => (catalog().find((m) => m.id === id) || {}).title || id;
const isKnownModule = (id) => catalog().some((m) => m.id === id);

function installedModules() {
    return catalog().filter((m) => m.file).map((m) => m.id);
}

/** Where the page finds each installed video. */
function moduleVideos() {
    const out = {};
    for (const m of catalog()) if (m.file) out[m.id] = 'training/' + encodeURIComponent(m.file);
    return out;
}

// Who must do each module: 'all' (everybody), 'some' (people whose job brings
// it, or who were chosen for it) or 'none' (anyone may, nobody is chased).
// Saved per module; a module never set uses what its pack says - all-staff
// courses for everybody, role courses by job.
const AUDIENCES = ['all', 'some', 'none'];

function audienceMap(settings) {
    let saved = {};
    try { saved = JSON.parse(settings.module_audience || '{}') || {}; } catch { saved = {}; }
    const out = {};
    for (const m of catalog()) out[m.id] = AUDIENCES.includes(saved[m.id]) ? saved[m.id] : m.audience;
    return out;
}

// —— Who each framework is for ——————————————————————————
// A framework is one set of courses: the built-in ones, or a pack such as
// HIPAA or SAMA. 'all' - it applies to everybody. 'some' - to the people
// chosen for it, and to anyone holding one of its jobs. 'none' - to nobody;
// the courses can still be taken, but nobody is asked to.
// Every framework starts as 'some', the built-in courses included: nothing is
// handed to the whole company until the administrator says so. Within a
// framework, each module's own setting still decides whether it is for all
// of those people or only for certain jobs.
const SCOPES = ['all', 'some', 'none'];
const DEFAULT_SCOPE = 'some';

/** The frameworks with at least one course on this server. */
function installedFrameworks() {
    return [...new Set(catalog().filter((m) => m.file).map((m) => m.framework))];
}

function scopeMap(settings) {
    let saved = {};
    try { saved = JSON.parse(settings.framework_scope || '{}') || {}; } catch { saved = {}; }
    const out = {};
    for (const fw of new Set(catalog().map((m) => m.framework))) out[fw] = SCOPES.includes(saved[fw]) ? saved[fw] : DEFAULT_SCOPE;
    return out;
}

// A server that had staff before frameworks had a setting gave every
// all-staff course to everybody. It goes on doing so: the frameworks it has
// are recorded as 'all' the first time this runs, and only packs added
// afterwards start as 'some'. Nobody's list of training changes by upgrading.
// A server with no staff yet has nobody to change, and starts the new way.
let scopeSeeded = null;
function seedFrameworkScope() {
    if (!scopeSeeded) {
        scopeSeeded = (async () => {
            if (await dbGetP("SELECT 1 AS x FROM settings WHERE key = 'framework_scope'")) return;
            const staff = await dbGetP("SELECT COUNT(*) AS n FROM users WHERE role = 'employee'");
            const start = {};
            if (staff && staff.n > 0) for (const fw of installedFrameworks()) start[fw] = 'all';
            await dbRunP("INSERT OR IGNORE INTO settings (key, value) VALUES ('framework_scope', ?)", [JSON.stringify(start)]);
        })().catch((e) => { scopeSeeded = null; throw e; });
    }
    return scopeSeeded;
}

/** What decides who must do what, read once and used for many people. */
async function loadRequirements(settings) {
    await seedFrameworkScope().catch(() => {});
    if (!settings || settings.framework_scope === undefined) settings = await getSettings().catch(() => settings || {});
    const rows = await dbAll("SELECT user_id, module_id FROM module_assignments");
    const jobRows = await dbAll("SELECT user_id, job_id FROM user_jobs");
    const frameworkRows = await dbAll("SELECT user_id, framework FROM user_frameworks");
    const jobs = jobList();
    const jobModules = new Map(jobs.map((j) => [j.id, j.modules]));
    const jobFramework = new Map(jobs.map((j) => [j.id, j.framework]));
    // A job's courses count as chosen for everyone who has that job, and the
    // job puts them in its framework: a SAMA branch job means SAMA applies.
    const assigned = new Set(rows.map((r) => r.user_id + '|' + r.module_id));
    const members = new Set(frameworkRows.map((r) => r.user_id + '|' + r.framework));
    for (const r of jobRows) {
        for (const m of jobModules.get(r.job_id) || []) assigned.add(r.user_id + '|' + m);
        if (jobFramework.has(r.job_id)) members.add(r.user_id + '|' + jobFramework.get(r.job_id));
    }
    return {
        installed: installedModules(),
        audience: audienceMap(settings),
        assigned,
        scope: scopeMap(settings),
        frameworkOf: Object.fromEntries(catalog().map((m) => [m.id, m.framework])),
        members
    };
}

/** The installed modules this person must finish. */
function requiredFor(userId, req) {
    return req.installed.filter((m) => {
        const framework = req.frameworkOf[m];
        const scope = req.scope[framework] || 'all';
        const audience = req.audience[m];
        if (scope === 'none' || audience === 'none') return false;
        // Chosen for this course by name, or through a job.
        if (req.assigned.has(userId + '|' + m)) return true;
        return audience === 'all' && (scope === 'all' || req.members.has(userId + '|' + framework));
    });
}

/** Each person's jobs, as user id -> list of job ids. */
async function jobsByUser() {
    const out = new Map();
    for (const r of await dbAll("SELECT user_id, job_id FROM user_jobs")) {
        if (!out.has(r.user_id)) out.set(r.user_id, []);
        out.get(r.user_id).push(r.job_id);
    }
    return out;
}

/** Replaces a person's jobs with the known ones in `jobIds`. */
async function setUserJobs(userId, jobIds) {
    const known = new Set(jobList().map((j) => j.id));
    const keep = [...new Set((jobIds || []).map(String))].filter((j) => known.has(j));
    await dbRunP("DELETE FROM user_jobs WHERE user_id = ?", [userId]);
    for (const j of keep) await dbRunP("INSERT INTO user_jobs (user_id, job_id) VALUES (?, ?)", [userId, j]);
    return keep;
}

/** Replaces the frameworks a person was chosen for with the known ones in `names`. */
async function setUserFrameworks(userId, names) {
    const known = new Set(installedFrameworks());
    const keep = [...new Set((names || []).map(String))].filter((f) => known.has(f));
    await dbRunP("DELETE FROM user_frameworks WHERE user_id = ?", [userId]);
    for (const f of keep) await dbRunP("INSERT INTO user_frameworks (user_id, framework) VALUES (?, ?)", [userId, f]);
    return keep;
}

/** Replaces the courses a person was chosen for by name with the known ones in `ids`. */
async function setUserModules(userId, ids) {
    const known = new Set(installedModules());
    const keep = [...new Set((ids || []).map(String))].filter((m) => known.has(m));
    await dbRunP("DELETE FROM module_assignments WHERE user_id = ?", [userId]);
    for (const m of keep) await dbRunP("INSERT INTO module_assignments (user_id, module_id) VALUES (?, ?)", [userId, m]);
    return keep;
}

/**
 * A person's training in one go: frameworks, jobs and single courses. Each
 * list that is given replaces what they had; one left out is not touched.
 */
async function setUserTraining(userId, training) {
    const t = training || {};
    if (Array.isArray(t.frameworks)) await setUserFrameworks(userId, t.frameworks);
    if (Array.isArray(t.jobs)) await setUserJobs(userId, t.jobs);
    if (Array.isArray(t.modules)) await setUserModules(userId, t.modules);
}

/** Adds to, or takes away from, what a person already has. Nothing else of theirs moves. */
async function changeUserTraining(userId, training, remove) {
    const t = training || {};
    const lists = [
        ['user_frameworks', 'framework', t.frameworks, new Set(installedFrameworks())],
        ['user_jobs', 'job_id', t.jobs, new Set(jobList().map((j) => j.id))],
        ['module_assignments', 'module_id', t.modules, new Set(installedModules())]
    ];
    for (const [table, column, values, known] of lists) {
        for (const v of [...new Set((Array.isArray(values) ? values : []).map(String))].filter((x) => known.has(x))) {
            await dbRunP(remove
                ? `DELETE FROM ${table} WHERE user_id = ? AND ${column} = ?`
                : `INSERT OR IGNORE INTO ${table} (user_id, ${column}) VALUES (?, ?)`, [userId, v]);
        }
    }
}

/** Framework names from what a person typed, separated by ; or |. */
function parseFrameworks(text) {
    const names = installedFrameworks();
    return String(text || '').split(/[;|]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
        .map((s) => names.find((f) => f.toLowerCase() === s))
        .filter(Boolean);
}

/** Job ids from what a person typed: ids or titles, separated by ; or |. */
function parseJobs(text) {
    const jobs = jobList();
    return String(text || '').split(/[;|]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
        .map((s) => (jobs.find((j) => j.id === s || j.title.toLowerCase() === s) || {}).id)
        .filter(Boolean);
}

// —— Quizzes ————————————————————————————————————————————
// The server keeps the answers and does the marking. The page is handed the
// questions without them and sends back what the person chose; what it says
// about the score is never taken on trust.
const BUILT_IN_QUIZZES = require('./quizzes');

/** A course's quiz, answers and all. For the server only. */
function quizFor(id) {
    if (Object.prototype.hasOwnProperty.call(BUILT_IN_QUIZZES, id)) return BUILT_IN_QUIZZES[id];
    if (!PACK_ID.test(String(id)) || !packModules().some((m) => m.id === id)) return null;
    try {
        const q = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, id + '.quiz.json'), 'utf8'));
        const qs = (Array.isArray(q.questions) ? q.questions : [])
            .filter((x) => x && Array.isArray(x.opts) && x.opts.length > 1 && Number.isInteger(x.a) && x.a >= 0 && x.a < x.opts.length)
            .map((x) => ({ q: String(x.q), opts: x.opts.map(String), a: x.a }));
        if (!qs.length) return null;
        return { title: String(q.title || id).slice(0, 200), content: 'Answer every question, then tick the box and submit.', qs };
    } catch {
        return null;
    }
}

function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// The questions, in a fresh order each time, each with its choices in a fresh
// order too. `i` and `k` say which question and which choice, so the answers
// can be matched up when they come back. Nothing here says which is right.
app.get('/api/training/quiz/:id', requireAuth, (req, res) => {
    const quiz = quizFor(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Unknown module' });
    res.json({
        title: quiz.title,
        content: quiz.content,
        pass_percent: QUIZ_PASS_PERCENT,
        questions: shuffled(quiz.qs.map((x, i) => ({ i, q: x.q, opts: shuffled(x.opts.map((text, k) => ({ k, text }))) })))
    });
});

// Marks a quiz. Every attempt is kept, passed or failed, with how many failures
// in a row this person now has on the module since they last passed it. A pass
// counts towards the module the same way it always has: with the video watched
// it is finished, without it the quiz is held until the video is.
app.post('/api/training/quiz/:id', requireAuth, express.json(), (req, res) => {
    const module_id = req.params.id;
    const userId = req.session.userId;
    const quiz = quizFor(module_id);
    if (!quiz) return res.status(400).json({ error: 'Unknown module' });
    if (req.body.acknowledged !== true) return res.status(400).json({ error: 'Please tick the acknowledgement before submitting.' });

    const chosen = new Map();
    for (const a of Array.isArray(req.body.answers) ? req.body.answers.slice(0, 500) : []) {
        if (a && Number.isInteger(a.i) && Number.isInteger(a.k)) chosen.set(a.i, a.k);
    }
    if (quiz.qs.some((x, i) => !chosen.has(i))) return res.status(400).json({ error: 'Please answer all questions before submitting.' });

    const total = quiz.qs.length;
    const correct = quiz.qs.filter((x, i) => chosen.get(i) === x.a).length;
    const score = Math.round((correct / total) * 100);
    const passed = score >= QUIZ_PASS_PERCENT;
    const result = { success: true, passed, score, correct, total, failed_in_a_row: 0 };

    db.run(
        "INSERT INTO quiz_attempts (user_id, module_id, correct, total, score, passed) VALUES (?, ?, ?, ?, ?, ?)",
        [userId, module_id, correct, total, score, passed ? 1 : 0],
        function (err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (passed) return recordPass();
            db.get(
                `SELECT COUNT(*) AS n FROM quiz_attempts
                  WHERE user_id = ? AND module_id = ? AND passed = 0
                    AND id > COALESCE((SELECT MAX(id) FROM quiz_attempts
                                        WHERE user_id = ? AND module_id = ? AND passed = 1), 0)`,
                [userId, module_id, userId, module_id],
                (err2, row) => res.json({ ...result, failed_in_a_row: err2 ? 0 : row.n })
            );
        }
    );

    function recordPass() {
        const today = todayIso();
        // The acknowledgement is recorded with the pass, on whichever path below the record takes.
        const done = (body) => db.run("UPDATE training_records SET acknowledged_at = ? WHERE user_id = ? AND module_id = ?",
            [new Date().toISOString(), userId, module_id], () => res.json({ ...result, ...body }));

        getSettings().catch(() => ({})).then((settings) => {
        const months = validMonthsFrom(settings);
        db.get("SELECT * FROM training_records WHERE user_id = ? AND module_id = ?", [userId, module_id], (err, row) => {
            if (err) return res.status(500).json({ error: 'Database error' });

            if (row) {
                const now = describeRecord(row, months);
                if (now.valid) {
                    return done({ message: 'Already completed', status: 'completed' });
                }
                // An expired module needs the video again before the quiz counts.
                if (!now.expired && row.status === 'video_completed') {
                    return markCompleted(row, userId, module_id, (err) => {
                        if (err) return res.status(500).json({ error: 'Database error' });
                        done({ message: 'Quiz passed!', status: 'completed' });
                    });
                }
                db.run("UPDATE training_records SET status = 'quiz_completed', cert_filename = 'QUIZ_ONLY', completion_date = ?, completed_at = NULL WHERE id = ?",
                    [now.expired ? today : (row.completion_date || today), row.id], function(err) {
                    if (err) return res.status(500).json({ error: 'Database error' });
                    done({ message: 'Quiz passed!', status: 'quiz_completed' });
                });
            } else {
                db.run(`INSERT INTO training_records (user_id, module_id, vendor_name, completion_date, cert_filename, cert_original_name, status)
                        VALUES (?, ?, 'Internal Portal', ?, 'QUIZ_ONLY', 'Quiz completion', 'quiz_completed')`,
                    [userId, module_id, today],
                    function(err) {
                        if (err) return res.status(500).json({ error: 'Database error' });
                        done({ message: 'Quiz passed!', status: 'quiz_completed' });
                });
            }
        });
        });
    }
});

// Admin: Get all training records
app.get('/api/admin/records', requireAdmin, (req, res) => {
    let uQuery = "SELECT id, emp_id, name, email FROM users WHERE role = 'employee'";
    let rQuery = "SELECT tr.user_id, tr.module_id, tr.cert_filename, tr.status, tr.completion_date, tr.completed_at FROM training_records tr JOIN users u ON tr.user_id = u.id";

    getSettings().catch(() => ({})).then((settings) => {
    const months = validMonthsFrom(settings);
    db.all(uQuery, [], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all(rQuery, [], (err, records) => {
            if (err) return res.status(500).json({ error: err.message });

          db.all("SELECT user_id, module_id, score, passed, attempted_at FROM quiz_attempts ORDER BY id", [], (err, attempts) => {
            if (err) return res.status(500).json({ error: err.message });

            // Per person and module: how many attempts failed, and the last one.
            const tally = (userId, moduleId) => {
                const mine = attempts.filter(a => a.user_id === userId && a.module_id === moduleId);
                if (!mine.length) return null;
                const last = mine[mine.length - 1];
                return {
                    attempts: mine.length,
                    failed: mine.filter(a => !a.passed).length,
                    last_score: last.score,
                    last_passed: !!last.passed,
                    last_at: last.attempted_at
                };
            };
            
            // A module counts as done only when both the video and the quiz are
            // behind the person, which is what 'completed' means. The admin
            // screens read these flags; without them every employee showed as
            // having done nothing at all.
            // And it counts only until it runs out.
            const finished = (record) => !!record && record.valid;

          Promise.all([
              loadRequirements(settings), jobsByUser(),
              dbAll("SELECT user_id, framework FROM user_frameworks"),
              dbAll("SELECT user_id, module_id FROM module_assignments")
          ]).then(([reqs, jobsOf, frameworkRows, moduleRows]) => {
            const listOf = (rows, key) => {
                const out = new Map();
                for (const r of rows) { if (!out.has(r.user_id)) out.set(r.user_id, []); out.get(r.user_id).push(r[key]); }
                return out;
            };
            const frameworksOf = listOf(frameworkRows, 'framework');
            const modulesOf = listOf(moduleRows, 'module_id');
            const result = users.map(u => {
                const userRecords = records.filter(r => r.user_id === u.id).map(r => describeRecord(r, months));
                const required = requiredFor(u.id, reqs);
                // Every module this person must do or has a record for.
                const ids = [...new Set(required.concat(userRecords.map(r => r.module_id).filter(Boolean)))];
                const modules = {}, quizzes = {}, done = {};
                for (const id of ids) {
                    modules[id] = userRecords.find(r => r.module_id === id);
                    quizzes[id] = tally(u.id, id);
                    done[id] = finished(modules[id]);
                }
                return {
                    emp_id: u.emp_id, name: u.name, email: u.email,
                    jobs: jobsOf.get(u.id) || [],
                    // What was ticked for this person by hand, as opposed to what everybody gets.
                    frameworks: frameworksOf.get(u.id) || [],
                    assigned: modulesOf.get(u.id) || [],
                    required, modules, quizzes, done
                };
            });
            res.json(result);
          }).catch((e) => res.status(500).json({ error: e.message }));
          });
        });
    });
    });
});

// Admin: how long a finished module stays valid.
app.get('/api/admin/training-settings', requireAdmin, async (req, res) => {
    const settings = await getSettings().catch(() => ({}));
    res.json({ validMonths: validMonthsFrom(settings), choices: VALID_MONTH_CHOICES });
});

app.post('/api/admin/training-settings', requireAdmin, express.json(), (req, res) => {
    const months = Number(req.body && req.body.validMonths);
    if (!VALID_MONTH_CHOICES.includes(months)) {
        return res.status(400).json({ error: 'Choose one of the listed periods.' });
    }
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('training_valid_months', ?)", [String(months)], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        logRuntime('info', `Training validity set to ${months || 'never expires'}${months ? ' months' : ''} by ${req.session.name || 'user ' + req.session.userId}`);
        res.json({ success: true, validMonths: months });
    });
});

// —— Automatic reminders, and who is told when they are ignored ——————
// Every required module that is installed has a due date: the day it runs
// out, or - for something never done - 30 days after the person was added.
//
// Staff get one email per module: 30, 15, 7 and 3 days before, on the day,
// then every day after until it is done. Nothing is combined, so three
// modules due is three emails.
//
// Once it is overdue, a chain of up to four people is told, one level at a
// time, each with the earlier levels copied in so everybody knows who else
// has been told. A level is told once when it is reached, then every 7 days
// until the module is done.
const STAFF_STAGES = [30, 15, 7, 3];
const NEW_STAFF_DAYS = 30;
const CHAIN_REPEAT_DAYS = 7;
const CHAIN_ROLES = [
    { role: 'Administrator', days: 1 },
    { role: "The administrator's manager", days: 7 },
    { role: "Their manager", days: 15 },
    { role: 'Top management', days: 30 }
];
const EMAIL_SHAPE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

const dbAll = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRunP = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, (err) => (err ? reject(err) : resolve())));
const dbGetP = (sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));

const dayNumber = (iso) => Math.round(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / 86400000);
const daysBetween = (later, earlier) => dayNumber(later) - dayNumber(earlier);
const addDaysIso = (iso, n) => new Date((dayNumber(iso) + n) * 86400000).toISOString().split('T')[0];

function normaliseChain(raw) {
    let list = [];
    try { list = JSON.parse(raw || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    return CHAIN_ROLES.map((r, i) => {
        const x = list[i] || {};
        const days = Number(x.days);
        return {
            role: r.role,
            name: String(x.name || '').trim().slice(0, 120),
            email: String(x.email || '').trim().slice(0, 200),
            days: Number.isInteger(days) && days >= 1 && days <= 365 ? days : r.days
        };
    });
}

function reminderSettingsFrom(settings) {
    const hour = Number(settings.reminders_hour);
    return {
        enabled: settings.reminders_enabled === 'true',
        hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9,
        chain: normaliseChain(settings.escalation_chain),
        lastRun: settings.reminders_last_run || ''
    };
}

/** Every required, installed module for every employee, with when it is due. */
async function dueWork(today, months) {
    const reqs = await loadRequirements();
    const users = await dbAll("SELECT id, emp_id, name, email, created_on FROM users WHERE role = 'employee'");
    const records = await dbAll("SELECT user_id, module_id, status, completion_date, completed_at FROM training_records");
    const items = [];
    for (const u of users) {
        for (const m of requiredFor(u.id, reqs)) {
            const rec = records.find((r) => r.user_id === u.id && r.module_id === m);
            const d = rec ? describeRecord(rec, months, today) : null;
            let due = null;
            if (d && d.valid) due = d.expires_on;                 // done: it is due again when it runs out
            else if (d && d.expired) due = d.expires_on;           // ran out
            else due = addDaysIso(u.created_on || today, NEW_STAFF_DAYS); // never finished
            if (!due) continue;                                    // done, and never runs out
            items.push({ user: u, module: m, due, daysLeft: daysBetween(due, today) });
        }
    }
    return items;
}

/** Which of the staff reminders this is, or null when it is too early. */
function staffStage(daysLeft) {
    if (daysLeft < 0) return 'after-' + (-daysLeft);
    if (daysLeft === 0) return 'on';
    const reached = STAFF_STAGES.filter((s) => s >= daysLeft);
    return reached.length ? 'before-' + reached[reached.length - 1] : null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const niceDate = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00Z')
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function staffMessage(item, stage, portalUrl) {
    const title = moduleTitle(item.module);
    const { user, daysLeft } = item;
    let subject, lead;
    if (stage.startsWith('after-')) {
        const n = -daysLeft;
        subject = `Training overdue by ${plural(n, 'day')}: ${title}`;
        lead = `Your security awareness training "${title}" was due on ${niceDate(item.due)} and is ${plural(n, 'day')} overdue.`;
    } else if (stage === 'on') {
        subject = `Training due today: ${title}`;
        lead = `Your security awareness training "${title}" is due today.`;
    } else {
        subject = `Training due in ${plural(daysLeft, 'day')}: ${title}`;
        lead = `Your security awareness training "${title}" is due on ${niceDate(item.due)}, in ${plural(daysLeft, 'day')}.`;
    }
    const text = `Hello ${user.name},\n\n${lead}\n\nIt takes a few minutes: watch the video, then pass the quiz. ` +
        `You can do it now.\n\nOffset Aware: ${portalUrl}\nUsername: ${user.emp_id}\n`;
    return { subject, text };
}

function chainMessage(item, index, chain, portalUrl, alsoTold) {
    const title = moduleTitle(item.module);
    const over = -item.daysLeft;
    const me = chain[index];
    const next = chain.slice(index + 1).find((l) => l.email);
    const lines = [
        `Hello ${me.name || me.role},`,
        '',
        `${item.user.name} (${item.user.emp_id}) has not completed the security awareness training "${title}".`,
        `It was due on ${niceDate(item.due)} and is ${plural(over, 'day')} overdue. They have been reminded every day since.`,
        '',
        alsoTold.length
            ? `This message was also sent to: ${alsoTold.map((l) => (l.name ? `${l.name} (${l.role})` : l.role)).join(', ')}.`
            : 'You are the first person told.',
    ];
    if (next) {
        const when = Math.max(1, next.days - over);
        lines.push(`If it is still not done, ${next.name || next.role} (${next.role}) will be told ` +
            (over >= next.days ? 'next' : `in ${plural(when, 'day')}`) + `, with you copied in.`);
    }
    lines.push('', `You will be reminded again in ${plural(CHAIN_REPEAT_DAYS, 'day')} if it is still outstanding.`,
        '', `Offset Aware: ${portalUrl}`);
    return {
        subject: `Training overdue: ${item.user.name}, ${title} (${plural(over, 'day')})`,
        text: lines.join('\n') + '\n'
    };
}

let reminderRunning = false;

/**
 * One pass: send whatever is due today. Safe to run twice in a day, because
 * every email sent is written to reminder_log and checked before the next.
 */
async function runReminders(today = todayIso()) {
    if (reminderRunning) return { skipped: 'busy' };
    reminderRunning = true;
    const out = { staff: 0, chain: 0, failed: 0, skipped: '' };
    try {
        const settings = await getSettings();
        if (!settings.smtp_host) { out.skipped = 'email-not-set-up'; return out; }
        const months = validMonthsFrom(settings);
        const { chain } = reminderSettingsFrom(settings);
        const portalUrl = process.env.PORTAL_URL || `https://localhost:${PORT}`;

        // Staff added before this ran have no start date: today is it.
        await dbRunP("UPDATE users SET created_on = ? WHERE created_on IS NULL AND role = 'employee'", [today]);

        const items = await dueWork(today, months);
        const { transporter, mailFrom } = await getTransporter();

        const log = (item, kind, stage, level, to, cc, subject, ok, error) => dbRunP(
            `INSERT INTO reminder_log (user_id, module_id, due_date, kind, stage, level, to_email, cc, subject, sent_on, ok, error)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [item.user.id, item.module, item.due, kind, stage, level, to, cc, subject, today, ok ? 1 : 0, ok ? null : String(error).slice(0, 300)]);

        const send = async (item, kind, stage, level, to, cc, message) => {
            try {
                await transporter.sendMail({ from: mailFrom, to, cc: cc || undefined, subject: message.subject, text: message.text });
                await log(item, kind, stage, level, to, cc, message.subject, true);
                return true;
            } catch (e) {
                logSmtp('error', `reminder to ${to} failed: ${e.message}`);
                await log(item, kind, stage, level, to, cc, message.subject, false, e.message);
                out.failed++;
                return false;
            }
        };

        for (const item of items) {
            // ——— the person themselves ———
            const stage = staffStage(item.daysLeft);
            if (stage && item.user.email) {
                const done = await dbGetP(
                    `SELECT 1 AS x FROM reminder_log WHERE user_id = ? AND module_id = ? AND due_date = ?
                        AND kind = 'staff' AND stage = ? AND ok = 1`,
                    [item.user.id, item.module, item.due, stage]);
                if (!done && await send(item, 'staff', stage, 0, item.user.email, '', staffMessage(item, stage, portalUrl))) out.staff++;
            }

            // ——— the chain, once it is overdue ———
            if (item.daysLeft >= 0) continue;
            const over = -item.daysLeft;
            for (let i = 0; i < chain.length; i++) {
                const level = chain[i];
                if (!EMAIL_SHAPE.test(level.email) || over < level.days) continue;
                const last = await dbGetP(
                    `SELECT MAX(sent_on) AS d FROM reminder_log WHERE user_id = ? AND module_id = ? AND due_date = ?
                        AND kind = 'chain' AND level = ? AND ok = 1`,
                    [item.user.id, item.module, item.due, i + 1]);
                if (last && last.d && daysBetween(today, last.d) < CHAIN_REPEAT_DAYS) continue;
                // Everyone above is copied, so each level knows who else has been told.
                const earlier = chain.slice(0, i).filter((l) => EMAIL_SHAPE.test(l.email) && over >= l.days && l.email !== level.email);
                const cc = [...new Set(earlier.map((l) => l.email))].join(', ');
                if (await send(item, 'chain', 'level-' + (i + 1), i + 1, level.email, cc, chainMessage(item, i, chain, portalUrl, earlier))) out.chain++;
            }
        }
        if (out.staff || out.chain) logRuntime('info', `Reminders sent: ${out.staff} to staff, ${out.chain} up the chain, ${out.failed} failed`);
        return out;
    } finally {
        reminderRunning = false;
    }
}

// Checked every few minutes; runs once a day, at the hour chosen in Escalation.
function startReminderScheduler() {
    const tick = async () => {
        try {
            const settings = await getSettings();
            const cfg = reminderSettingsFrom(settings);
            const today = todayIso();
            if (!cfg.enabled || cfg.lastRun === today || new Date().getHours() < cfg.hour) return;
            await dbRunP("INSERT OR REPLACE INTO settings (key, value) VALUES ('reminders_last_run', ?)", [today]);
            await runReminders(today);
        } catch (e) {
            logRuntime('error', 'Reminder run failed: ' + e.message);
        }
    };
    setTimeout(tick, 30 * 1000);
    setInterval(tick, 5 * 60 * 1000);
}

app.get('/api/admin/reminder-settings', requireAdmin, async (req, res) => {
    const settings = await getSettings().catch(() => ({}));
    res.json({ ...reminderSettingsFrom(settings), newStaffDays: NEW_STAFF_DAYS, stages: STAFF_STAGES,
        repeatDays: CHAIN_REPEAT_DAYS, smtpConfigured: !!settings.smtp_host });
});

app.post('/api/admin/reminder-settings', requireAdmin, express.json(), (req, res) => {
    const body = req.body || {};
    const hour = Number(body.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return res.status(400).json({ error: 'Choose an hour from 0 to 23.' });
    const rows = Array.isArray(body.chain) ? body.chain.slice(0, CHAIN_ROLES.length) : [];
    const chain = [];
    for (let i = 0; i < CHAIN_ROLES.length; i++) {
        const x = rows[i] || {};
        const email = String(x.email || '').trim();
        const days = Number(x.days);
        if (email && !EMAIL_SHAPE.test(email)) {
            return res.status(400).json({ error: `${CHAIN_ROLES[i].role}: that is not an email address.` });
        }
        if (!Number.isInteger(days) || days < 1 || days > 365) {
            return res.status(400).json({ error: `${CHAIN_ROLES[i].role}: days overdue must be a whole number from 1 to 365.` });
        }
        chain.push({ name: String(x.name || '').trim().slice(0, 120), email, days });
    }
    const enabled = body.enabled === true ? 'true' : 'false';
    db.serialize(() => {
        const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
        stmt.run('reminders_enabled', enabled);
        stmt.run('reminders_hour', String(hour));
        stmt.run('escalation_chain', JSON.stringify(chain));
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            logRuntime('info', `Automatic reminders ${enabled === 'true' ? 'on' : 'off'} at ${hour}:00, set by ${req.session.name || 'user ' + req.session.userId}`);
            res.json({ success: true });
        });
    });
});

// Everything the reminders have sent, newest first, for the Escalation screen
// and for an auditor who asks whether people were chased.
app.get('/api/admin/reminder-log', requireAdmin, async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    try {
        const rows = await dbAll(
            `SELECT l.id, l.sent_on, l.kind, l.stage, l.level, l.to_email, l.cc, l.subject, l.due_date, l.module_id, l.ok, l.error,
                    u.emp_id, u.name
               FROM reminder_log l LEFT JOIN users u ON u.id = l.user_id
              ORDER BY l.id DESC LIMIT ?`, [limit]);
        res.json(rows.map((r) => ({ ...r, module: moduleTitle(r.module_id) })));
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Send whatever is due now, rather than waiting for the hour. Nothing goes out
// twice: what has been sent is checked first. (asOf is for testing only.)
app.post('/api/admin/reminders/run', requireAdmin, express.json(), async (req, res) => {
    const asOf = process.env.AWARE_ALLOW_ASOF === '1' && /^\d{4}-\d{2}-\d{2}$/.test(String(req.body && req.body.asOf || ''))
        ? req.body.asOf : todayIso();
    try {
        res.json({ success: true, ...(await runReminders(asOf)) });
    } catch (e) {
        res.status(500).json({ error: 'The reminders could not be sent: ' + e.message });
    }
});

// Admin: which modules are on this server, and where to put one that is not.
app.get('/api/admin/modules', requireAdmin, async (req, res) => {
    try {
        const reqs = await loadRequirements();
        const counts = {};
        for (const key of reqs.assigned) { const m = key.split('|')[1]; counts[m] = (counts[m] || 0) + 1; }
        const chosen = {};
        for (const r of await dbAll("SELECT framework, COUNT(*) AS n FROM user_frameworks GROUP BY framework")) chosen[r.framework] = r.n;
        res.json({
            folder: TRAINING_DIR,
            downloadPage: COURSES_URL,
            // Who each framework applies to, before any one module's own setting.
            frameworks: installedFrameworks().map((name) => ({ name, scope: reqs.scope[name], people: chosen[name] || 0 })),
            // The original five are listed only when installed: new installs
            // use the course packs instead.
            modules: catalog().filter((m) => m.pack || m.file).map((m) => ({
                id: m.id,
                title: m.title,
                framework: m.framework,
                file: m.file || m.id + '.mp4',
                audience: reqs.audience[m.id],
                people: counts[m.id] || 0,
                installed: !!m.file
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin: the jobs on this server, what each adds, and how many people have it.
app.get('/api/admin/jobs', requireAdmin, async (req, res) => {
    try {
        const counts = {};
        for (const r of await dbAll("SELECT job_id, COUNT(*) AS n FROM user_jobs GROUP BY job_id")) counts[r.job_id] = r.n;
        res.json(jobList().map((j) => ({
            id: j.id, title: j.title, framework: j.framework, people: counts[j.id] || 0,
            modules: j.modules.map((m) => ({ id: m, title: moduleTitle(m) }))
        })));
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin: who a framework applies to - everybody, chosen people, or nobody.
app.post('/api/admin/frameworks/scope', requireAdmin, express.json(), async (req, res) => {
    const framework = String((req.body && req.body.framework) || '');
    const scope = req.body && req.body.scope;
    if (!installedFrameworks().includes(framework)) return res.status(404).json({ error: 'Unknown framework' });
    if (!SCOPES.includes(scope)) return res.status(400).json({ error: 'Choose everyone, chosen people or nobody.' });
    try {
        await seedFrameworkScope();
        const settings = await getSettings();
        let saved = {};
        try { saved = JSON.parse(settings.framework_scope || '{}') || {}; } catch { saved = {}; }
        saved[framework] = scope;
        await dbRunP("INSERT OR REPLACE INTO settings (key, value) VALUES ('framework_scope', ?)", [JSON.stringify(saved)]);
        logRuntime('info', `${framework} set to apply to "${scope}" by ${req.session.name || 'user ' + req.session.userId}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin: the people a framework applies to, when it is for chosen people.
app.get('/api/admin/frameworks/people', requireAdmin, async (req, res) => {
    const framework = String(req.query.framework || '');
    if (!installedFrameworks().includes(framework)) return res.status(404).json({ error: 'Unknown framework' });
    try {
        const rows = await dbAll(
            `SELECT u.emp_id, u.name, (f.user_id IS NOT NULL) AS chosen FROM users u
               LEFT JOIN user_frameworks f ON f.user_id = u.id AND f.framework = ?
              WHERE u.role = 'employee' ORDER BY u.name`, [framework]);
        res.json(rows.map((r) => ({ emp_id: r.emp_id, name: r.name, chosen: !!r.chosen })));
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/frameworks/people', requireAdmin, express.json(), async (req, res) => {
    const framework = String((req.body && req.body.framework) || '');
    const empIds = req.body && req.body.emp_ids;
    if (!installedFrameworks().includes(framework)) return res.status(404).json({ error: 'Unknown framework' });
    if (!Array.isArray(empIds) || empIds.length > 100000) return res.status(400).json({ error: 'emp_ids must be a list' });
    try {
        const users = await dbAll("SELECT id, emp_id FROM users WHERE role = 'employee'");
        const want = new Set(empIds.map(String));
        await dbRunP("BEGIN");
        await dbRunP("DELETE FROM user_frameworks WHERE framework = ?", [framework]);
        for (const u of users) {
            if (want.has(String(u.emp_id))) await dbRunP("INSERT INTO user_frameworks (user_id, framework) VALUES (?, ?)", [u.id, framework]);
        }
        await dbRunP("COMMIT");
        res.json({ success: true, people: users.filter((u) => want.has(String(u.emp_id))).length });
    } catch (e) {
        await dbRunP("ROLLBACK").catch(() => {});
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin: one person's training - frameworks, jobs and single courses. Each
// list sent replaces what they had.
app.post('/api/admin/users/:emp_id/training', requireAdmin, express.json(), async (req, res) => {
    const body = req.body || {};
    for (const key of ['frameworks', 'jobs', 'modules']) {
        if (body[key] !== undefined && !Array.isArray(body[key])) return res.status(400).json({ error: `${key} must be a list` });
    }
    try {
        const user = await dbGetP("SELECT id FROM users WHERE emp_id = ? AND role = 'employee'", [req.params.emp_id]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        await setUserTraining(user.id, body);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin: the same training for many people at once. It adds to what each
// person has, or takes it away; it never replaces the rest of their list.
app.post('/api/admin/users/bulk-training', requireAdmin, express.json(), async (req, res) => {
    const body = req.body || {};
    const empIds = body.emp_ids;
    if (!Array.isArray(empIds) || !empIds.length || empIds.length > 100000) return res.status(400).json({ error: 'Choose at least one person.' });
    for (const key of ['frameworks', 'jobs', 'modules']) {
        if (body[key] !== undefined && !Array.isArray(body[key])) return res.status(400).json({ error: `${key} must be a list` });
    }
    if (!['add', 'remove'].includes(body.action)) return res.status(400).json({ error: 'Choose add or remove.' });
    try {
        const want = new Set(empIds.map(String));
        const users = (await dbAll("SELECT id, emp_id FROM users WHERE role = 'employee'")).filter((u) => want.has(String(u.emp_id)));
        await dbRunP("BEGIN");
        for (const u of users) await changeUserTraining(u.id, body, body.action === 'remove');
        await dbRunP("COMMIT");
        logRuntime('info', `Training ${body.action === 'remove' ? 'removed from' : 'added to'} ${users.length} people by ${req.session.name || 'user ' + req.session.userId}`);
        res.json({ success: true, people: users.length });
    } catch (e) {
        await dbRunP("ROLLBACK").catch(() => {});
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin: a person's jobs. The list replaces what they had.
app.post('/api/admin/users/:emp_id/jobs', requireAdmin, express.json(), async (req, res) => {
    const jobs = req.body && req.body.jobs;
    if (!Array.isArray(jobs)) return res.status(400).json({ error: 'jobs must be a list' });
    try {
        const user = await dbGetP("SELECT id FROM users WHERE emp_id = ?", [req.params.emp_id]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, jobs: await setUserJobs(user.id, jobs) });
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin: who must do a module - everybody, chosen people, or nobody.
app.post('/api/admin/modules/:id/audience', requireAdmin, express.json(), async (req, res) => {
    const id = req.params.id;
    const audience = req.body && req.body.audience;
    if (!isKnownModule(id)) return res.status(404).json({ error: 'Unknown module' });
    if (!AUDIENCES.includes(audience)) return res.status(400).json({ error: 'Choose everyone, chosen people or nobody.' });
    try {
        const settings = await getSettings();
        let saved = {};
        try { saved = JSON.parse(settings.module_audience || '{}') || {}; } catch { saved = {}; }
        saved[id] = audience;
        await dbRunP("INSERT OR REPLACE INTO settings (key, value) VALUES ('module_audience', ?)", [JSON.stringify(saved)]);
        logRuntime('info', `${moduleTitle(id)} set to "${audience}" by ${req.session.name || 'user ' + req.session.userId}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin: the people a module is for, when it is for chosen people.
app.get('/api/admin/modules/:id/people', requireAdmin, async (req, res) => {
    if (!isKnownModule(req.params.id)) return res.status(404).json({ error: 'Unknown module' });
    try {
        const rows = await dbAll(
            `SELECT u.emp_id, u.name, (a.user_id IS NOT NULL) AS chosen FROM users u
               LEFT JOIN module_assignments a ON a.user_id = u.id AND a.module_id = ?
              WHERE u.role = 'employee' ORDER BY u.name`, [req.params.id]);
        res.json(rows.map((r) => ({ emp_id: r.emp_id, name: r.name, chosen: !!r.chosen })));
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/modules/:id/people', requireAdmin, express.json(), async (req, res) => {
    const id = req.params.id;
    const empIds = req.body && req.body.emp_ids;
    if (!isKnownModule(id)) return res.status(404).json({ error: 'Unknown module' });
    if (!Array.isArray(empIds) || empIds.length > 100000) return res.status(400).json({ error: 'emp_ids must be a list' });
    try {
        const users = await dbAll("SELECT id, emp_id FROM users WHERE role = 'employee'");
        const want = new Set(empIds.map(String));
        await dbRunP("BEGIN");
        await dbRunP("DELETE FROM module_assignments WHERE module_id = ?", [id]);
        for (const u of users) {
            if (want.has(String(u.emp_id))) await dbRunP("INSERT INTO module_assignments (user_id, module_id) VALUES (?, ?)", [u.id, id]);
        }
        await dbRunP("COMMIT");
        res.json({ success: true, people: users.filter((u) => want.has(String(u.emp_id))).length });
    } catch (e) {
        await dbRunP("ROLLBACK").catch(() => {});
        res.status(500).json({ error: 'Database error' });
    }
});

// —— Course packs, added from Settings —————————————————————
// The packs are large, so they are not in the installer or the Docker image.
// The Windows installer fetches the ones ticked during setup; this does the
// same from inside Aware, for Docker and for adding a pack later. It reaches
// the internet only when an administrator presses the button.
const PACKS_URL = (process.env.PACKS_URL || 'https://github.com/offsetsecurity/offset-aware/releases/download/courses-2').replace(/\/+$/, '') + '/';
const PACKS = [
    { id: 'iso27001', file: 'pack-iso27001.zip', title: 'ISO 27001', framework: 'ISO 27001', audience: 'Any organisation working to ISO/IEC 27001:2022', courses: 13, mb: 180 },
    { id: 'hipaa', file: 'pack-hipaa.zip', title: 'HIPAA', framework: 'HIPAA', audience: 'Vendors handling US health data for clients', courses: 7, mb: 127 },
    { id: 'sama', file: 'pack-sama.zip', title: 'SAMA, banks', framework: 'SAMA', audience: 'Banks regulated by the Saudi Central Bank', courses: 19, mb: 383 },
    { id: 'sama-finance', file: 'pack-sama-finance.zip', title: 'SAMA, finance companies', framework: 'SAMA (finance companies)', audience: 'Finance companies regulated by the Saudi Central Bank', courses: 7, mb: 55 }
];
// What a pack may put in the training folder: a course's four files and the
// pack's jobs, by those names and nothing else. No folders, no other types.
const PACK_FILE = /^[a-z0-9][a-z0-9-]{0,40}\.(mp4|vtt|quiz\.json|summary\.html|jobs\.json)$/;

let packJob = { state: 'idle' };

/** Saves a download to `dest` and returns its SHA-256. */
async function downloadTo(url, dest, onBytes) {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(2 * 60 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`The download page answered ${res.status}.`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    let got = 0;
    const meter = new Transform({
        transform(chunk, enc, done) { got += chunk.length; hash.update(chunk); onBytes(got, total); done(null, chunk); }
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest));
    return hash.digest('hex');
}

/**
 * Unpacks a course pack into the training folder, one file at a time, so a
 * 400 MB pack never has to fit in memory. Each file is written beside its
 * final name and moved into place whole.
 */
async function unzipPack(zipPath, destDir) {
    const fh = await fs.promises.open(zipPath, 'r');
    try {
        const { size } = await fh.stat();
        const tailLen = Math.min(size, 65557);
        const tail = Buffer.alloc(tailLen);
        await fh.read(tail, 0, tailLen, size - tailLen);
        let end = -1;
        for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
        if (end < 0) throw new Error('The pack is not a zip file.');
        const count = tail.readUInt16LE(end + 10);
        const dirSize = tail.readUInt32LE(end + 12);
        const dirAt = tail.readUInt32LE(end + 16);
        if (count === 0xffff || dirAt === 0xffffffff) throw new Error('The pack is larger than this can unpack.');
        const dir = Buffer.alloc(dirSize);
        await fh.read(dir, 0, dirSize, dirAt);

        let p = 0, written = 0;
        for (let n = 0; n < count; n++) {
            if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('The pack is damaged.');
            const method = dir.readUInt16LE(p + 10);
            const packedSize = dir.readUInt32LE(p + 20);
            const fullSize = dir.readUInt32LE(p + 24);
            const nameLen = dir.readUInt16LE(p + 28);
            const localAt = dir.readUInt32LE(p + 42);
            const name = dir.toString('utf8', p + 46, p + 46 + nameLen);
            p += 46 + nameLen + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
            if (!PACK_FILE.test(name)) continue;
            if (method !== 0 && method !== 8) throw new Error(`The pack holds ${name} in a form this cannot unpack.`);

            const local = Buffer.alloc(30);
            await fh.read(local, 0, 30, localAt);
            if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('The pack is damaged.');
            const start = localAt + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
            const part = path.join(destDir, '.' + name + '.part');
            const source = packedSize ? fs.createReadStream(zipPath, { start, end: start + packedSize - 1 }) : Readable.from([]);
            try {
                if (method === 8) await pipeline(source, zlib.createInflateRaw(), fs.createWriteStream(part));
                else await pipeline(source, fs.createWriteStream(part));
                if ((await fs.promises.stat(part)).size !== fullSize) throw new Error(`${name} did not unpack whole.`);
                await fs.promises.rename(part, path.join(destDir, name));
            } catch (e) {
                await fs.promises.rm(part, { force: true }).catch(() => {});
                throw e;
            }
            written++;
        }
        return written;
    } finally {
        await fh.close();
    }
}

async function installPacks(ids, who) {
    packJob = { state: 'working', packs: ids, current: null, step: 'Starting', received: 0, total: 0, done: [], error: null };
    try {
        await fs.promises.mkdir(TRAINING_DIR, { recursive: true });
        // Each pack is checked against the checksum published beside it.
        const sums = {};
        const listed = await fetch(PACKS_URL + 'SHA256SUMS.txt', { redirect: 'follow', signal: AbortSignal.timeout(60000) });
        if (!listed.ok) throw new Error(`The download page answered ${listed.status}.`);
        for (const line of (await listed.text()).split(/\r?\n/)) {
            const m = line.match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
            if (m) sums[m[2]] = m[1].toLowerCase();
        }
        for (const id of ids) {
            const pack = PACKS.find((x) => x.id === id);
            Object.assign(packJob, { current: id, step: 'Downloading', received: 0, total: 0 });
            const zip = path.join(TRAINING_DIR, '.' + pack.file + '.part');
            try {
                const sum = await downloadTo(PACKS_URL + pack.file, zip, (got, total) => { packJob.received = got; packJob.total = total; });
                if (!sums[pack.file] || sums[pack.file] !== sum) throw new Error(`${pack.title} did not arrive intact, so it was not installed. Try again.`);
                packJob.step = 'Unpacking';
                await unzipPack(zip, TRAINING_DIR);
            } finally {
                await fs.promises.rm(zip, { force: true }).catch(() => {});
            }
            packJob.done.push(id);
            logRuntime('info', `Course pack ${pack.title} installed by ${who}`);
        }
        packJob.state = 'done';
    } catch (e) {
        packJob.state = 'failed';
        packJob.error = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|aborted/i.test(String(e.message))
            ? 'This server could not reach the download page. Check its internet connection, or copy the packs in by hand.'
            : e.message;
        logRuntime('warn', `Course pack install failed: ${e.message}`);
    }
    packJob.current = null;
}

// Admin: the packs there are, which are here, and how an install is going.
app.get('/api/admin/packs', requireAdmin, (req, res) => {
    const have = {};
    for (const m of catalog()) if (m.file) have[m.framework] = (have[m.framework] || 0) + 1;
    res.json({
        packs: PACKS.map((p) => ({ id: p.id, title: p.title, framework: p.framework, audience: p.audience, courses: p.courses, mb: p.mb, installed: have[p.framework] || 0 })),
        job: packJob
    });
});

app.post('/api/admin/packs/install', requireAdmin, express.json(), (req, res) => {
    const ids = [...new Set((Array.isArray(req.body && req.body.packs) ? req.body.packs : []).map(String))].filter((id) => PACKS.some((p) => p.id === id));
    if (!ids.length) return res.status(400).json({ error: 'Tick at least one pack.' });
    if (packJob.state === 'working') return res.status(409).json({ error: 'A pack is already being installed.' });
    installPacks(ids, req.session.name || 'user ' + req.session.userId);
    res.json({ success: true });
});

// Admin: every completion ever recorded, for an auditor. One row per person,
// module and time they finished it.
app.get('/api/admin/completions.csv', requireAdmin, async (req, res) => {
    const settings = await getSettings().catch(() => ({}));
    const months = validMonthsFrom(settings);
    db.all(`SELECT u.emp_id, u.name, u.email, c.module_id, c.completed_on
              FROM training_completions c JOIN users u ON u.id = c.user_id
             ORDER BY u.emp_id, c.module_id, c.completed_on`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        const cell = (v) => {
            const s = String(v == null ? '' : v);
            // A leading =, +, - or @ would run as a formula in a spreadsheet.
            const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
            return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
        };
        const lines = [['Employee ID', 'Name', 'Email', 'Module', 'Completed on', 'Valid until'].join(',')];
        for (const r of rows) {
            lines.push([r.emp_id, r.name, r.email, moduleTitle(r.module_id), r.completed_on,
                expiresOn(r.completed_on, months) || 'Does not expire'].map(cell).join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="training-history-${todayIso()}.csv"`);
        res.send('\ufeff' + lines.join('\r\n') + '\r\n');
    });
});

/**
 * One line of a CSV file as its cells. A cell in double quotes may hold
 * commas - "Branch, call centre and collections" is one job, not three
 * columns - and a doubled quote inside it is a quote.
 */
function csvCells(line) {
    const cells = [];
    let cell = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') quoted = false;
            else cell += c;
        } else if (c === '"' && !cell.trim()) { quoted = true; cell = ''; }
        else if (c === ',') { cells.push(cell.trim()); cell = ''; }
        else cell += c;
    }
    cells.push(cell.trim());
    return cells;
}

/** What was typed in a Job or Training cell that is not a name this server knows. */
function unknownNames(text, known) {
    const names = new Set(known.map((n) => String(n).toLowerCase()));
    return String(text || '').split(/[;|]/).map((s) => s.trim()).filter((s) => s && !names.has(s.toLowerCase()));
}

// Admin: Bulk Import CSV
// A person already here is not added twice. When their row says a job or
// which training applies, that replaces theirs, so the same list can be
// uploaded again to give out training. Their name, email and password stay.
app.post('/api/admin/users/import', requireAdmin, staffListUpload, (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const content = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');

    const lines = content.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return res.status(400).json({ error: 'File is empty or missing data rows' });
    
    let added = 0;
    let skipped = 0;
    const withJobs = [];
    const existing = [];          // people already here whose row gives training
    const unknown = new Set();    // job and training names nobody recognised
    const jobNames = jobList().flatMap((j) => [j.id, j.title]);
    const frameworkNames = installedFrameworks();
    // Each person their own starting password, shown once to the administrator and emailed when email is set up.
    const accounts = [];
    
    const stmt = db.prepare("INSERT INTO users (emp_id, name, email, password, require_password_change) VALUES (?, ?, ?, ?, 1)");
    
    db.serialize(() => {
        db.exec("BEGIN TRANSACTION");
        // Start from 1 to skip header row
        for (let i = 1; i < lines.length; i++) {
            const cols = csvCells(lines[i]);
            if (cols.length < 3) { skipped++; continue; }
            
            const emp_id = cols[0];
            const name = cols[1];
            const email = cols[2];
            
            if (!emp_id || !name) { skipped++; continue; }
            // An optional fourth column: the person's jobs, by name, separated by ;
            const jobs = parseJobs(cols[3]);
            // An optional fifth: the frameworks that apply to them, by name.
            const frameworks = parseFrameworks(cols[4]);
            for (const n of unknownNames(cols[3], jobNames).concat(unknownNames(cols[4], frameworkNames))) unknown.add(n);

            const password = startingPassword();
            stmt.run([emp_id, name, email, bcrypt.hashSync(password, 10)], function(err) {
                if (err && (jobs.length || frameworks.length)) existing.push([emp_id, jobs, frameworks]);
                else if (err) skipped++;
                else {
                    added++;
                    accounts.push({ emp_id, name, email, password });
                    if (jobs.length || frameworks.length) withJobs.push([this.lastID, jobs, frameworks]);
                }
            });
        }
        db.exec("COMMIT", async (err) => {
            stmt.finalize();
            for (const [id, jobs, frameworks] of withJobs) await setUserTraining(id, { jobs, frameworks }).catch(() => {});
            // People already here: a filled-in cell replaces theirs, an empty one leaves it.
            let updated = 0;
            for (const [empId, jobs, frameworks] of existing) {
                const user = await dbGetP("SELECT id FROM users WHERE emp_id = ? AND role = 'employee'", [empId]).catch(() => null);
                if (!user) { skipped++; continue; }
                await setUserTraining(user.id, { jobs: jobs.length ? jobs : undefined, frameworks: frameworks.length ? frameworks : undefined }).catch(() => {});
                updated++;
            }
            // Email each person their own sign-in details, when email is set up.
            let emailed = 0;
            const settings = await getSettings().catch(() => ({}));
            if (settings.smtp_host) {
                const portalUrl = process.env.PORTAL_URL || `https://localhost:${PORT}`;
                for (const a of accounts) {
                    if (!a.email) continue;
                    try {
                        const { transporter, mailFrom } = await getTransporter();
                        await transporter.sendMail({
                            from: mailFrom,
                            to: a.email,
                            subject: "Your Offset Aware sign-in details",
                            text: `Hello ${a.name},

Your Offset Aware account has been created, for your security awareness training.

Address: ${portalUrl}
Username: ${a.emp_id}
Password: ${a.password}

Please sign in, choose your own password, and complete your training.
`,
                        });
                        emailed++;
                    } catch (e) {
                        logRuntime('warn', `Could not email sign-in details to ${a.email}: ${e.message}`);
                    }
                }
            }
            res.json({
                message: `Import complete. Added: ${added}, Skipped/Duplicates: ${skipped}` + (updated ? `, Training updated: ${updated}` : ''),
                added, skipped, emailed, updated,
                // Typed in the Job or Training column, and not a name on this server.
                unknown: [...unknown],
                // Shown once, so the administrator can hand them out. Each is replaced at first sign-in.
                accounts,
            });
        });
    });
});

// Admin: Add Employee
// Every new account gets a starting password of its own. They all used to get
// "test", so anyone who knew a colleague's employee ID could sign in first and
// take the account. Letters and digits that cannot be mistaken for each other.
const PASSWORD_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function startingPassword() {
    let out = '';
    for (let i = 0; i < 12; i++) out += PASSWORD_LETTERS[crypto.randomInt(PASSWORD_LETTERS.length)];
    return out;
}

app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const { emp_id, name, email, jobs, frameworks, modules } = req.body;
    // The administrator may choose one; otherwise each person gets their own.
    const chosen = String(req.body.password || '');
    const password = chosen || startingPassword();
    if (!emp_id || !name) return res.status(400).json({ error: 'Employee ID and name are required' });

    // The administrator typed this, and it is about to be emailed, so it is a
    // temporary password and the first sign-in has to replace it.
    const hash = bcrypt.hashSync(password, 10);
    db.run("INSERT INTO users (emp_id, name, email, password, require_password_change) VALUES (?, ?, ?, ?, 1)", [emp_id, name, email, hash], async function(err) {
        if (err) return res.status(400).json({ error: 'Employee ID already exists or invalid data' });
        await setUserTraining(this.lastID, { jobs, frameworks, modules }).catch(() => {});

        try {
            const { transporter, isEthereal, mailFrom } = await getTransporter();
            const portalUrl = process.env.PORTAL_URL || `https://localhost:${PORT}`;
            let info = await transporter.sendMail({
                from: mailFrom,
                to: email || 'test@example.com',
                subject: "Your Offset Aware sign-in details",
                text: `Hello ${name},\n\nYour Offset Aware account has been created, for your security awareness training.\n\nAddress: ${portalUrl}\nUsername: ${emp_id}\nPassword: ${password}\n\nPlease sign in, choose your own password, and complete your training.\n`,
            });
            const previewUrl = isEthereal ? nodemailer.getTestMessageUrl(info) : null;
            if (previewUrl) console.log("Email Preview URL: %s", previewUrl);
            res.json({ success: true, id: this.lastID, emailPreview: previewUrl, startingPassword: chosen ? undefined : password });
        } catch (mailErr) {
            console.error("Mail Error:", mailErr);
            res.json({ success: true, id: this.lastID, warning: 'User created but email failed to send.', startingPassword: chosen ? undefined : password });
        }
    });
});

// Admin: Delete Employee
app.delete('/api/admin/users/:emp_id', requireAdmin, (req, res) => {
    const emp_id = req.params.emp_id;
    
    db.get("SELECT id FROM users WHERE emp_id = ?", [emp_id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'User not found' });
        
        db.run("DELETE FROM module_assignments WHERE user_id = ?", [row.id]);
        db.run("DELETE FROM user_jobs WHERE user_id = ?", [row.id]);
        db.run("DELETE FROM user_frameworks WHERE user_id = ?", [row.id]);
        db.run("DELETE FROM training_records WHERE user_id = ?", [row.id], (err) => {
            db.run("DELETE FROM users WHERE id = ?", [row.id], function(err) {
                if (err) return res.status(500).json({ error: 'Database error' });
                res.json({ success: true });
            });
        });
    });
});

// Admin: reset a person's password, from Settings.
// The Employee ID and the email on the account are asked for together, so a
// slip in one cannot reset the wrong person. The new password is made here,
// one of its own for this person, and is replaced at their next sign-in.
app.post('/api/admin/users/reset-password', requireAdmin, express.json(), async (req, res) => {
    const empId = String((req.body && req.body.emp_id) || '').trim();
    const email = String((req.body && req.body.email) || '').trim();
    if (!empId) return res.status(400).json({ error: 'Enter the Employee ID.' });
    try {
        const user = await dbGetP("SELECT id, emp_id, name, email FROM users WHERE role = 'employee' AND LOWER(emp_id) = LOWER(?)", [empId]);
        // One answer for a wrong ID and a wrong email. An account with no
        // email on file matches an empty email, or it could never be reset.
        if (!user || String(user.email || '').trim().toLowerCase() !== email.toLowerCase()) {
            return res.status(404).json({ error: 'Nobody here has that Employee ID with that email. Check both on the Employees screen.' });
        }
        const password = startingPassword();
        await dbRunP("UPDATE users SET password = ?, require_password_change = 1 WHERE id = ?", [bcrypt.hashSync(password, 10), user.id]);
        logRuntime('info', `Password reset for ${user.emp_id} by ${req.session.name || 'user ' + req.session.userId}`);

        let emailed = false;
        let emailError = null;
        const settings = await getSettings().catch(() => ({}));
        if (settings.smtp_host && user.email) {
            try {
                const { transporter, mailFrom } = await getTransporter();
                const portalUrl = process.env.PORTAL_URL || `https://localhost:${PORT}`;
                await transporter.sendMail({
                    from: mailFrom,
                    to: user.email,
                    subject: "Your Offset Aware password has been reset",
                    text: `Hello ${user.name},\n\nYour Offset Aware password has been reset by an administrator.\n\nAddress: ${portalUrl}\nUsername: ${user.emp_id}\nNew Temporary Password: ${password}\n\nPlease log in and change your password immediately.\n`,
                });
                emailed = true;
            } catch (e) {
                emailError = e.message;
                logRuntime('warn', `Could not email the reset password to ${user.email}: ${e.message}`);
            }
        }
        // Shown once, so the administrator can pass it on when no email went.
        res.json({ success: true, emp_id: user.emp_id, name: user.name, startingPassword: password, emailed, emailError });
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Admin: Reset Password
app.post('/api/admin/users/:emp_id/reset', requireAdmin, (req, res) => {
    const emp_id = req.params.emp_id;
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });

    db.get("SELECT id, name, email FROM users WHERE emp_id = ?", [emp_id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'User not found' });

        const hash = bcrypt.hashSync(password, 10);
        // The email says "Temporary Password". Until now nothing made it so.
        db.run("UPDATE users SET password = ?, require_password_change = 1 WHERE id = ?", [hash, row.id], async function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            
            let previewUrl = null;
            let emailError = null;
            if (row.email) {
                try {
                    const { transporter, isEthereal, mailFrom } = await getTransporter();
                    const portalUrl = process.env.PORTAL_URL || `https://localhost:${PORT}`;
                    const info = await transporter.sendMail({
                        from: mailFrom,
                        to: row.email,
                        subject: "Your Offset Aware password has been reset",
                        text: `Hello ${row.name},\n\nYour Offset Aware password has been reset by an administrator.\n\nAddress: ${portalUrl}\nUsername: ${emp_id}\nNew Temporary Password: ${password}\n\nPlease log in and change your password immediately.\n`,
                    });
                    if (isEthereal) previewUrl = nodemailer.getTestMessageUrl(info);
                } catch (e) {
                    console.error("Failed to send reset email to", row.email, e);
                    emailError = e.message;
                }
            } else {
                emailError = "User has no email address on file.";
            }
            
            res.json({ success: true, emailPreview: previewUrl, emailError: emailError });
        });
    });
});

// Get SMTP Configuration
app.get('/api/admin/smtp', requireAdmin, async (req, res) => {
    try {
        const settings = await getSettings();
        if (settings.smtp_pass) {
            settings.smtp_pass = '********'; // Mask password for frontend
        }
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update SMTP Configuration
app.post('/api/admin/smtp', requireAdmin, async (req, res) => {
    const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, mail_from } = req.body;
    
    let finalPass = smtp_pass;
    if (smtp_pass === '********' || !smtp_pass) {
        const currentSettings = await getSettings();
        finalPass = currentSettings.smtp_pass || '';
    } else {
        finalPass = encryptSmtpPass(smtp_pass);
    }

    db.serialize(() => {
        const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
        stmt.run("smtp_host", smtp_host || '');
        stmt.run("smtp_port", smtp_port || '587');
        stmt.run("smtp_secure", smtp_secure === true ? 'true' : 'false');
        stmt.run("smtp_user", smtp_user || '');
        stmt.run("smtp_pass", finalPass);
        stmt.run("mail_from", mail_from || '');
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// —— HTTPS certificate ——————————————————————————
// Settings -> HTTPS certificate. Upload the certificate the company's IT team
// issued, and the browser stops saying "Not secure". Used at once: the portal
// is always on HTTPS, so the new certificate replaces the old one on the
// running server and nothing restarts.

function portalHost() {
    try {
        return new URL(process.env.PORTAL_URL || '').hostname;
    } catch {
        return '';
    }
}

async function certificateStatus() {
    let certificate = null;
    let problem = null;
    let source = 'self-signed';
    try {
        const loaded = await certificates.loadTls();
        source = loaded.source;
        certificate = certificates.describe(loaded.options);
    } catch (err) {
        problem = err.message;
    }
    return {
        source,
        certificate,
        problem,
        warnings: certificate ? certificates.warningsFor(certificate, portalHost()) : [],
        upload: certificates.uploadDetails(),
        portalUrl: process.env.PORTAL_URL || '',
    };
}

function logCertificate(req, action, info) {
    // Who, what and which certificate. Never the key.
    logRuntime('info', `${action} by ${req.session.name || "user " + req.session.userId}` +
        (info ? `: ${info.subject}, issued by ${info.issuer}, valid until ${info.validTo.slice(0, 10)}, ${info.fingerprint}` : ''));
}

app.get('/api/admin/certificate', requireAdmin, async (req, res) => {
    try {
        res.json(await certificateStatus());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/certificate', requireAdmin, async (req, res) => {
    const { files, password, confirm } = req.body || {};
    let prepared;
    try {
        prepared = certificates.prepareUpload(files, typeof password === 'string' ? password : '');
    } catch (err) {
        if (err instanceof certificates.CertificateError) return res.status(400).json({ error: err.message });
        throw err;
    }
    // Shown before anything changes, so a certificate for the wrong name
    // cannot replace a working one by accident.
    const warnings = certificates.warningsFor(prepared.info, portalHost());
    if (warnings.length && confirm !== true) {
        return res.json({ needsConfirmation: true, certificate: prepared.info, warnings });
    }
    try {
        certificates.saveUpload(prepared.options, files.map((f) => String(f.name || '').slice(0, 200)));
        const appliedNow = certificates.applyLive(prepared.options);
        logCertificate(req, 'HTTPS certificate uploaded', prepared.info);
        res.json({ needsConfirmation: false, appliedNow, status: await certificateStatus() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/certificate', requireAdmin, async (req, res) => {
    if (!certificates.hasUpload()) return res.status(400).json({ error: 'No certificate has been uploaded here.' });
    try {
        certificates.removeUpload();
        const loaded = await certificates.loadTls();
        const appliedNow = certificates.applyLive(loaded.options);
        logCertificate(req, 'HTTPS certificate removed, back to the self-signed one');
        res.json({ appliedNow, status: await certificateStatus() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Test SMTP Configuration
app.post('/api/test-email', requireAdmin, async (req, res) => {
    const settings = await getSettings();
    if (!settings.smtp_host) return res.status(400).json({ error: 'SMTP is not configured in the settings.' });

    db.get("SELECT email FROM users WHERE id = ?", [req.session.userId], async (err, user) => {
        if (err || !user || !user.email) return res.status(400).json({ error: 'Admin email not found in database. Cannot send test.' });
        
        try {
            const { transporter, isEthereal, mailFrom } = await getTransporter();
            const mailOptions = {
                from: mailFrom,
                to: user.email,
                subject: 'Test email from Offset Aware',
                text: 'This is a test from Offset Aware. If you can read it, email is set up correctly.'
            };
            
            const info = await transporter.sendMail(mailOptions);
            const msg = isEthereal ? `Ethereal preview link generated in console.` : `Test email successfully sent to ${user.email}.`;
            logSmtp('info', `Test email sent to ${user.email}`);
            res.json({ success: true, message: msg });
        } catch (error) {
            logSmtp('error', 'Failed to send test email', error);
            res.status(500).json({ error: 'SMTP Error: ' + error.message });
        }
    });
});

// Admin: email employees about their training status.
// - emp_id given  -> emails that one employee (compliant=confirmation, else reminder)
// - emp_id absent -> bulk: emails every employee who is NOT yet compliant
app.post('/api/notify/training', requireAdmin, (req, res) => {
    const singleEmpId = req.body.emp_id;

    let userQuery = "SELECT id, emp_id, name, email FROM users WHERE role = 'employee'";
    const params = [];
    if (singleEmpId) { userQuery += " AND emp_id = ?"; params.push(singleEmpId); }

    db.all(userQuery, params, (err, users) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (users.length === 0) return res.status(404).json({ error: 'No matching employees' });

        const ids = users.map(u => u.id);
        const placeholders = ids.map(() => '?').join(',');
        db.all(`SELECT user_id, module_id, status, completion_date, completed_at FROM training_records WHERE user_id IN (${placeholders})`, ids, async (err, records) => {
            if (err) return res.status(500).json({ error: 'Database error' });

            const settings = await getSettings().catch(() => ({}));
            const months = validMonthsFrom(settings);
            const reqs = await loadRequirements(settings).catch(() => null);
            // Done means done and still in date: a module that has run out
            // is chased like one that was never started. Only modules this
            // server has count.
            const isCompliant = (uid) => {
                const required = reqs ? requiredFor(uid, reqs) : [];
                const done = records.filter(r => r.user_id === uid && describeRecord(r, months).valid).map(r => r.module_id);
                return required.length > 0 && required.every(m => done.includes(m));
            };

            // Somebody who has been given no training has nothing to be reminded of.
            const hasTraining = (uid) => !!reqs && requiredFor(uid, reqs).length > 0;

            // Single send targets that employee; bulk targets only the people with training left to do.
            const targets = singleEmpId ? users : users.filter(u => hasTraining(u.id) && !isCompliant(u.id));
            const portalUrl = process.env.PORTAL_URL || `https://localhost:${PORT}`;
            let sent = 0; const skipped = []; const failed = [];

            try {
                const { transporter, mailFrom } = await getTransporter();
                for (const u of targets) {
                    if (!u.email) { skipped.push(u.emp_id); continue; }
                    const compliant = isCompliant(u.id);
                    const subject = compliant
                        ? 'Security Training Complete - Thank You'
                        : 'Action Required: Complete Your Security Training';
                    const text = compliant
                        ? `Hello ${u.name},\n\nOur records show you have completed all required security awareness training. Thank you.\n\nOffset Aware: ${portalUrl}\n`
                        : `Hello ${u.name},\n\nOur records show some of your required security awareness training is not done, or has run out and needs doing again. Please sign in and finish your outstanding modules as soon as possible.\n\nOffset Aware: ${portalUrl}\nUsername: ${u.emp_id}\n`;
                    try {
                        await transporter.sendMail({ from: mailFrom, to: u.email, subject, text });
                        sent++;
                    } catch (e) {
                        console.error('notify mail error for', u.emp_id, e.message);
                        failed.push(u.emp_id);
                    }
                }
            } catch (e) {
                return res.status(500).json({ error: 'Email transport error: ' + e.message });
            }
            res.json({ success: true, sent, skipped, failed });
        });
    });
});

// Admin: is there a newer version?
//
// Asks the portal's own releases page, which is public, and compares the tag
// with the version baked into this build. Nothing is downloaded here: this
// answers a question, and installing is a separate decision below.
const RELEASES_URL = process.env.RELEASES_URL
    || 'https://api.github.com/repos/offsetsecurity/offset-aware/releases/latest';
const UPDATE_REQUEST_DIR = process.env.UPDATE_REQUEST_DIR || '/updates/request';
const UPDATE_STATUS_DIR = process.env.UPDATE_STATUS_DIR || '/updates/status';

const isNewer = (latest, current) => {
    const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const [a, b] = [parts(latest), parts(current)];
    for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) > (b[i] || 0)) return true;
        if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
};

// The version of this build. APP_VERSION is set only by the Docker image, so on
// every other install it was "unknown" - which reads as older than any release.
// package.json goes into every build.
function installedVersion() {
    if (process.env.APP_VERSION) return process.env.APP_VERSION;
    try { return require('./package.json').version || 'unknown'; } catch (e) { return 'unknown'; }
}

app.get('/api/admin/update/version', requireAdmin, (req, res) => {
    res.json({ current: installedVersion() });
});

app.get('/api/admin/update/check', requireAdmin, async (req, res) => {
    const current = installedVersion();
    try {
        const r = await fetch(RELEASES_URL, {
            headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'offset-aware' },
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const body = await r.json();
        const latest = String(body.tag_name || '').replace(/^v/, '');
        if (!latest) throw new Error('no version on the release page');
        // Only Docker installs an update from here, through its updater
        // container, which takes the version published for that release. On
        // Windows the new installer is the update, and the page says where
        // to get it.
        const canInstall = process.env.INSTALL_KIND === 'docker';
        res.json({
            current, latest, newer: isNewer(latest, current),
            can_install: canInstall,
            download_url: body.html_url || 'https://github.com/offsetsecurity/offset-aware/releases/latest'
        });
    } catch (e) {
        // An on-premise portal with no way out to the internet is a normal
        // thing to be, not a fault, so this says so rather than erroring.
        res.json({ current, error: 'Could not reach the release page: ' + e.message });
    }
});

// Admin: how the update is going. Written by the updater container, which
// mounts this folder for writing and the request folder read-only.
app.get('/api/admin/update/status', requireAdmin, (req, res) => {
    try {
        const file = path.join(UPDATE_STATUS_DIR, 'status.json');
        if (!fs.existsSync(file)) return res.json({ state: 'idle' });
        res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
        res.json({ state: 'idle' });
    }
});

// Admin: In-App System Update
app.post('/api/admin/update', requireAdmin, express.json(), (req, res) => {
    // On Docker the portal cannot replace itself - it would be swapping the
    // image it is running inside - so it asks the updater container, by
    // leaving a note in a folder they share.
    if (process.env.INSTALL_KIND === 'docker') {
        const version = String((req.body && req.body.version) || '').replace(/[^0-9.]/g, '');
        if (!version) return res.json({ success: false, error: 'No version was given. Check for updates first.' });
        try {
            fs.mkdirSync(UPDATE_REQUEST_DIR, { recursive: true });
            fs.writeFileSync(
                path.join(UPDATE_REQUEST_DIR, 'update.json'),
                JSON.stringify({ version, requestedAt: new Date().toISOString() }, null, 2),
            );
            logRuntime('info', `Update to ${version} requested by ${req.session.userId}`);
            return res.json({ success: true, message: 'Update asked for. The portal will restart.' });
        } catch (e) {
            return res.json({
                success: false,
                error: 'Could not ask the updater. It is only started when COMPOSE_PROFILES=updates is in .env. ' + e.message,
            });
        }
    }
    // Anywhere else the server never fetches and runs new code by itself.
    res.json({ success: false, error: 'Download the new installer from the release page and run it. Your data, port and settings are kept.' });
});

// Errors. The caller is told what they can act on - the file is too large, the
// wrong type, the request could not be read - and nothing about how the server
// is built. Anything unexpected goes to the log, not to the browser.
app.use((err, req, res, next) => {
    if (!err) return next();
    if (res.headersSent) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That file is too large. The limit is 5 MB.' });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'That upload was not accepted.' });
    if (/^Unsupported file type/.test(err.message || '')) return res.status(400).json({ error: err.message });
    if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'The request could not be read.' });
    logRuntime('error', `Error at ${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Something went wrong. It has been written to the log.' });
});

// An address the API does not have is said to be missing, in the API's own
// terms, rather than answered with the page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// The page itself. It is one page at one address; anything else that was not
// a file above does not exist, and is said not to.
app.get('*', (req, res) => {
    if (req.path !== '/' && req.path !== '/index.html') return res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('Not found');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// And the same plain answer whatever was being attempted on it.
app.use((req, res) => res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('Not found'));

// STARTUP LOGIC
db.get("SELECT value FROM settings WHERE key = 'port'", [], async (err, row) => {
    // In Docker the container always listens on PORT; the port people use is
    // chosen in compose.yaml, so a port saved in the settings is ignored.
    const inDocker = process.env.INSTALL_KIND === 'docker';
    const finalPort = (!inDocker && row && row.value) ? parseInt(row.value, 10) : PORT;

    // The uploaded certificate if there is one, otherwise the self-signed one
    // the portal makes for itself. See tls.js.
    const { options, source } = await certificates.loadTls();
    if (source === 'self-signed') {
        console.log('Using the self-signed certificate. Browsers will say "Not secure" until an administrator uploads one under Settings.');
    }

    // http:// on the same port is redirected to https://, rather than dropped.
    certificates.createServer(options, app).listen(finalPort, '0.0.0.0', () => {
        const msg = `Offset Aware running securely on https://0.0.0.0:${finalPort}`;
        console.log(msg);
        logRuntime('info', msg);
        startReminderScheduler();
    });
});
