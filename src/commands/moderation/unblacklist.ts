import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';

const log = createLogger('Unblacklist');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('unblacklist')
        .setDescription('Removes a blacklist from a member, restoring their server access.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to unblacklist.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for removing the blacklist.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target = interaction.options.getMember('target') as GuildMember | null;
        const reason = interaction.options.getString('reason') ?? 'No reason provided.';

        // ── Validation ────────────────────────────────────────────────────────
        // Routed through the shared guard (see moderationGuard.ts) so this stays
        // in lockstep with ban/kick/timeout/warn/flag/blacklist rather than
        // drifting as its own hand-rolled copy.

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel:     'unblacklist',
            capability:      'manageable',
            capabilityLabel: 'modify',
        });

        if (guardError) {
            await interaction.editReply(guardError);
            return;
        }

        // ── Check for an active blacklist ─────────────────────────────────────

        const blacklistRoleId = config.guild.roles.blacklist;
        const hasBlacklistRole = blacklistRoleId ? target!.roles.cache.has(blacklistRoleId) : false;

        const activeRecord = await prisma.blacklist.findFirst({
            where: {
                guildId: interaction.guildId!,
                userId:  target!.id,
                active:  true,
            },
        });

        if (!activeRecord && !hasBlacklistRole) {
            await interaction.editReply(`❌ **${target!.user.username}** is not currently blacklisted.`);
            return;
        }

        // ── Action ────────────────────────────────────────────────────────────

        try {
            // ── Remove the blacklist role ─────────────────────────────────────

            if (blacklistRoleId && hasBlacklistRole) {
                await target!.roles.remove(blacklistRoleId, `Blacklist lifted by ${interaction.user.username}: ${reason}`);
            }

            // ── Mark the record as revoked (preserves audit history) ──────────

            if (activeRecord) {
                await prisma.blacklist.update({
                    where: { id: activeRecord.id },
                    data: {
                        active:      false,
                        revokedAt:   new Date(),
                        revokedById: interaction.user.id,
                    },
                });
            }

            await interaction.editReply(`✅ Blacklist removed from **${target!.user.username}**.`);

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Unblacklist',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
            }));

        } catch (err) {
            log.error('Unblacklist command failed:', err);
            await interaction.editReply('❌ Failed to remove the blacklist. The action was not completed.');
        }
    },
};

export default command;
