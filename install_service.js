const Service = require('node-windows').Service;
const path = require('path');

// Where the portal keeps what it owns: the database, the sessions, the
// uploaded certificates, its own HTTPS certificate and the logs.
//
// Not beside the code in Program Files, where it used to be. That folder is
// meant to be re-installable: an uninstall or a repair can empty it, backup
// tools skip it, and hardened machines refuse writes to it. Every training
// record the portal holds was sitting there.
//
// The service is told these paths directly as well as through .env, so a
// machine upgraded from an older copy still starts in the right place even if
// its .env was written before this existed.
const dataDir =
  process.env.PORTAL_DATA_DIR ||
  path.join(process.env.ProgramData || 'C:\\ProgramData', 'Offset Security', 'ISO Training Portal');

// Before anything is written there: the data folder and the settings file are
// for Windows and administrators only. See secure_folders.js.
for (const target of require('./secure_folders').lockDown(dataDir, __dirname)) {
  console.log('Restricted to administrators: ' + target);
}

const svc = new Service({
  name: 'ISO Training Portal',
  description: 'Offset Aware - security awareness training for every employee.',
  script: path.join(__dirname, 'server.js'),
  env: [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'DB_PATH', value: path.join(dataDir, 'database.sqlite') },
    { name: 'UPLOADS_DIR', value: path.join(dataDir, 'uploads') },
    { name: 'CERT_DIR', value: path.join(dataDir, 'certs') },
    { name: 'LOG_DIR', value: path.join(dataDir, 'logs') },
  ],
});

// Listen for the "install" event, which indicates the
// process is available as a service.
svc.on('install', function() {
  svc.start();
  console.log('Offset Aware service installed and started.');
  console.log('Data folder: ' + dataDir);
});

// Just in case this file is run twice.
svc.on('alreadyinstalled', function() {
  console.log('This service is already installed.');
});

svc.on('start', function() {
  console.log(svc.name + ' started!\n');
});

svc.on('error', function(err) {
  console.error('Error in service: ', err);
});

// Install the script as a service
console.log('Installing service...');
svc.install();
