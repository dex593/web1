module.exports = {
  apps: [
    {
      name: "moetruyen-web",
      cwd: __dirname,
      script: "server.js",
      interpreter: "bun",
      exec_mode: "cluster",
      instances: "max",
      autorestart: true,
      watch: false,
      time: true,
      env: {
        NODE_ENV: process.env.NODE_ENV || "production",
        APP_ENV: process.env.APP_ENV || "production",
        DISABLE_STARTUP_PROGRESS: "1"
      },
      env_production: {
        NODE_ENV: "production",
        APP_ENV: "production",
        DISABLE_STARTUP_PROGRESS: "1"
      }
    }
  ]
};
