import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import type { User } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { prisma } from '../../lib/prisma.js';
import { paginate } from '../../utils/paginator.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { createLogger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { NOTE_CONTENT_MAX, MAX_NOTES_PER_USER, NOTES_PER_PAGE } from '../../utils/notes.js';

const log = createLogger('Note');

// ─── /note ────────────────────────────────────────────────────────────────────
// Private, non-punitive staff memos about a user — context for the team, not
// enforcement. Nothing here DMs the user, assigns a role, or counts toward the
// action totals in /modlogs (though notes do show up there as their own pages).
//
//   /note add <target> <content>   — attach a note to a user
//   /note list <target>            — every note on a user, newest first
//   /note remove <id>              — delete a note (author, or Manage Messages)
//
// `target` is a user option rather than a member option on purpose: staff often
// want to note someone who has already left the server (ban evasion, a returning
// troublemaker), and notes are keyed by Discord ID so they survive that.
//
// Every reply is ephemeral. Adds are not mirrored to staff-logs (that would
// broadcast the very context this command exists to keep quiet), but removals
// are, with the original text, so a note can't silently vanish.

interface NoteRow {
    id:        string;
    authorId:  string;
    content:   string;
    createdAt: Date;
}

function noteFieldValue(note: NoteRow): string {
    const ts = Math.floor(note.createdAt.getTime() / 1000);
    return `${note.content}\n**Author:** <@${note.authorId}>\n**Added:** <t:${ts}:R>`;
}

function buildPages(notes: NoteRow[], target: User): EmbedBuilder[] {
    const totalPages = Math.ceil(notes.length / NOTES_PER_PAGE);
    const pages: EmbedBuilder[] = [];

    for (let i = 0; i < notes.length; i += NOTES_PER_PAGE) {
        const embed = new EmbedBuilder()
            .setColor(config.colors.info)
            .setTitle(`Staff Notes: ${target.username}`)
            .setThumbnail(target.displayAvatarURL())
            .setDescription(`**${notes.length}** note(s) on record.`)
            .setFooter({ text: `${config.meta.footer} • Page ${pages.length + 1} of ${totalPages}` })
            .setTimestamp();

        for (const note of notes.slice(i, i + NOTES_PER_PAGE)) {
            embed.addFields({ name: `ID: \`${note.id}\``, value: noteFieldValue(note) });
        }

        pages.push(embed);
    }

    return pages;
}

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('note')
        .setDescription('Attach private staff notes to a user.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)

        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a private note to a user.')
            .addUserOption(option => option
                .setName('target')
                .setDescription('The user the note is about.')
                .setRequired(true)
            )
            .addStringOption(option => option
                .setName('content')
                .setDescription('What staff should know.')
                .setRequired(true)
                .setMinLength(1)
                .setMaxLength(NOTE_CONTENT_MAX)
            )
        )

        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('Show every note on a user.')
            .addUserOption(option => option
                .setName('target')
                .setDescription('The user to look up.')
                .setRequired(true)
            )
        )

        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Delete a note by its ID.')
            .addStringOption(option => option
                .setName('id')
                .setDescription('The note ID shown in /note list or /modlogs.')
                .setRequired(true)
            )
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const sub     = interaction.options.getSubcommand(true);
        const guildId = interaction.guildId!;

        try {
            // ── add ───────────────────────────────────────────────────────────
            if (sub === 'add') {
                const target  = interaction.options.getUser('target', true);
                const content = interaction.options.getString('content', true).trim();

                if (!content) {
                    await interaction.editReply({ embeds: [Embeds.error('A note cannot be empty.')] });
                    return;
                }

                const existing = await prisma.note.count({ where: { guildId, userId: target.id } });

                if (existing >= MAX_NOTES_PER_USER) {
                    await interaction.editReply({ embeds: [Embeds.error(
                        `**${target.username}** already has ${MAX_NOTES_PER_USER} notes, the most Quill keeps per user. Remove an old one with \`/note remove\` first.`,
                    )] });
                    return;
                }

                const note = await prisma.note.create({
                    data: {
                        guildId,
                        userId:   target.id,
                        authorId: interaction.user.id,
                        content,
                    },
                });

                await interaction.editReply({ embeds: [Embeds.success(
                    `Note added to **${target.username}**.\n**ID:** \`${note.id}\``,
                )] });
                return;
            }

            // ── list ──────────────────────────────────────────────────────────
            if (sub === 'list') {
                const target = interaction.options.getUser('target', true);

                const notes = await prisma.note.findMany({
                    where:   { guildId, userId: target.id },
                    orderBy: { createdAt: 'desc' },
                });

                if (notes.length === 0) {
                    await interaction.editReply({ embeds: [Embeds.info(`**${target.username}** has no staff notes.`)] });
                    return;
                }

                await paginate(interaction, buildPages(notes, target));
                return;
            }

            // ── remove ────────────────────────────────────────────────────────
            if (sub === 'remove') {
                const id = interaction.options.getString('id', true).trim();

                // Scoped to this guild so an ID copied from another server can
                // never match, let alone delete, anything here.
                const note = await prisma.note.findFirst({ where: { id, guildId } });

                if (!note) {
                    await interaction.editReply({ embeds: [Embeds.error('No note with that ID was found in this server.')] });
                    return;
                }

                // Discord's default permissions gate the whole command, not one
                // subcommand, so the author/Manage Messages rule is enforced here.
                const isAuthor  = note.authorId === interaction.user.id;
                const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;

                if (!isAuthor && !canManage) {
                    await interaction.editReply({ embeds: [Embeds.error(
                        'You can only remove notes you wrote, unless you have the **Manage Messages** permission.',
                    )] });
                    return;
                }

                const { count } = await prisma.note.deleteMany({ where: { id, guildId } });

                if (count === 0) {
                    await interaction.editReply({ embeds: [Embeds.error('That note was already removed.')] });
                    return;
                }

                await interaction.editReply({ embeds: [Embeds.success('Note removed.')] });

                await sendLog(guildId, 'staff-logs', Embeds.info(
                    `${interaction.user} removed a note about <@${note.userId}> written by <@${note.authorId}>.\n\n${note.content}`,
                    'Staff Note Removed',
                ));
                log.info(`${interaction.user.tag} removed note ${note.id} in ${guildId}.`);
            }

        } catch (err) {
            log.error(`Note ${sub} failed:`, err);
            await interaction.editReply({ embeds: [Embeds.error('Something went wrong handling that note. Please try again.')] });
        }
    },
};

export default command;
