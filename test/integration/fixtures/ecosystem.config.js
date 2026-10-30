// increment_var gives each cluster instance its own port, which is what makes
// per-instance HTTP probing possible. Without it the cluster guard refuses the app.
module.exports = {
  apps: [{
    name: 'probe-fixture',
    script: './app.js',
    instances: 2,
    exec_mode: 'cluster',
    increment_var: 'PORT',
    env: { PORT: 3100 }
  }]
};
