// ─── Config ───────────────────────────────────────────────────────────────────

const colors = {
    success:    0x57F287,
    error:      0xED4245,
    warn:       0xFEE75C,
    info:       0x5865F2,
    mod:        0xEB459E,
    neutral:    0x2B2D31,
} as const;

// ─── Brand Palette ────────────────────────────────────────────────────────────
// Reserved for user-facing /embed announcements — deliberately separate from
// the status colors above. Kept tight on purpose: four tones, one of them a
// single accent. This is the entire palette /embed is allowed to use, which
// is what keeps every announcement feeling like it came from the same house
// rather than a grab-bag of bot-default colors.
const brand = {
    signature: 0xA8894F, // the one accent — muted brass, used sparingly
    onyx:      0x0B0B0C,
    graphite:  0x2B2D31,
    silver:    0xB5B8C5,
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
    brand,
    meta,
    guild,
} as const;
