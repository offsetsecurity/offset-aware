/**
 * The HTTPS certificate: which one to serve, checking an uploaded one before
 * it is used, and putting it on the running server without a restart.
 *
 * The portal always serves HTTPS. Until somebody gives it a real certificate
 * it makes its own, self-signed one (cert.pem and key.pem in CERT_DIR), and
 * every browser says "Not secure". An administrator fixes that by uploading
 * the certificate their IT team issued, under Settings.
 *
 * The uploaded one is kept as one file, uploaded-certificate.json, beside the
 * self-signed pair, and wins over it. One file, replaced in one rename, so a
 * crash half way through cannot pair a new certificate with an old key.
 * Removing it brings the self-signed one back.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const tls = require('tls');

const certDir = path.resolve(process.env.CERT_DIR || __dirname);
const selfSignedCert = path.join(certDir, 'cert.pem');
const selfSignedKey = path.join(certDir, 'key.pem');
const uploadedFile = path.join(certDir, 'uploaded-certificate.json');

const DAY = 86400000;

/** A refusal written for the person at the Settings screen. */
class CertificateError extends Error {}

// —— the .pfx password, encrypted at rest ——————————————
// Its own key, derived from SESSION_SECRET, so a copy of the certificate
// folder alone does not hand over the password.
const secretKey = () =>
    crypto.scryptSync(process.env.SESSION_SECRET || 'iso-compliance-dev-secret-change-me', 'portal-tls', 32);

function seal(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join(':');
}

function unseal(stored) {
    const [iv, tag, body] = stored.split(':');
    // The full 16-byte tag, always: GCM accepts shorter ones, which are far easier to forge.
    const tagBytes = Buffer.from(tag || '', 'hex');
    if (tagBytes.length !== 16) throw new Error('The stored certificate password has been altered.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'hex'), { authTagLength: 16 });
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(Buffer.from(body, 'hex')), decipher.final()]).toString('utf8');
}

// —— loading ——————————————————————————————

const hasUpload = () => fs.existsSync(uploadedFile);

function readUpload() {
    if (!hasUpload()) return null;
    return JSON.parse(fs.readFileSync(uploadedFile, 'utf8'));
}

function optionsFrom(stored) {
    return stored.format === 'pem'
        ? { cert: stored.cert, key: stored.key }
        : { pfx: Buffer.from(stored.pfx, 'base64'), passphrase: unseal(stored.passphrase) };
}

/**
 * The certificate to serve. The uploaded one if there is one and it can be
 * read; otherwise the self-signed pair, made here the first time.
 */
async function loadTls() {
    try {
        const stored = readUpload();
        if (stored) return { options: optionsFrom(stored), source: 'uploaded' };
    } catch (err) {
        // A damaged file, or SESSION_SECRET changed since the .pfx password was
        // stored. Serving the self-signed one keeps the portal reachable, so an
        // administrator can sign in and upload it again.
        console.error(`The uploaded certificate cannot be used (${err.message}). Serving the self-signed one.`);
    }
    if (!fs.existsSync(selfSignedCert) || !fs.existsSync(selfSignedKey)) {
        fs.mkdirSync(certDir, { recursive: true });
        console.log('Generating self-signed HTTPS certificate...');
        const selfsigned = require('selfsigned');
        const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 3650 });
        fs.writeFileSync(selfSignedCert, pems.cert);
        fs.writeFileSync(selfSignedKey, pems.private, { mode: 0o600 });
    }
    return {
        options: { cert: fs.readFileSync(selfSignedCert, 'utf8'), key: fs.readFileSync(selfSignedKey, 'utf8') },
        source: 'self-signed',
    };
}

// —— describing one ——————————————————————————

/** The certificate a TLS context would actually present, PEM or PFX alike. */
function leafOf(options) {
    const der = tls.createSecureContext(options).context.getCertificate();
    if (!der) throw new CertificateError('That file holds no certificate.');
    return new crypto.X509Certificate(der);
}

const field = (dn, name) => {
    const line = dn.split('\n').find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1) : '';
};

function describe(options, now = Date.now()) {
    const cert = leafOf(options);
    const validTo = new Date(cert.validTo);
    return {
        subject: field(cert.subject, 'CN') || cert.subject.replace(/\n/g, ', '),
        names: (cert.subjectAltName || '').split(', ')
            .map((n) => n.replace(/^DNS:/, '').replace(/^IP Address:/, '').trim()).filter(Boolean),
        issuer: field(cert.issuer, 'CN') || field(cert.issuer, 'O') || cert.issuer.replace(/\n/g, ', '),
        selfSigned: cert.subject === cert.issuer && cert.verify(cert.publicKey),
        validFrom: new Date(cert.validFrom).toISOString(),
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo.getTime() - now) / DAY),
        fingerprint: cert.fingerprint256,
    };
}

