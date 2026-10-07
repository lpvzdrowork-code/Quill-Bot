import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ChannelType,
    InteractionContextType,
    MessageFlags,
} from 'discord.js';
import type { TextChannel, Embed } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { EMBED_COLOR_CHOICES, resolveEmbedColor } from '../../utils/embedColors.js';
import { EMBED_PRESETS, EMBED_TYPE_CHOICES, buildApplyRow } from '../../utils/embedPresets.js';
import type { EmbedPresetKey } from '../../utils/embedPresets.js';
import { Embeds } from '../../utils/embeds.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Embed');

// ─── /embed ───────────────────────────────────────────────────────────────────
// Minimalist announcement/embed builder for staff. Two subcommands:
//
//   /embed create [color] [channel] [interactive] [type]
//                                        — post a new branded embed
//   /embed edit <message> [color]        — edit one Quill already sent
//
// Text content (title/description/footer/image) comes through a modal, not
// slash-command options — that's the only way to get real multi-line
// descriptions out of the Discord UI. The exception is `type`: a preset
// (see utils/embedPresets.ts) is a finished embed, so it skips the modal and
// posts immediately.
//
// `interactive` attaches the Apply button (custom ID open_application_modal),
// which opens a private ticket channel. Presets that set `requiresButton`
// (careers) always carry it, even if `interactive: false` is passed, so a
// recruitment panel can never be posted without its Apply button.
//
// Color is restricted to the brand
// palette (see embedColors.ts) rather than a free hex field, on purpose.
// The submit side lives in utils/embedModals.ts and is routed from
// interactionCreate.ts, since a modal submission isn't a ChatInputCommand.

