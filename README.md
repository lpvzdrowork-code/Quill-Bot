# Quill

A server-authoritative Discord moderation bot built with TypeScript, discord.js v14, and Prisma on PostgreSQL.

## Features

- Slash command moderation suite — ban, kick, warn, timeout, and their reversal commands
- Persistent audit log — every moderation action is written to a PostgreSQL database
- Structured channel logging — separate channels for moderation actions, member join/leave, and bot errors
- Moderator hierarchy enforcement — mods cannot action members with an equal or higher role
- DM notifications — targets are messaged before the action fires
- Graceful shutdown and unhandled rejection guard

## Commands

| Command | Permission | Description |
|---|---|---|
| `/ban` | Ban Members | Bans a member. Optionally deletes up to 7 days of messages. |
| `/unban` | Ban Members | Unbans a user by ID. |
| `/softban` | Ban Members | Bans then immediately unbans a member, wiping their last 7 days of messages. |
| `/kick` | Kick Members | Kicks a member from the server. |
| `/timeout` | Moderate Members | Times out a member for a set duration. |
| `/untimeout` | Moderate Members | Removes an active timeout. |
| `/warn` | Moderate Members | Issues a warning and records it to the database. |
| `/warnings` | Moderate Members | Lists all warnings on record for a member. |
| `/clearwarns` | Moderate Members | Removes a specific warning or all warnings for a member. |
| `/modlogs` | Moderate Members | Shows the last 5 bans, kicks, timeouts, and warnings for a member. |
| `/purge` | Manage Messages | Bulk-deletes up to 100 messages. Optionally filter by user. |
| `/slowmode` | Manage Channels | Sets the slowmode delay for the current channel (0 to disable). |
| `/lock` | Manage Channels | Locks or unlocks a channel for the everyone role. |
| `/ping` | — | Latency check. |

## Project Structure

```
src/
├── index.ts              # Entry point — env validation, boot sequence
├── deploy.ts             # Standalone command deploy script
├── client.ts             # Discord client singleton
├── config.ts             # Typed config (colors, meta, channel IDs)
├── commands/
│   ├── moderation/       # All moderation slash commands
│   └── testing/          # Dev/testing commands
├── events/               # Discord event handlers
├── utils/
│   ├── commandLoader.ts  # Recursively loads and registers commands
│   ├── eventLoader.ts    # Dynamically loads event handlers
│   ├── channelLogger.ts  # Sends embeds to configured log channels
│   ├── embeds.ts         # Embed factory (modAction, memberJoin, etc.)
│   └── logger.ts         # Leveled console logger with color output
├── lib/
│   └── prisma.ts         # Prisma client singleton
├── types/
│   └── index.ts          # Shared types (QuillClient, BotCommand, etc.)
└── generated/
    └── prisma/           # Auto-generated Prisma client (do not edit)

prisma/
├── schema.prisma         # DB schema — Warn, Timeout, Ban, Kick models
└── migrations/           # Migration history
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the template below into a `.env` file at the project root:

```env
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=
MOD_LOG_CHANNEL=
BOT_LOG_CHANNEL=
MEMBER_LOG_CHANNEL=
DATABASE_URL=
LOG_LEVEL=INFO
```

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
| `CLIENT_ID` | Application ID from the Developer Portal |
| `GUILD_ID` | Your server's ID (used for guild-scoped command deployment) |
| `MOD_LOG_CHANNEL` | Channel ID for moderation action logs |
| `BOT_LOG_CHANNEL` | Channel ID for bot errors and events |
| `MEMBER_LOG_CHANNEL` | Channel ID for member join/leave logs |
| `DATABASE_URL` | PostgreSQL connection string |
| `LOG_LEVEL` | Console log verbosity: `DEBUG`, `INFO`, `WARN`, or `ERROR` (default: `INFO`) |

### 3. Run database migrations

```bash
npx prisma migrate deploy
```

### 4. Deploy slash commands

```bash
npm run deploy
```

### 5. Start the bot

```bash
# Normal start
npm run dev

# Deploy commands then start (use when you've added or changed commands)
npm run dev:fresh
```

Production (compile first, then run):
```bash
npm run build
npm start
```

## Database Models

| Model | Purpose |
|---|---|
| `Warn` | Warning records per user per guild |
| `Timeout` | Timeout history; `endedAt` is set when manually removed via `/untimeout` |
| `Ban` | Ban history including days of messages deleted (also used by `/softban`) |
| `Kick` | Kick history |

## Adding a Command

1. Create a new file under `src/commands/<category>/<name>.ts`
2. Export a default object matching the `BotCommand` interface from `src/types/index.ts`
3. The command loader picks it up automatically on next boot — no registration needed
4. Run `npm run dev:fresh` to deploy the new command and start the bot
