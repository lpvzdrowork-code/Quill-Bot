import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Ban');

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Bans a member from the server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to ban.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for the ban.')
            .setRequired(false)
        )
        .addIntegerOption(option => option
            .setName('delete_messages')
            .setDescription('How many days of messages to delete (0-7).')
            .setMinValue(0)
            .setMaxValue(7)
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target        = interaction.options.getMember('target') as GuildMember | null;
        const reason        = interaction.options.getString('reason') ?? 'No reason provided.';
        const deleteSeconds = (interaction.options.getInteger('delete_messages') ?? 0) * 86400;

        if (!target || typeof target.bannable === 'undefined') {
            await interaction.editReply('❌ That user could not be found in this server.');
            return;
        }

        if (!target.bannable) {
            await interaction.editReply('❌ I cannot ban that member. They may have a higher role than me.');
            return;
        }

        if (target.id === interaction.user.id) {
            await interaction.editReply('❌ You cannot ban yourself.');
            return;
        }

        if (target.user.bot) {
            await interaction.editReply('❌ You cannot ban a bot.');
            return;
        }

        const invoker = interaction.member as GuildMember;
        if (target.roles.highest.position >= invoker.roles.highest.position) {
            await interaction.editReply('❌ You cannot ban a member with an equal or higher role than your own.');
            return;
        }

        try {
            try {
                await target.send({ embeds: [Embeds.modAction({
                    action:    'Ban',
                    target:    target.user,
                    moderator: interaction.user,
                    reason,
                })] });
            } catch { /* DMs closed */ }

            await target.ban({ reason, deleteMessageSeconds: deleteSeconds });

            await prisma.ban.create({
                data: {
                    guildId:     interaction.guildId!,
                    userId:      target.id,
                    moderatorId: interaction.user.id,
                    reason,
                    deleteDays: deleteSeconds > 0 ? deleteSeconds / 86400 : 0,
                },
            });

            await interaction.editReply(`✅ **${target.user.username}** has been banned.`);

            await sendLog('staffLog', Embeds.modAction({
                action:    'Ban',
                target:    target.user,
                moderator: interaction.user,
                reason,
                guild:     interaction.guild ?? undefined,
                extra: deleteSeconds > 0
                    ? { 'Messages Deleted': `${deleteSeconds / 86400} day(s)` }
                    : undefined,
            }));

        } catch (err) {
            log.error('Ban command failed:', err);
            await interaction.editReply('❌ Failed to ban that member. The action was not completed.');
        }
    },
};

export default command;
