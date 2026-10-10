// Closes Aware's data folder and its settings file to everybody on the server
// except Windows itself and administrators.
//
// The data folder holds the staff list, the password hashes, the live sign-in
// sessions and the private key of the HTTPS certificate. The settings file
// (.env) holds the secret that signs the sign-in cookie. ProgramData and
// Program Files both let every local user read what is put in them, so left
// alone, anybody with an ordinary account on the server could copy all of it.
//
// The service runs as Windows itself (LocalSystem), so it is unaffected.
//
// Run by install_service.js and by the installer; safe to run again:
//   node secure_folders.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Written as identifiers, not names, so this works on a Windows in any language.
const SYSTEM = '*S-1-5-18';
const ADMINISTRATORS = '*S-1-5-32-544';
// Anything earlier versions, or Windows' own defaults, may have let in.
const EVERYBODY_ELSE = ['*S-1-5-32-545', '*S-1-5-11', '*S-1-1-0', '*S-1-5-4', '*S-1-3-0'];

function icacls(args) {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    execFileSync(exe, args, { stdio: 'ignore', windowsHide: true });
}

/** Leaves `target` open to `who` and nobody else. A folder passes that on to all it holds. */
function lock(target, who = [SYSTEM, ADMINISTRATORS]) {
    if (process.platform !== 'win32' || !fs.existsSync(target)) return false;
    const folder = fs.statSync(target).isDirectory();
    icacls([target, '/inheritance:r',
        ...who.flatMap((sid) => ['/grant:r', sid + (folder ? ':(OI)(CI)F' : ':F')]),
        ...EVERYBODY_ELSE.filter((sid) => !who.includes(sid)).flatMap((sid) => ['/remove', sid])]);
    if (folder && fs.readdirSync(target).length) {
        // What is already inside takes its permissions from the folder from now on.
        try { icacls([path.join(target, '*'), '/reset', '/T', '/C', '/Q']); } catch (e) { /* a file in use keeps what it had until the next run */ }
    }
    return true;
}

function dataFolder() {
    return process.env.PORTAL_DATA_DIR
        || path.join(process.env.ProgramData || 'C:\\ProgramData', 'Offset Security', 'ISO Training Portal');
}

/** The data folder and the settings file. Says what it did; never stops an install. */
function lockDown(dataDir = dataFolder(), appDir = __dirname) {
    const done = [];
    for (const target of [dataDir, path.join(appDir, '.env')]) {
        try { if (lock(target)) done.push(target); } catch (e) { console.error('Could not restrict ' + target + ': ' + e.message); }
    }
    return done;
}

module.exports = { lock, lockDown, dataFolder, SYSTEM, ADMINISTRATORS };

if (require.main === module) {
    for (const target of lockDown()) console.log('Restricted to administrators: ' + target);
}
