import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } from 'discord.js';
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
        .setContexts(InteractionContextType.Guild)
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
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const amount = interaction.options.getInteger('amount', true);
        const target = interaction.options.getUser('target');
        const channel = interaction.channel as TextChannel;

        if (!channel || !channel.isTextBased()) {
            await interaction.editReply({ embeds: [Embeds.error('This command can only be used in a text channel.')] });
            return;
        }

        try {
            const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
            const deletable: import('discord.js').Message[] = [];

            if (target) {
                // Filtering by user: a single 100-message fetch can't guarantee
                // `amount` matches if the target's messages are sparse in this
                // channel, so walk backward through history in pages until we
                // have enough matches, hit the 14-day bulk-delete cutoff, or run
                // out of channel history. Capped at 500 scanned messages so a
                // channel where the target rarely posts can't turn this into an
                // unbounded fetch loop.
                const MAX_SCANNED = 500;
                let scanned = 0;
                let before: string | undefined;

                while (deletable.length < amount && scanned < MAX_SCANNED) {
                    const page = await channel.messages.fetch({ limit: 100, before });
                    if (page.size === 0) break;

                    for (const message of page.values()) {
                        scanned++;
                        if (message.createdTimestamp <= twoWeeksAgo) {
                            // Messages get older as we page back — once we cross
                            // the cutoff, nothing further back will be deletable.
                            scanned = MAX_SCANNED;
                            break;
                        }
                        if (message.author.id === target.id) {
                            deletable.push(message);
                            if (deletable.length >= amount) break;
                        }
                    }

                    before = [...page.values()].pop()?.id;
                    if (page.size < 100) break; // reached the start of the channel
                }
            } else {
                const messages = await channel.messages.fetch({ limit: amount });
                deletable.push(...[...messages.values()].filter(m => m.createdTimestamp > twoWeeksAgo));
            }

            if (deletable.length === 0) {
                await interaction.editReply({ embeds: [Embeds.error('No deletable messages found. Messages older than 14 days cannot be bulk deleted.')] });
                return;
            }

            const deleted = await channel.bulkDelete(deletable, true);

            const description = target
                ? `Deleted **${deleted.size}** message(s) from ${target.username} in ${channel}.`
                : `Deleted **${deleted.size}** message(s) in ${channel}.`;

            await interaction.editReply({ embeds: [Embeds.success(description)] });

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Purge',
                target:    target ?? interaction.user,
                moderator: interaction.user,
                reason:    description,
                extra:     { 'Channel': `${channel}` },
            }));

        } catch (err) {
            log.error('Purge command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to delete messages. The action was not completed.')] });
        }
    },
};

export default command;
