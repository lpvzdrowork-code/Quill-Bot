import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import type { TextChannel } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Lock');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Locks or unlocks a channel, preventing members from sending messages.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addStringOption(option => option
            .setName('action')
            .setDescription('Lock or unlock the channel.')
            .setRequired(true)
            .addChoices(
                { name: 'lock',   value: 'lock' },
                { name: 'unlock', value: 'unlock' },
            )
        )
        .addChannelOption(option => option
            .setName('channel')
            .setDescription('Channel to lock/unlock. Defaults to the current channel.')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for locking/unlocking.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const action  = interaction.options.getString('action', true) as 'lock' | 'unlock';
        const reason  = interaction.options.getString('reason') ?? 'No reason provided.';
        const channel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextChannel;

        if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.editReply('❌ Target must be a text channel.');
            return;
        }

        const everyoneRole = interaction.guild!.roles.everyone;
        const locking      = action === 'lock';

        try {
            await channel.permissionOverwrites.edit(everyoneRole, {
                SendMessages: locking ? false : null,
            }, { reason });

            const status = locking
                ? `🔒 ${channel} has been locked.`
                : `🔓 ${channel} has been unlocked.`;

            await interaction.editReply(`✅ ${status}`);

            // Also send a visible notice in the affected channel
            // Isolated in its own try-catch so a send failure doesn't overwrite the ✅ reply above
            try {
                await channel.send({ embeds: [
                    locking
                        ? Embeds.warn(`🔒 This channel has been locked by a moderator.`, 'Channel Locked')
                        : Embeds.success(`🔓 This channel has been unlocked.`, 'Channel Unlocked'),
                ]});
            } catch {
                log.warn(`Could not send lock notice to #${channel.name} — bot may lack Send Messages there.`);
            }

            await sendLog('staffLog', Embeds.modAction({
                action:    locking ? 'Lock' : 'Unlock',
                target:    interaction.user,
                moderator: interaction.user,
                reason,
                extra:     { 'Channel': `${channel}` },
            }));

        } catch (err) {
            log.error('Lock command failed:', err);
            await interaction.editReply('❌ Failed to modify channel permissions. The action was not completed.');
        }
    },
};

export default command;
