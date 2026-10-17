import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    InteractionContextType,
    MessageFlags,
} from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { resolveEmbedColor } from '../../utils/embedColors.js';
import { sendLog } from '../../utils/channelLogger.js';
import { createLogger } from '../../utils/logger.js';
import {
    TAG_CONTENT_MAX,
    TAG_NAME_MAX,
    TAG_TITLE_MAX,
    MAX_TAGS_PER_GUILD,
    normalizeTagName,
    searchTagNames,
    getTag,
    getTagNames,
    listTags,
    deleteTag,
    recordTagUse,
} from '../../utils/tags.js';
import type { TagRecord } from '../../utils/tags.js';

const log = createLogger('Tag');

// ─── /tag ─────────────────────────────────────────────────────────────────────
// Canned responses for staff: write something once ("how to open a ticket",
// "bug report template"), then drop it into any channel in one command.
//
//   /tag post <name> [user]   — post a tag publicly (optionally mentioning someone)
//   /tag view <name>          — preview a tag privately
//   /tag list                 — every tag in the server
//   /tag create <name>        — write a new tag (opens a form)
//   /tag edit <name>          — change a tag (opens a form with its current text)
//   /tag delete <name>        — remove a tag
//
// Anyone who can use the command (Moderate Members) can post, view and list.
// Create/edit/delete additionally need Manage Messages, checked here because
// Discord's default permissions apply to a whole command, not per subcommand.
//
// Tag text comes through a modal rather than a slash option, since that's the
// only way to get real line breaks out of the Discord UI (same reason /embed
// does it). The submit side lives in utils/tagModals.ts, routed from
// interactionCreate.ts. The `name` option autocompletes from the guild's tags
// via the `autocomplete` handler below.

const MANAGE_SUBCOMMANDS = new Set(['create', 'edit', 'delete']);
const LIST_CHAR_LIMIT    = 3800; // embed description cap is 4096; leave headroom for the footer line

function displayName(raw: string): string {
    return raw.replace(/`/g, '').trim().slice(0, TAG_NAME_MAX);
}

function tagEmbed(tag: TagRecord, footer?: string) {
    return Embeds.custom({
        color:       resolveEmbedColor('graphite'),
        title:       tag.title ?? undefined,
        description: tag.content,
        footer,
    });
}

async function replyError(interaction: ChatInputCommandInteraction, message: string): Promise<void> {
    await interaction.reply({ embeds: [Embeds.error(message)], flags: MessageFlags.Ephemeral });
}

/** Resolves the `name` option to an existing tag, replying with an error (and returning null) if there isn't one. */
async function findTag(interaction: ChatInputCommandInteraction): Promise<TagRecord | null> {
    const raw  = interaction.options.getString('name', true);
    const name = normalizeTagName(raw);
    const tag  = name ? await getTag(interaction.guildId!, name) : null;

    if (!tag) {
        await replyError(interaction, `No tag named \`${displayName(raw)}\`. Use \`/tag list\` to see what's available.`);
        return null;
    }

    return tag;
}

