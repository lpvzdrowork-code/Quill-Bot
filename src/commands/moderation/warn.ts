import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';

const log = createLogger('Warn');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Issues a warning to a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to warn.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for the warning.')
            .setRequired(true)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target = interaction.options.getMember('target') as GuildMember | null;
        const reason = interaction.options.getString('reason', true);

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel: 'warn',
        });

        if (guardError) {
            await interaction.editReply({ embeds: [Embeds.error(guardError)] });
            return;
        }

        try {
            const warn = await prisma.warn.create({
                data: {
                    guildId:     interaction.guildId!,
                    userId:      target!.id,
                    moderatorId: interaction.user.id,
                    reason,
                },
            });

            const warnCount = await prisma.warn.count({
                where: { guildId: interaction.guildId!, userId: target!.id },
            });

            try {
                await target!.send({ embeds: [Embeds.modAction({
                    action:    'Warn',
                    target:    target!.user,
                    moderator: interaction.user,
                    reason,
                    extra: { 'Total Warnings': String(warnCount) },
                })] });
            } catch { /* DMs closed */ }

            await interaction.editReply({ embeds: [Embeds.success(`**${target!.user.username}** has been warned. They now have **${warnCount}** warning(s).`)] });

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Warn',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
                extra: {
                    'Warning ID':     warn.id,
                    'Total Warnings': String(warnCount),
                },
            }));

        } catch (err) {
            log.error('Warn command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to warn that member. The action was not completed.')] });
        }
    },
};

export default command;
