import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    ChatInputCommandInteraction,
} from 'discord.js';

// ─── Paginator ────────────────────────────────────────────────────────────────
// Sends a paginated ephemeral embed with Prev/Next buttons.
// Buttons auto-disable when there's only one page, and the collector
// cleans up after 2 minutes of inactivity.
//
// Usage:
//   await paginate(interaction, pages);

const PAGE_TIMEOUT = 2 * 60 * 1000; // 2 minutes

export async function paginate(
    interaction: ChatInputCommandInteraction,
    pages: EmbedBuilder[],
): Promise<void> {
    if (pages.length === 0) return;

    // Single page — no buttons needed
    if (pages.length === 1) {
        await interaction.editReply({ embeds: [pages[0]] });
        return;
    }

    let current = 0;

    function row(page: number): ActionRowBuilder<ButtonBuilder> {
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('page_prev')
                .setLabel('◀ Prev')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId('page_next')
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === pages.length - 1),
        );
    }

    const reply = await interaction.editReply({
        embeds:     [pages[current]],
        components: [row(current)],
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter:        i => i.user.id === interaction.user.id,
        time:          PAGE_TIMEOUT,
    });

    collector.on('collect', async btn => {
        if (btn.customId === 'page_prev') current = Math.max(0, current - 1);
        if (btn.customId === 'page_next') current = Math.min(pages.length - 1, current + 1);

        await btn.update({
            embeds:     [pages[current]],
            components: [row(current)],
        });
    });

    collector.on('end', async () => {
        // Disable both buttons when the collector expires
        const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('page_prev')
                .setLabel('◀ Prev')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId('page_next')
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
        );

        await interaction.editReply({ components: [disabled] }).catch(() => null);
    });
}
