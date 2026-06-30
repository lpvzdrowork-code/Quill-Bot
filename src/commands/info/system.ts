import { SlashCommandBuilder, EmbedBuilder, version as djsVersion } from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('System');

// ─── System ───────────────────────────────────────────────────────────────────
// Real-time health snapshot: gateway/roundtrip latency, DB latency (a live
// query, not a cached value), memory, and uptime. No fake metrics — if a
// number can't be measured honestly (e.g. DB is down), it's reported as
// unreachable rather than omitted or faked.

function formatUptime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const days    = Math.floor(totalSeconds / 86400);
    const hours   = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (days)    parts.push(`${days}d`);
    if (hours)   parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
}

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('system')
        .setDescription("Shows Quill's current health and performance metrics."),

    async execute(interaction) {
        const sent = await interaction.reply({ content: '📡 Gathering metrics...', fetchReply: true });

        const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
        const websocket  = interaction.client.ws.ping;

        // ── DB latency — a live round-trip, not a cached/assumed value ────────

        let dbLatency: string;
        try {
            const start = Date.now();
            await prisma.$queryRaw`SELECT 1`;
            dbLatency = `${Date.now() - start}ms`;
        } catch (err) {
            log.error('Database health check failed:', err);
            dbLatency = '⚠️ unreachable';
        }

        const memoryMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
        const uptime   = formatUptime(interaction.client.uptime ?? 0);

        const embed = new EmbedBuilder()
            .setColor(dbLatency.startsWith('⚠️') ? config.colors.error : config.colors.info)
            .setTitle(`📡 ${config.meta.name} System Status`)
            .addFields(
                { name: '🏓 Roundtrip', value: `${roundtrip}ms`, inline: true },
                { name: '🌐 WebSocket', value: `${websocket}ms`, inline: true },
                { name: '🗄️ Database',  value: dbLatency,        inline: true },
                { name: '⏱️ Uptime',    value: uptime,           inline: true },
                { name: '💾 Memory',    value: `${memoryMb} MB`, inline: true },
                { name: '🏰 Guilds',    value: String(interaction.client.guilds.cache.size), inline: true },
            )
            .setFooter({ text: `${config.meta.footer} • v${config.meta.version} • discord.js v${djsVersion}` })
            .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });
    },
};

export default command;
