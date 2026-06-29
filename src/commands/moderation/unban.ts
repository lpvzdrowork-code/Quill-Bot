import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Unban');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('unban')
        .setDescription('Unbans a user from the server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addStringOption(option => option
            .setName('user_id')
            .setDescription('The ID of the user to unban.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for the unban.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const userId = interaction.options.getString('user_id', true).trim();
        const reason = interaction.options.getString('reason') ?? 'No reason provided.';

        if (!/^\d{17,20}$/.test(userId)) {
            await interaction.editReply('❌ That doesn\'t look like a valid Discord user ID.');
            return;
        }

        let bannedUser;
        try {
            bannedUser = await interaction.guild!.bans.fetch(userId);
        } catch {
            await interaction.editReply('❌ That user is not banned or could not be found.');
            return;
        }

        try {
            await interaction.guild!.members.unban(userId, reason);

            await interaction.editReply(`✅ **${bannedUser.user.username}** has been unbanned.`);

            await sendLog('staffLog', Embeds.modAction({
                action:    'Unban',
                target:    bannedUser.user,
                moderator: interaction.user,
                reason,
            }));

        } catch (err) {
            log.error('Unban command failed:', err);
            await interaction.editReply('❌ Failed to unban that user. The action was not completed.');
        }
    },
};

export default command;
