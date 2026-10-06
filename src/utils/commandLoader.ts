import { pathToFileURL } from 'url';
import { client } from '../client.js';
import { createLogger } from './logger.js';
import { collectCommandFiles, COMMANDS_DIR } from './commandFiles.js';
import type { BotCommand } from '../types/index.js';

const log = createLogger('CommandLoader');

// ─── Load Commands ────────────────────────────────────────────────────────────
// Scans /commands and all subdirectories (file discovery lives in
// commandFiles.ts, shared with deploy.ts), imports each file, validates the
// export, and registers it onto client.commands keyed by name.

export async function loadCommands(): Promise<void> {
    let files: string[];

    try {
        files = collectCommandFiles(COMMANDS_DIR);
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
