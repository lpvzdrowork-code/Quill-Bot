import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Untimeout');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('untimeout')
        .setDescription('Removes a timeout from a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to remove the timeout from.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for removing the timeout.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target = interaction.options.getMember('target') as GuildMember | null;
        const reason = interaction.options.getString('reason') ?? 'No reason provided.';

        if (!target) {
            await interaction.editReply('❌ That user could not be found in this server.');
            return;
        }

        if (!target.moderatable) {
            await interaction.editReply('❌ I cannot modify that member. They may have a higher role than me.');
            return;
        }

        const invoker = interaction.member as GuildMember;
        if (target.roles.highest.position >= invoker.roles.highest.position) {
            await interaction.editReply('❌ You cannot modify a member with an equal or higher role than your own.');
            return;
        }

        const timeoutRoleId  = config.guild.roles.timeout;
        const hasTimeoutRole = timeoutRoleId ? target.roles.cache.has(timeoutRoleId) : false;

        if (!target.isCommunicationDisabled() && !hasTimeoutRole) {
            await interaction.editReply(`❌ **${target.user.username}** is not currently timed out.`);
            return;
        }

        try {
            if (target.isCommunicationDisabled()) {
                await target.timeout(null, reason);
            }

            if (timeoutRoleId && hasTimeoutRole) {
                try {
                    await target.roles.remove(timeoutRoleId, 'Timeout role removed by Quill');
                } catch {
                    log.warn(`Failed to remove timeout role (${timeoutRoleId}) from ${target.user.username}.`);
                }
            }

            await prisma.timeout.updateMany({
                where:  { guildId: interaction.guildId!, userId: target.id, endedAt: null },
                data:   { endedAt: new Date() },
            });

            await interaction.editReply(`✅ Timeout removed from **${target.user.username}**.`);

            await sendLog('staffLog', Embeds.modAction({
                action:    'Untimeout',
                target:    target.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
            }));

        } catch (err) {
            log.error('Untimeout command failed:', err);
            await interaction.editReply('❌ Failed to remove the timeout. The action was not completed.');
        }
    },
};

export default command;