const ANNOUNCEABLE_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('embed')
        .setDescription('Post or edit a branded embed.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .setContexts(InteractionContextType.Guild)

        .addSubcommand(sub => sub
            .setName('create')
            .setDescription('Compose and post a new embed.')
            .addStringOption(option => option
                .setName('color')
                .setDescription('Brand color for the embed. Defaults to Graphite.')
                .addChoices(...EMBED_COLOR_CHOICES)
            )
            .addChannelOption(option => option
                .setName('channel')
                .setDescription('Where to post. Defaults to this channel.')
                .addChannelTypes(...ANNOUNCEABLE_TYPES)
            )
            .addBooleanOption(option => option
                .setName('interactive')
                .setDescription('Attach an Apply button. Always on for the careers type.')
            )
            .addStringOption(option => option
                .setName('type')
                .setDescription('Post a ready-made template instead of composing one.')
                .addChoices(...EMBED_TYPE_CHOICES)
            )
        )

        .addSubcommand(sub => sub
            .setName('edit')
            .setDescription('Edit an embed Quill previously posted.')
            .addStringOption(option => option
                .setName('message')
                .setDescription('The message link or ID of the embed to edit.')
                .setRequired(true)
            )
            .addStringOption(option => option
                .setName('color')
                .setDescription('Change the brand color. Leave blank to keep the current one.')
                .addChoices(...EMBED_COLOR_CHOICES)
            )
        ) as SlashCommandBuilder,

    async execute(interaction) {
        const sub = interaction.options.getSubcommand(true);

        if (sub === 'create') {
            const color       = interaction.options.getString('color') ?? 'graphite';
            const channel     = (interaction.options.getChannel('channel') as TextChannel | null) ?? interaction.channel as TextChannel;
            const type        = interaction.options.getString('type') as EmbedPresetKey | null;
            const interactive = interaction.options.getBoolean('interactive');

            if (!channel || !channel.isTextBased()) {
                await interaction.reply({ embeds: [Embeds.error('Pick a text channel to post in.')], flags: MessageFlags.Ephemeral });
                return;
            }

            // ── Preset path: no modal, post straight to the channel ───────────
            if (type) {
                const preset = EMBED_PRESETS[type];
                if (!preset) {
                    await interaction.reply({ embeds: [Embeds.error('Unknown embed type.')], flags: MessageFlags.Ephemeral });
                    return;
                }

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                try {
                    const embed = Embeds.custom({
                        color:       resolveEmbedColor(color),
                        title:       preset.title,
                        description: preset.description,
                        footer:      preset.footer,
                    });

                    const attachButton = preset.requiresButton || interactive === true;

                    await channel.send({
                        embeds:     [embed],
                        components: attachButton ? [buildApplyRow()] : [],
                    });

                    await interaction.editReply({ embeds: [Embeds.success(`Posted the ${type} embed to <#${channel.id}>.`)] });
                    log.info(`${interaction.user.tag} posted the '${type}' preset to #${channel.id}.`);
                } catch (err) {
                    log.error(`Failed to post '${type}' preset:`, err);
                    const detail = err instanceof Error ? err.message : String(err);
                    await interaction.editReply({ embeds: [Embeds.error(`Failed to post that embed. Check that I can send messages in <#${channel.id}>.\n\`\`\`${detail.slice(0, 300)}\`\`\``)] });
                }
                return;
            }

            // ── Custom path: compose via modal. The button choice rides along in
            //    the customId (1/0) since the modal submit is a separate interaction.
            const modal = new ModalBuilder()
                .setCustomId(`embed_create|${channel.id}|${color}|${interactive ? '1' : '0'}`)
                .setTitle('Compose Embed');

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('title')
                        .setLabel('Title (optional)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setMaxLength(256)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('description')
                        .setLabel('Description')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMaxLength(4000)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('image')
                        .setLabel('Image URL (optional)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('footer')
                        .setLabel('Footer (optional — blank by default)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setMaxLength(2048)
                ),
            );

            await interaction.showModal(modal);
            return;
        }

        if (sub === 'edit') {
            const messageInput = interaction.options.getString('message', true);
            const colorInput   = interaction.options.getString('color');

            const resolved = resolveMessageRef(messageInput, interaction.channelId);
            if (!resolved) {
                await interaction.reply({ embeds: [Embeds.error("That doesn't look like a valid message link or ID.")], flags: MessageFlags.Ephemeral });
                return;
            }

            // Discord requires showModal() to be the *initial* response to an
            // interaction — it can't follow a deferReply(). So the message/embed
            // lookup has to happen before any reply, inside the ~3s window a
            // single channel + message fetch comfortably fits in. We only reply
            // once, with either the modal (success) or an ephemeral error.
            let existing: Embed;

            try {
                const targetChannel = await interaction.guild!.channels.fetch(resolved.channelId);
                if (!targetChannel || !targetChannel.isTextBased()) {
                    await interaction.reply({ embeds: [Embeds.error("Couldn't find that channel.")], flags: MessageFlags.Ephemeral });
                    return;
                }

                const message = await (targetChannel as TextChannel).messages.fetch(resolved.messageId);

                if (message.author.id !== interaction.client.user!.id) {
                    await interaction.reply({ embeds: [Embeds.error("That message wasn't posted by Quill, so it can't be edited here.")], flags: MessageFlags.Ephemeral });
                    return;
                }

                const embed = message.embeds[0];
                if (!embed) {
                    await interaction.reply({ embeds: [Embeds.error("That message doesn't contain an embed.")], flags: MessageFlags.Ephemeral });
                    return;
                }

                existing = embed;

            } catch (err) {
                log.error('Embed edit lookup failed:', err);
                await interaction.reply({ embeds: [Embeds.error("Couldn't find or read that message. Check the link/ID and try again.")], flags: MessageFlags.Ephemeral });
                return;
            }

            const color = colorInput ?? 'keep'; // 'keep' -> embedModals reuses the message's current color

            const modal = new ModalBuilder()
                .setCustomId(`embed_edit|${resolved.channelId}|${resolved.messageId}|${color}`)
                .setTitle('Edit Embed');

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('title')
                        .setLabel('Title (optional)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setMaxLength(256)
                        .setValue(existing.title ?? '')
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('description')
                        .setLabel('Description')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMaxLength(4000)
                        .setValue(existing.description ?? '')
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('image')
                        .setLabel('Image URL (optional)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setValue(existing.image?.url ?? '')
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('footer')
                        .setLabel('Footer (optional — blank by default)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setValue(existing.footer?.text ?? '')
                ),
            );

            await interaction.showModal(modal);
        }
    },
};

// ─── Message Reference Resolver ────────────────────────────────────────────────
// Accepts either a raw message ID (assumes the current channel) or a full
// Discord message link (discord.com/channels/<guild>/<channel>/<message>).

function resolveMessageRef(input: string, fallbackChannelId: string): { channelId: string; messageId: string } | null {
    const linkMatch = input.match(/channels\/\d+\/(\d+)\/(\d+)/);
    if (linkMatch) {
        return { channelId: linkMatch[1], messageId: linkMatch[2] };
    }

    if (/^\d{17,20}$/.test(input.trim())) {
        return { channelId: fallbackChannelId, messageId: input.trim() };
    }

    return null;
}

export default command;
