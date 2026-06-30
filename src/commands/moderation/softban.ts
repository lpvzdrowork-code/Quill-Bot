import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';

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

        if (!target || typeof target.bannable === 'undefined') {
            await interaction.editReply('❌ That user could not be found in this server.');
            return;
        }

        if (!target.bannable) {
            await interaction.editReply('❌ I cannot ban that member. They may have a higher role than me.');
            return;
        }

        if (target.id === interaction.user.id) {
            await interaction.editReply('❌ You cannot softban yourself.');
            return;
        }

        if (target.user.bot) {
            await interaction.editReply('❌ You cannot softban a bot.');
            return;
        }

        // ── Hierarchy check ───────────────────────────────────────────────────

        const invoker = interaction.member as GuildMember;
        if (target.roles.highest.position >= invoker.roles.highest.position) {
            await interaction.editReply('❌ You cannot softban a member with an equal or higher role than your own.');
            return;
        }

        // ── Action ────────────────────────────────────────────────────────────

        try {
            try {
                await target.send({ embeds: [Embeds.modAction({
                    action:    'Softban',
                    target:    target.user,
                    moderator: interaction.user,
                    reason,
                })] });
            } catch {
                // User has DMs closed — silently continue
            }

            // Ban to wipe messages, then immediately unban
            await target.ban({ reason, deleteMessageSeconds: 7 * 86400 });
            await interaction.guild!.members.unban(target.id, 'Softban — automatic unban');

            await prisma.ban.create({
                data: {
                    guildId:     interaction.guildId!,
                    userId:      target.id,
                    moderatorId: interaction.user.id,
                    reason:      `[SOFTBAN] ${reason}`,
                    deleteDays:  7,
                    endedAt:     new Date(), // Softban = immediate unban, so close the record right away
                },
            });

            await interaction.editReply(`✅ **${target.user.username}** has been softbanned. Their last 7 days of messages have been deleted.`);

            await sendLog('staffLog', Embeds.modAction({
                action:    'Softban',
                target:    target.user,
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
