module.exports = {
  apps: [{
    name: 'claude-code-ui',
    script: 'server/index.js',
    cwd: '/media/my/claudecodeui',
    interpreter: '/root/.nvm/versions/node/v24.13.0/bin/node',
    env: {
      NODE_ENV: 'production',
      IS_SANDBOX: '1',
      // Cluster configuration - Master mode
      DEPLOYMENT_MODE: 'master',
      CLUSTER_SECRET: 'T4zCtdHamPVcTEAaODD3AAWxiJqC2XMR'
    },
    restart_delay: 3000,
    max_restarts: 10
  }]
};
