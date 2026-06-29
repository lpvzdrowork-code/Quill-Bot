import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Kick');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kicks a member from the server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to kick.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for the kick.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target = interaction.options.getMember('target') as GuildMember | null;
        const reason = interaction.options.getString('reason') ?? 'No reason provided.';

        if (!target || typeof target.kickable === 'undefined') {
            await interaction.editReply('❌ That user could not be found in this server.');
            return;
        }

        if (!target.kickable) {
            await interaction.editReply('❌ I cannot kick that member. They may have a higher role than me.');
            return;
        }

        if (target.id === interaction.user.id) {
            await interaction.editReply('❌ You cannot kick yourself.');
            return;
        }

        if (target.user.bot) {
            await interaction.editReply('❌ You cannot kick a bot.');
            return;
        }

        const invoker = interaction.member as GuildMember;
        if (target.roles.highest.position >= invoker.roles.highest.position) {
            await interaction.editReply('❌ You cannot kick a member with an equal or higher role than your own.');
            return;
        }

        try {
            try {
                await target.send({ embeds: [Embeds.modAction({
                    action:    'Kick',
                    target:    target.user,
                    moderator: interaction.user,
                    reason,
                })] });
            } catch { /* DMs closed */ }

            await target.kick(reason);

            await prisma.kick.create({
                data: {
                    guildId:     interaction.guildId!,
                    userId:      target.id,
                    moderatorId: interaction.user.id,
                    reason,
                },
            });

            await interaction.editReply(`✅ **${target.user.username}** has been kicked.`);

            await sendLog('staffLog', Embeds.modAction({
                action:    'Kick',
                target:    target.user,
                moderator: interaction.user,
                reason,
            }));

        } catch (err) {
            log.error('Kick command failed:', err);
            await interaction.editReply('❌ Failed to kick that member. The action was not completed.');
        }
    },
};

export default command;
