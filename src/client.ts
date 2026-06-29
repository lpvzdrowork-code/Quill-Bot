import { Client, Collection, GatewayIntentBits } from 'discord.js';
import type { BotCommand } from './types/index.js';

// ─── Client ───────────────────────────────────────────────────────────────────
// Single shared client instance for the entire bot.
// Extended with a `commands` collection so the command loader and interaction
// handler can register and look up commands by name.
//
// Usage:
//   import { client } from '../client.js';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
}) as Client & { commands: Collection<string, BotCommand> };

client.commands = new Collection<string, BotCommand>();

export { client };
