import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

const event: BotEvent = {
    name: Events.Error,
    once: false,
    execute(...args) {
        const error = args[0] as Error;
        logger.error('Discord client error:', error);
    },
};

export default event;
