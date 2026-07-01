import { Events } from 'discord.js';
import type { Guild } from 'discord.js';
import { prisma } from '../lib/prisma.js';
import { createLogger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

const log = createLogger('GuildCreate');

// ─── Guild Create ───────────────────────────────────────────────────────────
// Registers a guild row the moment Quill joins it, so the admin dashboard
// and suspension checks always have an up-to-date row to work against.

const event: BotEvent = {
    name: Events.GuildCreate,
    once: false,
    async execute(...args) {
        const guild = args[0] as Guild;

        try {
            await prisma.guild.upsert({
                where: { id: guild.id },
                update: { name: guild.name },
                create: { id: guild.id, name: guild.name },
            });

            log.info(`Registered guild ${guild.name} (${guild.id}).`);
        } catch (err) {
            log.error(`Failed to register guild ${guild.name} (${guild.id}):`, err);
        }
    },
};

export default event;