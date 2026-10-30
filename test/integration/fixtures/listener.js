// Stands in for a consumer (pm2-alertmanager): proves the wire contract crosses
// the process boundary via the PM2 bus.
const pm2 = require('pm2');

pm2.connect(err => {
  if (err) { console.error('[listener] connect failed', err); process.exit(1); }
  pm2.launchBus((err, bus) => {
    if (err) { console.error('[listener] launchBus failed', err); process.exit(1); }
    console.log('[listener] subscribed');
    bus.on('pm2-liveness:status', m => {
      console.log('[listener] EVENT ' + JSON.stringify(m.data));
    });
  });
});
