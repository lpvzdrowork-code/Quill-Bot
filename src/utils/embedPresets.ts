import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// ─── Embed Presets & Interactive Components ───────────────────────────────────
// Backs the `type` and `interactive` options on /embed create.
//
// Presets are complete, ready-to-post embeds (title, description, footer), so
// choosing one skips the compose modal entirely. To change the wording of a
// preset, edit it here — nothing else in the bot needs to know.

// ─── Application Button ───────────────────────────────────────────────────────
// This ID is a stable string, not a per-message one. interactionCreate.ts
// routes on it globally, so the button keeps working after a bot restart and
// on every message it was ever attached to (no collectors involved).

export const APPLICATION_BUTTON_ID = 'open_application_modal';

/** The single-button action row attached to interactive embeds. */
export function buildApplyRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(APPLICATION_BUTTON_ID)
            .setLabel('Apply')
            .setEmoji('📨')
            // Secondary (grey) sits on the Graphite embed without competing
            // with it. Swap to ButtonStyle.Primary for a Blurple button.
            .setStyle(ButtonStyle.Secondary),
    );
}

// ─── Preset Registry ──────────────────────────────────────────────────────────

export const EMBED_TYPE_CHOICES = [
    { name: 'Careers (recruitment post)', value: 'careers' },
] as const;

export type EmbedPresetKey = typeof EMBED_TYPE_CHOICES[number]['value'];

export interface EmbedPreset {
    title:       string;
    description: string;
    footer:      string;
    /** Whether the Apply button is attached when `interactive` isn't specified. */
    interactiveByDefault: boolean;
}

export const EMBED_PRESETS: Record<EmbedPresetKey, EmbedPreset> = {
    careers: {
        title: 'Careers at Lpvzdro Industries',
        description: [
            'Lpvzdro Industries develops Roblox experiences and the community tooling that supports them. We are growing our team with people who take pride in finishing what they start.',
            '',
            '**What We Look For**',
            '> Developers, builders, designers, and community staff who work independently, communicate clearly, and hold their output to a high standard.',
            '',
            '**How It Works**',
            'Select **Apply** below to begin. A private ticket is opened between you and our team, and every application is reviewed by a member of staff.',
            '',
            '**Before You Apply**',
            'Have examples of your work ready, along with your availability and the areas you would like to contribute to.',
        ].join('\n'),
        footer: 'Lpvzdro Industries™',
        interactiveByDefault: true,
    },
};
