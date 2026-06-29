import { Events } from 'discord.js';
import { client } from '../client.js';
import { logger } from '../utils/logger.js';
import { setBotStatus } from '../utils/botStatus.js';
import type { BotEvent } from '../utils/eventLoader.js';

const event: BotEvent = {
    name: Events.ClientReady,
    once: true,
    async execute() {
        logger.info(`Quill is online and logged in as ${client.user?.tag}`);
        logger.info(`Serving ${client.guilds.cache.size} guild(s).`);
        await setBotStatus('online');
    },
};

export default event;
