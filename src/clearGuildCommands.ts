// ─── clearGuildCommands.ts ────────────────────────────────────────────────────
// One-off cleanup: removes GUILD-scoped slash commands for Quill in one or more
// servers, leaving the GLOBAL commands (what deploy.ts pushes) untouched.
//
// Why this exists: an older deploy.ts registered commands per guild (via
// GUILD_ID). deploy.ts is global-only now, but Discord keeps the old guild
// commands until they're explicitly deleted. In that guild, the picker then
// shows every command twice — once global, once guild-scoped.
//
//   npm run deploy:clear-guild -- <guildId> [<guildId> ...]
//
// With no arguments it falls back to GUILD_ID from .env.

import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('ClearGuildCommands');

const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
    log.error('Missing DISCORD_TOKEN or CLIENT_ID in .env. Aborting.');
    process.exit(1);
}

const argIds   = process.argv.slice(2).filter(a => /^\d{15,25}$/.test(a));
const guildIds = argIds.length > 0 ? argIds : (process.env.GUILD_ID ? [process.env.GUILD_ID] : []);

if (guildIds.length === 0) {
    log.error('No guild ID given. Usage: npm run deploy:clear-guild -- <guildId>');
    process.exit(1);
}

const rest = new REST().setToken(token);

for (const guildId of guildIds) {
    try {
        const existing = await rest.get(Routes.applicationGuildCommands(clientId, guildId)) as unknown[];
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
        log.info(`Cleared ${existing.length} guild-scoped command(s) in ${guildId}. Global commands untouched.`);
    } catch (err) {
        log.error(`Failed to clear guild commands in ${guildId}:`, err);
    }
}
