import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import type { BotEvent } from '../utils/eventLoader.js';

// discord.js emits Events.Warn for non-fatal issues (deprecations, rate-limit
// pressure, cache misses, etc.) — distinct from Events.Error, which is
// reserved for actual client-level failures. Surfacing these separately means
// a slow-building problem (e.g. approaching a rate limit) shows up in logs
// before it escalates into an Events.Error.

const event: BotEvent = {
    name: Events.Warn,
    once: false,
    execute(...args) {
        const message = args[0] as string;
        logger.warn('Discord client warning:', message);
    },
};

export default event;
