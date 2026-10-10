const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object
const svc = new Service({
  name: 'ISO Training Portal',
  description: 'Offset Aware - security awareness training for every employee.',
  script: path.join(__dirname, 'server.js')
});

// Listen for the "uninstall" event so we know when it's done.
svc.on('uninstall', function() {
  console.log('Uninstall complete.');
  console.log('The service exists: ', svc.exists);
});

// Uninstall the service.
svc.uninstall();
