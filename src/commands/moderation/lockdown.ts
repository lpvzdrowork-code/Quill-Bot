import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { Embeds } from '../../utils/embeds.js';
import { sendLog } from '../../utils/channelLogger.js';
import { createLogger } from '../../utils/logger.js';
import { engageLockdown, revertLockdown, isLockdownActive } from '../../utils/raidGuard.js';
import { getSecuritySettings } from '../../utils/securityConfig.js';

const log = createLogger('Lockdown');

// ─── Command ────────────────────────────────────────────────────────────────
// /lockdown — manual emergency override for the anti-raid lockdown. Lets
// staff engage the same verification-level lockdown anti-raid uses ahead of
// an actual raid, or lift one early — including a lockdown left active after
// a bot restart lost its auto-revert timer (see raidGuard.ts).

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('lockdown')
        .setDescription('Manually engage or lift server lockdown (raises/restores verification level).')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option => option
            .setName('action')
            .setDescription('Engage or lift lockdown.')
            .setRequired(true)
            .addChoices(
                { name: 'engage', value: 'engage' },
                { name: 'lift',   value: 'lift' },
            )
        ) as SlashCommandBuilder,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const action = interaction.options.getString('action', true) as 'engage' | 'lift';
        const guild  = interaction.guild!;

        try {
            if (action === 'engage') {
                if (isLockdownActive(guild.id)) {
                    await interaction.editReply({ embeds: [Embeds.info('Lockdown is already active.')] });
                    return;
                }

                const settings = await getSecuritySettings(guild.id);
                await engageLockdown(guild, settings.lockdownMinutes);

                await interaction.editReply({ embeds: [Embeds.success(
                    `🔒 Lockdown engaged — verification level raised for ${settings.lockdownMinutes} minute(s), or until \`/lockdown lift\`.`,
                )] });

                await sendLog(guild.id, 'staff-logs', Embeds.warn(`🔒 Lockdown manually engaged by ${interaction.user}.`, 'Manual Lockdown'));

            } else {
                if (!isLockdownActive(guild.id)) {
                    await interaction.editReply({ embeds: [Embeds.info('Lockdown is not currently active.')] });
                    return;
                }

                await revertLockdown(guild);
                await interaction.editReply({ embeds: [Embeds.success('🔓 Lockdown lifted — verification level restored.')] });

                await sendLog(guild.id, 'staff-logs', Embeds.info(`🔓 Lockdown manually lifted by ${interaction.user}.`, 'Manual Lockdown'));
            }

            log.info(`${interaction.user.tag} ${action === 'engage' ? 'engaged' : 'lifted'} lockdown in guild ${guild.id}.`);

        } catch (err) {
            log.error('Lockdown command failed:', err);
            await interaction.editReply({ embeds: [Embeds.error('Failed to update the server verification level. The action was not completed.')] });
        }
    },
};

export default command;
