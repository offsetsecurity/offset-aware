const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// The portal's settings live in .env beside this file, and that is where the
// database path is written. This script used to ignore it and look for
// database.sqlite next to itself - which is where the database was before the
// records moved to ProgramData. Pointed at the wrong place, sqlite3 does not
// fail: it quietly creates a brand-new empty database there, and the script
// then reports "No Admin account found". Anyone locked out would conclude
// their administrator had been deleted.
//
// Not overriding what is already set: inside the Docker image DB_PATH is set
// for real, and there is no .env.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

// DB_PATH is set inside the Docker image, where the database is on a volume.
const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, 'database.sqlite'));

// Never create a database from here. If it is not where it should be, say so.
if (!fs.existsSync(dbPath)) {
    console.error(`\nError: no portal database was found at:\n  ${dbPath}\n`);
    console.error('Nothing was changed. Check DB_PATH in the .env file beside this script.');
    process.exit(1);
}

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
        console.error(`\nError: could not open the database at ${dbPath}`);
        console.error(`  ${err.message}`);
        console.error('\nThis needs to be run as an administrator.');
        process.exit(1);
    }
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('Enter the Admin Employee ID you want to reset: ', (empId) => {
    rl.question('Enter the NEW password (min 12 chars): ', (newPassword) => {
        if (newPassword.length < 12) {
            console.error("\nError: Password must be at least 12 characters.");
            process.exit(1);
        }

        const hash = bcrypt.hashSync(newPassword, 10);
        db.run("UPDATE users SET password = ? WHERE emp_id = ? AND role = 'admin'", [hash, empId], function(err) {
            if (err) {
                console.error("\nDatabase error:", err);
            } else if (this.changes === 0) {
                console.log("\nError: No Admin account found with that Employee ID.");
            } else {
                console.log(`\nSUCCESS! The password for Admin '${empId}' has been reset.`);
                console.log("You may now log in to the web dashboard with your new password.");
            }
            process.exit(0);
        });
    });
});
