import { Events } from 'discord.js';
import type { Interaction } from 'discord.js';
import type { BotCommand } from '../types/index.js';
import { client } from '../client.js';
import { createLogger } from '../utils/logger.js';
import { checkCooldown } from '../utils/cooldown.js';
import { isAllowedCommandChannel, getCommandChannelIds } from '../utils/guildConfig.js';
import { sendLog } from '../utils/channelLogger.js';
import { Embeds } from '../utils/embeds.js';
import type { BotEvent } from '../utils/eventLoader.js';

const log = createLogger('InteractionCreate');

const event: BotEvent = {
    name: Events.InteractionCreate,
    once: false,
    async execute(...args) {
        const interaction = args[0] as Interaction;

        if (!interaction.isChatInputCommand()) return;

        const command = client.commands.get(interaction.commandName) as BotCommand | undefined;

        if (!command) {
            log.warn(`No command found for /${interaction.commandName}.`);
            await interaction.reply({ content: 'Unknown command.', ephemeral: true });
            return;
        }

        const remainingCooldown = checkCooldown(interaction.commandName, interaction.user.id);
        if (remainingCooldown !== null) {
            await interaction.reply({
                content:   `⏳ Please wait **${remainingCooldown}s** before using \`/${interaction.commandName}\` again.`,
                ephemeral: true,
            });
            return;
        }

        // /setup is exempt so admins configuring the allowlist can never lock
        // themselves out of fixing it from a channel that isn't on the list yet.
        if (interaction.guildId && interaction.commandName !== 'setup') {
            const allowed = await isAllowedCommandChannel(interaction.guildId, interaction.channelId);

            if (!allowed) {
                const channelIds = await getCommandChannelIds(interaction.guildId);
                const channelList = channelIds.map(id => `<#${id}>`).join(', ');

                await interaction.reply({
                    content:   `❌ Commands aren't allowed in this channel. Try: ${channelList}`,
                    ephemeral: true,
                });
                return;
            }
        }

        try {
            await command.execute(interaction);
            log.info(`/${interaction.commandName} used by ${interaction.user.tag}.`);
        } catch (err) {
            log.error(`Error executing /${interaction.commandName}:`, err);

            const message = { content: 'Something went wrong while running that command.', ephemeral: true };

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(message);
            } else {
                await interaction.reply(message);
            }

            // Surface the failure to staff via message-logs — this is the one
            // event type the "bot logs" category was always meant for, it just
            // never had a call site wired up to it until now.
            if (interaction.guildId) {
                await sendLog(interaction.guildId, 'message-logs', Embeds.error(
                    `\`/${interaction.commandName}\` threw an error for ${interaction.user}.\n\`\`\`${String(err instanceof Error ? err.message : err).slice(0, 500)}\`\`\``,
                    '⚠️ Command Error',
                ));
            }
        }
    },
};

export default event;
