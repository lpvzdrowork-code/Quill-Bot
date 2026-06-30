import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

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

        if (!target) {
            await interaction.editReply('❌ That user could not be found in this server.');
            return;
        }

        if (!target.manageable) {
            await interaction.editReply('❌ I cannot modify that member. They may have a higher role than me.');
            return;
        }

        // ── Hierarchy check ───────────────────────────────────────────────────

        const invoker = interaction.member as GuildMember;
        if (target.roles.highest.position >= invoker.roles.highest.position) {
            await interaction.editReply('❌ You cannot modify a member with an equal or higher role than your own.');
            return;
        }

        // ── Check for an active blacklist ─────────────────────────────────────

        const blacklistRoleId = config.guild.roles.blacklist;
        const hasBlacklistRole = blacklistRoleId ? target.roles.cache.has(blacklistRoleId) : false;

        const activeRecord = await prisma.blacklist.findFirst({
            where: {
                guildId: interaction.guildId!,
                userId:  target.id,
                active:  true,
            },
        });

        if (!activeRecord && !hasBlacklistRole) {
            await interaction.editReply(`❌ **${target.user.username}** is not currently blacklisted.`);
            return;
        }

        // ── Action ────────────────────────────────────────────────────────────

        try {
            // ── Remove the blacklist role ─────────────────────────────────────

            if (blacklistRoleId && hasBlacklistRole) {
                await target.roles.remove(blacklistRoleId, `Blacklist lifted by ${interaction.user.username}: ${reason}`);
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

            await interaction.editReply(`✅ Blacklist removed from **${target.user.username}**.`);

            await sendLog('staffLog', Embeds.modAction({
                action:    'Unblacklist',
                target:    target.user,
                moderator: interaction.user,
                reason,
            }));

        } catch (err) {
            log.error('Unblacklist command failed:', err);
            await interaction.editReply('❌ Failed to remove the blacklist. The action was not completed.');
        }
    },
};

export default command;
