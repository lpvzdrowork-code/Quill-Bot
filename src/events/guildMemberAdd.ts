import { Events } from 'discord.js';
import type { GuildMember } from 'discord.js';
import { Embeds } from '../utils/embeds.js';
import { sendLog } from '../utils/channelLogger.js';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

const log = createLogger('GuildMemberAdd');

const event: BotEvent = {
    name: Events.GuildMemberAdd,
    once: false,
    async execute(...args) {
        const member = args[0] as GuildMember;

        log.info(`${member.user.username} joined ${member.guild.name}.`);

        await sendLog('memberLog', Embeds.memberJoin(member.user));

        // ── Blacklist persistence ─────────────────────────────────────────────
        // If this user has an active blacklist record, re-apply the role
        // immediately so they can't bypass it by leaving and rejoining.

        const blacklistRoleId = config.guild.roles.blacklist;
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

                await sendLog('staffLog', Embeds.modAction({
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
