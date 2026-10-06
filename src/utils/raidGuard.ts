import { GuildVerificationLevel } from 'discord.js';
import type { Guild, GuildMember } from 'discord.js';
import { sendLog } from './channelLogger.js';
import { Embeds } from './embeds.js';
import { getSecuritySettings, recordIncident } from './securityConfig.js';
import { createLogger } from './logger.js';

const log = createLogger('RaidGuard');

// ─── Raid Guard ─────────────────────────────────────────────────────────────
// Sliding-window join-rate tracker. Every guildMemberAdd feeds a timestamp in
// here; once `raidJoinThreshold` joins land within `raidWindowSeconds`, Quill
// treats it as a raid and takes the configured action (see securityConfig.ts
// for the three: alert / lockdown / kick_new).
//
// State is in-memory only (same reasoning as cooldown.ts — Quill runs as a
// single PM2 process) and resets on restart. That mainly matters for the
// lockdown timer: if the process restarts while a lockdown is active, the
// auto-revert setTimeout is lost and the guild's verification level stays
// raised until a staff member runs `/lockdown lift` — the lockdown itself
// isn't undone, just the automatic expiry. Documented rather than silently
// eaten; see the /lockdown command for the manual escape hatch.

interface LockdownRecord {
    previousLevel: GuildVerificationLevel;
    revertTimeout: NodeJS.Timeout;
}

interface RaidState {
    joinTimestamps: number[];
    lastTriggeredAt: number;
    lockdown: LockdownRecord | null;
}

const state = new Map<string, RaidState>();

const TRIGGER_COOLDOWN_MS = 5 * 60 * 1000; // don't fire a fresh raid response more than once per 5 min
const NEW_ACCOUNT_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — only consulted by the "kick_new" action

function getState(guildId: string): RaidState {
    let s = state.get(guildId);
    if (!s) {
        s = { joinTimestamps: [], lastTriggeredAt: 0, lockdown: null };
        state.set(guildId, s);
    }
    return s;
}

export function isLockdownActive(guildId: string): boolean {
    return state.get(guildId)?.lockdown != null;
}

// ─── Join Handling ────────────────────────────────────────────────────────────

/** Call on every guildMemberAdd. */
export async function handleJoinForRaidGuard(member: GuildMember): Promise<void> {
    const settings = await getSecuritySettings(member.guild.id);
    if (!settings.antiRaidEnabled) return;

    const s = getState(member.guild.id);
    const now = Date.now();

    s.joinTimestamps.push(now);
    const windowStart = now - settings.raidWindowSeconds * 1000;
    s.joinTimestamps = s.joinTimestamps.filter(t => t >= windowStart);

    const alreadyTriggered = s.lockdown !== null || (now - s.lastTriggeredAt < TRIGGER_COOLDOWN_MS && s.lastTriggeredAt > 0);

    // Every join that lands while a raid response is already active gets the
    // kick_new check too — that's the point of the response, not just the
    // one join that crossed the threshold.
    if (alreadyTriggered && settings.raidAction === 'kick_new') {
        await maybeKickNewAccount(member);
    }

    if (s.joinTimestamps.length < settings.raidJoinThreshold) return;
    if (now - s.lastTriggeredAt < TRIGGER_COOLDOWN_MS) return;

    s.lastTriggeredAt = now;
    const joinCount = s.joinTimestamps.length;

    await triggerRaidResponse(member.guild, settings.raidAction, settings.lockdownMinutes, joinCount, settings.raidWindowSeconds);

    if (settings.raidAction === 'kick_new' && !alreadyTriggered) {
        await maybeKickNewAccount(member);
    }
}

async function maybeKickNewAccount(member: GuildMember): Promise<void> {
    if (Date.now() - member.user.createdTimestamp > NEW_ACCOUNT_AGE_MS) return;
    if (!member.kickable) return;

    try {
        await member.kick('Anti-raid: account created under 3 days ago, joined during an active raid window.');
        log.info(`Anti-raid kicked new account ${member.user.tag} in ${member.guild.name}.`);
    } catch (err) {
        log.error(`Anti-raid failed to kick ${member.user.tag}:`, err);
    }
}

// ─── Response ─────────────────────────────────────────────────────────────────

async function triggerRaidResponse(
    guild: Guild,
    action: string,
    lockdownMinutes: number,
    joinCount: number,
    windowSeconds: number,
): Promise<void> {
    const details = `${joinCount} joins within ${windowSeconds}s.`;
    log.warn(`Raid detected in ${guild.name}: ${details} Action: ${action}.`);

    let takenAction: string = action;

    if (action === 'lockdown') {
        try {
            await engageLockdown(guild, lockdownMinutes);
        } catch (err) {
            log.error(`Failed to engage lockdown for ${guild.name}:`, err);
            takenAction = 'alert (lockdown failed; check my Manage Server permission)';
        }
    }

    await sendLog(guild.id, 'staff-logs', Embeds.warn(
        `**Raid detected.** ${details}\nAction taken: **${takenAction}**` +
        (action === 'lockdown' && takenAction === action ? `\nVerification level raised for ${lockdownMinutes} minute(s).` : ''),
        'Anti-Raid Triggered',
    ));

    await recordIncident(guild.id, 'raid', takenAction, details);
}

// ─── Lockdown (shared by the automatic response and the manual /lockdown command) ──

/** Raises verification level and schedules the auto-revert. Throws on failure — caller decides how to surface that. */
export async function engageLockdown(guild: Guild, minutes: number): Promise<void> {
    const s = getState(guild.id);
    if (s.lockdown) return; // already active — nothing to do

    const previousLevel = guild.verificationLevel;
    await guild.setVerificationLevel(GuildVerificationLevel.VeryHigh, 'Anti-raid lockdown.');

    const revertTimeout = setTimeout(() => void autoRevertLockdown(guild), minutes * 60 * 1000);
    s.lockdown = { previousLevel, revertTimeout };
}

/** Restores the pre-lockdown verification level. No-op if no lockdown is active. Caller is responsible for any logging. */
export async function revertLockdown(guild: Guild): Promise<void> {
    const s = state.get(guild.id);
    if (!s?.lockdown) return;

    clearTimeout(s.lockdown.revertTimeout);
    const { previousLevel } = s.lockdown;
    s.lockdown = null; // clear first so a failed API call doesn't leave us stuck thinking lockdown is still active

    await guild.setVerificationLevel(previousLevel, 'Anti-raid lockdown period elapsed, reverting.');
}

/** Wraps revertLockdown with the "expired naturally" log — used only by the scheduled auto-revert timer. */
async function autoRevertLockdown(guild: Guild): Promise<void> {
    try {
        await revertLockdown(guild);
        await sendLog(guild.id, 'staff-logs', Embeds.info(
            'Anti-raid lockdown has expired. Verification level reverted to its previous setting.',
            'Lockdown Lifted',
        ));
        log.info(`Auto-reverted anti-raid lockdown for ${guild.name}.`);
    } catch (err) {
        log.error(`Failed to auto-revert lockdown for ${guild.name}:`, err);
    }
}
