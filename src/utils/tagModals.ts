import type { ModalSubmitInteraction } from 'discord.js';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { Embeds } from './embeds.js';
import { sendLog } from './channelLogger.js';
import { createLogger } from './logger.js';
import { createTag, updateTag, MAX_TAGS_PER_GUILD } from './tags.js';

const log = createLogger('TagModal');

// ─── Tag Modal Submit Handler ─────────────────────────────────────────────────
// Routed here from interactionCreate.ts for any modal customId starting with
// "tag_". Two shapes:
//
//   tag_create|<name>
//   tag_edit|<name>
//
// The tag name rides along in the customId because the submit is a separate
// interaction from the /tag command that opened the modal. Names are already
// normalized by then (no "|" possible), so a plain split is safe.
//
// Permissions are checked again here: the modal was shown to someone who held
// Manage Messages, but roles can change between opening and submitting it.

export async function handleTagModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [kind, name] = interaction.customId.split('|');

    if (!interaction.guildId || !name) return;
    if (kind !== 'tag_create' && kind !== 'tag_edit') return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.editReply({ embeds: [Embeds.error('Managing tags requires the **Manage Messages** permission.')] });
        return;
    }

    const title   = interaction.fields.getTextInputValue('title').trim();
    const content = interaction.fields.getTextInputValue('content').trim();

    if (!content) {
        await interaction.editReply({ embeds: [Embeds.error('A tag needs some content.')] });
        return;
    }

    const input = {
        guildId: interaction.guildId,
        name,
        title:   title || null,
        content,
        userId:  interaction.user.id,
    };

    try {
        if (kind === 'tag_create') {
            const result = await createTag(input);

            if (result === 'exists') {
                await interaction.editReply({ embeds: [Embeds.error(`A tag named \`${name}\` already exists. Use \`/tag edit\` to change it.`)] });
                return;
            }

            if (result === 'limit') {
                await interaction.editReply({ embeds: [Embeds.error(`This server has reached the limit of ${MAX_TAGS_PER_GUILD} tags. Delete one with \`/tag delete\` first.`)] });
                return;
            }

            await interaction.editReply({ embeds: [Embeds.success(`Tag \`${name}\` created. Post it with \`/tag post\`.`)] });
            await sendLog(interaction.guildId, 'staff-logs', Embeds.info(`${interaction.user} created the tag \`${name}\`.`, 'Tag Created'));
            log.info(`${interaction.user.tag} created tag "${name}" in ${interaction.guildId}.`);
            return;
        }

        const updated = await updateTag(input);

        if (!updated) {
            await interaction.editReply({ embeds: [Embeds.error(`The tag \`${name}\` no longer exists.`)] });
            return;
        }

        await interaction.editReply({ embeds: [Embeds.success(`Tag \`${name}\` updated.`)] });
        await sendLog(interaction.guildId, 'staff-logs', Embeds.info(`${interaction.user} edited the tag \`${name}\`.`, 'Tag Edited'));
        log.info(`${interaction.user.tag} edited tag "${name}" in ${interaction.guildId}.`);

    } catch (err) {
        log.error(`Failed to save tag "${name}":`, err);
        await interaction.editReply({ embeds: [Embeds.error('Failed to save that tag. Nothing was changed.')] });
    }
}
