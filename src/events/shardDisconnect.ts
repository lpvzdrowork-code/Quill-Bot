import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

// Fires when a shard's connection closes and discord.js has given up trying
// to reconnect it automatically. This is more serious than ShardError — it
// means that shard (and every guild on it) is offline until something
// intervenes, so it's logged at ERROR rather than WARN.

const event: BotEvent = {
    name: Events.ShardDisconnect,
    once: false,
    execute(...args) {
        const [closeEvent, shardId] = args as [{ code: number; reason: string }, number];
        logger.error(`Shard ${shardId} disconnected (code ${closeEvent.code}): ${closeEvent.reason || 'no reason given'}`);
    },
};

export default event;
