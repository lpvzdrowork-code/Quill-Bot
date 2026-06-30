import { Events } from 'discord.js';
import type { Guild } from 'discord.js';
import { prisma } from '../lib/prisma.js';
import { createLogger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

const log = createLogger('GuildUpdate');

// ─── Guild Update ───────────────────────────────────────────────────────────
// Keeps the cached guild name in sync when a server is renamed, so the admin
// dashboard doesn't show a stale name indefinitely.

const event: BotEvent = {
    name: Events.GuildUpdate,
    once: false,
    async execute(...args) {
        const [oldGuild, newGuild] = args as [Guild, Guild];

        if (oldGuild.name === newGuild.name) return;

        await prisma.guild.update({
            where: { id: newGuild.id },
            data:  { name: newGuild.name },
        }).catch(() => {
            // Row may not exist yet if this guild predates guildCreate/backfill.
            log.warn(`Tried to rename guild ${newGuild.id} but no row exists yet.`);
        });

        log.info(`Updated cached name for guild ${newGuild.id}: "${oldGuild.name}" → "${newGuild.name}".`);
    },
};

export default event;