import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';

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

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel: 'kick',
            capability:  'kickable',
        });

        if (guardError) {
            await interaction.editReply(guardError);
            return;
        }

        try {
            try {
                await target!.send({ embeds: [Embeds.modAction({
                    action:    'Kick',
                    target:    target!.user,
                    moderator: interaction.user,
                    reason,
                })] });
            } catch { /* DMs closed */ }

            await target!.kick(reason);

            await prisma.kick.create({
                data: {
                    guildId:     interaction.guildId!,
                    userId:      target!.id,
                    moderatorId: interaction.user.id,
                    reason,
                },
            });

            await interaction.editReply(`✅ **${target!.user.username}** has been kicked.`);

            await sendLog(interaction.guildId!, 'mod-logs', Embeds.modAction({
                action:    'Kick',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
            }));

        } catch (err) {
            log.error('Kick command failed:', err);
            await interaction.editReply('❌ Failed to kick that member. The action was not completed.');
        }
    },
};

export default command;
