import { Events } from 'discord.js';
import type { GuildMember } from 'discord.js';
import { prisma } from '../lib/prisma.js';
import { getRoleId } from '../utils/guildConfig.js';
import { createLogger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

const log = createLogger('GuildMemberUpdate');

const event: BotEvent = {
    name: Events.GuildMemberUpdate,
    once: false,
    async execute(...args) {
        const oldMember = args[0] as GuildMember;
        const newMember = args[1] as GuildMember;

        // Detect when a Discord timeout is lifted — either naturally expiring
        // or being removed externally (e.g. via another bot or the server UI).
        // communicationDisabledUntil goes from a Date → null in both cases.
        const wasTimedOut = oldMember.communicationDisabledUntil !== null;
        const isNowFree   = newMember.communicationDisabledUntil === null;

        if (!wasTimedOut || !isNowFree) return;

        log.info(`Timeout lifted for ${newMember.user.username} — removing timeout role if present.`);

        // ── Remove timeout role ───────────────────────────────────────────────

        const timeoutRoleId = await getRoleId(newMember.guild.id, 'timeout');
        if (timeoutRoleId && newMember.roles.cache.has(timeoutRoleId)) {
            try {
                await newMember.roles.remove(timeoutRoleId, 'Timeout expired — role removed by Quill');
                log.info(`Timeout role removed from ${newMember.user.username}.`);
            } catch (err) {
                log.warn(`Failed to remove timeout role from ${newMember.user.username}:`, err);
            }
        }

        // ── Mark timeout as ended in the database ─────────────────────────────

        try {
            await prisma.timeout.updateMany({
                where: {
                    guildId:   newMember.guild.id,
                    userId:    newMember.id,
                    endedAt:   null,
                },
                data: {
                    endedAt: new Date(),
                },
            });
        } catch (err) {
            log.warn(`Failed to update timeout record for ${newMember.user.username}:`, err);
        }
    },
};

export default event;
