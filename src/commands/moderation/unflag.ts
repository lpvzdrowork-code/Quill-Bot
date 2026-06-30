import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Unflag');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('unflag')
        .setDescription('Removes a flag from a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
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
        await interaction.deferReply({ ephemeral: true });

        try {
            const target = interaction.options.getMember('target') as GuildMember | null;
            const reason = interaction.options.getString('reason') ?? 'No reason provided.';

            // ── Validation ────────────────────────────────────────────────────

            if (!target) {
                await interaction.editReply('❌ That user could not be found in this server.');
                return;
            }

            if (!target.manageable) {
                await interaction.editReply('❌ I cannot modify that member. They may have a higher role than me.');
                return;
            }

            // ── Hierarchy check ─────────────────────────────────────────

            const invoker = interaction.member as GuildMember;
            if (target.roles.highest.position >= invoker.roles.highest.position) {
                await interaction.editReply('❌ You cannot modify a member with an equal or higher role than your own.');
                return;
            }

            // ── Check for an active flag ──────────────────────────────────────

            const flagRoleId = config.guild.roles.flag;
            const hasFlagRole = flagRoleId ? target.roles.cache.has(flagRoleId) : false;

            const activeRecord = await prisma.flag.findFirst({
                where: {
                    guildId: interaction.guildId!,
                    userId:  target.id,
                    active:  true,
                },
            });

            if (!activeRecord && !hasFlagRole) {
                await interaction.editReply(`❌ **${target.user.username}** is not currently flagged.`);
                return;
            }

            // ── Hierarchy check ───────────────────────────────────────────────

            // ── Remove the flag role ──────────────────────────────────────────

            if (flagRoleId && hasFlagRole) {
                await target.roles.remove(flagRoleId, `Flag lifted by ${interaction.user.username}: ${reason}`);
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

            await interaction.editReply(`✅ Flag removed from **${target.user.username}**.`);

            // ── Log to staff log ──────────────────────────────────────────────

            await sendLog('staffLog', Embeds.modAction({
                action:    'Unflag',
                target:    target.user,
                moderator: interaction.user,
                reason,
            }));

        } catch (err) {
            log.error('Unflag command failed:', err);
            await interaction.editReply('❌ Failed to remove the flag. The action was not completed.');
        }
    },
};

export default command;
