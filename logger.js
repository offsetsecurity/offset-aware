const fs = require('fs');
const path = require('path');

// LOG_DIR lets Docker keep the logs on its data volume.
const logsDir = path.resolve(process.env.LOG_DIR || path.join(__dirname, 'logs'));
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Touch the files so they exist immediately for IT Admins to see
const runtimeFile = path.join(logsDir, 'runtime.log');
const smtpFile = path.join(logsDir, 'smtp.log');
if (!fs.existsSync(runtimeFile)) fs.writeFileSync(runtimeFile, '');
if (!fs.existsSync(smtpFile)) fs.writeFileSync(smtpFile, '');

function getTimestamp() {
    // Returns timestamp in format: YYYY-MM-DD HH:mm:ss
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
}

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
// Total-size budget for the whole logs/ folder: the two live logs plus one
// archive (2 + 1 = 3 files of MAX_LOG_SIZE). Older archives are purged first.
const MAX_LOGS_DIR_SIZE = 3 * MAX_LOG_SIZE; // 15 MB

// Keep the logs/ folder under MAX_LOGS_DIR_SIZE by deleting the oldest *.old.log
// archives first. Live *.log files are never deleted. Runs at startup and after
// each rotation, so these synchronous fs calls are infrequent.
function enforceLogsBudget() {
    try {
        const files = fs.readdirSync(logsDir)
            .map((name) => {
                const full = path.join(logsDir, name);
                const stats = fs.statSync(full);
                return { full, name, size: stats.size, mtime: stats.mtimeMs, isFile: stats.isFile() };
            })
            .filter((f) => f.isFile);

        let total = files.reduce((sum, f) => sum + f.size, 0);
        if (total <= MAX_LOGS_DIR_SIZE) return;

        const archives = files
            .filter((f) => f.name.endsWith('.old.log'))
            .sort((a, b) => a.mtime - b.mtime); // oldest first

        for (const archive of archives) {
            if (total <= MAX_LOGS_DIR_SIZE) break;
            try {
                fs.unlinkSync(archive.full);
                total -= archive.size;
                console.log(`[logger] Purged archive over budget: ${archive.name}`);
            } catch (e) { /* ignore individual delete failures */ }
        }
    } catch (e) {
        console.error('[logger] Failed to enforce logs budget:', e.message);
    }
}

// On startup, purge old archives if the logs folder is already over budget.
// (Must run after the constants and function above are initialized.)
enforceLogsBudget();

function writeLog(filename, level, message, meta = null) {
    const logFile = path.join(logsDir, filename);
    
    let metaStr = '';
    if (meta) {
        if (meta instanceof Error) {
            metaStr = `\nStack Trace:\n${meta.stack}`;
        } else if (typeof meta === 'object') {
            metaStr = `\nMetadata: ${JSON.stringify(meta, null, 2)}`;
        } else {
            metaStr = ` - ${meta}`;
        }
    }
    
    // A name or an address somebody typed can end up in a message. Line breaks
    // in it are flattened, so nobody can write a log line of their own.
    message = String(message).replace(/[\r\n]+/g, ' ');
    const logLine = `[${getTimestamp()}] [${level.toUpperCase()}] ${message}${metaStr}\n`;
    
    // Print to standard console so it still appears in the daemon logs if needed
    if (level === 'error') {
        console.error(`[${filename}] ${message}`);
    } else {
        console.log(`[${filename}] ${message}`);
    }

    // Auto-Purge / Log Rotation logic
    fs.stat(logFile, (err, stats) => {
        if (!err && stats.size > MAX_LOG_SIZE) {
            const archiveFile = path.join(logsDir, filename.replace('.log', '.old.log'));
            // Rename current to .old (overwriting any previous archive), then write new line
            fs.rename(logFile, archiveFile, () => {
                fs.appendFile(logFile, logLine, () => {});
                enforceLogsBudget();
            });
        } else {
            fs.appendFile(logFile, logLine, (err) => {
                if (err) console.error(`CRITICAL: Failed to write to log file ${filename}:`, err);
            });
        }
    });
}

module.exports = {
    logRuntime: (level, message, meta = null) => writeLog('runtime.log', level, message, meta),
    logSmtp: (level, message, meta = null) => writeLog('smtp.log', level, message, meta)
};
