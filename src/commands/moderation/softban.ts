import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';

const log = createLogger('Softban');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('softban')
        .setDescription('Bans then immediately unbans a member, wiping their last 7 days of messages.')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to softban.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for the softban.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target = interaction.options.getMember('target') as GuildMember | null;
        const reason = interaction.options.getString('reason') ?? 'No reason provided.';

        // ── Validation ────────────────────────────────────────────────────────

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel:     'softban',
            capability:      'bannable',
            capabilityLabel: 'ban',
        });

        if (guardError) {
            await interaction.editReply(guardError);
            return;
        }

        // ── Action ────────────────────────────────────────────────────────────

        try {
            try {
                await target!.send({ embeds: [Embeds.modAction({
                    action:    'Softban',
                    target:    target!.user,
                    moderator: interaction.user,
                    reason,
                })] });
            } catch {
                // User has DMs closed — silently continue
            }

            // Ban to wipe messages, then immediately unban
            await target!.ban({ reason, deleteMessageSeconds: 7 * 86400 });
            await interaction.guild!.members.unban(target!.id, 'Softban — automatic unban');

            await prisma.ban.create({
                data: {
                    guildId:     interaction.guildId!,
                    userId:      target!.id,
                    moderatorId: interaction.user.id,
                    reason:      `[SOFTBAN] ${reason}`,
                    deleteDays:  7,
                    endedAt:     new Date(), // Softban = immediate unban, so close the record right away
                },
            });

            await interaction.editReply(`✅ **${target!.user.username}** has been softbanned. Their last 7 days of messages have been deleted.`);

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Softban',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
                extra:     { 'Messages Deleted': '7 days' },
            }));

        } catch (err) {
            log.error('Softban command failed:', err);
            await interaction.editReply('❌ Failed to softban that member. The action was not completed.');
        }
    },
};

export default command;
