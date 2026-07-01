import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';

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

        // ── Validation ────────────────────────────────────────────────────────
        // Routed through the shared guard (see moderationGuard.ts) so this stays
        // in lockstep with ban/kick/timeout/warn/flag/blacklist rather than
        // drifting as its own hand-rolled copy. No `capability` here — clearing
        // warnings never touches a Discord-side permission, only the DB.

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel: 'clear warnings for',
        });

        if (guardError) {
            await interaction.editReply(guardError);
            return;
        }

        // ── Remove a specific warning ─────────────────────────────────────────

        if (warnId) {
            try {
                const warn = await prisma.warn.findUnique({ where: { id: warnId } });

                if (!warn || warn.guildId !== interaction.guildId || warn.userId !== target!.id) {
                    await interaction.editReply('❌ That warning ID was not found for this user.');
                    return;
                }

                await prisma.warn.delete({ where: { id: warnId } });

                await interaction.editReply(`✅ Warning \`${warnId}\` has been removed from **${target!.user.username}**.`);

                await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                    action:    'Warn Removed',
                    target:    target!.user,
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
                where: { guildId: interaction.guildId!, userId: target!.id },
            });

            if (count === 0) {
                await interaction.editReply(`✅ **${target!.user.username}** has no warnings to clear.`);
                return;
            }

            await interaction.editReply(`✅ Cleared **${count}** warning(s) from **${target!.user.username}**.`);

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Warns Cleared',
                target:    target!.user,
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
