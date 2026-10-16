import { SlashCommandBuilder, PermissionFlagsBits, GuildMember, InteractionContextType, MessageFlags } from 'discord.js';
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
        .setContexts(InteractionContextType.Guild)
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
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const target = interaction.options.getMember('target') as GuildMember | null;
        const reason = interaction.options.getString('reason') ?? 'No reason provided.';

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel: 'kick',
            capability:  'kickable',
        });

        if (guardError) {
            await interaction.editReply({ embeds: [Embeds.error(guardError)] });
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

            // The kick has gone through at this point — a failure saving it must not
            // be reported to the mod as "the action was not completed" (same as /ban).
            let recorded = true;
            try {
                await prisma.kick.create({
                    data: {
                        guildId:     interaction.guildId!,
                        userId:      target!.id,
                        moderatorId: interaction.user.id,
                        reason,
                    },
                });
            } catch (dbErr) {
                recorded = false;
                log.error('Kick succeeded but could not be saved to the database:', dbErr);
            }

            await interaction.editReply({ embeds: [Embeds.success(
                `**${target!.user.username}** has been kicked.` +
                (recorded ? '' : '\nThe kick was applied, but it could not be saved to the mod history.'),
            )] });

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Kick',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
            }));

        } catch (err) {
            log.error('Kick command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to kick that member. The action was not completed.')] });
        }
    },
};

export default command;
