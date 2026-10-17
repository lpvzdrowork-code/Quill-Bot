import { SlashCommandBuilder, PermissionFlagsBits, GuildMember, EmbedBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { prisma } from '../../lib/prisma.js';
import { paginate } from '../../utils/paginator.js';
import { Embeds } from '../../utils/embeds.js';
import { createLogger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { NOTES_PER_PAGE } from '../../utils/notes.js';

const log = createLogger('Modlogs');

const ITEMS_PER_PAGE = 5;

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('modlogs')
        .setDescription('Shows moderation history for a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to look up.')
            .setRequired(true)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const target = interaction.options.getMember('target') as GuildMember | null;

        if (!target) {
            await interaction.editReply({ embeds: [Embeds.error('That user could not be found in this server.')] });
            return;
        }

        const guildId = interaction.guildId!;
        const userId  = target.id;

        try {
            const [bans, kicks, timeouts, warns, blacklists, flags, notes] = await Promise.all([
                prisma.ban.findMany({
                    where:   { guildId, userId },
                    orderBy: { createdAt: 'desc' },
                }),
                prisma.kick.findMany({
                    where:   { guildId, userId },
                    orderBy: { createdAt: 'desc' },
                }),
                prisma.timeout.findMany({
                    where:   { guildId, userId },
                    orderBy: { createdAt: 'desc' },
                }),
                prisma.warn.findMany({
                    where:   { guildId, userId },
                    orderBy: { createdAt: 'desc' },
                }),
                prisma.blacklist.findMany({
                    where:   { guildId, userId },
                    orderBy: { createdAt: 'desc' },
                }),
                prisma.flag.findMany({
                    where:   { guildId, userId },
                    orderBy: { createdAt: 'desc' },
                }),
                prisma.note.findMany({
                    where:   { guildId, userId },
                    orderBy: { createdAt: 'desc' },
                }),
            ]);

            const total = bans.length + kicks.length + timeouts.length + warns.length
                        + blacklists.length + flags.length;

            // Notes are context, not enforcement: they stay out of `total` (the
            // "actions on record" count) but a user with only notes should still
            // get their history instead of "no moderation history".
            if (total === 0 && notes.length === 0) {
                await interaction.editReply({ embeds: [Embeds.success(`**${target.user.username}** has no moderation history.`)] });
                return;
            }

            // ── Build per-category pages ───────────────────────────────────────

            const pages: EmbedBuilder[] = [];

            function baseEmbed(title: string, color: number, count: number, page: number, totalPages: number) {
                return new EmbedBuilder()
                    .setColor(color)
                    .setTitle(title)
                    .setThumbnail(target!.user.displayAvatarURL())
                    .setDescription(`**${count}** record(s) for ${target!.user.username}.`)
                    .setFooter({ text: `${config.meta.footer} • Page ${page} of ${totalPages}` })
                    .setTimestamp();
            }

            function addPages<T extends { createdAt: Date; reason: string; moderatorId: string }>(
                records: T[],
                label: string,
                color: number,
                extraField?: (r: T) => string,
            ) {
                if (records.length === 0) return;

                const chunks: T[][] = [];
                for (let i = 0; i < records.length; i += ITEMS_PER_PAGE) {
                    chunks.push(records.slice(i, i + ITEMS_PER_PAGE));
                }

                chunks.forEach((chunk, idx) => {
                    const embed = baseEmbed(
                        `${label}: ${target!.user.username}`,
                        color,
                        records.length,
                        idx + 1,
                        chunks.length,
                    );

                    for (const record of chunk) {
                        const ts    = Math.floor(record.createdAt.getTime() / 1000);
                        const extra = extraField ? `\n${extraField(record)}` : '';
                        embed.addFields({
                            name:  `<t:${ts}:R>`,
                            value: `**Reason:** ${record.reason}\n**Moderator:** <@${record.moderatorId}>${extra}`,
                        });
                    }

                    pages.push(embed);
                });
            }

            addPages(bans, 'Bans', config.colors.error,
                b => b.deleteDays > 0 ? `**Messages Deleted:** ${b.deleteDays} day(s)` : '');

            addPages(kicks, 'Kicks', config.colors.error);

            addPages(timeouts, 'Timeouts', config.colors.mod,
                t => `**Duration:** ${t.duration}s | **Expires:** <t:${Math.floor(t.expiresAt.getTime() / 1000)}:R>`);

            addPages(warns, 'Warnings', config.colors.warn);

            // ── Fix #1: Blacklist and Flag history now included ────────────────

            addPages(blacklists, 'Blacklists', config.colors.error,
                b => b.active
                    ? '**Status:** Active'
                    : b.revokedAt
                        ? `**Status:** Revoked <t:${Math.floor(b.revokedAt.getTime() / 1000)}:R>`
                        : '**Status:** Revoked');

            addPages(flags, 'Flags', config.colors.warn,
                f => f.active
                    ? '**Status:** Active'
                    : f.revokedAt
                        ? `**Status:** Revoked <t:${Math.floor(f.revokedAt.getTime() / 1000)}:R>`
                        : '**Status:** Revoked');

            // Staff notes get dedicated pages rather than going through addPages():
            // that helper hardcodes "Reason"/"Moderator" labels, which don't fit a
            // note. The ID is shown so staff can /note remove straight from here.
            const notePageCount = Math.ceil(notes.length / NOTES_PER_PAGE);

            for (let i = 0; i < notes.length; i += NOTES_PER_PAGE) {
                const embed = baseEmbed(
                    `Staff Notes: ${target.user.username}`,
                    config.colors.info,
                    notes.length,
                    i / NOTES_PER_PAGE + 1,
                    notePageCount,
                );

                for (const note of notes.slice(i, i + NOTES_PER_PAGE)) {
                    const ts = Math.floor(note.createdAt.getTime() / 1000);
                    embed.addFields({
                        name:  `<t:${ts}:R>`,
                        value: `${note.content}\n**Author:** <@${note.authorId}>\n**ID:** \`${note.id}\``,
                    });
                }

                pages.push(embed);
            }

            // ── Overview page (prepended) ─────────────────────────────────────

            const overview = new EmbedBuilder()
                .setColor(config.colors.neutral)
                .setTitle(`Modlogs: ${target.user.username}`)
                .setThumbnail(target.user.displayAvatarURL())
                .setDescription(`**${total}** total action(s) on record.`)
                .addFields(
                    { name: 'Bans',       value: String(bans.length),        inline: true },
                    { name: 'Kicks',      value: String(kicks.length),       inline: true },
                    { name: 'Timeouts',   value: String(timeouts.length),    inline: true },
                    { name: 'Warnings',   value: String(warns.length),       inline: true },
                    { name: 'Blacklists', value: String(blacklists.length),  inline: true },
                    { name: 'Flags',      value: String(flags.length),       inline: true },
                    { name: 'Notes',      value: String(notes.length),       inline: true },
                )
                .setFooter({ text: `${config.meta.footer} • Page 1 of ${pages.length + 1} — use buttons to browse` })
                .setTimestamp();

            await paginate(interaction, [overview, ...pages]);

        } catch (err) {
            log.error('Modlogs command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to retrieve moderation logs. Please try again.')] });
        }
    },
};

export default command;
