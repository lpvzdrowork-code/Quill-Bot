// ─── deploy.ts ────────────────────────────────────────────────────────────────
// Deploys all slash commands to Discord — globally, so every server Quill is
// invited to gets the commands automatically, with no per-guild setup step.
//
//   node --import ./register.mjs src/deploy.ts
//
// Global propagation can take up to ~1 hour to reach every guild (Discord
// caches the command list client-side). This is a one-time wait per rollout,
// not per-guild — once it's live it's live everywhere, including servers
// Quill joins afterward.

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
// Always global — Quill is a public, multi-server bot. A guild-scoped deploy
// path previously existed here (gated on GUILD_ID) but meant commands never
// reached any server other than one hardcoded ID, which is exactly the bug
// this fix addresses. If you need faster iteration while developing locally,
// temporarily swap applicationCommands(clientId) below for
// applicationGuildCommands(clientId, yourTestGuildId) — guild-scoped deploys
// are instant — but never ship that swap; revert before deploying for real.

const rest = new REST().setToken(token);

await rest.put(Routes.applicationCommands(clientId), { body: commands });
log.info(`Deployed ${commands.length} command(s) globally. This can take up to ~1 hour to reach every server.`);
