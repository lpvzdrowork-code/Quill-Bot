import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { validateModerationTarget } from '../../utils/moderationGuard.js';

const log = createLogger('Timeout');

const DURATIONS: Record<string, number> = {
    '60 seconds':  60,
    '5 minutes':   60 * 5,
    '10 minutes':  60 * 10,
    '30 minutes':  60 * 30,
    '1 hour':      60 * 60,
    '6 hours':     60 * 60 * 6,
    '12 hours':    60 * 60 * 12,
    '1 day':       60 * 60 * 24,
    '1 week':      60 * 60 * 24 * 7,
};

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Times out a member, preventing them from sending messages.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(option => option
            .setName('target')
            .setDescription('The member to timeout.')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('duration')
            .setDescription('How long to timeout the member.')
            .setRequired(true)
            .addChoices(
                ...Object.keys(DURATIONS).map(label => ({ name: label, value: label }))
            )
        )
        .addStringOption(option => option
            .setName('reason')
            .setDescription('Reason for the timeout.')
            .setRequired(false)
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const target       = interaction.options.getMember('target') as GuildMember | null;
        const durationKey  = interaction.options.getString('duration', true);
        const reason       = interaction.options.getString('reason') ?? 'No reason provided.';
        const durationSecs = DURATIONS[durationKey];

        const guardError = validateModerationTarget({
            interaction,
            target,
            actionLabel: 'timeout',
            capability:  'moderatable',
        });

        if (guardError) {
            await interaction.editReply({ embeds: [Embeds.error(guardError)] });
            return;
        }

        try {
            const expiresAt = new Date(Date.now() + durationSecs * 1000);

            try {
                await target!.send({ embeds: [Embeds.modAction({
                    action:    'Timeout',
                    target:    target!.user,
                    moderator: interaction.user,
                    reason,
                    duration:  durationKey,
                    extra: { 'Expires': `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` },
                })] });
            } catch { /* DMs closed */ }

            await target!.timeout(durationSecs * 1000, reason);

            const timeoutRoleId = config.guild.roles.timeout;
            if (timeoutRoleId) {
                try {
                    await target!.roles.add(timeoutRoleId, 'Timeout role assigned by Quill');
                } catch {
                    log.warn(`Failed to assign timeout role (${timeoutRoleId}) to ${target!.user.username}.`);
                }
            }

            await prisma.timeout.create({
                data: {
                    guildId:     interaction.guildId!,
                    userId:      target!.id,
                    moderatorId: interaction.user.id,
                    reason,
                    duration:    durationSecs,
                    expiresAt,
                },
            });

            await interaction.editReply({ embeds: [Embeds.success(`**${target!.user.username}** has been timed out for **${durationKey}**.`)] });

            await sendLog(interaction.guildId!, 'staff-logs', Embeds.modAction({
                action:    'Timeout',
                target:    target!.user,
                moderator: interaction.user,
                reason,
                duration:  durationKey,
                guild:     interaction.guild ?? undefined,
                extra: { 'Expires': `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` },
            }));

        } catch (err) {
            log.error('Timeout command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to timeout that member. The action was not completed.')] });
        }
    },
};

export default command;
