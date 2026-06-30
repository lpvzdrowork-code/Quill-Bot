import { REST, Routes } from 'discord.js';
import { readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { client } from '../client.js';
import { createLogger } from './logger.js';
import type { BotCommand } from '../types/index.js';

const log = createLogger('CommandLoader');

// ─── File Collection ──────────────────────────────────────────────────────────
// Recursively collects all .ts/.js command files from /commands and any
// subdirectories (e.g. commands/moderation/, commands/testing/).

function collectCommandFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat     = statSync(fullPath);

        if (stat.isDirectory()) {
            files.push(...collectCommandFiles(fullPath));
        } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
            files.push(fullPath);
        }
    }

    return files;
}

// ─── Load Commands ────────────────────────────────────────────────────────────
// Scans /commands and all subdirectories, imports each file, validates the
// export, and registers it onto client.commands keyed by name.

export async function loadCommands(): Promise<void> {
    const __dirname  = dirname(fileURLToPath(import.meta.url));
    const commandsPath = join(__dirname, '..', 'commands');

    let files: string[];

    try {
        files = collectCommandFiles(commandsPath);
    } catch {
        log.warn('No /commands directory found or it is empty. Skipping command loading.');
        return;
    }

    if (files.length === 0) {
        log.warn('No command files found in /commands. Skipping command loading.');
        return;
    }

    let loaded = 0;

    for (const filePath of files) {
        const fileUrl = pathToFileURL(filePath).href;
        // Show category/filename in logs e.g. "moderation/ban.ts"
        const label   = filePath.replace(/\\/g, '/').split('/commands/')[1] ?? filePath;

        try {
            const module  = await import(fileUrl) as { default?: BotCommand };
            const command = module.default;

            if (!command || !command.data || typeof command.execute !== 'function') {
                log.warn(`Skipping ${label} — missing or invalid default export.`);
                continue;
            }

            // Derive category from the subfolder it was loaded from, e.g.
            // "moderation/ban.ts" -> "moderation". Commands sitting directly in
            // /commands with no subfolder fall back to "general". Used by /help
            // to group commands without a hardcoded, manually-maintained list.
            const [first, ...rest] = label.split('/');
            command.category = rest.length > 0 ? first : 'general';

            client.commands.set(command.data.name, command);
            log.debug(`Registered command: /${command.data.name} ← ${label}`);
            loaded++;

        } catch (err) {
            log.error(`Failed to load command file ${label}:`, err);
        }
    }

    log.info(`Loaded ${loaded}/${files.length} command(s).`);
}

// ─── Deploy Commands ──────────────────────────────────────────────────────────
// Pushes all loaded commands to Discord's API so they appear in the slash menu.
// Guild deploy is instant (dev), global deploy takes up to 1 hour (production).

export async function deployCommands(): Promise<void> {
    const token    = process.env.DISCORD_TOKEN;
    const clientId = process.env.CLIENT_ID;
    const guildId  = process.env.GUILD_ID;

    if (!token || !clientId) {
        log.error('Missing DISCORD_TOKEN or CLIENT_ID in .env. Cannot deploy commands.');
        return;
    }

    const commands = [...client.commands.values()].map(cmd => cmd.data.toJSON());

    if (commands.length === 0) {
        log.warn('No commands to deploy.');
        return;
    }

    const rest = new REST().setToken(token);

    try {
        if (guildId) {
            await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
            log.info(`Deployed ${commands.length} command(s) to guild ${guildId}.`);
        } else {
            await rest.put(Routes.applicationCommands(clientId), { body: commands });
            log.info(`Deployed ${commands.length} command(s) globally.`);
        }
    } catch (err) {
        log.error('Failed to deploy commands:', err);
    }
}
