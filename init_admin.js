const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');

// DB_PATH is where the database really lives: C:\ProgramData\... on Windows,
// /data on Docker. Only a copy installed before that change keeps it beside
// the code, which is why the fallback is still here.
const fs = require('fs');
const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, 'database.sqlite'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new sqlite3.Database(dbPath);

const adminId = process.argv[2];
const adminName = process.argv[3];
const adminEmail = process.argv[4];
const adminPassword = process.argv[5];
const port = process.argv[6];

if (!adminId || !adminName || !adminEmail || !adminPassword || !port) {
    console.error("Usage: node init_admin.js <admin_id> <admin_name> <admin_email> <admin_password> <port>");
    process.exit(1);
}

db.serialize(() => {
    // 0. Ensure tables exist
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        emp_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'employee'
    )`);

    // 1. Store Port in a config/settings table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('port', ?)`, [port]);

    // 2. Clear old admins and insert new admin
    db.run(`DELETE FROM users WHERE role = 'admin' OR role = 'super_admin' OR emp_id = ?`, [adminId]);
    
    const hash = bcrypt.hashSync(adminPassword, 10);
    db.run(`INSERT INTO users (emp_id, name, email, password, role) VALUES (?, ?, ?, ?, 'admin')`, 
        [adminId, adminName, adminEmail, hash], function(err) {
        if (err) {
            console.error("Failed to insert admin:", err);
            process.exit(1);
        } else {
            console.log("Admin account successfully created.");
            db.close();
        }
    });
});
