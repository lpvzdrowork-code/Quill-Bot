import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { TextChannel } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Purge');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Bulk-deletes messages from the current channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption(option => option
            .setName('amount')
            .setDescription('Number of messages to delete (1–100).')
            .setMinValue(1)
            .setMaxValue(100)
            .setRequired(true)
        )
        .addUserOption(option => option
            .setName('target')
            .setDescription('Only delete messages from this user.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const amount = interaction.options.getInteger('amount', true);
        const target = interaction.options.getUser('target');
        const channel = interaction.channel as TextChannel;

        if (!channel || !channel.isTextBased()) {
            await interaction.editReply('❌ This command can only be used in a text channel.');
            return;
        }

        try {
            // Fetch more than requested when filtering by user so we can hit the target count
            const fetchCount = target ? Math.min(amount * 5, 100) : amount;
            const messages = await channel.messages.fetch({ limit: fetchCount });

            const toDelete = target
                ? [...messages.values()].filter(m => m.author.id === target.id).slice(0, amount)
                : [...messages.values()];

            // Discord only allows bulk delete on messages under 14 days old
            const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
            const deletable = toDelete.filter(m => m.createdTimestamp > twoWeeksAgo);

            if (deletable.length === 0) {
                await interaction.editReply('❌ No deletable messages found. Messages older than 14 days cannot be bulk deleted.');
                return;
            }

            const deleted = await channel.bulkDelete(deletable, true);

            const description = target
                ? `Deleted **${deleted.size}** message(s) from ${target.username} in ${channel}.`
                : `Deleted **${deleted.size}** message(s) in ${channel}.`;

            await interaction.editReply(`✅ ${description}`);

            await sendLog('staffLog', Embeds.modAction({
                action:    'Purge',
                target:    target ?? interaction.user,
                moderator: interaction.user,
                reason:    description,
                extra:     { 'Channel': `${channel}` },
            }));

        } catch (err) {
            log.error('Purge command failed:', err);
            await interaction.editReply('❌ Failed to delete messages. The action was not completed.');
        }
    },
};

export default command;
