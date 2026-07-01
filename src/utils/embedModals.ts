import type { ModalSubmitInteraction, TextChannel } from 'discord.js';
import { Embeds } from './embeds.js';
import { resolveEmbedColor } from './embedColors.js';
import { createLogger } from './logger.js';

const log = createLogger('EmbedModal');

// ─── Embed Modal Submit Handler ────────────────────────────────────────────────
// Routed here from interactionCreate.ts for any modal customId starting with
// "embed_". Two shapes:
//
//   embed_create|<channelId>|<colorKey>
//   embed_edit|<channelId>|<messageId>|<colorKey|"keep">
//
// Kept separate from commands/tools/embed.ts because a ModalSubmitInteraction
// isn't a ChatInputCommandInteraction, so it can't go through BotCommand.execute.

export async function handleEmbedModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [kind, ...parts] = interaction.customId.split('|');

    if (kind === 'embed_create') {
        await handleCreate(interaction, parts);
    } else if (kind === 'embed_edit') {
        await handleEdit(interaction, parts);
    }
}

async function handleCreate(interaction: ModalSubmitInteraction, parts: string[]): Promise<void> {
    const [channelId, colorKey] = parts;

    await interaction.deferReply({ ephemeral: true });

    const title       = interaction.fields.getTextInputValue('title').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    const image        = interaction.fields.getTextInputValue('image').trim();
    const footer       = interaction.fields.getTextInputValue('footer').trim();

    try {
        const channel = await interaction.guild!.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
            await interaction.editReply('❌ That channel is no longer available.');
            return;
        }

        const embed = Embeds.custom({
            color:       resolveEmbedColor(colorKey),
            title:       title || undefined,
            description,
            footer:      footer || undefined,
            imageUrl:    image || undefined,
        });

        await (channel as TextChannel).send({ embeds: [embed] });
        await interaction.editReply(`✅ Posted to <#${channelId}>.`);
        log.info(`${interaction.user.tag} posted a new embed to #${channelId}.`);

    } catch (err) {
        log.error('Failed to post embed:', err);
        const detail = err instanceof Error ? err.message : String(err);
        await interaction.editReply(`❌ Failed to post that embed.\n\`\`\`${detail.slice(0, 300)}\`\`\``);
    }
}

async function handleEdit(interaction: ModalSubmitInteraction, parts: string[]): Promise<void> {
    const [channelId, messageId, colorKey] = parts;

    await interaction.deferReply({ ephemeral: true });

    const title       = interaction.fields.getTextInputValue('title').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    const image        = interaction.fields.getTextInputValue('image').trim();
    const footer       = interaction.fields.getTextInputValue('footer').trim();

    try {
        const channel = await interaction.guild!.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
            await interaction.editReply('❌ That channel is no longer available.');
            return;
        }

        const message = await (channel as TextChannel).messages.fetch(messageId);
        const previous = message.embeds[0];

        // "keep" means the /embed edit command didn't ask to change color —
        // reuse whatever the message already had rather than defaulting to
        // graphite, which would silently strip a signature/onyx/silver embed
        // back to the default every time someone fixes a typo.
        const color = colorKey === 'keep'
            ? (previous?.color ?? resolveEmbedColor('graphite'))
            : resolveEmbedColor(colorKey);

        const embed = Embeds.custom({
            color,
            title:       title || undefined,
            description,
            footer:      footer || undefined,
            imageUrl:    image || undefined,
        });

        await message.edit({ embeds: [embed] });
        await interaction.editReply('✅ Embed updated.');
        log.info(`${interaction.user.tag} edited embed ${messageId} in #${channelId}.`);

    } catch (err) {
        log.error('Failed to edit embed:', err);
        const detail = err instanceof Error ? err.message : String(err);
        await interaction.editReply(`❌ Failed to update that embed.\n\`\`\`${detail.slice(0, 300)}\`\`\``);
    }
}
