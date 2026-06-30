import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ClearWarns');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('clearwarns')
        .setDescription('Clears warnings for a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to clear warnings for.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('warn_id')
            .setDescription('A specific warning ID to remove. Leave blank to clear all warnings.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target = interaction.options.getMember('target') as GuildMember | null;
        const warnId = interaction.options.getString('warn_id')?.trim();

        if (!target) {
            await interaction.editReply('❌ That user could not be found in this server.');
            return;
        }

        if (target.id === interaction.user.id) {
            await interaction.editReply('❌ You cannot clear your own warnings.');
            return;
        }

        if (target.user.bot) {
            await interaction.editReply('❌ Bots cannot have warnings.');
            return;
        }

        const invoker = interaction.member as GuildMember;
        if (target.roles.highest.position >= invoker.roles.highest.position) {
            await interaction.editReply('❌ You cannot clear warnings for a member with an equal or higher role than your own.');
            return;
        }

        // ── Remove a specific warning ─────────────────────────────────────────

        if (warnId) {
            try {
                const warn = await prisma.warn.findUnique({ where: { id: warnId } });

                if (!warn || warn.guildId !== interaction.guildId || warn.userId !== target.id) {
                    await interaction.editReply('❌ That warning ID was not found for this user.');
                    return;
                }

                await prisma.warn.delete({ where: { id: warnId } });

                await interaction.editReply(`✅ Warning \`${warnId}\` has been removed from **${target.user.username}**.`);

                await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                    action:    'Warn Removed',
                    target:    target.user,
                    moderator: interaction.user,
                    reason:    `Removed warning ID: \`${warnId}\``,
                    guild:     interaction.guild ?? undefined,
                }));

            } catch (err) {
                log.error('ClearWarns (single) command failed:', err);
                await interaction.editReply('❌ Failed to remove that warning. The action was not completed.');
            }

            return;
        }

        // ── Clear all warnings ────────────────────────────────────────────────

        try {
            const { count } = await prisma.warn.deleteMany({
                where: { guildId: interaction.guildId!, userId: target.id },
            });

            if (count === 0) {
                await interaction.editReply(`✅ **${target.user.username}** has no warnings to clear.`);
                return;
            }

            await interaction.editReply(`✅ Cleared **${count}** warning(s) from **${target.user.username}**.`);

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Warns Cleared',
                target:    target.user,
                moderator: interaction.user,
                reason:    `All ${count} warning(s) cleared.`,
                guild:     interaction.guild ?? undefined,
            }));

        } catch (err) {
            log.error('ClearWarns (all) command failed:', err);
            await interaction.editReply('❌ Failed to clear warnings. The action was not completed.');
        }
    },
};

export default command;
