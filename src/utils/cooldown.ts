import { Collection } from 'discord.js';

// ─── Cooldown ─────────────────────────────────────────────────────────────────
// Simple in-memory per-command, per-user cooldown. Guards against accidental
// double-fires (double-click, client retry) and basic spam. In-memory is fine
// here since Quill runs as a single PM2 process (see ecosystem.config.cjs) —
// if that ever changes to multiple instances, this would need to move to
// Postgres/Redis to stay consistent across processes.
//
// Usage (in interactionCreate.ts):
//   const remaining = checkCooldown(interaction.commandName, interaction.user.id);
//   if (remaining !== null) {
//       await interaction.reply({ content: `⏳ Wait ${remaining}s.`, ephemeral: true });
//       return;
//   }

const DEFAULT_COOLDOWN_MS = 3000;

// Per-command overrides for commands that warrant a longer cooldown than the
// default — e.g. purge is heavier on the Discord API and easy to fat-finger
// repeatedly while tuning the amount.
const COMMAND_COOLDOWNS_MS: Record<string, number> = {
    purge: 5000,
};

// commandName -> (userId -> last-used timestamp)
const timestamps = new Collection<string, Collection<string, number>>();

// Entries only matter until their cooldown elapses, so drop expired ones
// periodically — otherwise the map grows by one entry per user per command forever.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function sweepExpired(now: number = Date.now()): void {
    for (const [commandName, users] of timestamps) {
        const cooldownMs = COMMAND_COOLDOWNS_MS[commandName] ?? DEFAULT_COOLDOWN_MS;

        for (const [userId, lastUsed] of users) {
            if (now - lastUsed >= cooldownMs) users.delete(userId);
        }

        if (users.size === 0) timestamps.delete(commandName);
    }
}

// unref() so this timer never keeps the process (or a test run) alive on its own.
setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();

/**
 * Checks whether `userId` is currently on cooldown for `commandName`.
 *
 * Returns the remaining cooldown in whole seconds (rounded up) if the user
 * must wait, or `null` if they're clear to proceed — in which case this call
 * also records the attempt, starting a fresh cooldown window.
 */
export function checkCooldown(commandName: string, userId: string): number | null {
    const cooldownMs = COMMAND_COOLDOWNS_MS[commandName] ?? DEFAULT_COOLDOWN_MS;

    let commandTimestamps = timestamps.get(commandName);
    if (!commandTimestamps) {
        commandTimestamps = new Collection<string, number>();
        timestamps.set(commandName, commandTimestamps);
    }

    const now = Date.now();
    const lastUsed = commandTimestamps.get(userId);

    if (lastUsed !== undefined) {
        const expiresAt = lastUsed + cooldownMs;
        if (now < expiresAt) {
            return Math.ceil((expiresAt - now) / 1000);
        }
    }

    commandTimestamps.set(userId, now);
    return null;
}
