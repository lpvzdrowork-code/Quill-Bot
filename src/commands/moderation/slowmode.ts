import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { TextChannel } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Slowmode');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('slowmode')
        .setDescription('Sets the slowmode delay for the current channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addIntegerOption(option => option
            .setName('seconds')
            .setDescription('Slowmode delay in seconds (0 to disable, max 21600).')
            .setMinValue(0)
            .setMaxValue(21600)
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for the slowmode change.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const seconds = interaction.options.getInteger('seconds', true);
        const reason  = interaction.options.getString('reason') ?? 'No reason provided.';
        const channel = interaction.channel as TextChannel;

        if (!channel || !channel.isTextBased() || !('setRateLimitPerUser' in channel)) {
            await interaction.editReply({ embeds: [Embeds.error('This command can only be used in a text channel.')] });
            return;
        }

        try {
            await channel.setRateLimitPerUser(seconds, reason);

            const status = seconds === 0
                ? `Slowmode disabled in ${channel}.`
                : `Slowmode set to **${seconds}s** in ${channel}.`;

            await interaction.editReply({ embeds: [Embeds.success(status)] });

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Slowmode',
                target:    interaction.user,
                moderator: interaction.user,
                reason,
                extra: {
                    'Channel': `${channel}`,
                    'Delay':   seconds === 0 ? 'Disabled' : `${seconds}s`,
                },
            }));

        } catch (err) {
            log.error('Slowmode command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to set slowmode. The action was not completed.')] });
        }
    },
};

export default command;
