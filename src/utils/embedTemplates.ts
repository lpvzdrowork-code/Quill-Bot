import { EmbedBuilder } from 'discord.js';
import { resolveEmbedColor } from './embedColors.js';

// ─── Embed Templates ──────────────────────────────────────────────────────────
// Preset layouts for /embed create's `type` option. A template is a finished
// embed, so choosing one skips the compose modal entirely. To change the
// wording, edit it here; to add a template, add a choice below and a builder
// next to buildCareersEmbed, then handle the new key in commands/tools/embed.ts.
//
// House style: no emoji, plain labels, short lines.

export const EMBED_TYPE_CHOICES = [
    { name: 'Careers', value: 'careers' },
] as const;

export type EmbedTemplateKey = typeof EMBED_TYPE_CHOICES[number]['value'];

const BRAND_FOOTER = 'Lpvzdro Industries\u2122';

export function buildCareersEmbed(colorKey?: string | null): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(resolveEmbedColor(colorKey ?? 'graphite'))
        .setTitle('Careers at Lpvzdro Industries')
        .setDescription(
            'Lpvzdro Industries builds Roblox experiences and the tooling that supports them. ' +
            'We are recruiting contributors who take craft, reliability and communication seriously.',
        )
        .addFields(
            {
                name:  'Disciplines',
                value: 'Scripting (Luau)\nBuilding and 3D modeling\nInterface design\nCommunity moderation',
            },
            {
                name:  'Expectations',
                value: 'Consistent communication\nWork you can show, where applicable\nQuality over speed',
            },
            {
                name:  'Process',
                value: '1. Select **Apply** below and complete the form.\n' +
                       '2. The team reviews every submission.\n' +
                       '3. Selected applicants are contacted directly on Discord.',
            },
        )
        .setFooter({ text: BRAND_FOOTER });
}
