module.exports = {
  apps: [
    {
      name: 'wakemate-backend',
      script: 'server.js',
      cwd: 'C:/Users/shint/Projects/APK-ALARM/backend',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        PORT: 4000
      }
    },
    {
      name: 'wakemate-tunnel',
      script: 'C:/Program Files (x86)/cloudflared/cloudflared.exe',
      args: 'tunnel run --url http://127.0.0.1:4000 wakemate-alarm',
      interpreter: 'none',
      cwd: 'C:/Users/shint/Projects/APK-ALARM',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000
    }
  ]
};
