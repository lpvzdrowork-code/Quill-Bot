import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

// Fires when a shard's WebSocket connection hits an error (network blip,
// Discord-side gateway issue, etc.). discord.js handles reconnection on its
// own — this handler exists purely so those errors land in our logs instead
// of vanishing, since they're otherwise easy to miss until a guild reports
// the bot "went offline" for a few minutes.

const event: BotEvent = {
    name: Events.ShardError,
    once: false,
    execute(...args) {
        const [error, shardId] = args as [Error, number];
        logger.error(`Shard ${shardId} error:`, error);
    },
};

export default event;
