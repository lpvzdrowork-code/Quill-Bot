// ─── Config ───────────────────────────────────────────────────────────────────

const colors = {
    success:    0x57F287,
    error:      0xED4245,
    warn:       0xFEE75C,
    info:       0x5865F2,
    mod:        0xEB459E,
    neutral:    0x2B2D31,
} as const;

const meta = {
    name:    'Quill',
    version: '1.0.0',
    footer:  'Quill Moderation',
} as const;

const guild = {
    id:       process.env.GUILD_ID       ?? '',
    channels: {
        staffLog:  process.env.STAFF_LOG_CHANNEL  ?? '', // All moderation action logs
        botLog:    process.env.BOT_LOG_CHANNEL    ?? '', // Bot error/event logs
        memberLog: process.env.MEMBER_LOG_CHANNEL ?? '', // Member join/leave logs
    },
    roles: {
        timeout:   process.env.TIMEOUT_ROLE   ?? '', // Role applied when a member is timed out
        blacklist: process.env.BLACKLIST_ROLE ?? '', // Role applied when a member is blacklisted
        flag:      process.env.FLAG_ROLE      ?? '', // Role applied when a member is flagged for staff watch
    },
} as const;

export const config = {
    colors,
    meta,
    guild,
} as const;