function buildTagModal(kind: 'create' | 'edit', name: string, existing?: TagRecord): ModalBuilder {
    const titleInput = new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title (optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(TAG_TITLE_MAX);

    const contentInput = new TextInputBuilder()
        .setCustomId('content')
        .setLabel('Content (markdown supported)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(TAG_CONTENT_MAX);

    if (existing) {
        titleInput.setValue(existing.title ?? '');
        contentInput.setValue(existing.content);
    }

    return new ModalBuilder()
        .setCustomId(`tag_${kind}|${name}`)
        .setTitle(kind === 'create' ? `New Tag: ${name}` : `Edit Tag: ${name}`)
        .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(contentInput),
        );
}

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('tag')
        .setDescription('Post and manage canned responses.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setContexts(InteractionContextType.Guild)

        .addSubcommand(sub => sub
            .setName('post')
            .setDescription('Post a tag in this channel.')
            .addStringOption(option => option
                .setName('name')
                .setDescription('The tag to post.')
                .setRequired(true)
                .setAutocomplete(true)
            )
            .addUserOption(option => option
                .setName('user')
                .setDescription('Mention someone alongside the tag.')
            )
        )

        .addSubcommand(sub => sub
            .setName('view')
            .setDescription('Preview a tag privately without posting it.')
            .addStringOption(option => option
                .setName('name')
                .setDescription('The tag to preview.')
                .setRequired(true)
                .setAutocomplete(true)
            )
        )

        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('Show every tag in this server.')
        )

        .addSubcommand(sub => sub
            .setName('create')
            .setDescription('Write a new tag.')
            .addStringOption(option => option
                .setName('name')
                .setDescription('Short name to call it by, e.g. rules or bug-report.')
                .setRequired(true)
                .setMaxLength(TAG_NAME_MAX)
            )
        )

        .addSubcommand(sub => sub
            .setName('edit')
            .setDescription('Change an existing tag.')
            .addStringOption(option => option
                .setName('name')
                .setDescription('The tag to edit.')
                .setRequired(true)
                .setAutocomplete(true)
            )
        )

        .addSubcommand(sub => sub
            .setName('delete')
            .setDescription('Delete a tag.')
            .addStringOption(option => option
                .setName('name')
                .setDescription('The tag to delete.')
                .setRequired(true)
                .setAutocomplete(true)
            )
        ) as SlashCommandBuilder,

    async autocomplete(interaction) {
        if (!interaction.guildId) {
            await interaction.respond([]);
            return;
        }

        let names: string[] = [];
        try {
            names = await getTagNames(interaction.guildId);
        } catch (err) {
            // Autocomplete has ~3s to answer and nothing useful to say on failure;
            // an empty list is better than an error toast on every keystroke.
            log.warn(`Could not load tag names for ${interaction.guildId}:`, err);
        }

        const focused = interaction.options.getFocused();
        await interaction.respond(searchTagNames(names, focused).map(name => ({ name, value: name })));
    },

    async execute(interaction) {
        const sub     = interaction.options.getSubcommand(true);
        const guildId = interaction.guildId!;

        if (MANAGE_SUBCOMMANDS.has(sub) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
            await replyError(interaction, 'Creating, editing and deleting tags requires the **Manage Messages** permission.');
            return;
        }

        // ── post ──────────────────────────────────────────────────────────────
        if (sub === 'post') {
            const tag = await findTag(interaction);
            if (!tag) return;

            const user = interaction.options.getUser('user');

            // Posted as the command's own reply so the channel shows who used it.
            // Only the explicitly chosen user can be pinged; nothing in the tag
            // text (e.g. @everyone) ever pings, and embeds don't ping regardless.
            await interaction.reply({
                content:         user ? `${user}` : undefined,
                embeds:          [tagEmbed(tag)],
                allowedMentions: user ? { users: [user.id] } : { parse: [] },
            });

            await recordTagUse(guildId, tag.name);
            return;
        }

        // ── view ──────────────────────────────────────────────────────────────
        if (sub === 'view') {
            const tag = await findTag(interaction);
            if (!tag) return;

            await interaction.reply({
                embeds: [tagEmbed(tag, `${tag.name}  •  Used ${tag.uses} ${tag.uses === 1 ? 'time' : 'times'}`)],
                flags:  MessageFlags.Ephemeral,
            });
            return;
        }

        // ── list ──────────────────────────────────────────────────────────────
        if (sub === 'list') {
            const tags = await listTags(guildId);

            if (tags.length === 0) {
                await interaction.reply({
                    embeds: [Embeds.info('No tags yet. Create one with `/tag create`.', 'Tags')],
                    flags:  MessageFlags.Ephemeral,
                });
                return;
            }

            const lines = tags.map(t => `\`${t.name}\`  ·  ${t.uses} ${t.uses === 1 ? 'use' : 'uses'}`);

            // A full server (100 tags) can exceed one embed description, so stop
            // adding lines before the limit and say how many were left out.
            const shown: string[] = [];
            let length = 0;
            for (const line of lines) {
                if (length + line.length + 1 > LIST_CHAR_LIMIT) break;
                shown.push(line);
                length += line.length + 1;
            }

            const hidden = lines.length - shown.length;
            const body   = shown.join('\n') + (hidden > 0 ? `\n…and ${hidden} more.` : '');

            await interaction.reply({
                embeds: [Embeds.info(body, `Tags (${tags.length})`)],
                flags:  MessageFlags.Ephemeral,
            });
            return;
        }

        // ── create ────────────────────────────────────────────────────────────
        if (sub === 'create') {
            const raw  = interaction.options.getString('name', true);
            const name = normalizeTagName(raw);

            if (!name) {
                await replyError(interaction, `Tag names can use letters, numbers, hyphens and underscores, up to ${TAG_NAME_MAX} characters.`);
                return;
            }

            // Checked before the form opens so nobody writes a long tag only to be
            // told it can't be saved. The submit re-checks atomically.
            const existing = await getTagNames(guildId);

            if (existing.includes(name)) {
                await replyError(interaction, `A tag named \`${name}\` already exists. Use \`/tag edit\` to change it.`);
                return;
            }

            if (existing.length >= MAX_TAGS_PER_GUILD) {
                await replyError(interaction, `This server has reached the limit of ${MAX_TAGS_PER_GUILD} tags. Delete one with \`/tag delete\` first.`);
                return;
            }

            await interaction.showModal(buildTagModal('create', name));
            return;
        }

        // ── edit ──────────────────────────────────────────────────────────────
        if (sub === 'edit') {
            // showModal() must be the first response, so the lookup (and any error
            // reply) happens before it, inside the 3s window.
            const tag = await findTag(interaction);
            if (!tag) return;

            await interaction.showModal(buildTagModal('edit', tag.name, tag));
            return;
        }

        // ── delete ────────────────────────────────────────────────────────────
        if (sub === 'delete') {
            const tag = await findTag(interaction);
            if (!tag) return;

            const deleted = await deleteTag(guildId, tag.name);

            if (!deleted) {
                await replyError(interaction, `The tag \`${tag.name}\` was already deleted.`);
                return;
            }

            await interaction.reply({
                embeds: [Embeds.success(`Tag \`${tag.name}\` deleted.`)],
                flags:  MessageFlags.Ephemeral,
            });

            await sendLog(guildId, 'staff-logs', Embeds.info(`${interaction.user} deleted the tag \`${tag.name}\`.`, 'Tag Deleted'));
            log.info(`${interaction.user.tag} deleted tag "${tag.name}" in ${guildId}.`);
        }
    },
};

export default command;
