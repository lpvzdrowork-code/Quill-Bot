module.exports = {
  apps: [
    {
      name: "Quill-Bot",
      // Runs the exact same command as `npm run dev` (ts-node via register.mjs),
      // so no build/compile step is required — pm2 always runs whatever is
      // currently in src/, not a possibly-stale dist/ build.
      script: "node",
      args: "--import ./register.mjs src/index.ts",
      cwd: "C:\\Users\\Dominic Maculitis\\Documents\\Quill_DiscordBot",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
