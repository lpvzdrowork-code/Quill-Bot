// ─── deploy.ts ────────────────────────────────────────────────────────────────
// Deploys all slash commands to Discord.
// Run this manually whenever you add, remove, or change a command:
//
//   node --import ./register.mjs src/deploy.ts
//
// Guild deploy is instant. Remove GUILD_ID from .env to deploy globally
// (global deploy takes up to 1 hour to propagate).

import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createLogger } from './utils/logger.js';
import type { BotCommand } from './types/index.js';

const log = createLogger('Deploy');

const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId  = process.env.GUILD_ID;

if (!token || !clientId) {
    log.error('Missing DISCORD_TOKEN or CLIENT_ID in .env. Aborting.');
    process.exit(1);
}

// ─── Collect command files ────────────────────────────────────────────────────

function collectFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];

    for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            files.push(...collectFiles(full));
        } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
            files.push(full);
        }
    }

    return files;
}

const __dirname  = dirname(fileURLToPath(import.meta.url));
const commandsPath = join(__dirname, 'commands');
const files      = collectFiles(commandsPath);
const commands   = [];

for (const filePath of files) {
    const module  = await import(pathToFileURL(filePath).href) as { default?: BotCommand };
    const command = module.default;

    if (command?.data && typeof command.execute === 'function') {
        commands.push(command.data.toJSON());
        log.debug(`Queued: /${command.data.name}`);
    }
}

// ─── Deploy ───────────────────────────────────────────────────────────────────

const rest = new REST().setToken(token);

if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    log.info(`Deployed ${commands.length} command(s) to guild ${guildId}.`);
} else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    log.info(`Deployed ${commands.length} command(s) globally.`);
}
