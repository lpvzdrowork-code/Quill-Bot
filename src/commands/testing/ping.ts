import { SlashCommandBuilder } from 'discord.js';
import type { BotCommand } from '../../types/index.js';

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Checks if Quill is alive and shows latency.'),

    async execute(interaction) {
        const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
        const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
        const websocket = interaction.client.ws.ping;

        await interaction.editReply(
            `Pong.\n> Roundtrip: \`${roundtrip}ms\`\n> WebSocket: \`${websocket}ms\``
        );
    },
};

export default command;
