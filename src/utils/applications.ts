import type { ButtonInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { Embeds } from './embeds.js';
import { createLogger } from './logger.js';

const log = createLogger('Applications');

// ─── Application Button Handler ───────────────────────────────────────────────
// Routed here from interactionCreate.ts when someone clicks the Apply button
// (custom ID `open_application_modal`, see embedPresets.ts).
//
// PLACEHOLDER: the private ticket workflow isn't built yet, so this just
// acknowledges the click. Replace the body with the real flow — typically
// showModal() with the application questions, then create a private ticket
// channel on submit. Note showModal() must be the first response to the
// interaction, so don't defer before calling it.

export async function handleApplicationButton(interaction: ButtonInteraction): Promise<void> {
    log.info(`${interaction.user.tag} clicked Apply in #${interaction.channelId}.`);

    await interaction.reply({
        embeds: [Embeds.info('Applications are not open just yet. Please check back soon.')],
        flags:  MessageFlags.Ephemeral,
    });
}
