import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

// Fires when a shard drops and discord.js begins automatically trying to
// reconnect it. Logged at WARN — expected/self-healing, but worth a record
// in case a guild reports a gap and you need to correlate it with a shard
// blip rather than a bug.

const event: BotEvent = {
    name: Events.ShardReconnecting,
    once: false,
    execute(...args) {
        const shardId = args[0] as number;
        logger.warn(`Shard ${shardId} reconnecting...`);
    },
};

export default event;
