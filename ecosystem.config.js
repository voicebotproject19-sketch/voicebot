/**
 * PM2 ecosystem configuration
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 start ecosystem.config.js --env production
 */
function resolvePm2Instances(value) {
  const raw = String(value || '1').trim().toLowerCase();
  if (raw === 'max') return 'max';
  if (!/^\d+$/.test(raw)) return 1;
  return Math.max(Number.parseInt(raw, 10), 1);
}

const pm2Instances = resolvePm2Instances(process.env.PM2_INSTANCES);
const pm2ClusterMode = pm2Instances === 'max' || pm2Instances > 1;

module.exports = {
  apps: [
    {
      name: 'voicebot',
      script: 'app.js',
      instances: pm2Instances,
      exec_mode: pm2ClusterMode ? 'cluster' : 'fork',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: 4000,
        VOICEBOT_CLUSTER_MODE: pm2ClusterMode ? 'true' : 'false',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
        VOICEBOT_CLUSTER_MODE: pm2ClusterMode ? 'true' : 'false',
      },
      // Graceful shutdown — wait for active WS connections to drain
      kill_timeout: 5000,
      listen_timeout: 10000,
      // Restart policy
      max_restarts: 10,
      restart_delay: 1000,
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Watch is disabled in production (use PM2 reload for zero-downtime deploys)
      watch: false,
    },
  ],
};
