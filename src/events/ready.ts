import { Events } from 'discord.js';
import { client } from '../client.js';
import { logger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

const event: BotEvent = {
    name: Events.ClientReady,
    once: true,
    execute() {
        logger.info(`Quill is online and logged in as ${client.user?.tag}`);
        logger.info(`Serving ${client.guilds.cache.size} guild(s).`);
    },
};

export default event;
