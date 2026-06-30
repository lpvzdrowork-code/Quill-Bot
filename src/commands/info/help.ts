import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { client } from '../../client.js';
import { config } from '../../config.js';

// ─── Help ─────────────────────────────────────────────────────────────────────
// Builds the command list straight off client.commands instead of a hardcoded
// list — every command is auto-tagged with a `category` in commandLoader.ts
// based on which /commands subfolder it lives in, so adding or removing a
// command file is the only maintenance this ever needs.

const CATEGORY_LABELS: Record<string, string> = {
    moderation: '🛡️ Moderation',
    config:     '⚙️ Configuration',
    info:       'ℹ️ Info',
    testing:    '🧪 Testing',
    general:    '📦 General',
};

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Shows all available Quill commands.'),

    async execute(interaction) {
        const byCategory = new Map<string, string[]>();

        for (const cmd of client.commands.values()) {
            const category = cmd.category ?? 'general';
            const line = `\`/${cmd.data.name}\` — ${cmd.data.description}`;

            if (!byCategory.has(category)) byCategory.set(category, []);
            byCategory.get(category)!.push(line);
        }

        const embed = new EmbedBuilder()
            .setColor(config.colors.info)
            .setTitle(`📖 ${config.meta.name} — Commands`)
            .setDescription(`${client.commands.size} command(s) loaded.`)
            .setFooter({ text: `${config.meta.footer} • v${config.meta.version}` })
            .setTimestamp();

        const sortedCategories = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));

        for (const [category, lines] of sortedCategories) {
            const label = CATEGORY_LABELS[category] ?? category;
            embed.addFields({ name: label, value: lines.sort().join('\n'), inline: false });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
    },
};

export default command;
