import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

// Fires when a shard successfully reconnects after a disconnect. Pairs with
// shardReconnecting.ts/shardDisconnect.ts to give a full timeline in logs:
// disconnect -> reconnecting -> resume, instead of just a gap of silence.

const event: BotEvent = {
    name: Events.ShardResume,
    once: false,
    execute(...args) {
        const shardId = args[0] as number;
        logger.info(`Shard ${shardId} resumed.`);
    },
};

export default event;
