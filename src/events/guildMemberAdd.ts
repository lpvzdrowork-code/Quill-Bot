import { Events } from 'discord.js';
import type { GuildMember } from 'discord.js';
import { Embeds } from '../utils/embeds.js';
import { sendLog } from '../utils/channelLogger.js';
import { prisma } from '../lib/prisma.js';
import { getRoleId } from '../utils/guildConfig.js';
import { handleJoinForRaidGuard } from '../utils/raidGuard.js';
import { createLogger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

const log = createLogger('GuildMemberAdd');

const event: BotEvent = {
    name: Events.GuildMemberAdd,
    once: false,
    async execute(...args) {
        const member = args[0] as GuildMember;

        log.info(`${member.user.username} joined ${member.guild.name}.`);

        await sendLog(member.guild.id, 'member-logs', Embeds.memberJoin(member.user));

        // ── Anti-raid ──────────────────────────────────────────────────────────
        // Feeds this join into the sliding-window join-rate tracker. Isolated
        // in its own try-catch so a raidGuard failure can never block the
        // blacklist-persistence check below it.
        try {
            await handleJoinForRaidGuard(member);
        } catch (err) {
            log.error(`Anti-raid check failed for ${member.user.username}'s join:`, err);
        }

        // ── Blacklist persistence ─────────────────────────────────────────────
        // If this user has an active blacklist record, re-apply the role
        // immediately so they can't bypass it by leaving and rejoining.

        const blacklistRoleId = await getRoleId(member.guild.id, 'blacklist');
        if (!blacklistRoleId) return;

        try {
            const activeBlacklist = await prisma.blacklist.findFirst({
                where: {
                    guildId: member.guild.id,
                    userId:  member.id,
                    active:  true,
                },
            });

            if (activeBlacklist) {
                await member.roles.add(blacklistRoleId, 'Blacklist persisted on rejoin by Quill');
                log.info(`Re-applied blacklist role to ${member.user.username} on rejoin.`);

                await sendLog(member.guild.id, 'staff-logs', Embeds.modAction({
                    action:    'Blacklist',
                    target:    member.user,
                    moderator: member.client.user!,
                    reason:    `Blacklist re-applied on rejoin. Original reason: ${activeBlacklist.reason}`,
                }));
            }
        } catch (err) {
            log.error(`Failed to check/re-apply blacklist for ${member.user.username} on rejoin:`, err);
        }
    },
};

export default event;
