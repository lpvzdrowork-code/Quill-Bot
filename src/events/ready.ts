import { Events } from 'discord.js';
import { client } from '../client.js';
import { logger } from '../utils/logger.js';
import { setBotStatus } from '../utils/botStatus.js';
import { prisma } from '../lib/prisma.js';
import type { BotEvent } from '../utils/eventLoader.js';

// ─── Guild Reconciliation ───────────────────────────────────────────────────
// guildCreate only fires for NEW joins. If it's ever missed for any reason
// (bot restarted mid-join, transient DB error, a gap like the one that shipped
// before the Guild table existed), the guild would otherwise never get a row.
// Running this upsert against every currently-joined guild on every boot makes
// guild registration self-healing instead of relying on a single event firing
// cleanly exactly once.
async function reconcileGuilds(): Promise<void> {
    let ok = 0;
    let failed = 0;

    for (const guild of client.guilds.cache.values()) {
        try {
            await prisma.guild.upsert({
                where: { id: guild.id },
                update: { name: guild.name },
                create: { id: guild.id, name: guild.name },
            });
            ok++;
        } catch (err) {
            failed++;
            logger.error(`[Reconcile] Failed to register guild ${guild.name} (${guild.id}):`, err);
        }
    }

    logger.info(`[Reconcile] Synced ${ok}/${client.guilds.cache.size} guild(s) with the database${failed ? ` (${failed} failed)` : ''}.`);
}

const event: BotEvent = {
    name: Events.ClientReady,
    once: true,
    async execute() {
        logger.info(`Quill is online and logged in as ${client.user?.tag}`);
        logger.info(`Serving ${client.guilds.cache.size} guild(s).`);
        await setBotStatus('online');
        await reconcileGuilds();
    },
};

export default event;