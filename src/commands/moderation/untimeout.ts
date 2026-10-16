import { SlashCommandBuilder, PermissionFlagsBits, GuildMember, InteractionContextType, MessageFlags } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';
import { getRoleId } from '../../utils/guildConfig.js';

const log = createLogger('Untimeout');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('untimeout')
        .setDescription('Removes a timeout from a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)
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
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const target = interaction.options.getMember('target') as GuildMember | null;
        const reason = interaction.options.getString('reason') ?? 'No reason provided.';

        // ── Validation ────────────────────────────────────────────────────────
        // Routed through the shared guard (see moderationGuard.ts) so this stays
        // in lockstep with ban/kick/timeout/warn/flag/blacklist rather than
        // drifting as its own hand-rolled copy.

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel:     'untimeout',
            capability:      'moderatable',
            capabilityLabel: 'modify',
        });

        if (guardError) {
            await interaction.editReply({ embeds: [Embeds.error(guardError)] });
            return;
        }

        const timeoutRoleId  = await getRoleId(interaction.guildId!, 'timeout');
        const hasTimeoutRole = timeoutRoleId ? target!.roles.cache.has(timeoutRoleId) : false;

        if (!target!.isCommunicationDisabled() && !hasTimeoutRole) {
            await interaction.editReply({ embeds: [Embeds.error(`**${target!.user.username}** is not currently timed out.`)] });
            return;
        }

        try {
            if (target!.isCommunicationDisabled()) {
                await target!.timeout(null, reason);
            }

            if (timeoutRoleId && hasTimeoutRole) {
                try {
                    await target!.roles.remove(timeoutRoleId, 'Timeout role removed by Quill');
                } catch {
                    log.warn(`Failed to remove timeout role (${timeoutRoleId}) from ${target!.user.username}.`);
                }
            }

            // The timeout is already lifted at this point — a failure updating the
            // history must not be reported as "the action was not completed".
            let recorded = true;
            try {
                await prisma.timeout.updateMany({
                    where:  { guildId: interaction.guildId!, userId: target!.id, endedAt: null },
                    data:   { endedAt: new Date() },
                });
            } catch (dbErr) {
                recorded = false;
                log.error('Timeout removed but the mod history could not be updated:', dbErr);
            }

            await interaction.editReply({ embeds: [Embeds.success(
                `Timeout removed from **${target!.user.username}**.` +
                (recorded ? '' : '\nThe timeout was lifted, but the mod history could not be updated.'),
            )] });

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Untimeout',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
            }));

        } catch (err) {
            log.error('Untimeout command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to remove the timeout. The action was not completed.')] });
        }
    },
};

export default command;