/** True when a browser would accept this certificate for `host`. */
function covers(info, host) {
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    return info.names.some((n) => {
        const name = n.toLowerCase();
        if (name === h) return true;
        if (!name.startsWith('*.')) return false;
        const suffix = name.slice(1);
        return h.endsWith(suffix) && !h.slice(0, -suffix.length).includes('.');
    });
}

/** Worth telling somebody about; none of these stop it being used. */
function warningsFor(info, publicHost) {
    const out = [];
    if (info.daysLeft < 0) out.push('It has expired. Every browser will refuse it until it is replaced.');
    else if (info.daysLeft <= 30) out.push(`It expires in ${info.daysLeft} day${info.daysLeft === 1 ? '' : 's'}. Ask for a new one now.`);
    if (info.selfSigned) {
        out.push('It is self-signed, so browsers will still say "Not secure" until it is trusted on each computer. ' +
            "A certificate from your company's certificate authority avoids that.");
    }
    if (!info.names.length) {
        out.push('It lists no names (no Subject Alternative Name). Current browsers reject a certificate like that.');
    } else if (publicHost && !covers(info, publicHost)) {
        out.push(`It is not issued for ${publicHost}, the address in PORTAL_URL. It covers: ${info.names.join(', ')}. ` +
            'Browsers warn when the name people type is not on the certificate.');
    }
    return out;
}

// —— checking an upload ——————————————————————

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const KEY_BLOCK = /-----BEGIN ((?:RSA |EC |ENCRYPTED )?PRIVATE KEY)-----[\s\S]+?-----END \1-----/g;

function readKey(pem, password) {
    const encrypted = pem.includes('ENCRYPTED');
    if (encrypted && !password) {
        throw new CertificateError('The private key has a password. Type it in the password box and upload again.');
    }
    try {
        return crypto.createPrivateKey(encrypted ? { key: pem, passphrase: password } : pem);
    } catch {
        throw new CertificateError(encrypted ? 'That password does not open the private key.' : 'The private key could not be read.');
    }
}

function fromPem(texts, password) {
    const all = texts.join('\n');
    const certs = [...new Set(all.match(CERT_BLOCK) || [])];
    const keys = [...all.matchAll(KEY_BLOCK)].map((m) => m[0]);
    if (!certs.length) throw new CertificateError('No certificate was found in those files.');
    if (!keys.length) {
        throw new CertificateError('The private key is missing. It is a separate file, usually ending .key or named privkey.pem. ' +
            'Choose it together with the certificate.');
    }
    if (keys.length > 1) throw new CertificateError('Those files hold more than one private key. Choose only the one that belongs to this certificate.');

    const key = readKey(keys[0], password);
    const parsed = certs.map((pem) => {
        try {
            return { pem, x509: new crypto.X509Certificate(pem) };
        } catch {
            throw new CertificateError('One of the certificates in those files is damaged.');
        }
    });
    // The certificate that goes with the key first, then the chain.
    const leaf = parsed.find((c) => c.x509.checkPrivateKey(key));
    if (!leaf) throw new CertificateError('The private key does not belong to that certificate. They have to come from the same request.');
    return {
        cert: [leaf.pem, ...parsed.filter((c) => c !== leaf).map((c) => c.pem)].join('\n') + '\n',
        // Stored without its password: the server opens it alone at every start.
        key: key.export({ type: 'pkcs8', format: 'pem' }),
    };
}

function fromPfx(pfx, password) {
    try {
        tls.createSecureContext({ pfx, passphrase: password });
    } catch (err) {
        if (/mac verify|password|decrypt/i.test(err.message)) {
            throw new CertificateError(password
                ? 'That password does not open the .pfx file.'
                : 'The .pfx file has a password. Type it in the password box and upload again.');
        }
        throw new CertificateError('That file is not a certificate this can read. Use a .pfx or .p12 file, or PEM files (.pem, .crt, .cer, .key).');
    }
    return { pfx, passphrase: password };
}

/**
 * Turns what somebody chose into something the server can use, or says
 * exactly why not. `files` is [{ name, data }] with data in base64.
 */
