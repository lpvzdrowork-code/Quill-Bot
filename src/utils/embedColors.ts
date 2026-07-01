import type { ColorResolvable } from 'discord.js';
import { config } from '../config.js';

// ─── Embed Color Choices ────────────────────────────────────────────────────────
// The entire palette /embed is allowed to use. Deliberately not open to
// arbitrary hex input — that's the one guardrail that keeps every announcement
// on-brand regardless of who on staff is posting it.

export const EMBED_COLOR_CHOICES = [
    { name: 'Signature (brass accent)', value: 'signature' },
    { name: 'Onyx',                     value: 'onyx' },
    { name: 'Graphite (default)',       value: 'graphite' },
    { name: 'Silver',                   value: 'silver' },
] as const;

export type EmbedColorKey = typeof EMBED_COLOR_CHOICES[number]['value'];

const COLOR_MAP: Record<EmbedColorKey, ColorResolvable> = {
    signature: config.brand.signature,
    onyx:      config.brand.onyx,
    graphite:  config.brand.graphite,
    silver:    config.brand.silver,
};

export function resolveEmbedColor(key: string | null | undefined): ColorResolvable {
    if (key && key in COLOR_MAP) return COLOR_MAP[key as EmbedColorKey];
    return COLOR_MAP.graphite;
}

// Reverse lookup — used when /embed edit needs to show which brand color
// (if any) a previously-posted embed is currently using, so the modal can
// hint at it. Falls back to "graphite" label if the embed used a raw/legacy
// color that isn't in the current palette.
export function labelForColor(color: number | null): string {
    const entry = Object.entries(COLOR_MAP).find(([, value]) => value === color);
    const key = (entry?.[0] as EmbedColorKey | undefined) ?? 'graphite';
    return EMBED_COLOR_CHOICES.find(c => c.value === key)?.name ?? 'Graphite';
}
