import { SlashCommandBuilder, PermissionFlagsBits, GuildMember, EmbedBuilder } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { prisma } from '../../lib/prisma.js';
import { paginate } from '../../utils/paginator.js';
import { createLogger } from '../../utils/logger.js';
import { config } from '../../config.js';

const log = createLogger('Warnings');

const WARNS_PER_PAGE = 5;

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('warnings')
        .setDescription('Lists all warnings for a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to check warnings for.')
            .setRequired(true)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target = interaction.options.getMember('target') as GuildMember | null;

        if (!target) {
            await interaction.editReply('❌ That user could not be found in this server.');
            return;
        }

        try {
            const warns = await prisma.warn.findMany({
                where:   { guildId: interaction.guildId!, userId: target.id },
                orderBy: { createdAt: 'desc' },
            });

            if (warns.length === 0) {
                await interaction.editReply(`✅ **${target.user.username}** has no warnings.`);
                return;
            }

            // ── Build pages ───────────────────────────────────────────────────

            const chunks: typeof warns[] = [];
            for (let i = 0; i < warns.length; i += WARNS_PER_PAGE) {
                chunks.push(warns.slice(i, i + WARNS_PER_PAGE));
            }

            const totalPages = chunks.length;

            const pages = chunks.map((chunk, idx) => {
                const embed = new EmbedBuilder()
                    .setColor(config.colors.warn)
                    .setTitle(`⚠️ Warnings — ${target.user.username}`)
                    .setThumbnail(target.user.displayAvatarURL())
                    .setDescription(`**${warns.length}** warning(s) on record.`)
                    .setFooter({ text: `${config.meta.footer} • Page ${idx + 1} of ${totalPages}` })
                    .setTimestamp();

                for (const warn of chunk) {
                    const ts = Math.floor(warn.createdAt.getTime() / 1000);
                    embed.addFields({
                        name:  `ID: \`${warn.id}\``,
                        value: `**Reason:** ${warn.reason}\n**Moderator:** <@${warn.moderatorId}>\n**Date:** <t:${ts}:R>`,
                    });
                }

                return embed;
            });

            await paginate(interaction, pages);

        } catch (err) {
            log.error('Warnings command failed:', err);
            await interaction.editReply('❌ Failed to retrieve warnings. Please try again.');
        }
    },
};

export default command;
