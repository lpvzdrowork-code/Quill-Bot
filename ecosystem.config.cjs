module.exports = {
  apps: [
    {
      name: "Quill-Bot",
      // Runs the same code as `npm run dev` (TypeScript via tsx, no watch mode),
      // so no build/compile step is required — pm2 always runs whatever is
      // currently in src/, not a possibly-stale dist/ build.
      script: "node",
      args: "--import tsx src/index.ts",
      // Resolve relative to this file so the config works from wherever the
      // project lives, instead of a hardcoded machine-specific path.
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
