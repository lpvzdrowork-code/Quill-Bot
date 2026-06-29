import { Client, Events } from 'discord.js';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createLogger } from './logger.js';

const log = createLogger('EventLoader');

// ─── Event Definition ─────────────────────────────────────────────────────────
// Every file in /events must export a default object matching this shape.
//
// Example event file (src/events/ready.ts):
//
//   import { Events } from 'discord.js';
//   import type { BotEvent } from '../utils/eventLoader.js';
//
//   const event: BotEvent = {
//       name: Events.ClientReady,
//       once: true,
//       execute(...args) {
//           const client = args[0];
//           console.log(`Logged in as ${client.user.tag}`);
//       },
//   };
//
//   export default event;

export interface BotEvent {
    name: string;        // The Discord.js event name (e.g. Events.ClientReady)
    once?: boolean;      // If true, the handler fires only once then unregisters
    execute(...args: unknown[]): void | Promise<void>;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loadEvents(client: Client): Promise<void> {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const eventsPath = join(__dirname, '..', 'events');

    let files: string[];

    try {
        files = readdirSync(eventsPath).filter(f => f.endsWith('.js') || f.endsWith('.ts'));
    } catch {
        log.warn('No /events directory found or it is empty. Skipping event loading.');
        return;
    }

    if (files.length === 0) {
        log.warn('No event files found in /events. Skipping event loading.');
        return;
    }

    let loaded = 0;

    for (const file of files) {
        const filePath = join(eventsPath, file);
        const fileUrl  = pathToFileURL(filePath).href;

        try {
            const module = await import(fileUrl) as { default?: BotEvent };
            const event  = module.default;

            if (!event || typeof event.name !== 'string' || typeof event.execute !== 'function') {
                log.warn(`Skipping ${file} — missing or invalid default export.`);
                continue;
            }

            if (event.once) {
                client.once(event.name, (...args) => void event.execute(...args));
            } else {
                client.on(event.name, (...args) => void event.execute(...args));
            }

            log.debug(`Registered event: ${event.name} (${event.once ? 'once' : 'on'}) ← ${file}`);
            loaded++;

        } catch (err) {
            log.error(`Failed to load event file ${file}:`, err);
        }
    }

    log.info(`Loaded ${loaded}/${files.length} event(s).`);
}
