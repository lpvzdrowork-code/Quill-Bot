import type { Client, Collection } from 'discord.js';

// ─── Extended Client ──────────────────────────────────────────────────────────
// Extends the base discord.js Client with custom properties Quill needs.
// Use this type anywhere you want the full Quill-flavored client instead of
// the base Client.
//
// Usage:
//   import type { QuillClient } from '../types/index.js';

export interface QuillClient extends Client {
    commands: Collection<string, BotCommand>;
}

// ─── Bot Command ──────────────────────────────────────────────────────────────
// Shape every command file must export as default.
// Mirrors the BotEvent pattern from eventLoader for consistency.
//
// Usage (in a future command file):
//   import type { BotCommand } from '../types/index.js';
//
//   const command: BotCommand = {
//       name: 'ping',
//       description: 'Replies with Pong!',
//       async execute(interaction) {
//           await interaction.reply('Pong!');
//       },
//   };
//
//   export default command;

import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export interface BotCommand {
    data: SlashCommandBuilder;
    execute(interaction: ChatInputCommandInteraction): Promise<void>;
    /**
     * Subfolder this command was loaded from (e.g. "moderation", "config").
     * Set automatically by commandLoader.ts — don't set this in the command
     * file itself. Used by /help to group commands without a hardcoded list.
     */
    category?: string;
}

// ─── Log Channel ──────────────────────────────────────────────────────────────
// Re-exported here so consumers can import everything from one place.

export type { LogChannel } from '../utils/channelLogger.js';
