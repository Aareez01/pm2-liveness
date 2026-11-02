const { join } = require('path');
module.exports = {
  apps: [{
    name: 'api',
    script: join(__dirname, 'app.js'),
    cwd: __dirname,
    instances: 2,
    exec_mode: 'cluster',
    increment_var: 'PORT',   // each instance gets its own port
    env: { PORT: 3000 }
  }]
};
