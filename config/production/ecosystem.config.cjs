const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = {
  cwd: root, script: path.join(root, 'scripts/start-production-service.sh'),
  interpreter: '/bin/bash', instances: 1, exec_mode: 'fork', autorestart: true,
  exp_backoff_restart_delay: 1000, kill_timeout: 30000, time: true,
};
module.exports = { apps: [
  { ...base, name: 'agentscore-api', args: 'api' },
] };
