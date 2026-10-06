import { AuditLogEvent } from 'discord.js';
import type { Guild, GuildAuditLogsEntry } from 'discord.js';
import { sendLog } from './channelLogger.js';
import { Embeds } from './embeds.js';
import { getSecuritySettings, recordIncident } from './securityConfig.js';
import { createLogger } from './logger.js';

const log = createLogger('NukeGuard');

// ─── Nuke Guard ─────────────────────────────────────────────────────────────
// Sliding-window tracker over *destructive* audit-log actions, keyed by
// executor. One member deleting `nukeActionThreshold` channels/roles or
// mass-banning within `nukeWindowSeconds` is the classic "server nuke"
// signature — a compromised or malicious admin account tearing the server
// down faster than a human moderator can react. This is the automatic
// circuit breaker for that.
//
// Only these action types count toward the threshold — routine, low-harm
// admin actions (nickname changes, channel renames, etc.) are deliberately
// left untracked so normal server management never trips it.
const TRACKED_ACTIONS = new Set<AuditLogEvent>([
    AuditLogEvent.ChannelDelete,
    AuditLogEvent.RoleDelete,
    AuditLogEvent.MemberBanAdd,
    AuditLogEvent.MemberKick,
    AuditLogEvent.WebhookCreate,
]);

interface ExecutorState {
    timestamps: number[];
    punishedAt: number;
}

// guildId -> executorId -> state
const state = new Map<string, Map<string, ExecutorState>>();
const PUNISH_COOLDOWN_MS = 5 * 60 * 1000; // don't re-punish the same executor within 5 min of a prior response

// Executors only accumulate state; drop anyone with no activity for an hour so the
// map doesn't grow forever in a long-running process. (An hour is well past any
// sane nukeWindowSeconds, so this can never discard timestamps still in a live window.)
const STALE_AFTER_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function sweepStale(): void {
    const now = Date.now();

    for (const [guildId, executors] of state) {
        for (const [executorId, s] of executors) {
            const lastActivity = Math.max(s.punishedAt, s.timestamps.at(-1) ?? 0);
            if (now - lastActivity > STALE_AFTER_MS) executors.delete(executorId);
        }

        if (executors.size === 0) state.delete(guildId);
    }
}

setInterval(sweepStale, SWEEP_INTERVAL_MS).unref();

/** Call on every GuildAuditLogEntryCreate. Filters down to tracked action types internally. */
export async function handleAuditLogEntryForNukeGuard(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    if (!TRACKED_ACTIONS.has(entry.action)) return;

    const executorId = entry.executorId;
    if (!executorId) return;
    if (executorId === guild.client.user?.id) return; // ignore Quill's own actions (e.g. its own bans)
    if (executorId === guild.ownerId) return; // owner exempt by default — a compromised owner account is a real risk too, but auto-punishing the owner (role strip/ban) risks locking them out of their own server on a false positive

    const settings = await getSecuritySettings(guild.id);
    if (!settings.antiNukeEnabled) return;

    if (settings.trustedRoleId) {
        try {
            const member = await guild.members.fetch(executorId);
            if (member.roles.cache.has(settings.trustedRoleId)) return;
        } catch {
            // Not fetchable (left the guild, etc.) — fall through and treat as untrusted.
        }
    }

    let guildState = state.get(guild.id);
    if (!guildState) {
        guildState = new Map();
        state.set(guild.id, guildState);
    }

    let executorState = guildState.get(executorId);
    if (!executorState) {
        executorState = { timestamps: [], punishedAt: 0 };
        guildState.set(executorId, executorState);
    }

    const now = Date.now();
    executorState.timestamps.push(now);
    const windowStart = now - settings.nukeWindowSeconds * 1000;
    executorState.timestamps = executorState.timestamps.filter(t => t >= windowStart);

    if (executorState.timestamps.length < settings.nukeActionThreshold) return;
    if (now - executorState.punishedAt < PUNISH_COOLDOWN_MS) return;

    executorState.punishedAt = now;
    await triggerNukeResponse(
        guild,
        executorId,
        settings.nukeAction,
        executorState.timestamps.length,
        settings.nukeWindowSeconds,
        entry.action,
    );
}

async function triggerNukeResponse(
    guild: Guild,
    executorId: string,
    action: string,
    count: number,
    windowSeconds: number,
    lastAction: AuditLogEvent,
): Promise<void> {
    const details = `${count} destructive action(s) (last: ${AuditLogEvent[lastAction] ?? lastAction}) within ${windowSeconds}s by <@${executorId}>.`;
    log.warn(`Nuke pattern detected in ${guild.name}: ${details} Action: ${action}.`);

    let takenAction: string = action;

    try {
        if (action === 'ban') {
            const member = await guild.members.fetch(executorId);
            if (member.bannable) {
                await member.ban({ reason: 'Anti-nuke: rapid destructive actions detected.' });
            } else {
                takenAction = 'alert (ban failed — target outranks me or I lack permission)';
            }
        } else if (action === 'strip_roles') {
            const member = await guild.members.fetch(executorId);
            if (member.manageable) {
                const rolesToStrip = member.roles.cache.filter(r => r.id !== guild.id);
                await member.roles.remove(rolesToStrip, 'Anti-nuke: rapid destructive actions detected.');
            } else {
                takenAction = 'alert (role strip failed — target outranks me or I lack permission)';
            }
        }
        // action === 'alert' falls straight through to the log below.
    } catch (err) {
        log.error(`Anti-nuke response failed for ${executorId} in ${guild.name}:`, err);
        takenAction = 'alert (response failed — see logs)';
    }

    await sendLog(guild.id, 'staff-logs', Embeds.warn(
        `**Possible server nuke detected.** ${details}\nAction taken: **${takenAction}**`,
        'Anti-Nuke Triggered',
    ));

    await recordIncident(guild.id, 'nuke', takenAction, details, executorId);
}