function prepareUpload(files, password = '', now = Date.now()) {
    if (!Array.isArray(files) || !files.length) throw new CertificateError('Choose the certificate file first.');
    if (files.length > 4) throw new CertificateError('Choose at most four files: the certificate, its key, and the chain.');
    const raw = files.map((f) => Buffer.from(String(f.data || ''), 'base64'));
    if (raw.some((b) => !b.length || b.length > 64 * 1024)) throw new CertificateError('One of those files is empty, or too big to be a certificate.');
    const isPem = raw.map((b) => b.toString('latin1').includes('-----BEGIN '));

    let options;
    if (isPem.every(Boolean)) options = fromPem(raw.map((b) => b.toString('utf8')), password);
    else if (raw.length === 1) options = fromPfx(raw[0], password);
    else throw new CertificateError('A .pfx file already holds the certificate and its key. Choose it on its own.');

    let info;
    try {
        info = describe(options, now);
    } catch (err) {
        if (err instanceof CertificateError) throw err;
        if (/key too small/i.test(err.message)) {
            throw new CertificateError('Its key is too weak. Browsers refuse anything under 2048 bits. Ask for a new certificate.');
        }
        throw new CertificateError(`The certificate and key cannot be used together: ${err.message}`);
    }
    if (info.daysLeft < 0) throw new CertificateError(`That certificate expired on ${info.validTo.slice(0, 10)}.`);
    if (Date.parse(info.validFrom) > now) throw new CertificateError(`That certificate is not valid until ${info.validFrom.slice(0, 10)}.`);
    const bits = leafOf(options).publicKey.asymmetricKeyDetails?.modulusLength;
    if (bits !== undefined && bits < 2048) {
        throw new CertificateError(`Its key is ${bits}-bit. Browsers refuse anything under 2048. Ask for a new certificate.`);
    }
    return { options, info };
}

// —— saving ——————————————————————————————

function saveUpload(options, filenames) {
    const now = new Date().toISOString();
    const stored = options.pfx
        ? { format: 'pfx', pfx: options.pfx.toString('base64'), passphrase: seal(options.passphrase), uploadedAt: now, filenames }
        : { format: 'pem', cert: options.cert, key: options.key, uploadedAt: now, filenames };
    fs.mkdirSync(certDir, { recursive: true });
    const next = `${uploadedFile}.next`;
    fs.writeFileSync(next, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(next, uploadedFile);
}

function removeUpload() {
    fs.rmSync(uploadedFile, { force: true });
}

function uploadDetails() {
    try {
        const s = readUpload();
        return s ? { uploadedAt: s.uploadedAt, filenames: s.filenames } : null;
    } catch {
        return null;
    }
}

// —— the server ——————————————————————————————

let live = null;

/** Puts a certificate on the running server. New connections get it at once. */
function applyLive(options) {
    if (!live) return false;
    live.setSecureContext(options);
    return true;
}

function redirect(req, res) {
    const host = req.headers.host || '';
    if (!/^[A-Za-z0-9.\-[\]:]{1,300}$/.test(host)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('This address only answers over HTTPS.\n');
        return;
    }
    // 307: temporary, so a browser does not remember it for ever, and Windows
    // PowerShell 5.1 follows it, which a 308 it does not.
    res.writeHead(307, { location: `https://${host}${req.url || '/'}` });
    res.end();
}

/**
 * An HTTPS server that also answers plain http:// on the same port, with a
 * redirect to https:// instead of a connection that drops with no reason
 * given. A TLS connection starts with a handshake record, first byte 0x16;
 * an HTTP request starts with a letter. That byte decides, and is put back
 * before either server reads it.
 */
function createServer(options, app) {
    const secure = https.createServer(options, app);
    const plain = http.createServer(redirect);
    const startTls = secure.listeners('connection');
    secure.removeAllListeners('connection');
    secure.on('connection', (socket) => {
        socket.setTimeout(30000, () => socket.destroy());
        socket.once('readable', () => {
            socket.setTimeout(0);
            const first = socket.read(1);
            if (!first) return socket.destroy();
            socket.unshift(first);
            if (first[0] === 0x16) startTls.forEach((l) => l.call(secure, socket));
            else plain.emit('connection', socket);
        });
    });
    live = secure;
    secure.on('close', () => { if (live === secure) live = null; });
    return secure;
}

module.exports = {
    CertificateError, applyLive, certDir, createServer, describe, hasUpload, loadTls,
    prepareUpload, removeUpload, saveUpload, uploadDetails, warningsFor,
};
