import { SlashCommandBuilder, PermissionFlagsBits, GuildMember, InteractionContextType, MessageFlags } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';

const log = createLogger('Ban');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Bans a member from the server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to ban.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for the ban.')
            .setRequired(false)
        )
        .addIntegerOption(option => option
            .setName('delete_messages')
            .setDescription('How many days of messages to delete (0-7).')
            .setMinValue(0)
            .setMaxValue(7)
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const target        = interaction.options.getMember('target') as GuildMember | null;
        const reason        = interaction.options.getString('reason') ?? 'No reason provided.';
        const deleteSeconds = (interaction.options.getInteger('delete_messages') ?? 0) * 86400;

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel: 'ban',
            capability:  'bannable',
        });

        if (guardError) {
            await interaction.editReply({ embeds: [Embeds.error(guardError)] });
            return;
        }

        try {
            try {
                await target!.send({ embeds: [Embeds.modAction({
                    action:    'Ban',
                    target:    target!.user,
                    moderator: interaction.user,
                    reason,
                })] });
            } catch { /* DMs closed */ }

            await target!.ban({ reason, deleteMessageSeconds: deleteSeconds });

            // The ban has gone through at this point — a failure saving it must not
            // be reported to the mod as "the action was not completed".
            let recorded = true;
            try {
                await prisma.ban.create({
                    data: {
                        guildId:     interaction.guildId!,
                        userId:      target!.id,
                        moderatorId: interaction.user.id,
                        reason,
                        deleteDays:  deleteSeconds / 86400,
                    },
                });
            } catch (dbErr) {
                recorded = false;
                log.error('Ban succeeded but could not be saved to the database:', dbErr);
            }

            await interaction.editReply({ embeds: [Embeds.success(
                `**${target!.user.username}** has been banned.` +
                (recorded ? '' : '\n⚠️ The ban was applied, but I failed to save it to the mod history.'),
            )] });

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Ban',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
                extra: deleteSeconds > 0
                    ? { 'Messages Deleted': `${deleteSeconds / 86400} day(s)` }
                    : undefined,
            }));

        } catch (err) {
            log.error('Ban command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to ban that member. The action was not completed.')] });
        }
    },
};

export default command;
