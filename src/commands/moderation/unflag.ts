import { SlashCommandBuilder, PermissionFlagsBits, GuildMember, InteractionContextType, MessageFlags } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';
import { getRoleId } from '../../utils/guildConfig.js';

const log = createLogger('Unflag');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('unflag')
        .setDescription('Removes a flag from a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to unflag.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for removing the flag.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const target = interaction.options.getMember('target') as GuildMember | null;
            const reason = interaction.options.getString('reason') ?? 'No reason provided.';

            // ── Validation ────────────────────────────────────────────────────
            // Routed through the shared guard (see moderationGuard.ts) so this
            // stays in lockstep with ban/kick/timeout/warn/flag/blacklist rather
            // than drifting as its own hand-rolled copy.

            const guardError = validateModerationTarget({
                interaction,
                target,
                actionLabel:     'unflag',
                capability:      'manageable',
                capabilityLabel: 'modify',
            });

            if (guardError) {
                await interaction.editReply({ embeds: [Embeds.error(guardError)] });
                return;
            }

            // ── Check for an active flag ──────────────────────────────────────

            const flagRoleId = await getRoleId(interaction.guildId!, 'flag');
            const hasFlagRole = flagRoleId ? target!.roles.cache.has(flagRoleId) : false;

            const activeRecord = await prisma.flag.findFirst({
                where: {
                    guildId: interaction.guildId!,
                    userId:  target!.id,
                    active:  true,
                },
            });

            if (!activeRecord && !hasFlagRole) {
                await interaction.editReply({ embeds: [Embeds.error(`**${target!.user.username}** is not currently flagged.`)] });
                return;
            }

            // ── Remove the flag role ──────────────────────────────────────────

            if (flagRoleId && hasFlagRole) {
                await target!.roles.remove(flagRoleId, `Flag lifted by ${interaction.user.username}: ${reason}`);
            }

            // ── Mark the DB record as revoked (preserves audit history) ───────

            if (activeRecord) {
                await prisma.flag.update({
                    where: { id: activeRecord.id },
                    data: {
                        active:      false,
                        revokedAt:   new Date(),
                        revokedById: interaction.user.id,
                    },
                });
            }

            await interaction.editReply({ embeds: [Embeds.success(`Flag removed from **${target!.user.username}**.`)] });

            // ── Log to staff log ──────────────────────────────────────────────

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Unflag',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
            }));

        } catch (err) {
            log.error('Unflag command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to remove the flag. The action was not completed.')] });
        }
    },
};

export default command;
